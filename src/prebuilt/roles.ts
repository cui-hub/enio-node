import { AgentError } from "../protocol/errors.js";
import type { AgentConfig, Tool } from "../protocol/types.js";
import type { AgentRole } from "../agents/registry.js";

/** 预设只规定职责和工具边界；模型、backend、权限及预算仍由业务提供。 */
export type AgentPresetName = "general-purpose" | "explorer" | "worker";

const PRESETS = {
  "general-purpose": {
    description: "处理独立的分析、文件和验证任务",
    instructions: "完成交付的独立子任务，按需使用工具，并返回结论、依据及未解决的问题。",
  },
  explorer: {
    description: "只读探索代码和资料，定位入口、调用链与证据",
    instructions: "只读分析代码与资料，不修改文件、不执行命令。返回关键路径、证据和不确定项。",
  },
  worker: {
    description: "按明确要求实现功能、修改文件并验证结果",
    instructions: "在任务给定的范围内实施改动，保护已有工作，使用可用工具验证并报告结果。",
  },
} satisfies Record<AgentPresetName, { description: string; instructions: string }>;

/**
 * 创建可选角色，不自动加入任何主 Agent。所有预设移除委派工具，避免隐式递归。
 * explorer 仅保留 effect=read 工具；最终装配再次过滤，防止中间件意外加回写入能力。
 * effect 和宿主回调仍是受信任声明，这个约束不是操作系统或外部服务沙箱。
 */
export function createAgentPreset<C = unknown>(
  name: AgentPresetName,
  configuration: AgentConfig<C>,
): AgentRole<C> {
  if (!Object.hasOwn(PRESETS, name)) throw new AgentError("invalid_config", "Unknown Agent preset");
  const preset = PRESETS[name];
  const accepts = (tool: Tool<unknown, C>) =>
    !tool.delegates && (name !== "explorer" || tool.effect === "read");
  return {
    name,
    description: preset.description,
    effect: name === "explorer" ? "read" : "execute",
    config: {
      ...configuration,
      instructions: [preset.instructions, configuration.instructions].filter(Boolean).join("\n\n"),
      tools: (configuration.tools ?? []).filter(accepts),
      middlewares: [
        ...(configuration.middlewares ?? []),
        {
          name: `enio-preset-${name}`,
          beforeAgent(setup) {
            return { ...setup, tools: setup.tools.filter(accepts) };
          },
        },
      ],
      ...(name === "explorer"
        ? {
            allowTool(tool, context) {
              return tool.effect === "read" && (configuration.allowTool?.(tool, context) ?? true);
            },
          }
        : {}),
    },
  };
}
