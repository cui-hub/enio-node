import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentError,
  ModelError,
  ToolError,
  createAgent,
  createScriptedModel,
  createTodoTool,
  defineTool,
} from "../src/index.js";
import type { AgentEvent, ChatModel, Message, Tool } from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

/** 空参数工具用于观察执行次数与顺序，不把实现中的分支原样复制为测试。 */
const emptyTool = (
  execute: Tool["execute"] = vi.fn(async () => ({ ok: true as const, content: "ok" })),
): Tool =>
  defineTool({
    name: "work",
    description: "test work",
    effect: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute,
  });
afterEach(() => vi.useRealTimers());

describe("single Agent loop", () => {
  it("A01: runs multiple rounds and serial tools, preserving caller input", async () => {
    const order: string[] = [];
    const work = emptyTool(
      vi.fn<Tool["execute"]>(async (_args, ctx) => {
        order.push(ctx.toolCallId);
        return { ok: true, content: ctx.toolCallId };
      }),
    );
    const original: Message[] = [
      { role: "user", content: "previous" },
      { role: "assistant", content: "reply" },
    ];
    const before = structuredClone(original);
    const agent = createAgent({
      model: sequence(
        calling(call("work", {}, "a"), call("work", {}, "b")),
        calling(call("work", {}, "c")),
        answer("finished"),
      ),
      tools: [work],
    });
    const result = await agent.run({ input: "start", messages: original }, { context: {} });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("finished");
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(3);
    expect(order).toEqual(["a", "b", "c"]);
    expect(
      result.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(order);
    expect(original).toEqual(before);
    expect(result.historyComplete).toBe(true);
  });

  it("A01: run and stream use the same engine and ordered isolated event snapshots", async () => {
    const model = createScriptedModel(() => answer("你好"));
    const agent = createAgent({
      model,
      hooks: {
        onEvent(event) {
          if (event.type === "text_delta") event.payload.text = "mutated";
        },
      },
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.stream({ input: "hello" }, { context: {} })) events.push(event);
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.payload.text)
        .join(""),
    ).toBe("你好");
    const final = events.at(-1)!;
    expect(final.type === "run_end" && final.payload.result.finalText).toBe(
      (await agent.run({ input: "hello" }, { context: {} })).finalText,
    );
  });

  it.each([
    ["unknown_tool", call("absent")],
    ["invalid_json", { ...call("work"), arguments: "{" }],
    ["invalid_arguments", call("work", { extra: true })],
  ])("A02: %s is fed back without running invalid calls", async (code, invalidCall) => {
    const work = emptyTool();
    const result = await createAgent({
      model: sequence(calling(invalidCall), calling(call("work", {}, "fixed")), answer()),
      tools: [work],
    }).run({ input: "repair" }, { context: {} });
    expect(result.status).toBe("completed");
    const message = result.messages.find((message) => message.role === "tool")!;
    expect(JSON.parse(message.content).code).toBe(code);
    expect(work.execute).toHaveBeenCalledTimes(1);
  });

  it("A02: validates runtime schema without coercing a numeric string", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: "ok" }));
    const tool = defineTool({
      ...emptyTool(execute),
      inputSchema: {
        type: "object",
        properties: { amount: { type: "integer" } },
        required: ["amount"],
        additionalProperties: false,
      },
    });
    const result = await createAgent({
      model: sequence(calling(call("work", { amount: "1" })), answer()),
      tools: [tool],
    }).run({ input: "go" }, { context: {} });
    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("A03: rejects the whole batch when the tool budget is insufficient", async () => {
    const work = emptyTool();
    const result = await createAgent({
      model: sequence(calling(call("work", {}, "a"), call("work", {}, "b"))),
      tools: [work],
      limits: { maxToolCalls: 1 },
    }).run({ input: "go" }, { context: {} });
    expect(result.stopReason).toBe("limit_exceeded");
    expect(work.execute).not.toHaveBeenCalled();
  });

  it("A03: counts logical iterations and terminates a never-ending tool loop", async () => {
    const model = createScriptedModel(({ messages }) =>
      calling(call("work", {}, `call-${messages.length}`)),
    );
    const work = emptyTool();
    const result = await createAgent({ model, tools: [work], limits: { maxIterations: 2 } }).run(
      { input: "loop" },
      { context: {} },
    );
    expect(result.stopReason).toBe("limit_exceeded");
    expect(result.iterations).toBe(2);
    expect(work.execute).toHaveBeenCalledTimes(2);
    expect(result.historyComplete).toBe(true);
  });

  it("A03: rejects oversized input before model I/O and oversized arguments before tools", async () => {
    const generate = vi.fn(async () => answer());
    const inputLimited = await createAgent({
      model: { generate },
      limits: { maxInputBytes: 10 },
    }).run({ input: "large input" }, { context: {} });
    expect(inputLimited.stopReason).toBe("limit_exceeded");
    expect(generate).not.toHaveBeenCalled();
    const work = emptyTool();
    const argsLimited = await createAgent({
      model: sequence(calling(call("work", { long: "123456" }))),
      tools: [work],
      limits: { maxToolArgumentBytes: 5 },
    }).run({ input: "go" }, { context: {} });
    expect(argsLimited.stopReason).toBe("limit_exceeded");
    expect(work.execute).not.toHaveBeenCalled();
  });

  it("treats an unclassified write failure as fatal without leaking exception details", async () => {
    const work: Tool = {
      ...emptyTool(),
      effect: "write",
      async execute() {
        throw new Error("private-token-value");
      },
    };
    const result = await createAgent({ model: sequence(calling(call("work"))), tools: [work] }).run(
      { input: "go" },
      { context: {} },
    );
    expect(result.stopReason).toBe("internal_error");
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-token-value");
  });

  it("consumer event mutations cannot rewrite tool arguments", async () => {
    const work = emptyTool();
    const agent = createAgent({ model: sequence(calling(call("work")), answer()), tools: [work] });
    for await (const event of agent.stream({ input: "go" }, { context: {} })) {
      if (event.type === "tool_call_ready") event.payload.call.arguments = '{"injected":true}';
    }
    expect(work.execute).toHaveBeenCalledWith({}, expect.anything());
  });

  it("A04: duplicate ids and incomplete finish reasons never execute tools", async () => {
    for (const response of [
      calling(call("work"), call("work")),
      { ...calling(call("work")), finishReason: "length" as const },
    ]) {
      const work = emptyTool();
      const result = await createAgent({ model: sequence(response), tools: [work] }).run(
        { input: "go" },
        { context: {} },
      );
      expect(result.status).toBe("failed");
      expect(work.execute).not.toHaveBeenCalled();
    }
  });

  it("A05: pre-cancelled runs do not invoke the model", async () => {
    const generate = vi.fn(async () => answer());
    const result = await createAgent({ model: { generate } }).run(
      { input: "go" },
      { context: {}, signal: AbortSignal.abort() },
    );
    expect(result.status).toBe("cancelled");
    expect(generate).not.toHaveBeenCalled();
  });

  it("A05: cancelling a pending write marks unknown effects and incomplete history", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const work: Tool = {
      ...emptyTool(),
      effect: "write",
      async execute(_args, ctx) {
        observedSignal = ctx.signal;
        controller.abort();
        return new Promise(() => {});
      },
    };
    const result = await createAgent({
      model: sequence(calling(call("work", {}, "a"), call("work", {}, "b"))),
      tools: [work],
    }).run({ input: "go" }, { context: {}, signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect(result.pendingToolCallIds).toEqual(["a", "b"]);
    expect(result.historyComplete).toBe(false);
    const reused = await createAgent({ model: sequence(answer()) }).run(
      { input: "continue", messages: result.messages },
      { context: {} },
    );
    expect(reused.stopReason).toBe("invalid_input");
  });

  it("A05: times out an uncooperative tool and ignores its late result", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => new Promise<{ ok: true; content: string }>(() => {}));
    const running = createAgent({
      model: sequence(calling(call("work"))),
      tools: [{ ...emptyTool(execute), effect: "write" }],
      limits: { toolTimeoutMs: 10 },
    }).run({ input: "go" }, { context: {} });
    await vi.runAllTimersAsync();
    const result = await running;
    expect(result.stopReason).toBe("tool_timeout");
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("A06: retries only retryable model errors before visible output", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new ModelError("network", "retry", true))
      .mockResolvedValue(answer());
    const events: AgentEvent[] = [];
    const result = await createAgent({
      model: { generate },
      limits: { retryDelayMs: 0 },
      hooks: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    }).run({ input: "go" }, { context: {} });
    expect(result.status).toBe("completed");
    expect(result.iterations).toBe(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "model_retry")).toHaveLength(1);
    const permanent = vi.fn().mockRejectedValue(new ModelError("auth", "denied", false));
    expect(
      (await createAgent({ model: { generate: permanent } }).run({ input: "go" }, { context: {} }))
        .stopReason,
    ).toBe("auth");
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it("A06: never restarts a model stream after visible text", async () => {
    let attempts = 0;
    const model: ChatModel = {
      async generate() {
        return answer();
      },
      async *stream() {
        attempts++;
        yield { type: "text_delta", text: "partial" };
        throw new ModelError("network", "broken", true);
      },
    };
    const result = await createAgent({ model }).run({ input: "go" }, { context: {} });
    expect(result.status).toBe("failed");
    expect(result.finalText).toBe("");
    expect(attempts).toBe(1);
    expect(result.usage.known).toBe(false);
  });

  it("A05: model deadlines cancel the request and release all timers", async () => {
    vi.useFakeTimers();
    let modelSignal: AbortSignal | undefined;
    const model: ChatModel = {
      generate(_request, signal) {
        modelSignal = signal;
        return new Promise(() => {});
      },
    };
    const running = createAgent({ model, limits: { modelTimeoutMs: 10 } }).run(
      { input: "go" },
      { context: {} },
    );
    await vi.runAllTimersAsync();
    expect((await running).stopReason).toBe("model_timeout");
    expect(modelSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses conversation history without accumulating fixed system instructions", async () => {
    const generate = vi.fn<ChatModel["generate"]>(async (request) => {
      expect(request.messages.filter((message) => message.role === "system")).toHaveLength(1);
      return answer();
    });
    const agent = createAgent({ model: { generate }, instructions: "fixed" });
    const first = await agent.run({ input: "one" }, { context: {} });
    const second = await agent.run({ input: "two", messages: first.messages }, { context: {} });
    expect(second.status).toBe("completed");
    expect(second.messages.filter((message) => message.role === "system")).toHaveLength(0);
  });

  it("A07: concurrent runs isolate todo state and histories", async () => {
    const model = createScriptedModel(({ messages }) =>
      messages.some((message) => message.role === "tool")
        ? answer()
        : calling(
            call("write_todos", {
              todos: [{ id: "1", content: messages.at(-1)!.content, status: "pending" }],
            }),
          ),
    );
    const agent = createAgent({ model, tools: [createTodoTool()] });
    const [a, b] = await Promise.all([
      agent.run({ input: "alpha" }, { context: {} }),
      agent.run({ input: "beta" }, { context: {} }),
    ]);
    expect(a.todos[0]?.content).toBe("alpha");
    expect(b.todos[0]?.content).toBe("beta");
    expect(a.runId).not.toBe(b.runId);
  });

  it("A10: output truncation preserves UTF-8 and a valid result envelope", async () => {
    const work = emptyTool(
      vi.fn(async () => ({ ok: true as const, content: '中文\\"'.repeat(5000) })),
    );
    const result = await createAgent({
      model: sequence(calling(call("work")), answer()),
      tools: [work],
      limits: { maxToolResultBytes: 256 },
    }).run({ input: "go" }, { context: {} });
    const content = result.messages.find((message) => message.role === "tool")!.content;
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(256);
    expect(JSON.parse(content)).toMatchObject({ ok: true, truncated: true });
    expect(content).not.toContain("�");
  });

  it("A12: breaking consumption cancels and closes the model iterator", async () => {
    let closed = false;
    let signal: AbortSignal | undefined;
    const model: ChatModel = {
      async generate() {
        return answer();
      },
      async *stream(_request, inputSignal) {
        signal = inputSignal;
        try {
          yield { type: "text_delta", text: "hello" };
          yield { type: "response", response: answer("hello") };
        } finally {
          closed = true;
        }
      },
    };
    for await (const event of createAgent({ model }).stream({ input: "go" }, { context: {} }))
      if (event.type === "text_delta") break;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(true);
  });

  it("A12: observer failures are isolated and counted", async () => {
    const result = await createAgent({
      model: sequence(answer()),
      hooks: {
        onEvent() {
          throw new Error("observer");
        },
      },
    }).run({ input: "go" }, { context: {} });
    expect(result.status).toBe("completed");
    expect(result.observerErrors).toBeGreaterThan(0);
  });

  it("denies tools before execution and returns classified business errors", async () => {
    const work = emptyTool();
    const result = await createAgent({
      model: sequence(calling(call("work")), answer()),
      tools: [work],
      allowTool: () => false,
    }).run({ input: "go" }, { context: {} });
    expect(
      JSON.parse(result.messages.find((message) => message.role === "tool")!.content).code,
    ).toBe("permission_denied");
    expect(work.execute).not.toHaveBeenCalled();
    const failing: Tool = {
      ...work,
      async execute() {
        throw new ToolError("out_of_stock", "No stock");
      },
    };
    const business = await createAgent({
      model: sequence(calling(call("work")), answer()),
      tools: [failing],
    }).run({ input: "go" }, { context: {} });
    expect(business.status).toBe("completed");
  });

  it("rejects duplicate registrations, unsupported schema and invalid budgets", () => {
    expect(() =>
      createAgent({ model: sequence(answer()), tools: [emptyTool(), emptyTool()] }),
    ).toThrow(AgentError);
    expect(() =>
      createAgent({
        model: sequence(answer()),
        tools: [{ ...emptyTool(), inputSchema: { type: "object", $ref: "https://example.com" } }],
      }),
    ).toThrow(AgentError);
    expect(() =>
      createAgent({ model: sequence(answer()), limits: { maxIterations: NaN } }),
    ).toThrow(AgentError);
  });
});
