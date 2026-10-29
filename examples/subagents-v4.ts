import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createDeepAgent,
  createFileTools,
  createFilesystemSkills,
  createSkillTool,
  createFileCheckpointStore,
  createLocalFilesystem,
  createScriptedModel,
  interrupt,
} from "../src/index.js";
import type { AgentEvent, Message, ModelResponse, RunResult, ToolResult } from "../src/index.js";

/** 脚本模型只为离线验收驱动固定步骤；真实接入时替换为模型适配器即可。 */
function ask(name: string, args: unknown, id: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    },
    finishReason: "tool_calls",
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}
function answer(content: string): ModelResponse {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}
/** 所有模型决策依赖已保存历史，重建实例后不需要复原闭包中的脚本游标。 */
function output(messages: Message[], id: string): string | undefined {
  const message = messages.find((message) => message.role === "tool" && message.toolCallId === id);
  if (!message) return;
  const result = JSON.parse(message.content) as ToolResult;
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.content;
}

/** 创建真实临时工作区并保留报告；测试调用方负责清理自己的目录。 */
export async function runV4Demo(log: (line: string) => void = console.log) {
  const root = await mkdtemp(path.join(tmpdir(), "enio-v4-"));
  await mkdir(path.join(root, "fixtures"));
  await mkdir(path.join(root, ".checkpoints"));
  await copyFile(
    new URL("./fixtures/metrics.md", import.meta.url),
    path.join(root, "fixtures/metrics.md"),
  );
  let sourceReads = 0;
  let writes = 0;
  const events: AgentEvent[] = [];

  /** 模拟进程重启：每次创建全新的 Agent 树、工具、backend 和文件检查点 store。 */
  const build = async () => {
    const store = createFileCheckpointStore({ root: path.join(root, ".checkpoints") });
    const readonly = createLocalFilesystem({ root, readable: ["fixtures/**"], writable: [] });
    const writable = createLocalFilesystem({
      root,
      readable: ["reports/**"],
      writable: ["reports/**"],
    });
    const skill = await createSkillTool({
      backend: createFilesystemSkills({
        root: fileURLToPath(new URL("./v4-skills", import.meta.url)),
      }),
      fork: {
        agents: {
          reviewer: {
            model: createScriptedModel(({ messages }) => {
              const read = output(messages, "source");
              if (!read) return ask("read_file", { path: "fixtures/metrics.md" }, "source");
              return answer(
                `# 指标报告\n\n来源：fixtures/metrics.md\n\n${(JSON.parse(read) as { content: string }).content}`,
              );
            }),
            tools: createFileTools({ backend: readonly }),
            hooks: {
              beforeTool() {
                sourceReads++;
              },
            },
          },
        },
      },
    });
    const writer = createDeepAgent({
      generalAgent: false,
      filesystem: writable,
      checkpoints: { store, namespace: "demo-v4/writer" },
      model: createScriptedModel(({ messages }) => {
        const body = messages.find((message) => message.role === "user")!.content;
        if (!output(messages, "plan"))
          return ask(
            "write_todos",
            { todos: [{ id: "write", content: "保存子任务报告", status: "in_progress" }] },
            "plan",
          );
        if (!output(messages, "save"))
          return ask("write_file", { path: "reports/summary.md", content: body }, "save");
        if (!output(messages, "verify"))
          return ask("read_file", { path: "reports/summary.md" }, "verify");
        if (!output(messages, "done"))
          return ask(
            "write_todos",
            { todos: [{ id: "write", content: "保存子任务报告", status: "completed" }] },
            "done",
          );
        return answer("已保存 reports/summary.md，并回读校验。");
      }),
      hooks: {
        beforeTool(call, ctx) {
          if (call.name !== "write_file") return;
          // 宿主明确确认后才执行写入；确认数据不由模型生成。
          if (!ctx.resume) return interrupt({ action: "write_report", path: "reports/summary.md" });
          return ctx.resume.data === true;
        },
        onEvent(event) {
          if (
            event.type === "tool_end" &&
            event.payload.name === "write_file" &&
            event.payload.result.ok
          )
            writes++;
        },
      },
    });
    return createDeepAgent({
      generalAgent: false,
      tools: [skill],
      subAgents: [{ name: "writer", description: "保存报告并回读校验", agent: writer }],
      checkpoints: { store, namespace: "demo-v4/root" },
      delegation: { maxDepth: 2, maxCalls: 4 },
      model: createScriptedModel(({ messages }) => {
        const review = output(messages, "review");
        if (!review) return ask("skill", { skill: "source-review" }, "review");
        const written = output(messages, "writer");
        if (!written) return ask("task", { agent: "writer", request: review }, "writer");
        return answer(`V4 文件任务完成：${written}`);
      }),
    });
  };

  /** 父流只有一个终止结果；嵌套事件带路径，UI 可独立渲染每个子任务。 */
  const consume = async (stream: AsyncIterable<AgentEvent>): Promise<RunResult> => {
    let terminal: RunResult | undefined;
    for await (const event of stream) {
      events.push(event);
      if (event.type === "agent_event") {
        const { path, event: child } = event.payload;
        if (["run_start", "run_interrupted", "run_resumed", "run_end"].includes(child.type))
          log(`[子任务 ${path.map((part) => part.name).join("/")}] ${child.type}`);
      }
      if (event.type === "run_end") terminal = event.payload.result;
    }
    if (!terminal) throw new Error("缺少根运行终止事件");
    return terminal;
  };
  const options = { context: {}, checkpointOwner: "local-v4-demo" };
  const first = await consume(
    (await build()).stream({ input: "分析指标资料，保存报告并验证。" }, options),
  );
  if (first.status !== "interrupted" || writes !== 0)
    throw new Error(
      `写入前中断未生效：${JSON.stringify({ status: first.status, error: first.error, writes })}`,
    );
  log("[宿主] 演示自动提供确认数据，重新创建全部 Agent 实例后恢复。");
  const result = await consume(
    (await build()).resumeStream(
      { checkpointId: first.interrupt!.checkpointId, data: true },
      options,
    ),
  );
  if (
    result.status !== "completed" ||
    sourceReads !== 1 ||
    Number(writes) !== 1 ||
    result.todos.length !== 0
  )
    throw new Error(
      `V4 验收失败：${JSON.stringify({ status: result.status, sourceReads, writes, error: result.error })}`,
    );
  log(
    `${result.finalText}\n报告：${path.join(root, "reports/summary.md")}\n资料读取 ${sourceReads} 次，报告写入 ${writes} 次。`,
  );
  return { root, result, first, sourceReads, writes, events };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await runV4Demo();
