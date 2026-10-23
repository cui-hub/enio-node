import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentError,
  ModelError,
  createAgent,
  createArtifactTool,
  createFileArtifactStore,
  createMemoryArtifactStore,
  createSummarization,
  createToolResultReduction,
  defineTool,
  exportState,
  parseState,
  serializeState,
} from "../src/index.js";
import type { AgentEvent, ChatModel, Message, ModelRequest, ToolResult } from "../src/index.js";
import { validateHistory } from "../src/runtime/history.js";
import { answer, call, calling, sequence } from "./helpers.js";

const signal = () => new AbortController().signal;
const longHistory = (): Message[] => [
  { role: "system", content: "persistent rule" },
  { role: "user", content: "earlier task " + "details ".repeat(500) },
  { role: "assistant", content: "earlier answer " + "facts ".repeat(500) },
];
const outputTool = (content: string) =>
  defineTool({
    name: "output",
    description: "output fixture",
    effect: "read" as const,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { ok: true as const, content };
    },
  });

describe("summarization and exported working state", () => {
  it("keeps optional undefined model fields compatible with JSON state export", async () => {
    const result = await createAgent({
      model: sequence({
        ...answer(),
        message: { role: "assistant", content: "done", toolCalls: undefined },
      }),
    }).run({ input: "hi" }, { context: {} });
    expect(result.status).toBe("completed");
    expect(parseState(serializeState(exportState(result))).messages.at(-1)).toEqual({
      role: "assistant",
      content: "done",
    });
  });
  it("compresses before the hard request limit, preserves instructions, and accounts for summary usage", async () => {
    const original = longHistory();
    const before = structuredClone(original);
    const requests: ModelRequest[] = [];
    const events: AgentEvent[] = [];
    const saved = vi.fn();
    const model: ChatModel = {
      async generate(request) {
        requests.push(request);
        return answer("continued");
      },
    };
    const result = await createAgent({
      model,
      instructions: "host instruction",
      agentsMd: {
        async load() {
          return "project rule";
        },
      },
      contextPolicies: [
        createSummarization({
          model: sequence(answer("Task and decisions preserved.")),
          triggerMessages: 2,
          keepRecentMessages: 1,
        }),
      ],
      limits: { maxInputBytes: 1500 },
      hooks: {
        afterAgent(state) {
          saved(structuredClone(state));
          state.messages.length = 0;
        },
        onEvent(event) {
          events.push(event);
        },
      },
    }).run({ input: "continue", messages: original }, { context: {} });
    expect(result.status).toBe("completed");
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 4, known: true });
    expect(requests[0]!.messages.map((m) => m.content)).toContain("host instruction");
    expect(requests[0]!.messages.map((m) => m.content)).toContain("project rule");
    expect(requests[0]!.messages.map((m) => m.content)).toContain("persistent rule");
    expect(JSON.stringify(result.messages)).not.toContain("host instruction");
    expect(JSON.stringify(result.messages)).not.toContain("project rule");
    expect(JSON.stringify(result.messages)).not.toContain("details details");
    expect(original).toEqual(before);
    expect(saved).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "context_updated")).toBe(true);
    const exported = parseState(serializeState(exportState(result)));
    exported.messages[0]!.content = "changed";
    expect(result.messages[0]!.content).toBe("persistent rule");
  });

  it("keeps the whole newest tool batch when the requested suffix starts inside it", async () => {
    const calls = [call("output", {}, "a"), call("output", {}, "b")];
    const messages: Message[] = [
      ...longHistory(),
      { role: "assistant", content: "", toolCalls: calls },
      { role: "tool", toolCallId: "a", content: "A" },
      { role: "tool", toolCallId: "b", content: "B" },
    ];
    const policy = createSummarization({
      model: sequence(answer("summary")),
      triggerMessages: 1,
      keepRecentMessages: 1,
    });
    const update = await policy.beforeModel!({
      runId: "run",
      messages,
      request: { messages, tools: [] },
      signal: signal(),
    });
    expect(update!.messages.slice(-3)).toEqual(messages.slice(-3));
    expect(() => validateHistory(update!.messages)).not.toThrow();
  });

  it("retains used ids after compression so the model cannot reuse an old tool call", async () => {
    const history: Message[] = [
      ...longHistory(),
      { role: "assistant", content: "", toolCalls: [call("output", {}, "old")] },
      { role: "tool", toolCallId: "old", content: "ok" },
    ];
    const tool = outputTool("ok");
    const execute = vi.spyOn(tool, "execute");
    const result = await createAgent({
      model: sequence(calling(call("output", {}, "old"))),
      tools: [tool],
      contextPolicies: [
        createSummarization({
          model: sequence(answer("summary")),
          triggerMessages: 1,
          keepRecentMessages: 1,
        }),
      ],
    }).run({ input: "next", messages: history }, { context: {} });
    expect(result.stopReason).toBe("protocol_error");
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses compressed state for the next conversation turn without replaying raw history", async () => {
    const first = await createAgent({
      model: sequence(answer()),
      contextPolicies: [
        createSummarization({
          model: sequence(answer("summary")),
          triggerMessages: 1,
          keepRecentMessages: 1,
        }),
      ],
    }).run({ input: "first", messages: longHistory() }, { context: {} });
    const model: ChatModel = {
      async generate(request) {
        expect(JSON.stringify(request)).toContain("summary");
        expect(JSON.stringify(request)).not.toContain("details details");
        return answer();
      },
    };
    expect(
      (
        await createAgent({ model }).run(
          { input: "second", state: exportState(first) },
          { context: {} },
        )
      ).status,
    ).toBe("completed");
  });

  it("retries transient summary errors then uses fallback, marking unknown billing", async () => {
    const generate = vi.fn<ChatModel["generate"]>(async () => {
      throw new ModelError("temporary", "temporary", true);
    });
    const result = await createAgent({
      model: sequence(answer()),
      contextPolicies: [
        createSummarization({
          model: { generate },
          fallbackModels: [sequence(answer("summary"))],
          maxRetries: 1,
          retryDelayMs: 0,
          triggerMessages: 1,
          keepRecentMessages: 1,
        }),
      ],
    }).run({ input: "next", messages: longHistory() }, { context: {} });
    expect(result.status).toBe("completed");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.usage.known).toBe(false);
  });

  it.each([answer(""), calling(call("output"))])(
    "rejects unusable summaries before the main model executes",
    async (response) => {
      const generate = vi.fn(async () => answer());
      const result = await createAgent({
        model: { generate },
        contextPolicies: [
          createSummarization({
            model: sequence(response),
            triggerMessages: 1,
            keepRecentMessages: 1,
          }),
        ],
      }).run({ input: "next", messages: longHistory() }, { context: {} });
      expect(result.stopReason).toBe("invalid_summary");
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it("bounds an uncooperative summary request and aborts its signal", async () => {
    let captured: AbortSignal | undefined;
    const model: ChatModel = {
      generate(_request, sig) {
        captured = sig;
        return new Promise(() => {});
      },
    };
    const result = await createAgent({
      model: sequence(answer()),
      contextPolicies: [
        createSummarization({ model, timeoutMs: 10, triggerMessages: 1, keepRecentMessages: 1 }),
      ],
    }).run({ input: "next", messages: longHistory() }, { context: {} });
    expect(result.stopReason).toBe("summary_timeout");
    expect(captured?.aborted).toBe(true);
  });

  it("does not replace working history with a larger summary", async () => {
    const messages: Message[] = [{ role: "user", content: "small" }];
    const update = await createSummarization({
      model: sequence(answer("large ".repeat(200))),
      triggerTokens: 1,
      keepRecentMessages: 0,
    }).beforeModel!({ runId: "r", messages, request: { messages, tools: [] }, signal: signal() });
    expect(update!.messages).toEqual(messages);
    expect(update!.usage).toBeDefined();
  });

  it("rejects invalid token counters and malformed custom finalizers", async () => {
    for (const policy of [
      createSummarization({ model: sequence(answer()), tokenCounter: () => NaN }),
      createSummarization({
        model: sequence(answer("summary")),
        triggerMessages: 1,
        keepRecentMessages: 1,
        finalize: () => [{ role: "tool", toolCallId: "orphan", content: "bad" }],
      }),
    ]) {
      const result = await createAgent({
        model: sequence(answer()),
        contextPolicies: [policy],
      }).run({ input: "next", messages: longHistory() }, { context: {} });
      expect(result.status).toBe("failed");
    }
  });

  it("fails a state persistence hook instead of reporting successful persistence", async () => {
    const result = await createAgent({
      model: sequence(answer()),
      hooks: {
        afterAgent() {
          throw new Error("offline");
        },
      },
    }).run({ input: "hi" }, { context: {} });
    expect(result.status).toBe("failed");
    expect(() => exportState(result)).toThrow();
  });

  it("rejects incompatible or unfinished serialized snapshots", () => {
    for (const value of [
      { schemaVersion: 2, messages: [], todos: [], usedToolCallIds: [] },
      {
        schemaVersion: 1,
        messages: [calling(call("output")).message],
        todos: [],
        usedToolCallIds: ["call-1"],
      },
    ]) {
      expect(() => parseState(JSON.stringify(value))).toThrow();
    }
    expect(() => parseState("{}", 1)).toThrow();
  });
});

describe("tool output reduction and artifact retrieval", () => {
  it("offloads at the runtime hard limit even when the policy threshold is higher", async () => {
    const store = createMemoryArtifactStore();
    const content = "complete content ".repeat(2000);
    const result = await createAgent({
      model: sequence(calling(call("output")), answer()),
      tools: [outputTool(content)],
      contextPolicies: [createToolResultReduction({ store })],
      limits: { maxToolResultBytes: 256 },
    }).run({ input: "logs" }, { context: {} });
    expect(result.status).toBe("completed");
    const output = JSON.parse(result.messages.find((message) => message.role === "tool")!.content);
    expect(JSON.parse(await store.read(output.artifact.id, signal())).content).toBe(content);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(256);
  });

  it("clears oversized historical arguments even when the result is already offloaded", async () => {
    const store = createMemoryArtifactStore();
    const old = await store.write("original output", signal());
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [call("output", { text: "x".repeat(5000) }, "a")],
      },
      {
        role: "tool",
        toolCallId: "a",
        content: JSON.stringify({ ok: true, content: "external", artifact: old }),
      },
    ];
    const policy = createToolResultReduction({ store, clearAtTokens: 1, keepRecentToolRounds: 0 });
    const update = await policy.beforeModel!({
      runId: "r",
      messages,
      request: { messages, tools: [] },
      signal: signal(),
    });
    const artifact = JSON.parse(update!.messages[1]!.content).artifact;
    expect(JSON.parse(await store.read(artifact.id, signal())).result.artifact).toEqual(old);
    expect(JSON.stringify(update!.messages)).not.toContain("xxxxx");
    expect(
      await policy.beforeModel!({
        runId: "r",
        messages: update!.messages,
        request: { messages: update!.messages, tools: [] },
        signal: signal(),
      }),
    ).toBeUndefined();
  });

  it("offloads full output before runtime truncation and exposes a retrievable reference", async () => {
    const store = createMemoryArtifactStore();
    const content = "完整日志🙂\n".repeat(3000);
    const result = await createAgent({
      model: sequence(calling(call("output")), answer()),
      tools: [outputTool(content), createArtifactTool({ store })],
      contextPolicies: [createToolResultReduction({ store, maxOutputBytes: 512 })],
      limits: { maxToolResultBytes: 512 },
    }).run({ input: "logs" }, { context: {} });
    expect(result.status).toBe("completed");
    const output: ToolResult = JSON.parse(
      result.messages.find((message) => message.role === "tool")!.content,
    );
    expect(output.artifact).toBeDefined();
    expect(JSON.parse(await store.read(output.artifact!.id, signal())).content).toBe(content);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(512);
  });

  it("clears old call arguments and results while preserving the newest complete round", async () => {
    const store = createMemoryArtifactStore();
    const large = "x".repeat(4000);
    const messages: Message[] = [
      { role: "user", content: "work" },
      { role: "assistant", content: "", toolCalls: [call("output", { text: large }, "old")] },
      { role: "tool", toolCallId: "old", content: JSON.stringify({ ok: true, content: large }) },
      { role: "assistant", content: "", toolCalls: [call("output", {}, "new")] },
      { role: "tool", toolCallId: "new", content: JSON.stringify({ ok: true, content: large }) },
    ];
    const update = await createToolResultReduction({
      store,
      clearAtTokens: 1,
      keepRecentToolRounds: 1,
    }).beforeModel!({ runId: "r", messages, request: { messages, tools: [] }, signal: signal() });
    expect(update!.messages.slice(-2)).toEqual(messages.slice(-2));
    expect(
      (update!.messages[1] as Extract<Message, { role: "assistant" }>).toolCalls![0]!.arguments,
    ).toBe("{}");
    const artifact = JSON.parse(update!.messages[2]!.content).artifact;
    expect(JSON.parse(await store.read(artifact.id, signal())).call.arguments).toContain(large);
    expect(() => validateHistory(update!.messages)).not.toThrow();
    expect(messages[2]!.content).toContain(large);
  });

  it("reads all Unicode bytes through persisted artifact pages across store instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "enio-artifacts-"));
    try {
      const content = "你好🙂abc".repeat(50);
      const reference = await createFileArtifactStore({ root }).write(content, signal());
      const store = createFileArtifactStore({ root });
      const reader = createArtifactTool({ store, pageBytes: 17 });
      let offset = 0;
      let restored = "";
      for (;;) {
        const result = await reader.execute(
          { id: reference.id, offset },
          { runId: "r", toolCallId: "read", signal: signal(), context: {}, state: { todos: [] } },
        );
        if (!result.ok) throw new Error("read failed");
        const page = JSON.parse(result.content);
        restored += page.content;
        if (page.nextOffset === undefined) break;
        offset = page.nextOffset;
      }
      expect(restored).toBe(content);
      await expect(store.read("../../outside", signal())).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never recursively offloads the artifact reader and honors exclusions", async () => {
    const store = createMemoryArtifactStore();
    const policy = createToolResultReduction({
      store,
      maxOutputBytes: 256,
      excludeTools: ["output"],
    });
    const result = { ok: true as const, content: "x".repeat(5000) };
    for (const name of ["read_artifact", "output"])
      expect(
        await policy.afterTool!({ runId: "r", call: call(name), result, signal: signal() }),
      ).toEqual(result);
  });

  it("does not report an offload failure after a write as a retryable tool failure", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: "x".repeat(5000) }));
    const store = {
      async write(): Promise<never> {
        throw new AgentError("storage_failed", "offline");
      },
      async read() {
        return "";
      },
    };
    const result = await createAgent({
      model: sequence(calling(call("output")), answer()),
      tools: [{ ...outputTool(""), effect: "write", execute }],
      contextPolicies: [createToolResultReduction({ store, maxOutputBytes: 256 })],
    }).run({ input: "write" }, { context: {} });
    expect(result.status).toBe("failed");
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.interrupt).toBeUndefined();
  });
});
