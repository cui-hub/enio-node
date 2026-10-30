import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  createAgent,
  createAgentTool,
  createDeepAgent,
  createSkillTool,
  createFilesystemSkills,
  createScriptedModel,
  createMemoryFilesystem,
  createMemoryCheckpointStore,
  interrupt,
} from "../src/index.js";
import type {
  AgentEvent,
  ChatModel,
  Skill,
  SkillBackend,
  SkillMetadata,
  Tool,
} from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

const options = { context: {}, checkpointOwner: "skill-owner" };
const metadata: SkillMetadata = { name: "review", description: "Review source", context: "fork" };
/** 自定义业务 backend 与文件目录实现遵循相同发现/加载协议。 */
function backend(
  entry: SkillMetadata = metadata,
  content = "Review the source carefully.",
): SkillBackend {
  return {
    async list() {
      return [entry];
    },
    async get() {
      return { ...entry, content };
    },
  };
}
const useSkill = (request?: string) =>
  calling(call("skill", { skill: "review", ...(request ? { request } : {}) }));

describe("V4 Skill fork", () => {
  it.each(["fork", "fork_with_context"] as const)(
    "executes %s in an independent Agent with the expected history",
    async (mode) => {
      const seen: string[][] = [];
      const tool = await createSkillTool({
        backend: backend({ ...metadata, context: mode }),
        fork: {
          agents: {
            reviewer: {
              instructions: "child policy",
              model: {
                async generate(request) {
                  seen.push(request.messages.map((message) => message.content));
                  return answer("review completed");
                },
              },
            },
          },
        },
      });
      const events: AgentEvent[] = [];
      const result = await createAgent({
        model: sequence(useSkill("Check edge cases"), answer("parent answer")),
        tools: [tool],
        instructions: "parent policy",
        hooks: {
          onEvent(event) {
            events.push(event);
          },
        },
      }).run({ input: "parent-only context" }, options);
      expect(result.status).toBe("completed");
      expect(seen[0]).toEqual([
        "child policy",
        ...(mode === "fork_with_context" ? ["parent-only context"] : []),
        "Skill: review\nReview the source carefully.\n\n任务要求：Check edge cases",
      ]);
      expect(result.messages.find((message) => message.role === "tool")!.content).toContain(
        "review completed",
      );
      expect(JSON.stringify(result.messages)).not.toContain("Review the source carefully");
      expect(
        events.some(
          (event) => event.type === "agent_event" && event.payload.path[0]!.name === "reviewer",
        ),
      ).toBe(true);
    },
  );

  it("discovers filesystem fork routes and uses only the host's registered Agent/model override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "enio-v4-skills-"));
    try {
      await mkdir(path.join(root, "review"));
      await writeFile(
        path.join(root, "review/SKILL.md"),
        "---\nname: review\ndescription: Review source\ncontext: fork\nagent: reviewer\nmodel: fast\n---\nReview carefully.",
      );
      const normal = vi.fn(async () => answer("wrong model"));
      const fast = vi.fn(async () => answer("fast review"));
      const tool = await createSkillTool({
        backend: createFilesystemSkills({ root }),
        fork: {
          agents: { reviewer: { model: { generate: normal } } },
          models: { fast: { generate: fast } },
        },
      });
      expect(tool.description).toContain("fork, agent=reviewer, model=fast");
      expect(tool.description).not.toContain("Review carefully.");
      const result = await createAgent({
        model: sequence(useSkill(), answer("parent")),
        tools: [tool],
      }).run({ input: "go" }, options);
      expect(result.finalText).toBe("parent");
      expect(normal).not.toHaveBeenCalled();
      expect(fast).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unregistered routes and ambiguous defaults before running a model", async () => {
    const configuration = { model: sequence(answer()) };
    for (const entry of [
      { ...metadata, agent: "unknown" },
      { ...metadata, model: "unknown" },
    ]) {
      await expect(
        createSkillTool({ backend: backend(entry), fork: { agents: { worker: configuration } } }),
      ).rejects.toMatchObject({ code: "invalid_skill" });
    }
    await expect(
      createSkillTool({
        backend: backend(),
        fork: { agents: { a: configuration, b: configuration } },
      }),
    ).rejects.toMatchObject({ code: "invalid_skill" });
  });

  it("does not turn Skill scripts or resource paths into execution/file permissions", async () => {
    const events: AgentEvent[] = [];
    const tool = await createSkillTool({
      backend: backend(metadata, "Run scripts/check.js, then read secret.txt."),
      fork: {
        agents: {
          reviewer: {
            model: sequence(
              calling(
                call("execute", { command: "node", args: ["scripts/check.js"] }, "execute"),
                call("read_file", { path: "secret.txt" }, "read"),
              ),
              answer("tools unavailable"),
            ),
          },
        },
      },
    });
    const result = await createAgent({
      model: sequence(useSkill(), answer()),
      tools: [tool],
      hooks: {
        onEvent(e) {
          events.push(e);
        },
      },
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    const ends = events.filter(
      (e) => e.type === "agent_event" && e.payload.event.type === "tool_end",
    );
    expect(ends).toHaveLength(2);
    expect(ends.every((e) => JSON.stringify(e).includes("unknown_tool"))).toBe(true);
  });

  it("resumes a fork using its saved body without reloading or redoing completed writes", async () => {
    const store = createMemoryCheckpointStore();
    const writes: string[] = [];
    const get = vi.fn(async (): Promise<Skill> => ({
      ...metadata,
      content: "original instructions",
    }));
    const source: SkillBackend = {
      async list() {
        return [metadata];
      },
      get,
    };
    const build = async () =>
      createAgent({
        model: createScriptedModel(({ messages }) =>
          messages.some((m) => m.role === "tool") ? answer("root done") : useSkill(),
        ),
        checkpoints: { store, namespace: "root-skill-v4" },
        tools: [
          await createSkillTool({
            backend: source,
            fork: {
              agents: {
                reviewer: {
                  model: createScriptedModel(({ messages }) => {
                    expect(messages.some((m) => m.content.includes("original instructions"))).toBe(
                      true,
                    );
                    return messages.some((m) => m.role === "tool")
                      ? answer("review done")
                      : calling(call("write", {}, "first"), call("write", {}, "second"));
                  }),
                  tools: [
                    {
                      name: "write",
                      description: "write",
                      effect: "write",
                      inputSchema: { type: "object" },
                      async execute(_args, ctx) {
                        writes.push(ctx.toolCallId);
                        return { ok: true, content: "written" };
                      },
                    },
                  ],
                  checkpoints: { store, namespace: "worker-v4" },
                  hooks: {
                    beforeTool(call, ctx) {
                      if (call.id === "second" && !ctx.resume) return interrupt("confirm");
                    },
                  },
                },
              },
            },
          }),
        ],
      });
    const first = await (await build()).run({ input: "go" }, options);
    expect(first.status).toBe("interrupted");
    expect(writes).toEqual(["first"]);
    get.mockRejectedValue(new Error("source unavailable after interruption"));
    const resumed = await (
      await build()
    ).resume({ checkpointId: first.interrupt!.checkpointId, data: true }, options);
    expect(resumed.status).toBe("completed");
    expect(writes).toEqual(["first", "second"]);
    expect(get).toHaveBeenCalledOnce();
  });

  it("fails if the backend changes a discovered execution route", async () => {
    const source = backend();
    source.get = async () => ({ ...metadata, context: "fork_with_context", content: "changed" });
    const tool = await createSkillTool({
      backend: source,
      fork: { agents: { reviewer: { model: sequence(answer()) } } },
    });
    const result = await createAgent({ model: sequence(useSkill()), tools: [tool] }).run(
      { input: "go" },
      options,
    );
    expect(result.stopReason).toBe("invalid_skill");
  });

  it("rejects a changed Skill route on resume instead of starting a new child", async () => {
    const store = createMemoryCheckpointStore();
    let entry: SkillMetadata = { ...metadata };
    const execute = vi.fn(async () => ({ ok: true as const, content: "written" }));
    const build = async () =>
      createAgent({
        model: sequence(useSkill()),
        checkpoints: { store, namespace: "changed-root" },
        tools: [
          await createSkillTool({
            backend: backend(entry),
            fork: {
              agents: {
                reviewer: {
                  model: sequence(calling(call("write"))),
                  checkpoints: { store, namespace: "changed-child" },
                  tools: [
                    {
                      name: "write",
                      description: "write",
                      effect: "write",
                      inputSchema: { type: "object" },
                      execute,
                    },
                  ],
                  hooks: {
                    beforeTool(_call, ctx) {
                      if (!ctx.resume) return interrupt("confirm");
                    },
                  },
                },
              },
            },
          }),
        ],
      });
    const first = await (await build()).run({ input: "go" }, options);
    expect(first.status).toBe("interrupted");
    entry = { ...entry, context: "fork_with_context" };
    const result = await (
      await build()
    ).resume({ checkpointId: first.interrupt!.checkpointId, data: true }, options);
    expect(result.stopReason).toBe("checkpoint_mismatch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps inline skills as text loading even in a mixed catalog", async () => {
    const tool = await createSkillTool({
      backend: {
        async list() {
          return [metadata, { name: "inline", description: "inline" }];
        },
        async get() {
          return { name: "inline", description: "inline", content: "Inline steps" };
        },
      },
      fork: { agents: { reviewer: { model: sequence(answer()) } } },
    });
    const events: AgentEvent[] = [];
    const result = await createAgent({
      model: sequence(calling(call("skill", { skill: "inline" })), answer()),
      tools: [tool],
      hooks: {
        onEvent(e) {
          events.push(e);
        },
      },
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    expect(events.some((e) => e.type === "agent_event")).toBe(false);
    expect(result.messages.find((m) => m.role === "tool")!.content).toContain("Inline steps");
  });
});

describe("V4 DeepAgent assembly", () => {
  it("provides todos and task by default, and leaves general-purpose children without recursive delegation", async () => {
    const seenTools: string[][] = [];
    const model = createScriptedModel(({ messages, tools }) => {
      seenTools.push(tools.map((tool) => tool.name));
      if (messages.some((m) => m.role === "tool")) return answer("parent done");
      if (messages.at(-1)?.content === "child task") return answer("child done");
      return calling(call("task", { agent: "general-purpose", request: "child task" }));
    });
    const result = await createDeepAgent({ model }).run({ input: "parent task" }, options);
    expect(result.status).toBe("completed");
    expect(seenTools).toEqual([["write_todos", "task"], ["write_todos"], ["write_todos", "task"]]);
  });

  it("assembles explicit file/execute backends and runs a registered specialist", async () => {
    const filesystem = createMemoryFilesystem({
      files: { "source.txt": "content" },
      writable: ["out.txt"],
    });
    const execute = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      truncated: false,
    }));
    const specialist = createAgent({ model: sequence(answer("specialist result")) });
    const model: ChatModel = sequence(
      calling(
        call("read_file", { path: "source.txt" }, "read"),
        call("write_file", { path: "out.txt", content: "report" }, "write"),
        call("execute", { command: "checker" }, "execute"),
        call("task", { agent: "reviewer", request: "check" }, "review"),
      ),
      answer("finished"),
    );
    const result = await createDeepAgent({
      model,
      filesystem,
      execute: { execute },
      generalAgent: false,
      subAgents: [{ name: "reviewer", description: "review", agent: specialist }],
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    expect(
      (await filesystem.readFile({ path: "out.txt" }, new AbortController().signal)).content,
    ).toBe("report");
    expect(execute).toHaveBeenCalledOnce();
    expect(
      result.messages.find((m) => m.role === "tool" && m.toolCallId === "review")!.content,
    ).toContain("specialist result");
  });

  it("resumes an interrupted default child with a derived checkpoint namespace", async () => {
    const store = createMemoryCheckpointStore();
    const execute = vi.fn(async () => ({ ok: true as const, content: "written" }));
    const work: Tool = {
      name: "work",
      description: "write",
      effect: "write",
      inputSchema: { type: "object" },
      execute,
    };
    const build = () =>
      createDeepAgent({
        checkpoints: { store, namespace: "deep-v4" },
        tools: [work],
        model: createScriptedModel(({ messages }) => {
          if (messages.some((m) => m.role === "tool")) return answer("done");
          return messages.at(-1)?.content === "child"
            ? calling(call("work"))
            : calling(call("task", { agent: "general-purpose", request: "child" }));
        }),
        hooks: {
          beforeTool(call, ctx) {
            if (call.name === "work" && !ctx.resume) return interrupt("confirm");
          },
        },
      });
    const first = await build().run({ input: "parent" }, options);
    expect(first.status).toBe("interrupted");
    const resumed = await build().resume(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    );
    expect(resumed.status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("supports disabling presets, rejects duplicate names, and excludes user delegation tools from the default child", async () => {
    const generate = vi.fn<ChatModel["generate"]>(async (request) => {
      expect(request.tools).toEqual([]);
      return answer();
    });
    expect(
      (
        await createDeepAgent({ model: { generate }, todos: false, generalAgent: false }).run(
          { input: "go" },
          options,
        )
      ).status,
    ).toBe("completed");
    const child = createAgent({ model: sequence(answer()) });
    expect(() =>
      createDeepAgent({
        model: sequence(answer()),
        subAgents: [{ name: "general-purpose", description: "duplicate", agent: child }],
      }),
    ).toThrow();
    const names: string[][] = [];
    const model = createScriptedModel(({ messages, tools }) => {
      names.push(tools.map((tool) => tool.name));
      return messages.at(-1)?.content === "child" || messages.some((m) => m.role === "tool")
        ? answer()
        : calling(call("task", { agent: "general-purpose", request: "child" }));
    });
    const result = await createDeepAgent({
      model,
      tools: [createAgentTool({ name: "specialist", description: "specialist", agent: child })],
    }).run({ input: "go" }, options);
    expect(result.status).toBe("completed");
    expect(names[0]).toContain("specialist");
    expect(names[1]).toEqual(["write_todos"]);
  });
});
