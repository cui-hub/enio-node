import { describe, expect, it, vi } from "vitest";
import {
  createAgent,
  createAgentPreset,
  createAgentRegistry,
  createAgentTool,
  createDeepAgent,
  createMemoryCheckpointStore,
  createScriptedModel,
  createSkillTool,
  createTaskTool,
  interrupt,
} from "../src/index.js";
import type { AgentConfig, AgentEvent, AgentRole, SkillBackend, Tool } from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

const options = { context: {}, checkpointOwner: "roles-owner" };
const source = (agent?: string, model?: string): SkillBackend => ({
  async list() {
    return [{ name: "review", description: "review", context: "fork", agent, model }];
  },
  async get() {
    return { ...(await this.list(new AbortController().signal))[0]!, content: "Review source." };
  },
});
const tool = (name: string, effect: Tool["effect"]): Tool => ({
  name,
  description: name,
  effect,
  inputSchema: { type: "object" },
  execute: vi.fn(async () => ({ ok: true as const, content: name })),
});

describe("shared Agent roles", () => {
  it("shares model, instructions, tools and middleware across task and Skill, with independent runs", async () => {
    const seen: { input: string; instructions: string; tools: string[] }[] = [];
    const runs: string[] = [];
    const registry = createAgentRegistry({
      roles: [
        {
          name: "reviewer",
          description: "review source",
          config: {
            model: createScriptedModel(({ messages, tools }) => {
              seen.push({
                input: messages.at(-1)!.content,
                instructions: messages[0]!.content,
                tools: tools.map((t) => t.name),
              });
              return answer("review complete");
            }),
            instructions: "shared policy",
            tools: [tool("read", "read")],
            middlewares: [
              {
                name: "shared",
                beforeAgent(setup) {
                  return { ...setup, instructions: setup.instructions + " / middleware" };
                },
              },
            ],
            hooks: {
              onEvent(event) {
                if (event.type === "run_start") runs.push(event.runId);
              },
            },
          },
        },
      ],
    });
    const skill = await createSkillTool({ backend: source(), fork: { registry } });
    const result = await createDeepAgent({
      registry,
      tools: [skill],
      model: sequence(
        calling(call("task", { agent: "reviewer", request: "Task input" }, "task")),
        calling(call("skill", { skill: "review", request: "Skill input" }, "skill")),
        answer("done"),
      ),
    }).run({ input: "parent context" }, options);
    expect(result.status).toBe("completed");
    expect(seen).toEqual([
      { input: "Task input", instructions: "shared policy / middleware", tools: ["read"] },
      {
        input: "Skill: review\nReview source.\n\n任务要求：Skill input",
        instructions: "shared policy / middleware",
        tools: ["read"],
      },
    ]);
    expect(new Set(runs).size).toBe(2);
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(JSON.stringify(result.messages)).not.toContain("shared policy");
  });

  it("uses a Skill model override without changing task's role model", async () => {
    const normal = vi.fn(async () => answer("normal"));
    const fast = vi.fn(async () => answer("fast"));
    const registry = createAgentRegistry({
      roles: [createAgentPreset("worker", { model: { generate: normal } })],
    });
    const skill = await createSkillTool({
      backend: source("worker", "fast"),
      fork: { registry, models: { fast: { generate: fast } } },
    });
    const result = await createAgent({
      model: sequence(
        calling(call("skill", { skill: "review" }, "skill")),
        calling(call("task", { agent: "worker", request: "work" }, "task")),
        answer(),
      ),
      tools: [skill, createTaskTool({ registry })],
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    expect(normal).toHaveBeenCalledOnce();
    expect(fast).toHaveBeenCalledOnce();
  });

  it("freezes the role directory and copies mutable configuration containers", () => {
    const config: AgentConfig<unknown> = {
      model: sequence(answer()),
      tools: [tool("read", "read")],
      limits: { maxIterations: 8 },
    };
    const role: AgentRole = { name: "reader", description: "reader", config };
    const registry = createAgentRegistry({ roles: [role] });
    role.name = "changed";
    config.tools!.length = 0;
    config.limits!.maxIterations = 1;
    const copy = registry.get("reader")!;
    copy.config.tools![0]!.inputSchema.properties = { injected: { type: "string" } };
    copy.config.limits!.maxIterations = 2;
    expect(registry.defaultAgent).toBe("reader");
    expect(registry.get("changed")).toBeUndefined();
    expect(registry.get("reader")!.config.limits!.maxIterations).toBe(8);
    expect(registry.list()[0]!.config.tools![0]!.inputSchema).toEqual({ type: "object" });
  });

  it("rejects duplicate roles, unknown defaults, missing Skill roles and ambiguous configuration", async () => {
    const worker = createAgentPreset("worker", { model: sequence(answer()) });
    expect(() => createAgentRegistry({ roles: [worker, worker] })).toThrow();
    expect(() => createAgentRegistry({ roles: [worker], defaultAgent: "missing" })).toThrow();
    const registry = createAgentRegistry({
      roles: [worker, createAgentPreset("explorer", worker.config)],
    });
    await expect(createSkillTool({ backend: source(), fork: { registry } })).rejects.toMatchObject({
      code: "invalid_skill",
    });
    await expect(
      createSkillTool({ backend: source("missing"), fork: { registry } }),
    ).rejects.toMatchObject({ code: "invalid_skill" });
    expect(() =>
      createDeepAgent({ model: sequence(answer()), registry, generalAgent: true }),
    ).toThrow();
    expect(() => createTaskTool({ registry, agents: [] } as never)).toThrow();
    await expect(
      createSkillTool({ backend: source(), fork: { registry, agents: {} } as never }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("rebuilds shared roles and resumes task then Skill without replaying completed child tools", async () => {
    const store = createMemoryCheckpointStore();
    const read = tool("read", "read");
    const write = tool("write", "write");
    const events: AgentEvent[] = [];
    const build = async () => {
      const registry = createAgentRegistry({
        roles: [
          createAgentPreset("worker", {
            checkpoints: { store, namespace: "shared-child" },
            tools: [read, write],
            model: createScriptedModel(({ messages }) =>
              messages.some((m) => m.role === "tool")
                ? answer("child done")
                : calling(call("read", {}, "read"), call("write", {}, "write")),
            ),
            hooks: {
              beforeTool(call, ctx) {
                if (call.name === "write" && !ctx.resume) return interrupt("confirm");
              },
            },
          }),
        ],
      });
      return createDeepAgent({
        registry,
        checkpoints: { store, namespace: "shared-root" },
        tools: [await createSkillTool({ backend: source("worker"), fork: { registry } })],
        hooks: {
          onEvent(event) {
            events.push(event);
          },
        },
        model: createScriptedModel(({ messages }) => {
          if (!messages.some((m) => m.role === "tool" && m.toolCallId === "task"))
            return calling(call("task", { agent: "worker", request: "work" }, "task"));
          if (!messages.some((m) => m.role === "tool" && m.toolCallId === "skill"))
            return calling(call("skill", { skill: "review" }, "skill"));
          return answer("parent done");
        }),
      });
    };
    const first = await (await build()).run({ input: "go" }, options);
    expect(first.status).toBe("interrupted");
    const second = await (
      await build()
    ).resume({ checkpointId: first.interrupt!.checkpointId, data: true }, options);
    expect(second.status).toBe("interrupted");
    const third = await (
      await build()
    ).resume({ checkpointId: second.interrupt!.checkpointId, data: true }, options);
    expect(third.status).toBe("completed");
    expect(third.runId).toBe(first.runId);
    expect(read.execute).toHaveBeenCalledTimes(2);
    expect(write.execute).toHaveBeenCalledTimes(2);
    expect(
      events.filter((e) => e.type === "agent_event" && e.payload.event.type === "run_resumed"),
    ).toHaveLength(2);
  });
});

describe("optional Agent presets", () => {
  it.each(["general-purpose", "explorer", "worker"] as const)(
    "%s applies its tool boundary after dynamic middleware",
    async (name) => {
      const read = tool("read", "read");
      const write = tool("write", "write");
      const execute = tool("execute", "execute");
      const delegate = createAgentTool({
        name: "delegate",
        description: "delegate",
        effect: "read",
        agent: createAgent({ model: sequence(answer()) }),
      });
      const seen: string[][] = [];
      const registry = createAgentRegistry({
        roles: [
          createAgentPreset(name, {
            model: createScriptedModel(({ tools }) => {
              seen.push(tools.map((t) => t.name));
              return answer();
            }),
            tools: [read, write, execute, delegate],
            middlewares: [
              {
                name: "dynamic",
                beforeAgent(setup) {
                  return { ...setup, tools: [read, write, execute, delegate] };
                },
              },
            ],
          }),
        ],
      });
      const result = await createAgent({
        tools: [createTaskTool({ registry })],
        model: sequence(calling(call("task", { agent: name, request: "go" })), answer()),
      }).run({ input: "go" }, options);
      expect(result.status).toBe("completed");
      expect(seen).toEqual([name === "explorer" ? ["read"] : ["read", "write", "execute"]]);
    },
  );

  it("explorer preserves host ACL and cannot execute write tools named by the model", async () => {
    const read = tool("read", "read");
    const write = tool("write", "write");
    const allowTool = vi.fn(async () => false);
    const role = createAgentPreset("explorer", {
      model: sequence(calling(call("read", {}, "r"), call("write", {}, "w")), answer()),
      tools: [read, write],
      allowTool,
    });
    const result = await createAgent(role.config).run({ input: "go" }, options);
    const results = result.messages
      .filter((m) => m.role === "tool")
      .map((m) => JSON.parse(m.content));
    expect(results.map((r) => r.code)).toEqual(["permission_denied", "unknown_tool"]);
    expect(read.execute).not.toHaveBeenCalled();
    expect(write.execute).not.toHaveBeenCalled();
    expect(allowTool).toHaveBeenCalledOnce();
  });
});
