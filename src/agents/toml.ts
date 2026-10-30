import { parse } from "smol-toml";
import { AgentError } from "../protocol/errors.js";
import type { AgentConfig, ChatModel } from "../protocol/types.js";
import { LocalFileStore } from "../backends/local-filesystem.js";
import { checkAbort } from "../runtime/control.js";
import { createAgentPreset } from "../prebuilt/roles.js";
import type { AgentPresetName } from "../prebuilt/roles.js";
import { createAgentRegistry } from "./registry.js";
import type { AgentRole } from "./registry.js";

/** TOML 只引用宿主提供的模型与工具；不从文件构造客户端、凭证或进程执行器。 */
export interface LoadAgentRolesOptions<C> {
  /** 显式传入配置目录，例如 .enio/agents；只读取本层普通 .toml 文件。 */
  root: string;
  /** 默认模型、工具白名单、ACL、预算、检查点和中间件等宿主配置。 */
  defaults: AgentConfig<C>;
  /** TOML model 字段只允许引用此表的键，省略时使用 defaults.model。 */
  models?: Record<string, ChatModel>;
  signal?: AbortSignal;
}

const FIELDS = new Set([
  "name",
  "description",
  "developer_instructions",
  "preset",
  "model",
  "tools",
  "history",
]);

/**
 * 加载完整目录后统一返回；任意文件无效则整批失败，不静默丢失业务角色。
 * 目录最多 200 个角色、单文件 32 KiB；复用 LocalFileStore 的普通文件与链接检查。
 * 不扫描用户目录、不执行 TOML 内容，不热更新已创建的 Agent 或已有检查点。
 */
export async function loadAgentRoles<C = unknown>({
  root,
  defaults,
  models = {},
  signal = AbortSignal.timeout(30_000),
}: LoadAgentRolesOptions<C>): Promise<AgentRole<C>[]> {
  checkAbort(signal);
  const store = new LocalFileStore(root, 32_768, 1000);
  const files = (await store.list(".", signal))
    .filter((entry) => entry.type === "file" && entry.path.endsWith(".toml"))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > 200)
    throw new AgentError("invalid_agent_config", "Too many TOML Agent definitions");
  // 注册表提前校验宿主基线，避免重复工具名在 Map 转换时被掩盖。
  createAgentRegistry({
    roles: [{ name: "defaults", description: "host defaults", config: defaults }],
  });
  const availableTools = new Map((defaults.tools ?? []).map((tool) => [tool.name, tool]));
  const availableModels = new Map(Object.entries(models));
  const roles: AgentRole<C>[] = [];
  for (const file of files) {
    checkAbort(signal);
    // 错误仅包含文件名和字段名，不回显可能误写到文件中的密钥或原始正文。
    const invalid = (reason: string): never => {
      throw new AgentError("invalid_agent_config", `${file.path}: ${reason}`);
    };
    const text = await store.read(file.path, signal);
    const data: Record<string, unknown> = (() => {
      try {
        return parse(text);
      } catch {
        return invalid("Invalid TOML syntax");
      }
    })();
    if (Object.keys(data).some((key) => !FIELDS.has(key))) invalid("Unsupported field");
    const requiredText = (key: string, maxBytes: number): string => {
      const value = data[key];
      if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maxBytes)
        return invalid(`Invalid ${key}`);
      return value;
    };
    const name = requiredText("name", 64);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) invalid("Invalid name");
    const description = requiredText("description", 1024);
    const instructions = requiredText("developer_instructions", 24_576);
    if (data.history !== undefined && !["isolated", "inherit"].includes(data.history as string))
      invalid("Invalid history");
    if (
      data.preset !== undefined &&
      !["general-purpose", "explorer", "worker"].includes(data.preset as string)
    )
      invalid("Unknown preset");
    let model = defaults.model;
    if (data.model !== undefined) {
      if (typeof data.model !== "string" || !availableModels.has(data.model))
        invalid("Unknown model alias");
      model = availableModels.get(data.model as string)!;
    }
    const selected = data.tools ?? [...availableTools.keys()];
    if (
      !Array.isArray(selected) ||
      selected.some((key) => typeof key !== "string" || !availableTools.has(key)) ||
      new Set(selected).size !== selected.length
    )
      invalid("Invalid or unregistered tools");
    const names = new Set(selected as string[]);
    const config: AgentConfig<C> = {
      ...defaults,
      model,
      instructions: [defaults.instructions, instructions].filter(Boolean).join("\n\n"),
      tools: (selected as string[]).map((key) => availableTools.get(key)!),
    };
    const role: AgentRole<C> = data.preset
      ? createAgentPreset(data.preset as AgentPresetName, config)
      : { name, description, config };
    // 在宿主中间件和预设过滤之后再收窄，tools=[] 也不能被动态装配加回工具。
    role.config.middlewares = [
      ...(role.config.middlewares ?? []),
      {
        name: `enio-toml-tools-${name}`,
        beforeAgent(setup) {
          return { ...setup, tools: setup.tools.filter((tool) => names.has(tool.name)) };
        },
      },
    ];
    roles.push({
      ...role,
      name,
      description,
      history: data.history as "isolated" | "inherit" | undefined,
    });
  }
  checkAbort(signal);
  // 空目录可与内置预设组合；非空目录拒绝重复角色，返回独立配置快照。
  return roles.length ? createAgentRegistry({ roles }).list() : [];
}
