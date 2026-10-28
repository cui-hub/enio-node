import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgent,
  createMemoryCheckpointStore,
  exportState,
  interrupt,
  ToolError,
} from "../src/index.js";
import type { AgentEvent, Tool, ToolChunk } from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

/** 测试工具使用真实异步边界，验证调度和对外结果，不依赖内部任务队列。 */
function makeTool(name = "work", overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    effect: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { ok: true, content: name };
    },
    ...overrides,
  };
}
const options = { context: {}, checkpointOwner: "user:conversation" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => vi.useRealTimers());

describe("V3 tool streaming", () => {
  it("emits progress before the final result without running execute twice or storing progress in history", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: "wrong path" }));
    const events: AgentEvent[] = [];
    const agent = createAgent({
      model: sequence(calling(call("work")), answer()),
      tools: [
        makeTool("work", {
          execute,
          async *stream() {
            yield { type: "text_delta", text: "working", channel: "stdout" };
            yield { type: "result", result: { ok: true, content: "final data" } };
          },
        }),
      ],
    });
    for await (const event of agent.stream({ input: "go" }, options)) events.push(event);
    expect(execute).not.toHaveBeenCalled();
    expect(events.findIndex((event) => event.type === "tool_output")).toBeLessThan(
      events.findIndex((event) => event.type === "tool_end"),
    );
    const end = events.at(-1)!;
    expect(end.type).toBe("run_end");
    if (end.type !== "run_end") throw new Error("missing result");
    expect(end.payload.result.status).toBe("completed");
    expect(JSON.stringify(end.payload.result.messages)).not.toContain("working");
    expect(JSON.stringify(end.payload.result.messages)).toContain("final data");
  });

  it.each([
    [null as unknown as ToolChunk], // JavaScript 扩展也必须得到稳定的流协议错误。
    [{ type: "text_delta", text: "progress" }],
    [
      { type: "result", result: { ok: true, content: "done" } },
      { type: "text_delta", text: "late" },
    ],
    [
      { type: "result", result: { ok: true, content: "done" } },
      { type: "result", result: { ok: true, content: "again" } },
    ],
  ] as ToolChunk[][])("rejects incomplete or malformed stream %#", async (...chunks) => {
    const result = await createAgent({
      model: sequence(calling(call("work"))),
      tools: [
        makeTool("work", {
          async *stream() {
            for (const chunk of chunks) yield chunk;
          },
        }),
      ],
    }).run({ input: "go" }, options);
    expect(result.stopReason).toBe("invalid_tool_stream");
    expect(result.historyComplete).toBe(false);
  });

  it("feeds a classified streaming business error back to the model", async () => {
    const result = await createAgent({
      model: sequence(calling(call("work")), answer("recovered")),
      tools: [
        makeTool("work", {
          async *stream() {
            yield { type: "text_delta", text: "checking" };
            throw new ToolError("not_found", "missing");
          },
        }),
      ],
    }).run({ input: "go" }, options);
    expect(result.finalText).toBe("recovered");
    expect(
      JSON.parse(result.messages.find((message) => message.role === "tool")!.content).code,
    ).toBe("not_found");
  });

  it("bounds progress independently of the final result budget", async () => {
    const result = await createAgent({
      model: sequence(calling(call("work"))),
      limits: { maxToolStreamBytes: 4 },
      tools: [
        makeTool("work", {
          effect: "write",
          async *stream() {
            yield { type: "text_delta", text: "中文" };
            yield { type: "result", result: { ok: true, content: "ok" } };
          },
        }),
      ],
    }).run({ input: "go" }, options);
    expect(result.stopReason).toBe("limit_exceeded");
    expect(result.error?.outcomeUnknown).toBe(true);
  });

  it("stops pulling and closes the tool when the consumer breaks", async () => {
    let produced = 0;
    let closed = false;
    let signal: AbortSignal | undefined;
    const work = makeTool("work", {
      async *stream(_args, ctx) {
        signal = ctx.signal;
        try {
          produced++;
          yield { type: "text_delta", text: "one" };
          produced++;
          yield { type: "text_delta", text: "two" };
          yield { type: "result", result: { ok: true, content: "done" } };
        } finally {
          closed = true;
        }
      },
    });
    for await (const event of createAgent({
      model: sequence(calling(call("work"))),
      tools: [work],
    }).stream({ input: "go" }, options)) {
      if (event.type === "tool_output") break;
    }
    await tick();
    expect(produced).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(true);
  });

  it("times out an uncooperative tool stream and marks write effects unknown", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const running = createAgent({
      model: sequence(calling(call("work"))),
      limits: { toolTimeoutMs: 10 },
      tools: [
        makeTool("work", {
          effect: "write",
          async *stream(_args, ctx) {
            signal = ctx.signal;
            await new Promise(() => {});
            yield { type: "result", result: { ok: true, content: "late" } };
          },
        }),
      ],
    }).run({ input: "go" }, options);
    await vi.runAllTimersAsync();
    const result = await running;
    expect(result.stopReason).toBe("tool_timeout");
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("V3 controlled concurrency and checkpoints", () => {
  it("runs at most two opted-in reads concurrently and treats writes as barriers", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const work = (name: string, write = false) =>
      makeTool(name, {
        effect: write ? "write" : "read",
        parallelSafe: !write,
        async execute() {
          if (write) expect(active).toBe(0);
          order.push(`start:${name}`);
          peak = Math.max(peak, ++active);
          await tick();
          active--;
          order.push(`end:${name}`);
          return { ok: true, content: name };
        },
      });
    const names = ["a", "b", "c", "write", "d", "e"];
    const result = await createAgent({
      model: sequence(calling(...names.map((name) => call(name, {}, name))), answer()),
      tools: names.map((name) => work(name, name === "write")),
      toolExecution: { maxConcurrency: 2 },
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    expect(peak).toBe(2);
    expect(order.indexOf("start:write")).toBeGreaterThan(order.indexOf("end:c"));
    expect(order.indexOf("start:d")).toBeGreaterThan(order.indexOf("end:write"));
    expect(result.historyComplete).toBe(true);
  });

  it("keeps ordinary read tools serial even when concurrency is enabled", async () => {
    let active = 0;
    const work = makeTool("work", {
      async execute() {
        expect(active++).toBe(0);
        await tick();
        active--;
        return { ok: true, content: "ok" };
      },
    });
    const result = await createAgent({
      model: sequence(calling(call("work", {}, "a"), call("work", {}, "b")), answer()),
      tools: [work],
      toolExecution: { maxConcurrency: 4 },
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
  });

  it("checkpoints only interrupted calls after other parallel reads finish, and never replays completed reads", async () => {
    const executed: string[] = [];
    const work = makeTool("work", {
      parallelSafe: true,
      async execute(_args, ctx) {
        executed.push(ctx.toolCallId);
        await tick();
        return { ok: true, content: ctx.toolCallId };
      },
    });
    const agent = createAgent({
      model: sequence(
        calling(call("work", {}, "a"), call("work", {}, "b"), call("work", {}, "c")),
        answer(),
      ),
      tools: [work],
      toolExecution: { maxConcurrency: 3 },
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "parallel" },
      hooks: {
        beforeTool(call, ctx) {
          if (call.id !== "b" && !ctx.resume) return interrupt({ id: call.id });
        },
      },
    });
    const first = await agent.run({ input: "go" }, options);
    expect(first.status).toBe("interrupted");
    expect(first.pendingToolCallIds).toEqual(["a", "c"]);
    expect(executed).toEqual(["b"]);
    const second = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(second.status).toBe("interrupted");
    expect(second.pendingToolCallIds).toEqual(["c"]);
    const third = await agent.resume(
      { checkpointId: second.interrupt!.checkpointId, data: true },
      options,
    );
    expect(third.status).toBe("completed");
    expect(executed).toEqual(["b", "a", "c"]);
    expect(third.toolCalls).toBe(3);
    expect(third.historyComplete).toBe(true);
  });

  it("cancels other in-flight reads after fatal failure and never starts the next write", async () => {
    let peerSignal: AbortSignal | undefined;
    const write = vi.fn(async () => ({ ok: true as const, content: "write" }));
    const agent = createAgent({
      model: sequence(
        calling(call("fail", {}, "a"), call("wait", {}, "b"), call("write", {}, "c")),
      ),
      tools: [
        makeTool("fail", {
          parallelSafe: true,
          async execute() {
            await tick();
            throw new Error("broken");
          },
        }),
        makeTool("wait", {
          parallelSafe: true,
          async execute(_args, ctx) {
            peerSignal = ctx.signal;
            return new Promise(() => {});
          },
        }),
        makeTool("write", { effect: "write", execute: write }),
      ],
      toolExecution: { maxConcurrency: 2 },
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "failure" },
    });
    const result = await agent.run({ input: "go" }, options);
    expect(result.status).toBe("failed");
    expect(peerSignal?.aborted).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(result.interrupt).toBeUndefined();
  });

  it("isolates run state from parallel tools and rejects invalid concurrency declarations", async () => {
    expect(() =>
      createAgent({
        model: sequence(answer()),
        tools: [makeTool("bad", { effect: "write", parallelSafe: true })],
      }),
    ).toThrow();
    expect(() =>
      createAgent({ model: sequence(answer()), toolExecution: { maxConcurrency: 0 } }),
    ).toThrow();
    const work = makeTool("work", {
      parallelSafe: true,
      async execute(_args, ctx) {
        ctx.state.todos.push({ id: "bad", content: "shared write", status: "pending" });
        return { ok: true, content: "bad" };
      },
    });
    const result = await createAgent({
      model: sequence(calling(call("work", {}, "a"), call("work", {}, "b"))),
      tools: [work],
      toolExecution: { maxConcurrency: 2 },
    }).run({ input: "go" }, options);
    expect(result.stopReason).toBe("internal_error");
    expect(result.todos).toEqual([]);
  });
});

describe("V3 direct tool results", () => {
  it("finishes the whole batch and returns without another model call; subsequent conversations still call the model", async () => {
    const generate = vi.fn(
      sequence(calling(call("work", {}, "a"), call("other", {}, "b")), answer("next conversation"))
        .generate,
    );
    const other = vi.fn(async () => ({ ok: true as const, content: "other done" }));
    const afterAgent = vi.fn();
    const agent = createAgent({
      model: { generate },
      tools: [makeTool("work", { returnDirect: true }), makeTool("other", { execute: other })],
      hooks: { afterAgent },
    });
    const result = await agent.run({ input: "go" }, options);
    expect(result.finalText).toBe("work");
    expect(result.stopReason).toBe("return_direct");
    expect(result.historyComplete).toBe(true);
    expect(other).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(afterAgent).toHaveBeenCalledOnce();
    const next = await agent.run({ input: "again", state: exportState(result) }, options);
    expect(next.finalText).toBe("next conversation");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("sends failed direct-tool results back to the model", async () => {
    const result = await createAgent({
      model: sequence(calling(call("work")), answer("explained failure")),
      tools: [
        makeTool("work", {
          returnDirect: true,
          async execute() {
            throw new ToolError("missing", "missing");
          },
        }),
      ],
    }).run({ input: "go" }, options);
    expect(result.finalText).toBe("explained failure");
    expect(result.stopReason).toBe("stop");
  });

  it("rejects multiple direct tools before executing any operation", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: "ok" }));
    const result = await createAgent({
      model: sequence(calling(call("work", {}, "a"), call("work", {}, "b"))),
      tools: [makeTool("work", { returnDirect: true, execute })],
    }).run({ input: "go" }, options);
    expect(result.stopReason).toBe("protocol_error");
    expect(execute).not.toHaveBeenCalled();
  });

  it("retains a completed direct result across a later tool interruption", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: "direct" }));
    const agent = createAgent({
      model: sequence(calling(call("work", {}, "a"), call("other", {}, "b"))),
      tools: [makeTool("work", { returnDirect: true, execute }), makeTool("other")],
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "direct" },
      hooks: {
        beforeTool(call, ctx) {
          if (call.name === "other" && !ctx.resume) return interrupt("confirm");
        },
      },
    });
    const first = await agent.run({ input: "go" }, options);
    expect(first.status).toBe("interrupted");
    const second = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(second.stopReason).toBe("return_direct");
    expect(second.finalText).toBe("direct");
    expect(execute).toHaveBeenCalledOnce();
  });
});
