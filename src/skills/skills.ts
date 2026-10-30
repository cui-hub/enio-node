import { parseDocument } from "yaml";
import { AgentError, ToolError } from "../protocol/errors.js";
import type {
  Agent,
  AgentConfig,
  ChatModel,
  JsonValue,
  Tool,
  ToolChunk,
  ToolContext,
} from "../protocol/types.js";
import { defineTool } from "../tools/registry.js";
import { abortable, byteLength, checkAbort } from "../runtime/control.js";
import { LocalFileStore } from "../backends/local-filesystem.js";
import { createAgent } from "../runtime/agent.js";
import { AgentToolInterrupt } from "../runtime/interrupt.js";
import { createAgentTool } from "../builtins/agent.js";
import type { AgentRegistry } from "../agents/registry.js";

/** name/description 在创建时发现，正文仅在 skill 工具被调用时进入模型上下文。 */
export interface SkillMetadata {
  name: string;
  description: string;
  context?: "inline" | "fork" | "fork_with_context";
  /** agent 只选择 fork.registry 或 fork.agents 的名称；model 只选择 fork.models 的键。 */
  agent?: string;
  model?: string;
}
/** 正文是指令文本；资源目录不会自动变成文件或 execute 权限。 */
export interface Skill extends SkillMetadata {
  content: string;
  baseDirectory?: string;
}
/** 可由业务实现数据库或远端技能库，接口本身不依赖 Agent 或 Graph。 */
export interface SkillBackend {
  list(signal: AbortSignal): Promise<SkillMetadata[]>;
  get(name: string, signal: AbortSignal): Promise<Skill>;
}

/** 外部 backend 同样校验模式；inline 不允许改变运行中的 Agent 或模型。 */
function validateSkill(value: unknown, bodyRequired = false): asserts value is Skill {
  if (!value || typeof value !== "object")
    throw new AgentError("invalid_skill", "Skill must be an object");
  const skill = value as Record<string, unknown>;
  if (
    typeof skill.name !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(skill.name) ||
    typeof skill.description !== "string" ||
    !skill.description.trim() ||
    byteLength(skill.description) > 1024
  )
    throw new AgentError("invalid_skill", "Invalid skill name or description");
  if (
    (skill.context !== undefined &&
      !["inline", "fork", "fork_with_context"].includes(skill.context as string)) ||
    [skill.agent, skill.model].some(
      (key) =>
        key !== undefined &&
        (typeof key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)),
    ) ||
    ((skill.context === undefined || skill.context === "inline") &&
      (skill.agent !== undefined || skill.model !== undefined))
  )
    throw new AgentError(
      "unsupported_skill",
      "Unsupported skill mode or inline agent/model override",
    );
  if (
    bodyRequired &&
    (typeof skill.content !== "string" ||
      !skill.content.trim() ||
      byteLength(skill.content) > 24_576)
  )
    throw new AgentError("invalid_skill", "Skill body must be nonempty text within 24 KiB");
}

/** YAML 使用 failsafe schema 且禁止 aliases，避免把元数据解析成可执行对象。 */
function parseSkill(text: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new AgentError("invalid_skill", "SKILL.md requires YAML frontmatter");
  try {
    const document = parseDocument(match[1]!, { schema: "failsafe", uniqueKeys: true });
    if (document.errors.length) throw new Error("invalid yaml");
    const metadata = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
    const skill = { ...metadata, content: match[2]!.trim() };
    validateSkill(skill, true);
    return skill;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("invalid_skill", "Cannot parse skill metadata");
  }
}

/** 只发现 root 的一级子目录中的 SKILL.md；路径经存储检查，不跟随链接。 */
export function createFilesystemSkills({ root }: { root: string }): SkillBackend {
  const store = new LocalFileStore(root, 32_768, 200);
  const files = new Map<string, string>();
  return {
    async list(signal) {
      const metadata: SkillMetadata[] = [];
      const discovered = new Map<string, string>();
      for (const entry of await store.list(".", signal)) {
        if (entry.type !== "directory") continue;
        const file = `${entry.path}/SKILL.md`;
        let text: string;
        try {
          text = await store.read(file, signal);
        } catch (error) {
          if (error instanceof ToolError && error.code === "not_found") continue;
          throw error;
        }
        const skill = parseSkill(text);
        if (discovered.has(skill.name))
          throw new AgentError("invalid_skill", "Duplicate skill name");
        discovered.set(skill.name, file);
        metadata.push({
          name: skill.name,
          description: skill.description,
          ...(skill.context ? { context: skill.context } : {}),
          ...(skill.agent ? { agent: skill.agent } : {}),
          ...(skill.model ? { model: skill.model } : {}),
        });
      }
      files.clear();
      discovered.forEach((file, name) => files.set(name, file));
      return metadata.sort((a, b) => a.name.localeCompare(b.name));
    },
    async get(name, signal) {
      checkAbort(signal);
      const file = files.get(name);
      if (!file) throw new ToolError("skill_not_found", "Skill is not registered");
      const skill = parseSkill(await store.read(file, signal));
      if (skill.name !== name)
        throw new AgentError("invalid_skill", "Skill identity changed after discovery");
      return { ...skill, baseDirectory: file.slice(0, -"/SKILL.md".length) };
    },
  };
}

/** Skill fork 只选择宿主提供的配置，不从 Markdown 构造客户端或授予执行权限。 */
export type SkillForkOptions<C> = {
  defaultAgent?: string;
  models?: Record<string, ChatModel>;
} & (
  | { agents: Record<string, AgentConfig<C>>; registry?: never }
  | { registry: AgentRegistry<C>; agents?: never }
);
export interface SkillToolOptions<C> {
  backend: SkillBackend;
  signal?: AbortSignal;
  fork?: SkillForkOptions<C>;
}

/**
 * 显式异步发现目录；inline 原样返回正文，fork 把正文交给独立 Agent。
 * 恢复时只使用已保存的子检查点，不重新加载可能变化的技能正文或执行已完成步骤。
 */
export async function createSkillTool<C = unknown>({
  backend,
  signal = AbortSignal.timeout(30_000),
  fork,
}: SkillToolOptions<C>): Promise<Tool<{ skill: string; request?: string }, C>> {
  checkAbort(signal);
  const metadata = structuredClone(
    await abortable(
      Promise.resolve().then(() => backend.list(signal)),
      signal,
    ),
  );
  if (!Array.isArray(metadata) || metadata.length > 200)
    throw new AgentError("invalid_skill", "Too many skills or invalid catalog");
  metadata.forEach((item) => validateSkill(item));
  const catalog = new Map(metadata.map((item) => [item.name, item]));
  if (catalog.size !== metadata.length)
    throw new AgentError("invalid_skill", "Duplicate skill name");
  const hasFork = metadata.some(
    (item) => item.context === "fork" || item.context === "fork_with_context",
  );
  if (hasFork && !fork)
    throw new AgentError(
      "unsupported_skill",
      "Fork skills require an explicit host Agent registry",
    );
  if (fork?.registry !== undefined && fork.agents !== undefined)
    throw new AgentError("invalid_config", "Choose either Skill agents or a shared registry");
  const agentConfigs = new Map(
    fork?.registry
      ? fork.registry.list().map((role) => [role.name, role.config] as const)
      : Object.entries(fork?.agents ?? {}),
  );
  const models = new Map(Object.entries(fork?.models ?? {}));
  const defaultAgent =
    fork?.defaultAgent ??
    fork?.registry?.defaultAgent ??
    (agentConfigs.size === 1 ? [...agentConfigs.keys()][0] : undefined);
  if (defaultAgent !== undefined && !agentConfigs.has(defaultAgent))
    throw new AgentError("invalid_skill", "Default fork Agent is not registered");
  const children = new Map<string, Agent<C>>();
  const routes = new Map<string, { name: string; signature: string }>();
  const routeOf = (skill: SkillMetadata) =>
    JSON.stringify([skill.context ?? "inline", skill.agent ?? defaultAgent, skill.model ?? null]);
  for (const item of metadata) {
    if (item.context !== "fork" && item.context !== "fork_with_context") continue;
    const key = item.agent ?? defaultAgent;
    const configuration = key ? agentConfigs.get(key) : undefined;
    if (!key || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || !configuration)
      throw new AgentError("invalid_skill", "Fork Agent is not registered by the host");
    const model = item.model ? models.get(item.model) : configuration.model;
    if (!model) throw new AgentError("invalid_skill", "Fork model is not registered by the host");
    // namespace 区分技能、Agent 和显式模型键；实现变化仍由宿主升级自己的 namespace。
    children.set(
      item.name,
      createAgent({
        ...configuration,
        model,
        ...(configuration.checkpoints
          ? {
              checkpoints: {
                ...configuration.checkpoints,
                namespace: `${configuration.checkpoints.namespace}/skill/${item.name}/${key}/${item.model ?? "default"}`,
              },
            }
          : {}),
      }),
    );
    routes.set(item.name, { name: key, signature: routeOf(item) });
  }
  const description = hasFork
    ? "按名称使用 Skill。inline 返回正文；fork 在独立 Agent 中执行；fork_with_context 继承完整父对话。\n" +
      metadata
        .map(
          (item) =>
            `${item.name}: ${item.description} [${item.context ?? "inline"}, agent=${item.agent ?? defaultAgent ?? "-"}, model=${item.model ?? "default"}]`,
        )
        .join("\n")
    : "按名称加载 inline Skill 指令；不启动子 Agent、不执行脚本。\n" +
      metadata.map((item) => `${item.name}: ${item.description}`).join("\n");
  if (byteLength(description) > 32_768)
    throw new AgentError("invalid_skill", "Skill catalog is too large");

  async function* stream(
    args: { skill: string; request?: string },
    ctx: ToolContext<C>,
  ): AsyncGenerator<ToolChunk> {
    const entry = catalog.get(args.skill);
    if (!entry) throw new ToolError("skill_not_found", "Skill is not registered");
    const route = routes.get(args.skill);
    let content = "";
    let continuation = ctx.continuation;
    if (continuation !== undefined) {
      const saved = continuation as {
        kind?: string;
        skill?: string;
        route?: string;
        child?: JsonValue;
      };
      if (
        !saved ||
        saved.kind !== "skill-fork" ||
        saved.skill !== args.skill ||
        !route ||
        saved.route !== route.signature ||
        saved.child === undefined
      )
        throw new AgentError("checkpoint_mismatch", "Skill route changed since interruption");
      continuation = saved.child;
    } else {
      const skill = await backend.get(args.skill, ctx.signal);
      validateSkill(skill, true);
      if (skill.name !== args.skill || routeOf(skill) !== routeOf(entry))
        throw new AgentError(
          "invalid_skill",
          "Skill identity or execution mode changed after discovery",
        );
      content = `Skill: ${skill.name}\n${skill.content}`;
    }
    if (!route) {
      yield { type: "result", result: { ok: true, content } };
      return;
    }
    const child = createAgentTool({
      name: route.name,
      description: entry.description,
      agent: children.get(args.skill)!,
      history: entry.context === "fork_with_context" ? "inherit" : "isolated",
    });
    try {
      yield* child.stream!(
        { request: content + (args.request ? `\n\n任务要求：${args.request}` : "") },
        { ...ctx, ...(continuation !== undefined ? { continuation } : {}) },
      );
    } catch (error) {
      if (error instanceof AgentToolInterrupt)
        throw new AgentToolInterrupt(error.info, {
          kind: "skill-fork",
          skill: args.skill,
          route: route.signature,
          child: error.continuation,
        });
      throw error;
    }
  }
  return defineTool({
    name: "skill",
    description,
    effect: hasFork ? "execute" : "read",
    ...(hasFork ? { delegates: true, stream } : {}),
    inputSchema: {
      type: "object",
      required: ["skill"],
      additionalProperties: false,
      properties: {
        skill: { type: "string", minLength: 1, maxLength: 64 },
        ...(hasFork ? { request: { type: "string", maxLength: 8192 } } : {}),
      },
    },
    async execute(args, ctx) {
      for await (const chunk of stream(args, ctx)) if (chunk.type === "result") return chunk.result;
      throw new AgentError("incomplete_agent_run", "Skill did not produce a result");
    },
  });
}
