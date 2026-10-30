import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  createAgentPreset,
  createAgentRegistry,
  createDeepAgent,
  createFileTools,
  createMemoryFilesystem,
  createScriptedModel,
  createSkillTool,
  loadAgentRoles,
} from "../src/index.js";
import type { Message, ModelResponse, ToolResult } from "../src/index.js";

/** 离线模型仅用于稳定展示接入链路；业务接入时换成真实模型适配器。 */
function call(name: string, args: unknown, id: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ name, arguments: JSON.stringify(args), id }],
    },
    finishReason: "tool_calls",
  };
}
function answer(content: string): ModelResponse {
  return { message: { role: "assistant", content }, finishReason: "stop" };
}
function output(messages: Message[], id: string): string | undefined {
  const message = messages.find((m) => m.role === "tool" && m.toolCallId === id);
  if (!message) return;
  const result = JSON.parse(message.content) as ToolResult;
  if (!result.ok) throw new Error(result.code);
  return result.content;
}

/** 三种可选预设与一个 TOML 角色共用注册表；task 和 fork Skill 都调用同一业务角色。 */
export async function runAgentRolesDemo(log: (line: string) => void = console.log) {
  const backend = createMemoryFilesystem({
    files: { "fixtures/metrics.md": "订单成功率：99.9%。" },
    writable: ["reports/**"],
  });
  const tools = createFileTools({ backend });
  const model = createScriptedModel(({ messages }) => {
    if (output(messages, "save")) return answer("已保存报告。");
    return call(
      "write_file",
      { path: "reports/summary.md", content: messages.at(-1)!.content },
      "save",
    );
  });
  const reviewModel = createScriptedModel(({ messages }) => {
    const read = output(messages, "source");
    if (!read) return call("read_file", { path: "fixtures/metrics.md" }, "source");
    return answer(
      `来源：fixtures/metrics.md\n${(JSON.parse(read) as { content: string }).content}`,
    );
  });
  const defaults = { model, tools };
  const registry = createAgentRegistry({
    defaultAgent: "general-purpose",
    roles: [
      createAgentPreset("general-purpose", defaults),
      createAgentPreset("explorer", defaults),
      createAgentPreset("worker", defaults),
      ...(await loadAgentRoles({
        root: fileURLToPath(new URL("./agents", import.meta.url)),
        defaults,
        models: { review: reviewModel },
      })),
    ],
  });
  const metadata = {
    name: "report",
    description: "读取指标并准备报告",
    context: "fork" as const,
    agent: "report-reviewer",
  };
  const skill = await createSkillTool({
    backend: {
      async list() {
        return [metadata];
      },
      async get() {
        return { ...metadata, content: "读取指标资料，返回带来源的报告草稿。" };
      },
    },
    fork: { registry },
  });
  const rolesUsed: string[] = [];
  const agent = createDeepAgent({
    registry,
    tools: [skill],
    model: createScriptedModel(({ messages }) => {
      if (!output(messages, "task-review"))
        return call("task", { agent: "report-reviewer", request: "检查指标来源。" }, "task-review");
      const report = output(messages, "skill-review");
      if (!report) return call("skill", { skill: "report" }, "skill-review");
      if (!output(messages, "write"))
        return call("task", { agent: "worker", request: report }, "write");
      return answer("共享角色与 TOML 业务 Agent 示例完成。");
    }),
    hooks: {
      onEvent(event) {
        if (event.type === "agent_event" && event.payload.event.type === "run_start") {
          const name = event.payload.path.at(-1)!.name;
          rolesUsed.push(name);
          log(`启动角色：${name}`);
        }
      },
    },
  });
  const result = await agent.run({ input: "分析指标并保存报告。" }, { context: {} });
  if (result.status !== "completed") throw new Error(result.error?.code ?? result.stopReason);
  const report = await backend.readFile(
    { path: "reports/summary.md" },
    new AbortController().signal,
  );
  log(`${result.finalText}\n${report.content}`);
  return {
    result,
    report: report.content,
    rolesUsed,
    names: registry.list().map((role) => role.name),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await runAgentRolesDemo();
