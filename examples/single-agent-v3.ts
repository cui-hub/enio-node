import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createAgent, createScriptedModel, defineTool, ModelError } from "../src/index.js";
import type { AgentMiddleware, ChatModel, ToolContext, ToolResult } from "../src/index.js";

/** 离线示例：读取仓库自带的固定资料，无凭证、写入和外部网络依赖。 */
type DemoContext = { taskName: string };
type ReadInput = { source: string };
const sources = new Map([
  ["metrics", new URL("./fixtures/metrics.md", import.meta.url)],
  ["risks", new URL("./fixtures/risks.md", import.meta.url)],
]);

/** 两个执行入口共享读取逻辑；Runner 选择 stream，不会额外调用 execute。 */
async function readSource(args: ReadInput, ctx: ToolContext<DemoContext>): Promise<ToolResult> {
  const content = await readFile(sources.get(args.source)!, {
    encoding: "utf8",
    signal: ctx.signal,
  });
  return { ok: true, content };
}
const inspect = defineTool<ReadInput, DemoContext>({
  name: "inspect_source",
  description: "读取预置的 metrics 或 risks 资料",
  effect: "read",
  parallelSafe: true, // 工具只读取固定文件，不修改共享状态；允许宿主开启并发。
  inputSchema: {
    type: "object",
    properties: { source: { type: "string", enum: [...sources.keys()] } },
    required: ["source"],
    additionalProperties: false,
  },
  execute: readSource,
  async *stream(args, ctx) {
    yield { type: "text_delta", text: `开始读取 ${args.source}` };
    // 模拟不同读取耗时，让终端能观察到两个调用的进度交错；signal 仍控制等待。
    await delay(args.source === "metrics" ? 25 : 10, undefined, { signal: ctx.signal });
    const result = await readSource(args, ctx);
    yield { type: "text_delta", text: `读取完成 ${args.source}` };
    yield { type: "result", result };
  },
});

/** 已形成的报告直接交付，避免让模型再改写一次。 */
const deliver = defineTool<{ report: string }, DemoContext>({
  name: "deliver_report",
  description: "交付带来源的资料摘录，结果直接作为最终回答",
  effect: "read",
  returnDirect: true,
  inputSchema: {
    type: "object",
    properties: { report: { type: "string", minLength: 1 } },
    required: ["report"],
    additionalProperties: false,
  },
  async execute({ report }) {
    return { ok: true, content: report };
  },
});

/** 真实接入时将两者换成 createOpenAICompatibleModel 返回的实例。 */
const primary: ChatModel = {
  async generate() {
    throw new ModelError("network", "演示主模型不可用", true);
  },
};
const backup = createScriptedModel(({ messages }) => {
  const outputs = messages.filter((message) => message.role === "tool");
  if (!outputs.length) {
    return {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [...sources.keys()].map((source) => ({
          id: `read-${source}`,
          name: inspect.name,
          arguments: JSON.stringify({ source }),
        })),
      },
      finishReason: "tool_calls",
    };
  }
  // 脚本模型只拼接原文，便于确定性验收；这一步不是自然语言推理。
  const report = [...sources.keys()]
    .map((source) => {
      const output = outputs.find((message) => message.toolCallId === `read-${source}`)!;
      const result = JSON.parse(output.content) as ToolResult;
      if (!result.ok) throw new Error(result.message);
      return `来源：examples/fixtures/${source}.md\n${result.content.trim()}`;
    })
    .join("\n\n");
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "deliver", name: deliver.name, arguments: JSON.stringify({ report }) }],
    },
    finishReason: "tool_calls",
  };
});

const trace: AgentMiddleware<DemoContext> = {
  name: "demo-trace",
  beforeAgent(setup, ctx) {
    return { ...setup, instructions: `任务：${ctx.context.taskName}。所有资料必须带来源。` };
  },
  async *wrapModel(request, ctx, next) {
    console.log(`[模型] index=${ctx.modelIndex} attempt=${ctx.attempt}`);
    yield* next(request); // 每个尝试仅调用一次；重试和备用模型由 Runner 管理。
  },
  async *wrapTool(call, _ctx, next) {
    console.log(`[工具] ${call.id}`);
    yield* next(); // 校验与权限检查已经完成，包装器不能替换已鉴权的参数。
  },
  afterAgent(snapshot) {
    console.log(`[完成钩子] 保存 ${snapshot.messages.length} 条工作消息`);
  },
};

const agent = createAgent<DemoContext>({
  model: primary,
  modelFailover: { models: [backup] },
  middlewares: [trace],
  tools: [inspect, deliver],
  toolExecution: { maxConcurrency: 2 },
  limits: { maxModelRetries: 0 }, // 示例立即切换；真实业务可以保留默认重试预算。
});
for await (const event of agent.stream(
  { input: "读取指标和风险资料，交付带来源的摘录。" },
  { context: { taskName: "V3 文件资料摘录" } },
)) {
  if (event.type === "model_fallback")
    console.log(`[切换] ${event.payload.from} → ${event.payload.to}`);
  if (event.type === "tool_output") console.log(`[进度 ${event.payload.id}] ${event.payload.text}`);
  if (event.type === "run_end") {
    const result = event.payload.result;
    if (result.status !== "completed") throw new Error(JSON.stringify(result.error));
    if (result.stopReason !== "return_direct" || result.iterations !== 2 || result.toolCalls !== 3)
      throw new Error("V3 示例没有按预期完成两轮模型调用和三次工具调用");
    console.log(`\n${result.finalText}\n\n结束原因：${result.stopReason}`);
  }
}
