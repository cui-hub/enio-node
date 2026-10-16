import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgent,
  createExecuteTool,
  createFilesystemSkills,
  createProcessBackend,
  createSkillTool,
} from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

describe("inline Skill and explicit process extension", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "enio-skills-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("A11: discovers metadata and loads instructions into the existing agent", async () => {
    await mkdir(path.join(root, "report"));
    await writeFile(
      path.join(root, "report/SKILL.md"),
      "---\nname: report\ndescription: Report instructions\n---\nRead the source before writing.",
    );
    const tool = await createSkillTool({ backend: createFilesystemSkills({ root }) });
    expect(tool.description).toContain("report: Report instructions");
    expect(tool.description).not.toContain("Read the source");
    const result = await createAgent({
      model: sequence(calling(call("skill", { skill: "report" })), answer()),
      tools: [tool],
    }).run({ input: "report" }, { context: {} });
    expect(result.status).toBe("completed");
    expect(result.messages.find((message) => message.role === "tool")!.content).toContain(
      "Read the source before writing.",
    );
    expect(result.iterations).toBe(2);
  });

  it.each(["context: fork", "context: fork_with_context", "agent: child", "model: other"])(
    "A11: rejects unsupported config %s",
    async (config) => {
      await mkdir(path.join(root, "report"));
      await writeFile(
        path.join(root, "report/SKILL.md"),
        `---\nname: report\ndescription: description\n${config}\n---\nInstructions`,
      );
      await expect(
        createSkillTool({ backend: createFilesystemSkills({ root }) }),
      ).rejects.toMatchObject({ code: "unsupported_skill" });
    },
  );

  it("A11: unknown skills do not fetch a backend entry or start execution", async () => {
    const get = vi.fn();
    const tool = await createSkillTool({
      backend: {
        async list() {
          return [{ name: "report", description: "report" }];
        },
        get,
      },
    });
    const result = await createAgent({
      model: sequence(calling(call("skill", { skill: "unknown" })), answer()),
      tools: [tool],
    }).run({ input: "go" }, { context: {} });
    expect(
      JSON.parse(result.messages.find((message) => message.role === "tool")!.content).code,
    ).toBe("skill_not_found");
    expect(get).not.toHaveBeenCalled();
  });

  it("A14: execute is unavailable unless explicitly registered", async () => {
    const result = await createAgent({
      model: sequence(calling(call("execute", { command: process.execPath })), answer()),
    }).run({ input: "go" }, { context: {} });
    expect(
      JSON.parse(result.messages.find((message) => message.role === "tool")!.content).code,
    ).toBe("unknown_tool");
  });

  it("A14: passes literal args, bounds output and restricts commands/environment", async () => {
    const backend = createProcessBackend({
      root,
      commands: [process.execPath],
      authorize: () => true,
      env: { ALLOWED: "visible" },
      maxOutputBytes: 100,
    });
    const result = await backend.execute(
      {
        command: process.execPath,
        args: [
          "-e",
          'console.log(process.env.ALLOWED); console.log(process.env.HOME ?? "hidden"); console.log(process.argv[1]);',
          "$(touch forbidden)",
        ],
      },
      AbortSignal.timeout(3000),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("visible\nhidden\n$(touch forbidden)");
    const long = await backend.execute(
      { command: process.execPath, args: ["-e", 'process.stdout.write("x".repeat(1000))'] },
      AbortSignal.timeout(3000),
    );
    expect(long.truncated).toBe(true);
    expect(Buffer.byteLength(long.stdout)).toBeLessThanOrEqual(100);
    const unicode = await backend.execute(
      { command: process.execPath, args: ["-e", 'process.stdout.write("中".repeat(1000))'] },
      AbortSignal.timeout(3000),
    );
    expect(unicode.truncated).toBe(true);
    expect(unicode.stdout).not.toContain("�");
    expect(Buffer.byteLength(unicode.stdout)).toBeLessThanOrEqual(100);
    await expect(
      backend.execute({ command: "/bin/sh", args: [] }, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    const tool = createExecuteTool({ backend });
    const run = await createAgent({
      model: sequence(
        calling(call("execute", { command: process.execPath, args: ["-e", "console.log('ok')"] })),
        answer(),
      ),
      tools: [tool],
    }).run({ input: "go" }, { context: {} });
    expect(run.status).toBe("completed");
  });

  it("A14: kills a timed out process and reports uncertain side effects", async () => {
    const backend = createProcessBackend({
      root,
      commands: [process.execPath],
      authorize: () => true,
      timeoutMs: 50,
      killGraceMs: 20,
    });
    const started = Date.now();
    await expect(
      backend.execute(
        { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "tool_timeout", outcomeUnknown: true });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("A14: also stops a child that ignores SIGTERM in the same process group", async () => {
    const heartbeat = path.join(root, "heartbeat");
    const childCode = `process.on('SIGTERM', () => {}); setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 10);`;
    const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    const backend = createProcessBackend({
      root,
      commands: [process.execPath],
      authorize: () => true,
      timeoutMs: 250,
      killGraceMs: 25,
    });
    await expect(
      backend.execute(
        { command: process.execPath, args: ["-e", parentCode] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "tool_timeout" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stopped = await readFile(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await readFile(heartbeat, "utf8")).toBe(stopped);
  });
});
