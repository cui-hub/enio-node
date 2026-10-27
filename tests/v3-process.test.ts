import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgent, createExecuteTool, createProcessBackend } from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

describe("V3 process output streaming", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "enio-stream-"));
  });
  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("cleans up a running process when the agent event consumer breaks", async () => {
    const backend = createProcessBackend({
      root,
      commands: [process.execPath],
      authorize: () => true,
      killGraceMs: 10,
    });
    const agent = createAgent({
      model: sequence(
        calling(
          call("execute", {
            command: process.execPath,
            args: ["-e", "console.log(process.pid); setInterval(() => {}, 1000);"],
          }),
        ),
      ),
      tools: [createExecuteTool({ backend })],
    });
    let pid: number | undefined;
    try {
      for await (const event of agent.stream(
        { input: "go" },
        { context: {}, signal: AbortSignal.timeout(3000) },
      )) {
        if (event.type === "tool_output") {
          pid = Number(event.payload.text.trim());
          break;
        }
      }
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(
        () => {
          expect(() => process.kill(pid!, 0)).toThrow();
        },
        { timeout: 2000 },
      );
    } finally {
      // 即使取消回归导致测试失败，也不留下测试自己的子进程。
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* 已被正常回收。 */
        }
      }
    }
  });

  it("delivers stdout while the process is still waiting, then returns its final output", async () => {
    const release = path.join(root, "release");
    const backend = createProcessBackend({
      root,
      commands: [process.execPath],
      authorize: () => true,
    });
    const script = `console.log('ready'); const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.error('finished'); } }, 10);`;
    const agent = createAgent({
      model: sequence(
        calling(call("execute", { command: process.execPath, args: ["-e", script] })),
        answer(),
      ),
      tools: [createExecuteTool({ backend })],
    });
    const channels: string[] = [];
    let result;
    for await (const event of agent.stream(
      { input: "go" },
      { context: {}, signal: AbortSignal.timeout(5000) },
    )) {
      if (event.type === "tool_output") {
        channels.push(event.payload.channel!);
        if (event.payload.text.includes("ready")) await writeFile(release, "ok");
      }
      if (event.type === "run_end") result = event.payload.result;
    }
    expect(result?.status).toBe("completed");
    expect(channels).toContain("stdout");
    expect(channels).toContain("stderr");
    const output = JSON.parse(result!.messages.find((message) => message.role === "tool")!.content);
    expect(JSON.parse(output.content)).toMatchObject({
      exitCode: 0,
      stdout: "ready\n",
      stderr: "finished\n",
    });
  });

  it("preserves UTF-8 across output chunks and caps streamed bytes", async () => {
    const backend = createProcessBackend({
      root,
      commands: [process.execPath],
      authorize: () => true,
      maxOutputBytes: 7,
    });
    const script = `const b=Buffer.from('中文中文'); process.stdout.write(b.subarray(0,2)); setTimeout(() => process.stdout.write(b.subarray(2)), 10);`;
    let text = "";
    let final;
    for await (const chunk of backend.stream!(
      { command: process.execPath, args: ["-e", script] },
      AbortSignal.timeout(3000),
    )) {
      if (chunk.type === "text_delta") text += chunk.text;
      else final = chunk.result;
    }
    expect(text).toBe("中文");
    expect(text).not.toContain("�");
    expect(final).toMatchObject({ stdout: text, truncated: true });
  });
});
