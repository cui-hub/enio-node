import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentError,
  ModelError,
  ToolError,
  createAgent,
  createAgentsMd,
  createFilesystemAgentsMd,
  createScriptedModel,
  createTodoTool,
} from "../src/index.js";
import type {
  AgentsMdLoader,
  AgentsMdOptions,
  AgentsMdWarning,
  Message,
  ModelRequest,
} from "../src/index.js";
import { answer, call, calling } from "./helpers.js";

/** 保留可变文件表，用真实读取次数验证跨轮缓存和跨 run 刷新。 */
function backend(files: Record<string, string>) {
  return {
    read: vi.fn(async (file: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!(file in files)) throw new ToolError("not_found", "missing");
      return files[file]!;
    }),
  };
}

/** 每次测试独立的取消域，避免把全局 signal 用作共享运行状态。 */
const signal = () => new AbortController().signal;
const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("A15: project instruction loading", () => {
  it("loads lazily, skips missing/empty files, and snapshots configured paths", async () => {
    const source = backend({ "empty.md": " \n", "rules.md": "Use pnpm." });
    const files = ["absent.md", "empty.md", "rules.md"];
    const warnings: AgentsMdWarning[] = [];
    const loader = createAgentsMd({
      backend: source,
      files,
      onWarning: (warning) => {
        warnings.push(warning);
      },
    });
    files.push("later.md");
    expect(source.read).not.toHaveBeenCalled();
    const content = await loader.load(signal());
    expect(content).toContain("rules.md");
    expect(content).toContain("Use pnpm.");
    expect(content).not.toContain("empty.md");
    expect(source.read.mock.calls.map(([file]) => file)).toEqual([
      "absent.md",
      "empty.md",
      "rules.md",
    ]);
    expect(warnings.map(({ code }) => code)).toEqual(["not_found"]);
    expect(await createAgentsMd({ backend: source, files: [] }).load(signal())).toBe("");
  });

  it("expands relative imports in DFS order, deduplicates, and skips cycles/mentions", async () => {
    const source = backend({
      "AGENTS.md": "Root. @docs/rules.md @shared.md @owner contact@example.md",
      "docs/rules.md": "Rules. @../shared.md @../AGENTS.md",
      "shared.md": "Common requirements.",
      "CUSTOM.md": "Additional rules.",
    });
    const warnings: AgentsMdWarning[] = [];
    const content = await createAgentsMd({
      backend: source,
      files: ["AGENTS.md", "shared.md", "CUSTOM.md"],
      onWarning: (warning) => {
        warnings.push(warning);
      },
    }).load(signal());
    expect(source.read.mock.calls.map(([file]) => file)).toEqual([
      "AGENTS.md",
      "docs/rules.md",
      "shared.md",
      "CUSTOM.md",
    ]);
    expect(content).toContain("@docs/rules.md");
    expect(content.indexOf("Root.")).toBeLessThan(content.indexOf("Rules."));
    expect(content.indexOf("Rules.")).toBeLessThan(content.indexOf("Common requirements."));
    expect(content.indexOf("Common requirements.")).toBeLessThan(
      content.indexOf("Additional rules."),
    );
    expect(warnings.map(({ code }) => code)).toEqual(["cycle"]);
  });

  it("limits depth without excluding an explicitly listed entry file", async () => {
    const source = backend({ "AGENTS.md": "@child.md", "child.md": "child" });
    const warning = vi.fn();
    const content = await createAgentsMd({
      backend: source,
      files: ["AGENTS.md", "child.md"],
      maxImportDepth: 0,
      onWarning: warning,
    }).load(signal());
    expect(content).toContain("Project instructions (child.md)");
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "depth_limit" }));
  });

  it("counts missing files toward the file limit and stops further I/O", async () => {
    const source = backend({ "AGENTS.md": "@missing.md @later.md", "later.md": "later" });
    const warning = vi.fn();
    await createAgentsMd({ backend: source, maxFiles: 2, onWarning: warning }).load(signal());
    expect(source.read.mock.calls.map(([file]) => file)).toEqual(["AGENTS.md", "missing.md"]);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "file_limit" }));
  });

  it("truncates a file on a UTF-8 boundary and does not follow its imports", async () => {
    const source = backend({ "AGENTS.md": "中文😊@child.md", "child.md": "child" });
    const warning = vi.fn();
    const content = await createAgentsMd({
      backend: source,
      maxFileBytes: 7,
      onWarning: warning,
    }).load(signal());
    expect(content).toContain("中文\n[truncated]");
    expect(content).not.toContain("�");
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "file_truncated" }));
  });

  it("caps the entire injected text including labels, and stops later reads", async () => {
    const source = backend({ "AGENTS.md": "中文😊".repeat(100), "later.md": "later" });
    const warning = vi.fn();
    const content = await createAgentsMd({
      backend: source,
      files: ["AGENTS.md", "later.md"],
      maxTotalBytes: 100,
      onWarning: warning,
    }).load(signal());
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(100);
    expect(content).toContain("[truncated]");
    expect(content).not.toContain("�");
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "total_limit" }));
    expect(await createAgentsMd({ backend: source, maxTotalBytes: 1 }).load(signal())).toBe("");
  });

  it.each(["../secret.md", "/secret.md", "~/secret.md", "C:\\secret.md", "bad\nname.md"])(
    "rejects invalid entry path %s before I/O",
    (file) => {
      const source = backend({});
      expect(() => createAgentsMd({ backend: source, files: [file] })).toThrow(
        expect.objectContaining({ code: "invalid_agents_md_path" }),
      );
      expect(source.read).not.toHaveBeenCalled();
    },
  );

  it("rejects an import escaping the root before asking the backend to read it", async () => {
    const source = backend({ "AGENTS.md": "@../secret.md" });
    await expect(createAgentsMd({ backend: source }).load(signal())).rejects.toMatchObject({
      code: "invalid_agents_md_path",
    });
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it.each([
    { maxFileBytes: 0 },
    { maxTotalBytes: -1 },
    { maxImportDepth: 0.5 },
    { maxFiles: Infinity },
  ])("rejects invalid budgets %j synchronously", (options) => {
    expect(() => createAgentsMd({ backend: backend({}), ...options })).toThrow(
      expect.objectContaining({ code: "invalid_config" }),
    );
  });

  it("distinguishes absent files from fatal read failures without exposing raw errors", async () => {
    const absent = {
      async read() {
        throw Object.assign(new Error("private absolute path"), { code: "ENOENT" });
      },
    };
    expect(await createAgentsMd({ backend: absent }).load(signal())).toBe("");
    const denied = {
      async read() {
        throw Object.assign(new Error("credential: secret"), { code: "EACCES" });
      },
    };
    await expect(createAgentsMd({ backend: denied }).load(signal())).rejects.toMatchObject({
      code: "agents_md_load_failed",
      message: "Cannot read project instructions: AGENTS.md",
    });
  });

  it("isolates warning observer errors", async () => {
    const options: AgentsMdOptions = {
      backend: backend({}),
      onWarning: () => {
        throw new Error("log unavailable");
      },
    };
    expect(await createAgentsMd(options).load(signal())).toBe("");
    expect(
      await createAgentsMd({
        ...options,
        onWarning: async () => {
          throw new Error("async logger unavailable");
        },
      }).load(signal()),
    ).toBe("");
  });

  it("reads a real workspace and rejects symbolic links and oversized raw files", async () => {
    // macOS 的临时目录祖先可能是系统别名；root 本身始终由 mkdtemp 创建。
    const root = await mkdtemp(path.join(tmpdir(), "enio-instructions-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "AGENTS.md"), "Use pnpm. @docs/testing.md");
    await writeFile(path.join(root, "docs/testing.md"), "Run relevant checks.");
    const loader = createFilesystemAgentsMd({ root });
    const content = await loader.load(signal());
    expect(content).toContain("Use pnpm.");
    expect(content).toContain("Run relevant checks.");
    await symlink(path.join(root, "docs/testing.md"), path.join(root, "linked.md"));
    await expect(
      createFilesystemAgentsMd({ root, files: ["linked.md"] }).load(signal()),
    ).rejects.toMatchObject({ code: "agents_md_load_failed" });
    await writeFile(path.join(root, "large.md"), "a".repeat(1_048_577));
    await expect(
      createFilesystemAgentsMd({ root, files: ["large.md"] }).load(signal()),
    ).rejects.toMatchObject({ code: "agents_md_load_failed" });
    expect(() => createFilesystemAgentsMd({ root: "" })).toThrow(AgentError);
  });
});

describe("A15: Agent request integration", () => {
  it("injects once per request before the first user, caches across rounds, and refreshes next run", async () => {
    const files = { "AGENTS.md": "Original project rules." };
    const source = backend(files);
    const requests: ModelRequest[] = [];
    const original: Message[] = [
      { role: "system", content: "historical system" },
      { role: "user", content: "previous question" },
      { role: "assistant", content: "", toolCalls: [call("write_todos", { todos: [] }, "old")] },
      { role: "tool", toolCallId: "old", content: "{}" },
      { role: "assistant", content: "previous reply" },
    ];
    const before = structuredClone(original);
    const agent = createAgent({
      instructions: "Fixed system rules.",
      agentsMd: createAgentsMd({ backend: source }),
      tools: [createTodoTool()],
      hooks: { beforeModel: () => "Dynamic system rules." },
      model: {
        async generate(request) {
          requests.push(structuredClone(request));
          if (requests.length === 1) {
            files["AGENTS.md"] = "Updated project rules.";
            return calling(call("write_todos", { todos: [] }, "new"));
          }
          return answer();
        },
      },
    });
    expect(source.read).not.toHaveBeenCalled();
    const result = await agent.run({ input: "do work", messages: original }, { context: {} });
    expect(result.status).toBe("completed");
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.messages.slice(0, 5)).toEqual([
        { role: "system", content: "Dynamic system rules." },
        { role: "system", content: "Fixed system rules." },
        before[0],
        { role: "user", content: expect.stringContaining("Original project rules.") },
        before[1],
      ]);
      expect(
        request.messages.filter(({ content }) => content.includes("Original project rules.")),
      ).toHaveLength(1);
      expect(request.tools.map(({ name }) => name)).toEqual(["write_todos"]);
    }
    expect(result.messages.some(({ content }) => content.includes("project rules"))).toBe(false);
    expect(original).toEqual(before);
    expect(result.historyComplete).toBe(true);
    const next = await agent.run({ input: "continue", messages: result.messages }, { context: {} });
    expect(next.status).toBe("completed");
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(
      requests[2]!.messages.filter(({ content }) => content.includes("Updated project rules.")),
    ).toHaveLength(1);
    expect(
      requests[2]!.messages.some(({ content }) => content.includes("Original project rules.")),
    ).toBe(false);
  });

  it("caches an empty result for the current run, then discovers a newly created file", async () => {
    const files: Record<string, string> = {};
    const source = backend(files);
    let round = 0;
    const requests: ModelRequest[] = [];
    const agent = createAgent({
      agentsMd: createAgentsMd({ backend: source }),
      tools: [createTodoTool()],
      model: {
        async generate(request) {
          requests.push(request);
          if (++round === 1) {
            files["AGENTS.md"] = "Newly created rules.";
            return calling(call("write_todos", { todos: [] }));
          }
          return answer();
        },
      },
    });
    expect((await agent.run({ input: "first" }, { context: {} })).status).toBe("completed");
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(
      requests.every(
        ({ messages }) => !messages.some(({ content }) => content.includes("Newly created")),
      ),
    ).toBe(true);
    await agent.run({ input: "second" }, { context: {} });
    expect(requests[2]!.messages[0]!.content).toContain("Newly created rules.");
  });

  it("uses the same instruction snapshot during model retries", async () => {
    const load = vi.fn(async () => "Retry rules");
    let attempt = 0;
    const model = {
      generate: vi.fn(async () => {
        if (++attempt === 1) throw new ModelError("network", "Retry", true);
        return answer();
      }),
    };
    const result = await createAgent({
      model,
      agentsMd: { load },
      limits: { retryDelayMs: 1 },
    }).run({ input: "retry" }, { context: {} });
    expect(result.status).toBe("completed");
    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent loads and their cancellation signals independent", async () => {
    const pending: { signal: AbortSignal; resolve: (text: string) => void }[] = [];
    const loader: AgentsMdLoader = {
      load: (runSignal) =>
        new Promise((resolve) => {
          pending.push({ signal: runSignal, resolve });
        }),
    };
    const agent = createAgent({
      agentsMd: loader,
      model: {
        async generate(request) {
          return answer(request.messages[0]!.content);
        },
      },
    });
    const controller = new AbortController();
    const first = agent.run({ input: "first" }, { context: {}, signal: controller.signal });
    const second = agent.run({ input: "second" }, { context: {} });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.signal).not.toBe(pending[1]!.signal);
    controller.abort();
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending[1]!.signal.aborted).toBe(false);
    pending[1]!.resolve("Second run rules");
    expect((await first).status).toBe("cancelled");
    expect((await second).finalText).toBe("Second run rules");
    pending[0]!.resolve("Late first run rules");
  });

  it("times out a noncooperative loader before calling the model", async () => {
    vi.useFakeTimers();
    const generate = vi.fn(async () => answer());
    const result = createAgent({
      model: { generate },
      agentsMd: { load: () => new Promise<string>(() => {}) },
      limits: { runTimeoutMs: 10 },
    }).run({ input: "wait" }, { context: {} });
    await vi.advanceTimersByTimeAsync(11);
    expect((await result).stopReason).toBe("run_timeout");
    expect(generate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not load before stream consumption, and return cancels a pending read", async () => {
    let backendSignal: AbortSignal | undefined;
    const read = vi.fn((_file: string, runSignal: AbortSignal) => {
      backendSignal = runSignal;
      return new Promise<string>(() => {});
    });
    const generate = vi.fn(async () => answer());
    const stream = createAgent({
      model: { generate },
      agentsMd: createAgentsMd({ backend: { read } }),
    }).stream({ input: "wait" }, { context: {} });
    expect(read).not.toHaveBeenCalled();
    expect((await stream.next()).value.type).toBe("run_start");
    expect(read).not.toHaveBeenCalled();
    const pending = stream.next();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await stream.return!();
    await pending;
    expect(backendSignal!.aborted).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });

  it("includes instructions in the total request budget", async () => {
    const generate = vi.fn(async () => answer());
    const result = await createAgent({
      model: { generate },
      agentsMd: { load: async () => "r".repeat(4096) },
      limits: { maxInputBytes: 1024 },
    }).run({ input: "hello" }, { context: {} });
    expect(result.stopReason).toBe("limit_exceeded");
    expect(generate).not.toHaveBeenCalled();
  });

  it("reports loading failures through run_end and rejects invalid loader results", async () => {
    const generate = vi.fn(async () => answer());
    const agent = createAgent({
      model: { generate },
      agentsMd: createAgentsMd({
        backend: {
          async read() {
            throw new Error("secret");
          },
        },
      }),
    });
    const events = [];
    for await (const event of agent.stream({ input: "hello" }, { context: {} })) events.push(event);
    expect(events.map(({ type }) => type)).toEqual(["run_start", "run_end"]);
    const last = events.at(-1)!;
    expect(last.type === "run_end" && last.payload.result.stopReason).toBe("agents_md_load_failed");
    const invalid = {
      async load() {
        return 42;
      },
    } as unknown as AgentsMdLoader;
    const result = await createAgent({ model: { generate }, agentsMd: invalid }).run(
      { input: "hello" },
      { context: {} },
    );
    expect(result.stopReason).toBe("invalid_agents_md");
    expect(generate).not.toHaveBeenCalled();
  });

  it("makes loading opt-in and preserves stream text and reusable history", async () => {
    const requests: ModelRequest[] = [];
    const model = createScriptedModel((request) => {
      requests.push(request);
      return answer("你好");
    });
    const without = await createAgent({ model }).run({ input: "hello" }, { context: {} });
    expect(requests[0]!.messages).toEqual([{ role: "user", content: "hello" }]);
    const load = vi.fn(async () => "Project rules");
    const stream = createAgent({ model, agentsMd: { load } }).stream(
      { input: "hello" },
      { context: {} },
    );
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.payload.text;
      if (event.type === "run_end") expect(event.payload.result.messages).toEqual(without.messages);
    }
    expect(text).toBe("你好");
    expect(load).toHaveBeenCalledTimes(1);
    expect(requests[1]!.messages[0]).toEqual({ role: "user", content: "Project rules" });
  });
});
