import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentError,
  createAgent,
  createFileCheckpointStore,
  createMemoryCheckpointStore,
  createMemoryArtifactStore,
  createToolResultReduction,
  createTodoTool,
  defineTool,
  exportState,
  interrupt,
} from "../src/index.js";
import type { AgentEvent, CheckpointStore, ChatModel, JsonValue, Tool } from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

const options = { context: { userId: "u1" }, checkpointOwner: "u1:conversation1" };
const writeTool = (
  execute: Tool["execute"] = vi.fn(async () => ({ ok: true as const, content: "written" })),
) =>
  defineTool({
    name: "write",
    description: "write business data",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "write" as const,
    execute,
  });
const gate = (toolCall: { name: string }, context: { resume?: { data: JsonValue } }) => {
  if (toolCall.name !== "write") return;
  if (!context.resume) return interrupt({ question: "Confirm this write?" });
  return context.resume.data === true;
};

describe("checkpoint interruption and resume", () => {
  it("restores a partially completed batch with todos, counters and original project instructions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "enio-checkpoints-"));
    try {
      const executed: string[] = [];
      const load = vi.fn(async () => "initial project rules");
      const events: AgentEvent[] = [];
      const tool = writeTool(async (_args, ctx) => {
        executed.push(ctx.toolCallId);
        expect(ctx.state.todos).toHaveLength(1);
        return { ok: true, content: "written" };
      });
      const todos = [{ id: "task", content: "ship", status: "pending" as const }];
      const common = {
        tools: [createTodoTool(), tool],
        agentsMd: { load },
        hooks: {
          beforeTool: gate,
          onEvent(event: AgentEvent) {
            events.push(event);
          },
        },
      };
      const first = await createAgent({
        ...common,
        model: sequence(
          calling(
            call("write_todos", { todos }, "a"),
            call("write", {}, "b"),
            call("write", {}, "c"),
          ),
        ),
        checkpoints: { store: createFileCheckpointStore({ root }), namespace: "orders-v1" },
      }).run({ input: "write after planning" }, options);
      expect(first.status).toBe("interrupted");
      expect(first.pendingToolCallIds).toEqual(["b", "c"]);
      expect(first.toolCalls).toBe(1);
      expect(executed).toEqual([]);
      expect(() => exportState(first)).toThrow();
      const checkpointId = first.interrupt!.checkpointId;
      const persisted = await readFile(path.join(root, `${checkpointId}.json`), "utf8");
      expect(persisted).not.toContain("userId");
      // 新建 store、Agent 和模型，证明恢复来自文件而不是闭包中的原生成器。
      const generate = vi.fn<ChatModel["generate"]>(async (request) => {
        expect(
          request.messages.some((message) => message.content === "initial project rules"),
        ).toBe(true);
        return answer("finished");
      });
      const agent = createAgent({
        ...common,
        model: { generate },
        checkpoints: { store: createFileCheckpointStore({ root }), namespace: "orders-v1" },
      });
      load.mockResolvedValue("changed project rules");
      const second = await agent.resume({ checkpointId, data: true }, options);
      expect(second.status).toBe("interrupted");
      expect(executed).toEqual(["b"]);
      expect(second.interrupt!.call.id).toBe("c");
      expect(second.interrupt!.checkpointId).not.toBe(checkpointId);
      const third = await agent.resume(
        { checkpointId: second.interrupt!.checkpointId, data: true },
        options,
      );
      expect(third.status).toBe("completed");
      expect(third.runId).toBe(first.runId);
      expect(third.iterations).toBe(2);
      expect(third.toolCalls).toBe(3);
      expect(third.todos).toEqual(todos);
      expect(third.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, known: false });
      expect(executed).toEqual(["b", "c"]);
      expect(generate).toHaveBeenCalledOnce();
      expect(load).toHaveBeenCalledOnce();
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
      expect(events.every((event) => event.runId === first.runId)).toBe(true);
      expect(exportState(third).todos).toEqual(todos);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["memory", "file"])(
    "allows only one concurrent resume with the %s store",
    async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "enio-race-"));
      try {
        const memory = createMemoryCheckpointStore();
        const store = () => (kind === "file" ? createFileCheckpointStore({ root }) : memory);
        const tool = writeTool();
        const make = (model: ChatModel) =>
          createAgent({
            model,
            tools: [tool],
            hooks: { beforeTool: gate },
            checkpoints: { store: store(), namespace: "race" },
          });
        const first = await make(sequence(calling(call("write")))).run({ input: "write" }, options);
        const input = { checkpointId: first.interrupt!.checkpointId, data: true };
        const outcomes = await Promise.all([
          make(sequence(answer())).resume(input, options),
          make(sequence(answer())).resume(input, options),
        ]);
        expect(outcomes.map((result) => result.status).sort()).toEqual(["completed", "failed"]);
        expect(outcomes.find((result) => result.status === "failed")?.stopReason).toBe(
          "checkpoint_unavailable",
        );
        expect(tool.execute).toHaveBeenCalledOnce();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects another owner/configuration without consuming the legitimate checkpoint", async () => {
    const store = createMemoryCheckpointStore();
    const tool = writeTool();
    const make = (namespace = "orders") =>
      createAgent({
        model: sequence(calling(call("write")), answer()),
        tools: [tool],
        hooks: { beforeTool: gate },
        checkpoints: { store, namespace },
      });
    const agent = make();
    const first = await agent.run({ input: "write" }, options);
    const input = { checkpointId: first.interrupt!.checkpointId, data: true };
    expect(
      (await agent.resume(input, { ...options, checkpointOwner: "another-user" })).stopReason,
    ).toBe("checkpoint_mismatch");
    expect((await make("changed").resume(input, options)).stopReason).toBe("checkpoint_mismatch");
    expect((await agent.resume(input, options)).status).toBe("completed");
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("uses the current host identity and permission checks on resume", async () => {
    const store = createMemoryCheckpointStore();
    const tool = writeTool();
    const agent = createAgent({
      model: sequence(calling(call("write")), answer("denied")),
      tools: [tool],
      hooks: { beforeTool: gate },
      checkpoints: { store, namespace: "orders" },
      allowTool: (_tool, ctx) => (ctx.context as { allowed: boolean }).allowed,
    });
    const first = await agent.run({ input: "write" }, { ...options, context: { allowed: true } });
    const result = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      { ...options, context: { allowed: false } },
    );
    expect(result.status).toBe("completed");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(result.messages)).toContain("permission_denied");
  });

  it("can reject a pending operation and continue reasoning without executing it", async () => {
    const tool = writeTool();
    const agent = createAgent({
      model: sequence(calling(call("write")), answer("not submitted")),
      tools: [tool],
      hooks: { beforeTool: gate },
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "orders" },
    });
    const first = await agent.run({ input: "write" }, options);
    const result = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: false },
      options,
    );
    expect(result.status).toBe("completed");
    expect(result.historyComplete).toBe(true);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("fails before side effects when checkpoint storage is unavailable", async () => {
    const tool = writeTool();
    const store: CheckpointStore = {
      async save() {
        throw new AgentError("storage_failed", "offline");
      },
      async take() {
        throw new Error("unused");
      },
    };
    const result = await createAgent({
      model: sequence(calling(call("write"))),
      tools: [tool],
      hooks: { beforeTool: gate },
      checkpoints: { store, namespace: "orders" },
    }).run({ input: "write" }, options);
    expect(result.stopReason).toBe("storage_failed");
    expect(result.interrupt).toBeUndefined();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("requires checkpoint ownership and does not silently convert cancellation into resume", async () => {
    const tool = writeTool();
    const agent = createAgent({
      model: sequence(calling(call("write"))),
      tools: [tool],
      hooks: { beforeTool: gate },
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "orders" },
    });
    expect((await agent.run({ input: "write" }, { context: {} })).stopReason).toBe("invalid_input");
    const first = await agent.run({ input: "write" }, options);
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await agent.resume(
          { checkpointId: first.interrupt!.checkpointId, data: true },
          { ...options, signal: controller.signal },
        )
      ).status,
    ).toBe("cancelled");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("preserves total iteration budget rather than resetting it at resume", async () => {
    const tool = writeTool();
    const agent = createAgent({
      model: sequence(calling(call("write")), answer()),
      tools: [tool],
      hooks: { beforeTool: gate },
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "orders" },
      limits: { maxIterations: 1 },
    });
    const first = await agent.run({ input: "write" }, options);
    const result = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(result.stopReason).toBe("limit_exceeded");
    expect(result.toolCalls).toBe(1);
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("never creates a resumable checkpoint for an uncertain tool side effect", async () => {
    const tool = writeTool(async () => {
      throw new Error("connection lost after submission");
    });
    const result = await createAgent({
      model: sequence(calling(call("write"))),
      tools: [tool],
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "orders" },
    }).run({ input: "write" }, options);
    expect(result.error?.outcomeUnknown).toBe(true);
    expect(result.interrupt).toBeUndefined();
  });

  it("preserves offloaded references when pausing after a completed tool", async () => {
    const artifacts = createMemoryArtifactStore();
    const output = defineTool({
      ...writeTool(),
      name: "read",
      effect: "read" as const,
      async execute() {
        return { ok: true as const, content: "logs ".repeat(5000) };
      },
    });
    const agent = createAgent({
      model: sequence(calling(call("read", {}, "r"), call("write", {}, "w")), answer()),
      tools: [output, writeTool()],
      contextPolicies: [createToolResultReduction({ store: artifacts, maxOutputBytes: 512 })],
      hooks: { beforeTool: gate },
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "orders" },
    });
    const first = await agent.run({ input: "read and write" }, options);
    const artifact = JSON.parse(
      first.messages.find((message) => message.role === "tool")!.content,
    ).artifact;
    const result = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(result.status).toBe("completed");
    expect(JSON.stringify(exportState(result))).toContain(artifact.id);
  });

  it("resumed stream return cancels execution before any pending side effect", async () => {
    const tool = writeTool();
    const agent = createAgent({
      model: sequence(calling(call("write"))),
      tools: [tool],
      hooks: { beforeTool: gate },
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "orders" },
    });
    const first = await agent.run({ input: "write" }, options);
    const iterator = agent.resumeStream(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect((await iterator.next()).value.type).toBe("run_resumed");
    await iterator.return!();
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
