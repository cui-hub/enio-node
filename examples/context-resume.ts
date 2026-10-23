import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgent,
  createArtifactTool,
  createFileArtifactStore,
  createFileCheckpointStore,
  createScriptedModel,
  createSummarization,
  createToolResultReduction,
  defineTool,
  exportState,
  interrupt,
  parseState,
  serializeState,
} from "../src/index.js";
import type { Message } from "../src/index.js";

/** 离线学习示例：摘要 → 日志外置 → 写操作前中断 → 新实例恢复 → 状态持久化。 */
const root = await mkdtemp(path.join(os.tmpdir(), "enio-context-resume-"));
await mkdir(path.join(root, "artifacts"));
await mkdir(path.join(root, "checkpoints"));
const artifacts = createFileArtifactStore({ root: path.join(root, "artifacts") });
const readLogs = defineTool({
  name: "read_logs",
  description: "读取任务的完整日志",
  effect: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    return { ok: true, content: "测试日志：所有检查通过。\n".repeat(3000) };
  },
});
let submissions = 0;
const submit = defineTool({
  name: "submit_report",
  description: "确认后提交报告",
  effect: "write",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    submissions++;
    return { ok: true, content: "报告已提交" };
  },
});

/** 模型使用历史判断下一步，没有依赖闭包游标，重建 Agent 也能继续。 */
const model = createScriptedModel(({ messages }) => {
  const latestTool = messages.filter((message) => message.role === "tool").at(-1);
  if (latestTool?.toolCallId === "submit-1")
    return { message: { role: "assistant", content: "报告已确认并提交。" }, finishReason: "stop" };
  const name = latestTool ? "submit_report" : "read_logs";
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: latestTool ? "submit-1" : "logs-1", name, arguments: "{}" }],
    },
    finishReason: "tool_calls",
  };
});
const summaryModel = createScriptedModel(() => ({
  message: {
    role: "assistant",
    content: "历史讨论确定：读取测试日志，确认通过后提交报告；提交前等待用户确认。",
  },
  finishReason: "stop",
}));

function buildAgent() {
  return createAgent({
    model,
    tools: [readLogs, submit, createArtifactTool({ store: artifacts })],
    contextPolicies: [
      createToolResultReduction({ store: artifacts, maxOutputBytes: 1024 }),
      createSummarization({ model: summaryModel, triggerMessages: 2, keepRecentMessages: 3 }),
    ],
    checkpoints: {
      store: createFileCheckpointStore({ root: path.join(root, "checkpoints") }),
      namespace: "context-resume-demo-v1",
    },
    hooks: {
      beforeTool(call, ctx) {
        if (call.name !== "submit_report") return;
        if (!ctx.resume) return interrupt({ question: "确认提交报告吗？" });
        // 恢复只提供输入；是否放行由宿主逻辑决定，不会跳过权限检查。
        return ctx.resume.data === true;
      },
      onEvent(event) {
        if (event.type === "context_updated") console.log("上下文已整理", event.payload);
      },
    },
  });
}

const history: Message[] = [
  { role: "user", content: "较早的项目讨论。".repeat(1000) },
  { role: "assistant", content: "已经明确报告需要附上测试结论。".repeat(500) },
];
const runOptions = { context: {}, checkpointOwner: "demo-user:demo-conversation" };
const first = await buildAgent().run(
  { input: "读取日志并提交报告", messages: history },
  runOptions,
);
if (first.status !== "interrupted" || !first.interrupt)
  throw new Error(`Expected interrupt: ${first.stopReason}`);
console.log("等待确认", first.interrupt.info, "已提交次数", submissions);

// 仅演示模拟宿主确认。真实应用应从已鉴权的交互请求取得确认结果。
const result = await buildAgent().resume(
  { checkpointId: first.interrupt.checkpointId, data: true },
  runOptions,
);
if (result.status !== "completed") throw new Error(`Resume failed: ${result.stopReason}`);
const text = serializeState(exportState(result));
await writeFile(path.join(root, "working-state.json"), text, { mode: 0o600 });
console.log(result.finalText, "已提交次数", submissions);
console.log("下一轮可传入的消息数", parseState(text).messages.length);
console.log("示例状态与外置内容目录", root);
