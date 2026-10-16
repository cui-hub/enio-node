import { parseDocument } from "yaml";
import { AgentError, ToolError } from "../protocol/errors.js";
import type { Tool } from "../protocol/types.js";
import { defineTool } from "../tools/registry.js";
import { abortable, byteLength, checkAbort } from "../runtime/control.js";
import { LocalFileStore } from "../backends/local-filesystem.js";

/** name/description 在创建时发现，正文仅在 skill 工具被调用时进入模型上下文。 */
export interface SkillMetadata {
  name: string;
  description: string;
}
/** 一期仅支持 inline；资源目录不会自动变成 execute 权限。 */
export interface Skill extends SkillMetadata {
  content: string;
  baseDirectory?: string;
}
/** 可由业务实现数据库或远端技能库，接口本身不依赖 Agent 或 Graph。 */
export interface SkillBackend {
  list(signal: AbortSignal): Promise<SkillMetadata[]>;
  get(name: string, signal: AbortSignal): Promise<Skill>;
}

/** 外部 backend 也要校验模式；拒绝 fork、模型覆盖及未知可执行配置。 */
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
    (skill.context !== undefined && skill.context !== "inline") ||
    skill.agent !== undefined ||
    skill.model !== undefined
  )
    throw new AgentError(
      "unsupported_skill",
      "Only inline skills without agent/model overrides are supported",
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
        metadata.push({ name: skill.name, description: skill.description });
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

/**
 * 显式异步初始化便于启动时发现配置错误，createAgent 自身仍保持同步。
 * 构建工具不会授予额外能力；加载结果只作为普通 ToolResult 回填当前 Agent。
 */
export async function createSkillTool<C = unknown>({
  backend,
  signal = AbortSignal.timeout(30_000),
}: {
  backend: SkillBackend;
  signal?: AbortSignal;
}): Promise<Tool<{ skill: string }, C>> {
  checkAbort(signal);
  const metadata = await abortable(
    Promise.resolve().then(() => backend.list(signal)),
    signal,
  );
  if (metadata.length > 200) throw new AgentError("invalid_skill", "Too many skills");
  metadata.forEach((item) => validateSkill(item));
  const names = new Set(metadata.map((item) => item.name));
  if (names.size !== metadata.length) throw new AgentError("invalid_skill", "Duplicate skill name");
  const description =
    "按名称加载 inline Skill 指令；不启动子 Agent、不执行脚本。\n" +
    metadata.map((item) => `${item.name}: ${item.description}`).join("\n");
  if (byteLength(description) > 32_768)
    throw new AgentError("invalid_skill", "Skill catalog is too large");
  return defineTool({
    name: "skill",
    description,
    effect: "read",
    inputSchema: {
      type: "object",
      required: ["skill"],
      additionalProperties: false,
      properties: { skill: { type: "string", minLength: 1, maxLength: 64 } },
    },
    async execute({ skill: name }, ctx) {
      if (!names.has(name)) throw new ToolError("skill_not_found", "Skill is not registered");
      const skill = await backend.get(name, ctx.signal);
      validateSkill(skill, true);
      if (skill.name !== name)
        throw new AgentError("invalid_skill", "Skill backend returned a different identity");
      return { ok: true, content: `Skill: ${skill.name}\n${skill.content}` };
    },
  });
}
