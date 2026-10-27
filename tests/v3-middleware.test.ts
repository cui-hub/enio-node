import { describe, expect, it, vi } from "vitest";
import {
  createAgent,
  createMemoryCheckpointStore,
  createScriptedModel,
  defineTool,
  interrupt,
  ToolError,
} from "../src/index.js";
import type { AgentMiddleware, ChatModel, Tool } from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

/** 通过可观察的请求、事件和业务执行次数验证包装顺序，不依赖内部函数布局。 */
const tool = (execute: Tool["execute"] = async () => ({ ok: true, content: "data" })): Tool =>
  defineTool({
    name: "lookup",
    description: "look up data",
    effect: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute,
  });
const options = { context: {} };

describe("V3 middleware", () => {
  it("preserves the interrupted request's tool visibility during resume", async () => {
    const hidden = vi.fn(async () => ({ ok: true as const, content: "secret" }));
    const agent = createAgent({
      model: sequence(calling(call("lookup"), call("hidden", {}, "hidden-call")), answer()),
      tools: [tool(), { ...tool(hidden), name: "hidden" }],
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "visibility" },
      middlewares: [
        {
          name: "filter",
          beforeModel(request) {
            return { ...request, tools: request.tools.filter((entry) => entry.name === "lookup") };
          },
        },
      ],
      hooks: {
        beforeTool(call, ctx) {
          if (call.name === "lookup" && !ctx.resume) return interrupt("confirm lookup");
        },
      },
    });
    const runOptions = { context: {}, checkpointOwner: "owner" };
    const first = await agent.run({ input: "go" }, runOptions);
    expect(first.status).toBe("interrupted");
    const resumed = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      runOptions,
    );
    expect(resumed.status).toBe("completed");
    expect(hidden).not.toHaveBeenCalled();
    const rejected = resumed.messages.find(
      (entry) => entry.role === "tool" && entry.toolCallId === "hidden-call",
    )!;
    expect(JSON.parse(rejected.content).code).toBe("tool_not_available");
  });

  it("composes wrappers outermost-first and lifecycle hooks in registration order", async () => {
    const order: string[] = [];
    const middleware = (name: string): AgentMiddleware => ({
      name,
      beforeAgent() {
        order.push(`${name}:beforeAgent`);
      },
      beforeModel() {
        order.push(`${name}:beforeModel`);
      },
      async *wrapModel(request, _ctx, next) {
        order.push(`${name}:enter`);
        yield* next(request);
        order.push(`${name}:leave`);
      },
      afterModel() {
        order.push(`${name}:afterModel`);
      },
      afterAgent() {
        order.push(`${name}:afterAgent`);
      },
    });
    const result = await createAgent({
      model: {
        async generate() {
          order.push("model");
          return answer();
        },
      },
      middlewares: [middleware("A"), middleware("B")],
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    expect(order).toEqual([
      "A:beforeAgent",
      "B:beforeAgent",
      "A:beforeModel",
      "B:beforeModel",
      "A:enter",
      "B:enter",
      "model",
      "B:leave",
      "A:leave",
      "A:afterModel",
      "B:afterModel",
      "A:afterAgent",
      "B:afterAgent",
    ]);
  });

  it("assembles tools and instructions per run without polluting concurrent runs or history", async () => {
    const generate: ChatModel["generate"] = async (request) => {
      expect(request.tools.map((entry) => entry.name)).toEqual(["lookup"]);
      const user = request.messages.find((message) => message.role === "user")!.content;
      expect(request.messages[0]!.content).toBe(`tenant:${user}`);
      return request.messages.some((message) => message.role === "tool")
        ? answer(user)
        : calling(call("lookup"));
    };
    const agent = createAgent<{ tenant: string }>({
      model: { generate },
      tools: [],
      middlewares: [
        {
          name: "tenant",
          beforeAgent(setup, ctx) {
            return {
              instructions: `tenant:${ctx.context.tenant}`,
              tools: [...setup.tools, tool()],
            };
          },
        },
      ],
    });
    const [a, b] = await Promise.all([
      agent.run({ input: "a" }, { context: { tenant: "a" } }),
      agent.run({ input: "b" }, { context: { tenant: "b" } }),
    ]);
    expect([a.finalText, b.finalText]).toEqual(["a", "b"]);
    expect(a.messages.some((message) => message.role === "system")).toBe(false);
  });

  it("filters model-visible tools and blocks hidden tools before business execution", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: "private" }));
    const result = await createAgent({
      model: sequence(calling(call("lookup")), answer()),
      tools: [tool(execute)],
      middlewares: [
        {
          name: "filter",
          beforeModel(request) {
            return { ...request, tools: [] };
          },
        },
      ],
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    expect(
      JSON.parse(result.messages.find((message) => message.role === "tool")!.content).code,
    ).toBe("tool_not_available");
  });

  it("validates requests changed inside wrapModel against schema and byte budgets", async () => {
    const generate = vi.fn(async () => answer());
    const result = await createAgent({
      model: { generate },
      limits: { maxInputBytes: 400 },
      middlewares: [
        {
          name: "expand",
          async *wrapModel(request, _ctx, next) {
            yield* next({ ...request, messages: [{ role: "user", content: "x".repeat(500) }] });
          },
        },
      ],
    }).run({ input: "go" }, options);
    expect(result.stopReason).toBe("limit_exceeded");
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not let middleware advertise a forged parameter schema", async () => {
    const result = await createAgent({
      model: sequence(answer()),
      tools: [tool()],
      middlewares: [
        {
          name: "forge",
          beforeModel(request) {
            request.tools[0]!.inputSchema = { type: "string" };
            return request;
          },
        },
      ],
    }).run({ input: "go" }, options);
    expect(result.stopReason).toBe("invalid_middleware");
  });

  it("runs tool wrappers after permission checks and disallows duplicate next calls", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: "written" }));
    const entered = vi.fn();
    const wrapper: AgentMiddleware = {
      name: "twice",
      async *wrapTool(_call, _ctx, next) {
        entered();
        yield* next();
        yield* next();
      },
    };
    const denied = await createAgent({
      model: sequence(calling(call("lookup")), answer()),
      tools: [tool(execute)],
      allowTool: () => false,
      middlewares: [wrapper],
    }).run({ input: "go" }, options);
    expect(denied.status).toBe("completed");
    expect(entered).not.toHaveBeenCalled();
    const failed = await createAgent({
      model: sequence(calling(call("lookup"))),
      tools: [{ ...tool(execute), effect: "write" }],
      middlewares: [wrapper],
    }).run({ input: "go" }, options);
    expect(failed.stopReason).toBe("invalid_middleware");
    expect(failed.error?.outcomeUnknown).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not convert a wrapper error after a completed write into a retryable tool result", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: "written" }));
    const result = await createAgent({
      model: sequence(calling(call("lookup"))),
      tools: [{ ...tool(execute), effect: "write" }],
      middlewares: [
        {
          name: "broken-audit",
          async *wrapTool(_call, _ctx, next) {
            for await (const _chunk of next()) throw new ToolError("audit_failed", "audit failed");
          },
        },
      ],
    }).run({ input: "go" }, options);
    expect(result.status).toBe("failed");
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(result.messages.some((message) => message.role === "tool")).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("supports model cache short-circuit and guards multiple next calls", async () => {
    const generate = vi.fn(async () => answer());
    const cached = await createAgent({
      model: { generate },
      middlewares: [
        {
          name: "cache",
          async *wrapModel() {
            yield { type: "response", response: answer("cached") };
          },
        },
      ],
    }).run({ input: "go" }, options);
    expect(cached.finalText).toBe("cached");
    expect(generate).not.toHaveBeenCalled();
    const duplicate = await createAgent({
      model: { generate },
      middlewares: [
        {
          name: "twice",
          async *wrapModel(request, _ctx, next) {
            yield* next(request);
            yield* next(request);
          },
        },
      ],
    }).run({ input: "go" }, options);
    expect(duplicate.stopReason).toBe("invalid_middleware");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("allows afterModel rewriting for nonstream responses, but rejects inconsistent streamed text", async () => {
    const middleware: AgentMiddleware = {
      name: "rewrite",
      afterModel(response) {
        return { ...response, message: { ...response.message, content: "changed" } };
      },
    };
    const plain = await createAgent({ model: sequence(answer()), middlewares: [middleware] }).run(
      { input: "go" },
      options,
    );
    expect(plain.finalText).toBe("changed");
    const streamed = await createAgent({
      model: createScriptedModel(() => answer()),
      middlewares: [middleware],
    }).run({ input: "go" }, options);
    expect(streamed.stopReason).toBe("protocol_error");
  });

  it("keeps registered metadata stable after the caller mutates the original tool", async () => {
    const original = tool();
    const agent = createAgent({
      model: sequence(calling(call("lookup")), answer()),
      tools: [original],
    });
    original.inputSchema.required = ["unexpected"];
    const result = await agent.run({ input: "go" }, options);
    expect(JSON.parse(result.messages.find((message) => message.role === "tool")!.content).ok).toBe(
      true,
    );
  });
});
