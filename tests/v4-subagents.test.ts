import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentError,
  ToolError,
  createAgent,
  createAgentTool,
  createTaskTool,
  createFileCheckpointStore,
  createMemoryCheckpointStore,
  createScriptedModel,
  createTodoTool,
  interrupt,
} from "../src/index.js";
import type { Agent, AgentEvent, CheckpointStore, ChatModel, Tool } from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

const options = { context: {}, checkpointOwner: "owner" };
const work = (execute: Tool["execute"] = async () => ({ ok: true, content: "written" })): Tool => ({
  name: "work",
  description: "write work",
  effect: "write",
  inputSchema: { type: "object" },
  execute,
});
const childTool = (agent: Agent<Record<string, never>>, name = "child") =>
  createAgentTool({ name, description: `${name} task`, agent });
const ask = (name = "child", id = "parent-call") =>
  calling(call(name, { request: "child request" }, id));
const usageCalling = (...calls: Parameters<typeof calling>) => ({
  ...calling(...calls),
  usage: { inputTokens: 10, outputTokens: 2 },
});
afterEach(() => vi.useRealTimers());

describe("V4 AgentTool isolation and nested events", () => {
  it("snapshots child depth configuration instead of observing later caller mutations", async () => {
    const delegation = { maxDepth: 2 };
    const child = createAgent({ model: sequence(answer("child")), delegation });
    delegation.maxDepth = 0;
    const result = await createAgent({
      model: sequence(ask(), answer()),
      tools: [childTool(child)],
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
  });

  it("accepts valid model messages with explicitly undefined optional toolCalls", async () => {
    const response = answer("child");
    response.message.toolCalls = undefined;
    const child = createAgent({ model: sequence(response) });
    const result = await createAgent({
      model: sequence(ask(), answer()),
      tools: [childTool(child)],
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
  });

  it("does not convert middleware errors after a completed child into retryable tool results", async () => {
    const execute = vi.fn(work().execute);
    const child = createAgent({
      model: sequence(calling(call("work")), answer()),
      tools: [work(execute)],
    });
    const result = await createAgent({
      model: sequence(ask()),
      tools: [childTool(child)],
      middlewares: [
        {
          name: "broken-postprocessing",
          async *wrapTool(_call, _ctx, next) {
            for await (const chunk of next()) {
              if (chunk.type === "agent_event" && chunk.event.type === "run_end")
                throw new ToolError("postprocessing_failed", "Child already completed");
              yield chunk;
            }
          },
        },
      ],
    }).run({ input: "go" }, options);
    expect(result.status).toBe("failed");
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps child messages and todos isolated and only returns the final text to the parent model", async () => {
    const events: AgentEvent[] = [];
    const child = createAgent({
      model: createScriptedModel(({ messages }) => {
        expect(messages.some((m) => m.content === "parent private history")).toBe(false);
        return messages.some((m) => m.role === "tool")
          ? answer("child final")
          : calling(
              call("write_todos", {
                todos: [{ id: "child", content: "child-only todo", status: "completed" }],
              }),
            );
      }),
      tools: [createTodoTool()],
    });
    const agent = createAgent({
      model: sequence(ask(), answer("parent final")),
      tools: [childTool(child)],
      hooks: {
        onEvent(event) {
          events.push(event);
        },
      },
    });
    const result = await agent.run({ input: "parent private history" }, options);
    expect(result.status).toBe("completed");
    expect(result.todos).toEqual([]);
    expect(JSON.stringify(result.messages)).not.toContain("child-only todo");
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(JSON.parse(result.messages.find((m) => m.role === "tool")!.content).content).toBe(
      "child final",
    );
    const nested = events.filter((e) => e.type === "agent_event");
    expect(nested.some((e) => e.payload.event.type === "text_delta")).toBe(true);
    expect(
      nested.every((e) => e.runId === result.runId && e.payload.event.runId !== result.runId),
    ).toBe(true);
    expect(nested[0]!.payload.path).toEqual([
      { name: "child", parentRunId: result.runId, toolCallId: "parent-call" },
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("inherits only complete parent conversation while excluding the pending batch and system instructions", async () => {
    const generate = vi.fn<ChatModel["generate"]>(async (request) => {
      expect(request.messages.map((m) => m.content)).toEqual([
        "child system",
        "earlier question",
        "earlier answer",
        "current request",
        "child request",
      ]);
      expect(request.messages.some((m) => m.role === "assistant" && m.toolCalls?.length)).toBe(
        false,
      );
      return answer("inherited");
    });
    const child = createAgent({ model: { generate }, instructions: "child system" });
    const parent = createAgent({
      model: sequence(ask(), answer()),
      instructions: "parent system",
      tools: [
        createAgentTool({
          name: "child",
          description: "inherit",
          agent: child,
          history: "inherit",
        }),
      ],
    });
    const result = await parent.run(
      {
        input: "current request",
        messages: [
          { role: "system", content: "historical parent system" },
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
      },
      options,
    );
    expect(result.status).toBe("completed");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("uses trusted business context in each child and does not share state between concurrent parent runs", async () => {
    const child = createAgent<{ tenant: string }>({
      model: createScriptedModel(({ messages }) => answer(messages[0]!.content)),
      middlewares: [
        {
          name: "tenant",
          beforeAgent(setup, ctx) {
            return { ...setup, instructions: ctx.context.tenant };
          },
        },
      ],
    });
    const parent = createAgent<{ tenant: string }>({
      model: createScriptedModel(({ messages }) => {
        const output = messages.find((m) => m.role === "tool");
        return output ? answer(JSON.parse(output.content).content) : ask();
      }),
      tools: [createAgentTool({ name: "child", description: "tenant child", agent: child })],
    });
    const results = await Promise.all(
      ["a", "b"].map((tenant) => parent.run({ input: "go" }, { context: { tenant } })),
    );
    expect(results.map((r) => r.finalText)).toEqual(["a", "b"]);
  });

  it("flattens grandchild events and aggregates subtree usage exactly once", async () => {
    const leaf = createAgent({ model: sequence(answer("leaf")) });
    const middle = createAgent({
      model: sequence(usageCalling(call("leaf", { request: "go" })), answer("middle")),
      tools: [childTool(leaf, "leaf")],
    });
    const events: AgentEvent[] = [];
    const parent = createAgent({
      model: sequence(usageCalling(call("middle", { request: "go" })), answer("parent")),
      tools: [childTool(middle, "middle")],
      hooks: {
        onEvent(event) {
          events.push(event);
        },
      },
    });
    const result = await parent.run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 10, known: true });
    const nested = events.filter((e) => e.type === "agent_event");
    expect(
      nested.some((e) => e.payload.path.map((step) => step.name).join("/") === "middle/leaf"),
    ).toBe(true);
    expect(nested.every((e) => e.payload.event.type !== ("agent_event" as string))).toBe(true);
  });

  it("scopes a child's direct return to the child so the parent continues", async () => {
    const child = createAgent({
      model: sequence(calling(call("work"))),
      tools: [{ ...work(), returnDirect: true }],
    });
    const result = await createAgent({
      model: sequence(ask(), answer("parent continues")),
      tools: [childTool(child)],
    }).run({ input: "go" }, options);
    expect(result.finalText).toBe("parent continues");
    expect(result.stopReason).toBe("stop");
  });

  it("checks parent and child permissions independently and keeps task selection within the host registry", async () => {
    const execute = vi.fn(work().execute);
    const generate = vi.fn(sequence(calling(call("work")), answer("denied by child")).generate);
    const child = createAgent({
      model: { generate },
      tools: [work(execute)],
      allowTool: () => false,
    });
    const task = createTaskTool({
      agents: [{ name: "child", description: "child", agent: child }],
    });
    const blocked = await createAgent({
      model: sequence(calling(call("task", { agent: "child", request: "go" })), answer()),
      tools: [task],
      allowTool: () => false,
    }).run({ input: "go" }, options);
    expect(blocked.status).toBe("completed");
    expect(generate).not.toHaveBeenCalled();
    const allowed = await createAgent({
      model: sequence(calling(call("task", { agent: "child", request: "go" })), answer()),
      tools: [task],
    }).run({ input: "go" }, options);
    expect(allowed.status).toBe("completed");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    const unknown = await createAgent({
      model: sequence(calling(call("task", { agent: "unknown", request: "go" })), answer()),
      tools: [task],
    }).run({ input: "go" }, options);
    expect(unknown.messages.find((m) => m.role === "tool")!.content).toContain("invalid_arguments");
  });
});

describe("V4 nested interruption and persistent resume", () => {
  it("replaces child continuation references across consecutive interruptions without replaying writes", async () => {
    const store = createMemoryCheckpointStore();
    const writes: string[] = [];
    const child = createAgent({
      model: sequence(calling(call("work", {}, "a"), call("work", {}, "b")), answer("child")),
      tools: [
        work(async (_args, ctx) => {
          writes.push(ctx.toolCallId);
          return { ok: true, content: "written" };
        }),
      ],
      checkpoints: { store, namespace: "repeated-child" },
      hooks: {
        beforeTool(call, ctx) {
          if (!ctx.resume) return interrupt({ id: call.id });
        },
      },
    });
    const agent = createAgent({
      model: sequence(ask(), answer()),
      tools: [childTool(child)],
      checkpoints: { store, namespace: "repeated-parent" },
      delegation: { maxCalls: 1 },
    });
    const first = await agent.run({ input: "go" }, options);
    expect(first.status).toBe("interrupted");
    const second = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(second.status).toBe("interrupted");
    expect(second.interrupt!.checkpointId).not.toBe(first.interrupt!.checkpointId);
    expect(writes).toEqual(["a"]);
    const third = await agent.resume(
      { checkpointId: second.interrupt!.checkpointId, data: true },
      options,
    );
    expect(third.status).toBe("completed");
    expect(writes).toEqual(["a", "b"]);
  });

  /** 无状态模型允许在恢复时重新创建整棵 Agent 树；执行计数来自业务副作用。 */
  function tree(store: CheckpointStore, execute: Tool["execute"], events: AgentEvent[] = []) {
    const leaf = createAgent({
      model: createScriptedModel(({ messages }) =>
        messages.some((m) => m.role === "tool")
          ? answer("leaf done")
          : usageCalling(call("work", {}, "first-write"), call("work", {}, "confirmed-write")),
      ),
      tools: [work(execute)],
      checkpoints: { store, namespace: "leaf-v4" },
      hooks: {
        beforeTool(call, ctx) {
          if (call.id === "confirmed-write" && !ctx.resume) return interrupt("confirm leaf write");
          if (ctx.resume) return ctx.resume.data === true;
        },
      },
    });
    const middle = createAgent({
      model: createScriptedModel(({ messages }) =>
        messages.some((m) => m.role === "tool")
          ? answer("middle done")
          : usageCalling(call("leaf", { request: "go" }, "middle-task")),
      ),
      tools: [childTool(leaf, "leaf")],
      checkpoints: { store, namespace: "middle-v4" },
    });
    return createAgent({
      model: createScriptedModel(({ messages }) =>
        messages.some((m) => m.role === "tool")
          ? answer("root done")
          : usageCalling(call("middle", { request: "go" }, "root-task")),
      ),
      tools: [childTool(middle, "middle")],
      checkpoints: { store, namespace: "root-v4" },
      hooks: {
        onEvent(event) {
          events.push(event);
        },
      },
    });
  }

  it("resumes through three fresh Agent/store instances without replaying completed child writes or usage", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "enio-v4-checkpoints-"));
    const executed: string[] = [];
    const execute: Tool["execute"] = async (_args, ctx) => {
      executed.push(ctx.toolCallId);
      return { ok: true, content: "done" };
    };
    try {
      const firstEvents: AgentEvent[] = [];
      const first = await tree(
        createFileCheckpointStore({ root: directory }),
        execute,
        firstEvents,
      ).run({ input: "go" }, options);
      expect(first.status).toBe("interrupted");
      expect(executed).toEqual(["first-write"]);
      expect(first.usage).toEqual({ inputTokens: 30, outputTokens: 6, known: true });
      const saved = JSON.parse(
        await readFile(path.join(directory, `${first.interrupt!.checkpointId}.json`), "utf8"),
      );
      expect(Object.keys(saved.continuations)).toEqual(["root-task"]);
      expect(saved.delegation.budget.calls).toBe(2);
      const resumedEvents: AgentEvent[] = [];
      const resumed = await tree(
        createFileCheckpointStore({ root: directory }),
        execute,
        resumedEvents,
      ).resume({ checkpointId: first.interrupt!.checkpointId, data: true }, options);
      expect(resumed.status).toBe("completed");
      expect(resumed.runId).toBe(first.runId);
      expect(resumed.usage).toEqual({ inputTokens: 60, outputTokens: 12, known: true });
      expect(executed).toEqual(["first-write", "confirmed-write"]);
      expect(resumedEvents[0]!.seq).toBeGreaterThan(firstEvents.at(-1)!.seq);
      expect(
        resumedEvents.filter(
          (e) => e.type === "agent_event" && e.payload.event.type === "run_resumed",
        ),
      ).toHaveLength(2);
      expect(resumed.messages.filter((m) => m.role === "tool")).toHaveLength(1);
      const again = await tree(createFileCheckpointStore({ root: directory }), execute).resume(
        { checkpointId: first.interrupt!.checkpointId, data: true },
        options,
      );
      expect(again.stopReason).toBe("checkpoint_unavailable");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("denies a resumed child action and rejects a different checkpoint owner before taking the parent", async () => {
    const store = createMemoryCheckpointStore();
    const execute = vi.fn(work().execute);
    const first = await tree(store, execute).run({ input: "go" }, options);
    const wrong = await tree(store, execute).resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      { ...options, checkpointOwner: "other" },
    );
    expect(wrong.stopReason).toBe("checkpoint_mismatch");
    const declined = await tree(store, execute).resume(
      { checkpointId: first.interrupt!.checkpointId, data: false },
      options,
    );
    expect(declined.status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not restart a child when its checkpoint has disappeared", async () => {
    const parentStore = createMemoryCheckpointStore();
    const execute = vi.fn(work().execute);
    const build = (store: CheckpointStore) => {
      const child = createAgent({
        model: sequence(calling(call("work"))),
        tools: [work(execute)],
        checkpoints: { store, namespace: "child" },
        hooks: {
          beforeTool() {
            return interrupt("pause");
          },
        },
      });
      return createAgent({
        model: sequence(ask()),
        tools: [childTool(child)],
        checkpoints: { store: parentStore, namespace: "parent" },
      });
    };
    const first = await build(createMemoryCheckpointStore()).run({ input: "go" }, options);
    expect(first.status).toBe("interrupted");
    const resumed = await build(createMemoryCheckpointStore()).resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(resumed.status).toBe("failed");
    expect(resumed.stopReason).toBe("checkpoint_unavailable");
    expect(resumed.interrupt).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("V4 cancellation, protocol and tree bounds", () => {
  it("propagates consumer cancellation to a running child model and closes its stream", async () => {
    let signal: AbortSignal | undefined;
    let closed = false;
    const child = createAgent({
      model: {
        async generate() {
          return answer();
        },
        async *stream(_request, current) {
          signal = current;
          try {
            yield { type: "text_delta", text: "child working" };
            await new Promise(() => {});
          } finally {
            closed = true;
          }
        },
      },
    });
    for await (const event of createAgent({
      model: sequence(ask()),
      tools: [childTool(child)],
    }).stream({ input: "go" }, options)) {
      if (event.type === "agent_event" && event.payload.event.type === "text_delta") break;
    }
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(signal?.aborted).toBe(true);
  });

  it("times out an uncooperative child without producing a resumable checkpoint", async () => {
    vi.useFakeTimers();
    const child = createAgent({ model: { generate: () => new Promise(() => {}) } });
    const running = createAgent({
      model: sequence(ask()),
      tools: [childTool(child)],
      limits: { toolTimeoutMs: 10 },
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "parent" },
    }).run({ input: "go" }, options);
    await vi.runAllTimersAsync();
    const result = await running;
    expect(result.stopReason).toBe("tool_timeout");
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(result.interrupt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates parent execution on child failure rather than retrying its side effects", async () => {
    const execute = vi.fn(async () => {
      throw new AgentError("business_crash", "failed", true);
    });
    const child = createAgent({ model: sequence(calling(call("work"))), tools: [work(execute)] });
    const result = await createAgent({ model: sequence(ask()), tools: [childTool(child)] }).run(
      { input: "go" },
      options,
    );
    expect(result.stopReason).toBe("business_crash");
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(result.usage.known).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("caps recursive delegation before starting a third child", async () => {
    let child: Agent<Record<string, never>>;
    const proxy: Agent<Record<string, never>> = {
      run: (input, opts) => child.run(input, opts),
      stream: (input, opts) => child.stream(input, opts),
      resume: (input, opts) => child.resume(input, opts),
      resumeStream: (input, opts) => child.resumeStream(input, opts),
    };
    const model = createScriptedModel(({ messages }) =>
      messages.some((m) => m.role === "tool") ? answer("bounded") : ask(),
    );
    child = createAgent({ model, tools: [childTool(proxy)] });
    const events: AgentEvent[] = [];
    const result = await createAgent({
      model,
      tools: [childTool(proxy)],
      delegation: { maxDepth: 2 },
      hooks: {
        onEvent(e) {
          events.push(e);
        },
      },
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    expect(
      events.filter((e) => e.type === "agent_event" && e.payload.event.type === "run_start"),
    ).toHaveLength(2);
    expect(JSON.stringify(events)).toContain("agent_depth_exceeded");
  });

  it("shares a call budget across siblings and does not reset it after a checkpoint", async () => {
    const store = createMemoryCheckpointStore();
    const generate = vi.fn(async () => answer("child"));
    const child = createAgent({ model: { generate } });
    const agent = createAgent({
      model: sequence(
        calling(call("child", { request: "a" }, "a"), call("child", { request: "b" }, "b")),
        answer(),
      ),
      tools: [childTool(child)],
      delegation: { maxCalls: 1 },
      checkpoints: { store, namespace: "budget" },
      hooks: {
        beforeTool(call, ctx) {
          if (call.id === "b" && !ctx.resume) return interrupt("continue");
        },
      },
    });
    const first = await agent.run({ input: "go" }, options);
    expect(first.status).toBe("interrupted");
    const result = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(result.status).toBe("completed");
    expect(
      result.messages.find((m) => m.role === "tool" && m.toolCallId === "b")!.content,
    ).toContain("agent_calls_exceeded");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("bounds nested event output and rejects missing terminal events", async () => {
    const child = createAgent({ model: createScriptedModel(() => answer("some text")) });
    const bounded = await createAgent({
      model: sequence(ask()),
      tools: [childTool(child)],
      limits: { maxToolStreamBytes: 1 },
    }).run({ input: "go" }, options);
    expect(bounded.stopReason).toBe("limit_exceeded");
    const invalid: Agent<Record<string, never>> = { ...child, async *stream() {} };
    const result = await createAgent({ model: sequence(ask()), tools: [childTool(invalid)] }).run(
      { input: "go" },
      options,
    );
    expect(result.stopReason).toBe("incomplete_agent_run");
  });

  it("rejects invalid delegation configuration and concurrent AgentTool declarations", () => {
    const child = createAgent({ model: sequence(answer()) });
    expect(() =>
      createAgent({ model: sequence(answer()), delegation: { maxDepth: -1 } }),
    ).toThrow();
    expect(() =>
      createAgent({
        model: sequence(answer()),
        tools: [{ ...childTool(child), effect: "read", parallelSafe: true }],
      }),
    ).toThrow();
    expect(() => createTaskTool({ agents: [] })).toThrow();
    expect(() =>
      createTaskTool({
        agents: [
          { name: "a", description: "a", agent: child },
          { name: "a", description: "b", agent: child },
        ],
      }),
    ).toThrow();
  });
});
