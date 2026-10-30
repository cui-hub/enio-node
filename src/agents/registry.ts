import { AgentError } from "../protocol/errors.js";
import type { AgentConfig, Tool } from "../protocol/types.js";
import { createAgent } from "../runtime/agent.js";
import { ToolRegistry } from "../tools/registry.js";

/** 角色描述用于模型选择；config 只供宿主装配，不进入工具参数或提示词。 */
export interface AgentRole<C = unknown> {
  name: string;
  description: string;
  config: AgentConfig<C>;
  /** task 默认 isolated；Skill 始终由自己的 context 字段决定历史传递方式。 */
  history?: "isolated" | "inherit";
  /** 默认 execute；只有宿主确认整个角色只读时才声明 read。 */
  effect?: Tool["effect"];
}

/** 同一份角色配置供 task、Skill 和 DeepAgent 使用，每次运行的消息和状态仍独立。 */
export interface AgentRegistry<C = unknown> {
  readonly defaultAgent: string | undefined;
  list(): AgentRole<C>[];
  get(name: string): AgentRole<C> | undefined;
}

/** 复制配置容器和工具元数据，保留模型、store、backend 与宿主回调的实例身份。 */
function copyConfig<C>(config: AgentConfig<C>): AgentConfig<C> {
  return {
    ...config,
    tools: config.tools?.map((tool) => ({
      ...tool,
      inputSchema: structuredClone(tool.inputSchema),
    })),
    limits: config.limits && { ...config.limits },
    hooks: config.hooks && { ...config.hooks },
    checkpoints: config.checkpoints && { ...config.checkpoints },
    delegation: config.delegation && { ...config.delegation },
    toolExecution: config.toolExecution && { ...config.toolExecution },
    middlewares: config.middlewares && [...config.middlewares],
    contextPolicies: config.contextPolicies && [...config.contextPolicies],
    modelFailover: config.modelFailover && {
      ...config.modelFailover,
      models: [...config.modelFailover.models],
    },
  };
}

/**
 * 显式创建稳定的角色目录；重复名称、错误默认项和无效配置在装配时失败。
 * 只有一个角色时可省略 defaultAgent；多个角色不会按注册顺序猜测默认角色。
 */
export function createAgentRegistry<C = unknown>({
  roles,
  defaultAgent,
}: {
  roles: AgentRole<C>[];
  defaultAgent?: string;
}): AgentRegistry<C> {
  if (!Array.isArray(roles) || !roles.length || roles.length > 200)
    throw new AgentError("invalid_config", "Agent registry requires 1 to 200 roles");
  const entries = new Map<string, AgentRole<C>>();
  for (const role of roles) {
    if (
      typeof role?.name !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(role.name) ||
      entries.has(role.name) ||
      typeof role.description !== "string" ||
      !role.description.trim() ||
      Buffer.byteLength(role.description) > 1024 ||
      (role.history !== undefined && !["isolated", "inherit"].includes(role.history)) ||
      (role.effect !== undefined && !["read", "write", "execute"].includes(role.effect)) ||
      !role.config
    )
      throw new AgentError("invalid_config", "Invalid or duplicate Agent role");
    // createAgent 只校验配置，不调用模型、不加载 AGENTS.md，也不执行工具。
    createAgent(role.config);
    const config = copyConfig(role.config);
    config.tools = new ToolRegistry(role.config.tools ?? []).tools();
    entries.set(role.name, { ...role, config });
  }
  if (defaultAgent !== undefined && !entries.has(defaultAgent))
    throw new AgentError("invalid_config", "Default Agent is not registered");
  const copyRole = (role: AgentRole<C>): AgentRole<C> => ({
    ...role,
    config: copyConfig(role.config),
  });
  return Object.freeze({
    defaultAgent: defaultAgent ?? (entries.size === 1 ? [...entries.keys()][0] : undefined),
    list: () => [...entries.values()].map(copyRole),
    get: (name: string) => {
      const role = entries.get(name);
      return role && copyRole(role);
    },
  });
}
