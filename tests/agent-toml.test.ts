import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgent,
  createAgentRegistry,
  createScriptedModel,
  createSkillTool,
  createTaskTool,
  loadAgentRoles,
} from "../src/index.js";
import type { Tool } from "../src/index.js";
import { answer, call, calling, sequence } from "./helpers.js";

const definition = `name = "order-reviewer"
description = "审查订单调用链"
developer_instructions = """
先追踪订单状态流转。
报告问题和代码依据。
"""
preset = "explorer"
model = "fast"
tools = ["read"]
`;
const read: Tool = {
  name: "read",
  description: "read",
  effect: "read",
  inputSchema: { type: "object" },
  async execute() {
    return { ok: true, content: "read" };
  },
};
const write: Tool = { ...read, name: "write", effect: "write" };
const options = { context: {} };

/** 每项测试使用临时配置目录，不依赖用户机器上的个人 Agent 配置。 */
async function withFiles(files: Record<string, string>, test: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "enio-agents-toml-"));
  try {
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
    await test(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("TOML business Agents", () => {
  it("loads a business role and uses it through task and Skill with the same host model and tools", async () => {
    await withFiles({ "orders.toml": definition }, async (root) => {
      const normal = vi.fn(async () => answer("wrong model"));
      const inputs: string[] = [];
      const fast = createScriptedModel(({ messages, tools }) => {
        expect(tools.map((t) => t.name)).toEqual(["read"]);
        expect(messages[0]!.content).toContain("host ACL policy");
        expect(messages[0]!.content).toContain("报告问题和代码依据。");
        inputs.push(messages.at(-1)!.content);
        return answer("reviewed");
      });
      const registry = createAgentRegistry({
        roles: await loadAgentRoles({
          root,
          defaults: {
            model: { generate: normal },
            tools: [read, write],
            instructions: "host ACL policy",
          },
          models: { fast },
        }),
      });
      expect(registry.defaultAgent).toBe("order-reviewer");
      expect(registry.get("order-reviewer")!.effect).toBe("read");
      const metadata = {
        name: "orders",
        description: "orders",
        context: "fork" as const,
        agent: "order-reviewer",
      };
      const skill = await createSkillTool({
        backend: {
          async list() {
            return [metadata];
          },
          async get() {
            return { ...metadata, content: "Check orders." };
          },
        },
        fork: { registry },
      });
      const result = await createAgent({
        model: sequence(
          calling(call("task", { agent: "order-reviewer", request: "Review orders" }, "t")),
          calling(call("skill", { skill: "orders" }, "s")),
          answer(),
        ),
        tools: [createTaskTool({ registry }), skill],
      }).run({ input: "go" }, options);
      expect(result.status).toBe("completed");
      expect(inputs).toEqual(["Review orders", "Skill: orders\nCheck orders."]);
      expect(normal).not.toHaveBeenCalled();
    });
  });

  it("keeps explicit empty tool lists empty even after host middleware adds tools", async () => {
    await withFiles(
      {
        "empty.toml":
          'name="empty"\ndescription="empty"\ndeveloper_instructions="Think."\ntools=[]',
      },
      async (root) => {
        const roles = await loadAgentRoles({
          root,
          defaults: {
            model: createScriptedModel(({ tools }) => {
              expect(tools).toEqual([]);
              return answer();
            }),
            tools: [read, write],
            middlewares: [
              {
                name: "add-tools",
                beforeAgent(setup) {
                  return { ...setup, tools: [read, write] };
                },
              },
            ],
          },
        });
        expect((await createAgent(roles[0]!.config).run({ input: "go" }, options)).status).toBe(
          "completed",
        );
      },
    );
  });

  it("inherits host defaults, allows custom instructions without a preset, and preserves task history policy", async () => {
    await withFiles(
      {
        "custom.toml":
          'name="custom"\ndescription="custom"\ndeveloper_instructions="Think."\nhistory="inherit"',
      },
      async (root) => {
        const model = sequence(answer());
        const roles = await loadAgentRoles({ root, defaults: { model, tools: [read] } });
        expect(roles[0]!.config.model).toBe(model);
        expect(roles[0]!.config.tools!.map((t) => t.name)).toEqual(["read"]);
        expect(roles[0]!.config.instructions).toBe("Think.");
        expect(roles[0]!.history).toBe("inherit");
      },
    );
  });

  it.each([
    ["unknown field", definition + '\napi_key="secret-value"'],
    ["unknown model", definition.replace('model = "fast"', 'model = "unknown"')],
    ["unknown tool", definition.replace('["read"]', '["shell"]')],
    ["duplicate tool", definition.replace('["read"]', '["read", "read"]')],
    ["unknown preset", definition.replace('preset = "explorer"', 'preset = "missing"')],
    ["bad history", definition + '\nhistory="all"'],
    ["bad name", definition.replace('"order-reviewer"', '"../outside"')],
    ["missing instructions", 'name="reader"\ndescription="reader"'],
    ["invalid syntax", definition + "\ninvalid = ["],
    ["wrong field type", definition.replace('["read"]', "true")],
  ])("rejects %s without loading a partial directory or calling a model", async (_label, body) => {
    await withFiles({ "invalid.toml": body! }, async (root) => {
      const generate = vi.fn(async () => answer());
      let failure: unknown;
      try {
        await loadAgentRoles({
          root,
          defaults: { model: { generate }, tools: [read] },
          models: { fast: { generate } },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "invalid_agent_config" });
      expect(String(failure)).not.toContain("secret-value");
      expect(generate).not.toHaveBeenCalled();
    });
  });

  it("rejects duplicate names across TOML files", async () => {
    await withFiles({ "a.toml": definition, "b.toml": definition }, async (root) => {
      const model = sequence(answer());
      await expect(
        loadAgentRoles({ root, defaults: { model, tools: [read] }, models: { fast: model } }),
      ).rejects.toMatchObject({ code: "invalid_config" });
    });
  });

  it("loads only ordinary top-level TOML files and returns an empty list for an empty directory", async () => {
    await withFiles({ "notes.md": "not a definition" }, async (root) => {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "nested/hidden.toml"), definition);
      await symlink(path.join(root, "nested/hidden.toml"), path.join(root, "link.toml"));
      expect(await loadAgentRoles({ root, defaults: { model: sequence(answer()) } })).toEqual([]);
    });
  });

  it("rejects oversized definitions and respects an already aborted load", async () => {
    await withFiles({ "large.toml": "#" + "x".repeat(32_768) }, async (root) => {
      const defaults = { model: sequence(answer()) };
      await expect(loadAgentRoles({ root, defaults })).rejects.toMatchObject({
        code: "file_too_large",
      });
      await expect(
        loadAgentRoles({ root, defaults, signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: "cancelled" });
    });
  });
});
