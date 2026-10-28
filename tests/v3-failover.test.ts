import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentError,
  ModelError,
  createAgent,
  createMemoryCheckpointStore,
  interrupt,
} from "../src/index.js";
import type { AgentEvent, ChatModel, Checkpoint, Tool } from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

const options = { context: {}, checkpointOwner: "owner" };
const work: Tool = {
  name: "work",
  description: "work",
  effect: "read",
  inputSchema: { type: "object" },
  async execute() {
    return { ok: true, content: "done" };
  },
};
afterEach(() => vi.useRealTimers());

describe("V3 main-model failover", () => {
  it("resumes an actual V2 checkpoint without V3 fields using the original binding", async () => {
    // 固定样本由未修改的 v2 tag 实际运行生成；不要用 V3 重新生成来掩盖兼容性回归。
    const checkpoint = JSON.parse(
      await readFile(new URL("./fixtures/v2-checkpoint.json", import.meta.url), "utf8"),
    ) as Checkpoint;
    const store = createMemoryCheckpointStore();
    await store.save(checkpoint, new AbortController().signal);
    const execute = vi.fn(work.execute);
    const result = await createAgent({
      model: sequence(answer("legacy resumed")),
      tools: [{ ...work, execute }],
      checkpoints: { store, namespace: "legacy-v2" },
      hooks: {
        beforeTool(_call, ctx) {
          return ctx.resume?.data === true;
        },
      },
    }).resume({ checkpointId: checkpoint.id, data: true }, options);
    expect(result.status).toBe("completed");
    expect(result.runId).toBe(checkpoint.runId);
    expect(result.finalText).toBe("legacy resumed");
    expect(result.iterations).toBe(2);
    expect(result.historyComplete).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("exhausts retries, switches once and keeps the successful model for subsequent turns", async () => {
    const primary = vi.fn(async () => {
      throw new ModelError("network", "offline", true);
    });
    const fallback = vi.fn(sequence(calling(call("work")), answer("fallback answer")).generate);
    const events: AgentEvent[] = [];
    const result = await createAgent({
      model: { generate: primary },
      modelFailover: { models: [{ generate: fallback }] },
      tools: [work],
      limits: { maxModelRetries: 1, retryDelayMs: 0 },
      hooks: {
        onEvent(event) {
          events.push(event);
        },
      },
    }).run({ input: "go" }, options);
    expect(result.finalText).toBe("fallback answer");
    expect(primary).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(result.iterations).toBe(2);
    expect(result.usage.known).toBe(false);
    expect(
      events.filter((event) => event.type === "model_fallback").map((event) => event.payload),
    ).toEqual([{ from: 0, to: 1, code: "network" }]);
  });

  it("tries further fallbacks and stops after exhausting the configured model pool", async () => {
    const model = (): ChatModel => ({
      async generate() {
        throw new ModelError("offline", "offline", true);
      },
    });
    const generate = vi.fn(async () => {
      throw new ModelError("last", "last failed", true);
    });
    const result = await createAgent({
      model: model(),
      modelFailover: { models: [model(), { generate }] },
      limits: { maxModelRetries: 0 },
    }).run({ input: "go" }, options);
    expect(result.stopReason).toBe("last");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not fall back on permanent errors unless the host explicitly opts in", async () => {
    const primary: ChatModel = {
      async generate() {
        throw new ModelError("auth", "denied", false);
      },
    };
    const generate = vi.fn(async () => answer("backup"));
    const denied = await createAgent({
      model: primary,
      modelFailover: { models: [{ generate }] },
    }).run({ input: "go" }, options);
    expect(denied.stopReason).toBe("auth");
    expect(generate).not.toHaveBeenCalled();
    const allowed = await createAgent({
      model: primary,
      modelFailover: { models: [{ generate }], shouldFailover: (error) => error.code === "auth" },
    }).run({ input: "go" }, options);
    expect(allowed.finalText).toBe("backup");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("never restarts after visible text, even when failover policy returns true", async () => {
    const fallback = vi.fn(async () => answer());
    const model: ChatModel = {
      async generate() {
        return answer();
      },
      async *stream() {
        yield { type: "text_delta", text: "partial" };
        throw new ModelError("network", "broken", true);
      },
    };
    const result = await createAgent({
      model,
      modelFailover: { models: [{ generate: fallback }], shouldFailover: () => true },
    }).run({ input: "go" }, options);
    expect(result.stopReason).toBe("network");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("never treats protocol errors or runner deadlines as failover candidates", async () => {
    const generate = vi.fn(async () => answer());
    const invalid = await createAgent({
      model: {
        async generate() {
          throw new AgentError("protocol_error", "invalid");
        },
      },
      modelFailover: { models: [{ generate }], shouldFailover: () => true },
    }).run({ input: "go" }, options);
    expect(invalid.stopReason).toBe("protocol_error");
    vi.useFakeTimers();
    const running = createAgent({
      model: { generate: () => new Promise(() => {}) },
      limits: { modelTimeoutMs: 10 },
      modelFailover: { models: [{ generate }], shouldFailover: () => true },
    }).run({ input: "go" }, options);
    await vi.runAllTimersAsync();
    expect((await running).stopReason).toBe("model_timeout");
    expect(generate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores the selected fallback from a checkpoint without calling the failed primary again", async () => {
    const primary = vi.fn(async () => {
      throw new ModelError("offline", "offline", true);
    });
    const fallback = sequence(calling(call("work")), answer("resumed"));
    const store = createMemoryCheckpointStore();
    const build = () =>
      createAgent({
        model: { generate: primary },
        modelFailover: { models: [fallback] },
        tools: [work],
        limits: { maxModelRetries: 0 },
        checkpoints: { store, namespace: "model-selection" },
        hooks: {
          beforeTool(_call, ctx) {
            if (!ctx.resume) return interrupt("confirm");
          },
        },
      });
    const first = await build().run({ input: "go" }, options);
    expect(first.status).toBe("interrupted");
    const second = await build().resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(second.finalText).toBe("resumed");
    expect(primary).toHaveBeenCalledOnce();
  });

  it("keeps model selection local to each run", async () => {
    const primary: ChatModel = {
      async generate(request) {
        if (request.messages.at(-1)!.content === "a")
          throw new ModelError("offline", "offline", true);
        return answer("primary");
      },
    };
    const agent = createAgent({
      model: primary,
      modelFailover: { models: [sequence(answer("fallback"))] },
      limits: { maxModelRetries: 0 },
    });
    expect((await agent.run({ input: "a" }, options)).finalText).toBe("fallback");
    expect((await agent.run({ input: "b" }, options)).finalText).toBe("primary");
  });

  it("rejects changed dynamic setup when resuming a checkpoint", async () => {
    let instruction = "old";
    const agent = createAgent({
      model: sequence(calling(call("work"))),
      tools: [work],
      middlewares: [
        {
          name: "setup",
          beforeAgent(setup) {
            return { ...setup, instructions: instruction };
          },
        },
      ],
      checkpoints: { store: createMemoryCheckpointStore(), namespace: "setup" },
      hooks: {
        beforeTool() {
          return interrupt("confirm");
        },
      },
    });
    const first = await agent.run({ input: "go" }, options);
    instruction = "new";
    const result = await agent.resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(result.stopReason).toBe("checkpoint_mismatch");
  });
});
