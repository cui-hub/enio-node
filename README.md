# enio-node

Node.js + TypeScript 单 Agent SDK，参考 Eino 的模型／工具循环和扩展边界实现。项目名按约定使用 **enio-node**；它是独立实现，不是 Eino 官方 TypeScript 版本。

一期已提供：Agent Loop、统一工具接口、OpenAI-compatible Chat Completions 适配器、流式事件、取消／超时／预算、文件工具、待办、inline Skill，以及显式启用的命令执行扩展。子 Agent、Graph、Workflow、检查点恢复和审批留到后续阶段。

## 快速运行

工程使用 Node.js **24.19.0**、pnpm **12.11.2**、TypeScript strict 和 tsc。pnpm 版本固定在 `packageManager`，依赖固定在 `pnpm-lock.yaml`；本项目是单包，`pnpm-workspace.yaml` 用来保存 pnpm 配置。

```bash
# 记录进入任务前的版本，结束时恢复，不修改 shell 启动文件。
task_node_before=$(node --version)
source "$HOME/.nvm/nvm.sh"
nvm install
nvm use

# Corepack 根据 packageManager 调用固定版本 pnpm，不依赖全局 pnpm 的版本。
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run demo
corepack pnpm run demo:business

nvm use "$task_node_before"
```

离线文件演示无需 API Key。它创建临时工作区，复制三份资料，实际执行 `skill → write_todos → glob → read_file → write_file → read_file → write_todos`，并打印报告路径。演示保留临时目录供查看；自动测试在结束后清理自己的目录。

| 命令                     | 用途                                   |
| ------------------------ | -------------------------------------- |
| `pnpm run typecheck`     | 检查 SDK、测试和示例的 TypeScript 类型 |
| `pnpm run format:check`  | 只读检查源码、测试与文档格式           |
| `pnpm run test`          | 离线行为测试，默认跳过真实模型测试     |
| `pnpm run build`         | 生成 ESM、类型声明、source map 到 dist |
| `pnpm run check`         | 格式检查＋类型检查＋离线测试＋构建     |
| `pnpm run demo`          | 使用脚本模型完成真实文件任务           |
| `pnpm run demo:business` | 展示业务工具与宿主身份上下文           |
| `pnpm run demo:live`     | 使用宿主配置的真实模型完成文件任务     |
| `pnpm run test:live`     | 显式执行会产生模型费用的集成验收       |

## 最小接入

先构建，再从 `dist/index.js` 引入；未来发布时可以改用正式包名。当前 package 为 private，不会误发布到公共仓库。

```typescript
import { createAgent, createScriptedModel, defineTool } from "./dist/index.js";

const lookup = defineTool<{ orderId: string }, { userId: string }>({
  name: "lookup_order",
  description: "查询当前用户的订单状态",
  effect: "read",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string", minLength: 1 } },
    required: ["orderId"],
    additionalProperties: false,
  },
  async execute({ orderId }, { context, signal }) {
    signal.throwIfAborted();
    // 用 context.userId 做业务鉴权，不能相信模型提供的身份。
    return {
      ok: true,
      content: JSON.stringify({ orderId, userId: context.userId, status: "paid" }),
    };
  },
});

const model = createScriptedModel(({ messages }) => {
  if (messages.some((message) => message.role === "tool")) {
    return { message: { role: "assistant", content: "订单已支付。" }, finishReason: "stop" };
  }
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "lookup-1", name: "lookup_order", arguments: '{"orderId":"001"}' }],
    },
    finishReason: "tool_calls",
  };
});

const agent = createAgent({ model, tools: [lookup] });
const result = await agent.run(
  { input: "查一下订单 001" },
  { context: { userId: "current-user" } },
);
console.log(result.status, result.finalText);
```

完整示例见 [examples/business-tool.ts](examples/business-tool.ts)、[examples/file-report.ts](examples/file-report.ts)。`createScriptedModel` 是确定性测试／演示模型，不执行自然语言推理。

## 真实模型

通过环境变量配置 `ENIO_API_KEY`、`ENIO_MODEL`，可选 `ENIO_BASE_URL`、`ENIO_INCLUDE_USAGE=false`。SDK 不自动读取 `.env`；不要把真实凭证写进源码或提交到 Git。可用配置字段见 [.env.example](.env.example)。

```typescript
import { createOpenAICompatibleModel } from "./dist/index.js";

const model = createOpenAICompatibleModel({
  model: config.model,
  apiKey: config.apiKey,
  baseURL: config.baseURL,
  maxOutputTokens: 4096,
  includeUsage: true,
});
```

适配器使用官方 openai SDK 的 HTTP/SSE 能力，关闭 SDK 重试，由 Runner 统一控制。请求使用 Chat Completions、function tools、`max_completion_tokens`；网关不支持 `stream_options` 时可以关闭 usage。接口兼容性必须通过对应端点的真实测试确认，不能仅凭“OpenAI-compatible”标签推断全部支持。

当前已通过真实 SDK＋模拟 HTTP/SSE 的协议测试；未配置真实端点与凭证，因此没有宣称任何真实模型已通过集成验收。

## Tool 与 Skill

| 能力     | 接入方式                                            | 执行行为                               |
| -------- | --------------------------------------------------- | -------------------------------------- |
| 业务工具 | `defineTool` 后加入 `tools`                         | 校验参数和权限，再调用业务函数         |
| 文件工具 | `createFileTools({ backend })`                      | 同一执行器调用内存或本地 backend       |
| 待办     | `createTodoTool()`                                  | 替换当前 run 的 todos，不持久化        |
| Skill    | `await createSkillTool({ backend })` 后加入 `tools` | 元数据预加载，正文按需回填当前 Agent   |
| 命令执行 | `createExecuteTool({ backend })`                    | 只有显式注册才开放；默认文件示例不注册 |

```typescript
const backend = createLocalFilesystem({
  root: workspace,
  readable: ["fixtures/**", "reports/**"],
  writable: ["reports/**"],
});
const skillTool = await createSkillTool({
  backend: createFilesystemSkills({ root: skillsDirectory }),
});
const agent = createAgent({
  model,
  tools: [...createFileTools({ backend }), createTodoTool(), skillTool],
});
```

这里将方案中的自动 Skill 配置收敛为**显式异步工厂**：创建工具时验证元数据，`createAgent` 保持同步。工具调用和 inline Skill 的执行链路没有变化。每个 Skill 位于技能根目录的一级子目录，包含 `SKILL.md`，格式见 [报告 Skill](examples/skills/report-summary/SKILL.md)。一期明确拒绝 fork、fork_with_context、agent/model 覆盖。

文件工具包括 `ls`、`read_file`、`write_file`、`edit_file`、`glob`、`grep`。默认文件 backend 只读，写入需要 `writable` 白名单。创建文件默认不覆盖；覆盖或编辑须提供最近一次读取返回的 `expectedHash`。编辑采用唯一的精确文本匹配。`grep` 使用字面量；大文件、遍历数量、深度、扫描字节数和返回体积均受限。

读取按行分页，每次最多 24 KiB；单行超长时也会截断，一期不提供该行的字节偏移续读。目录列举可返回用于导航的非敏感目录名；可读文件由 readable 限制，`.git`、`.env` 等默认排除。

## 流式事件与运行结果

```typescript
const controller = new AbortController();
for await (const event of agent.stream(
  { input: "生成报告" },
  {
    context: {},
    signal: controller.signal,
  },
)) {
  if (event.type === "text_delta") renderText(event.payload.text);
  if (event.type === "tool_end") renderToolStatus(event.payload);
  if (event.type === "run_end") renderFinal(event.payload.result);
}
```

`run` 消费同一个事件引擎。事件有 `schemaVersion`、`runId`、单调递增的 `seq`、`iteration` 和时间戳；类型涵盖运行、模型、工具和重试过程。事件和模型请求使用独立快照，观察回调不能改写内部历史。

完整消费时返回唯一 `run_end`。中间文本不代表完成，最终以 `RunResult.status` 为准。主动 break／return 会立即发出取消信号并清理迭代器，关闭后的消费者不会再收到终止事件。采用拉取式背压，没有额外的无界事件队列。

业务配置错误在创建时抛出；运行错误以 `failed`／`cancelled` 结果返回。未知工具、无效参数和显式 `ToolError` 会回填模型，未分类异常终止运行。取消途中未完成的工具调用保留在 `pendingToolCallIds`；`historyComplete=false` 的消息仅供诊断，不能直接重用。完整历史可由宿主保存后传入 `RunInput.messages`，这不等于持久化恢复。

## 关键限制

| 项目     | 默认值／约束                                                 |
| -------- | ------------------------------------------------------------ |
| 模型轮数 | 20；网络重试单独计数                                         |
| 工具调用 | 总计 64，单轮最多 8，严格串行                                |
| 超时     | run 120s、model 60s、tool 30s；父级取消优先                  |
| 重试     | 模型可重试网络／429／5xx 错误最多 2 次；已经暴露文本后不重试 |
| 体积     | 工具参数／结果各 32 KiB；模型输入／响应各 1 MiB              |
| 副作用   | 不自动重试工具、不回滚写入、不保证 exactly-once              |
| 执行平台 | 本地进程 backend 限 macOS/Linux；普通进程组超时清理有测试    |

超时只会停止等待和后续动作，不保证终止不合作的业务函数。`outcomeUnknown` 表示副作用可能已发生，宿主应查询业务状态，不能盲目重放。`usage.known=false` 表示统计不完整，字节和时间预算不等于精确费用上限。

本地路径检查、命令白名单和进程内锁都不是沙箱。命令 backend 要求绝对命令白名单、`authorize` 回调和显式环境变量，使用 `shell=false`；授权 Node／Python 等解释器就授予了其执行能力。独立会话、外部并发进程、脱离进程组的进程和多租户隔离属于后续隔离 backend 的责任。

## 源码阅读

- [架构与扩展方式](docs/architecture.md)：模块依赖、循环和取消链路。
- [验收记录](docs/acceptance.md)：一期 A01–A14 对应测试与未验证部分。
- [技术方案](https://bytedance.larkoffice.com/docx/BBlHd6EVNolOv9xCNZ5cheqYnre)：需求范围与后续分期。

核心代码配有中文 JSDoc，说明公开类型、执行阶段、权限边界和失败语义。构建产物由 tsc 生成，不手改 `dist/`。
