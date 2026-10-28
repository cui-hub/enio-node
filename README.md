# enio-node

用于学习 Agent 框架设计的 Node.js + TypeScript 单 Agent SDK，参考 [Eino](https://github.com/cloudwego/eino) 的模型／工具循环和扩展边界实现。项目名按约定使用 **enio-node**；它是独立实现，不是 Eino 官方 TypeScript 版本。

项目仓库：[cui-hub/enio-node](https://github.com/cui-hub/enio-node)。建议结合源码注释、架构文档和离线示例理解模型调用、工具执行与运行时控制的完整链路。

已提供：Agent Loop、统一工具接口、OpenAI-compatible Chat Completions 适配器、流式事件、取消／超时／预算、文件工具、待办、inline Skill、AGENTS.md 项目指令加载，以及显式启用的命令执行扩展。V2 增加历史摘要、工具结果外置、工作状态导出和工具执行前的持久化中断恢复；V3 增加生命周期中间件、模型／工具包装器、工具流式输出、受控并发、工具直接返回及主模型故障切换。子 Agent、Graph、Workflow 与业务审批系统留到后续阶段。

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
corepack pnpm run demo:instructions
corepack pnpm run demo:v3

nvm use "$task_node_before"
```

离线文件演示无需 API Key。它创建临时工作区，复制三份资料，实际执行 `skill → write_todos → glob → read_file → write_file → read_file → write_todos`，并打印报告路径。演示保留临时目录供查看；自动测试在结束后清理自己的目录。

| 命令                     | 用途                                           |
| ------------------------ | ---------------------------------------------- |
| `pnpm run typecheck`     | 检查 SDK、测试和示例的 TypeScript 类型         |
| `pnpm run format:check`  | 只读检查源码、测试与文档格式                   |
| `pnpm run test`          | 离线行为测试，默认跳过真实模型测试             |
| `pnpm run build`         | 生成 ESM、类型声明、source map 到 dist         |
| `pnpm run check`         | 格式检查＋类型检查＋离线测试＋构建             |
| `pnpm run demo`          | 使用脚本模型完成真实文件任务                   |
| `pnpm run demo:business` | 展示业务工具与宿主身份上下文                   |
| `pnpm run demo:context`  | 演示摘要、结果外置、确认中断与新实例恢复       |
| `pnpm run demo:v3`       | 演示中间件、流式工具、并发、直接返回与模型切换 |
| `pnpm run demo:live`     | 使用宿主配置的真实模型完成文件任务             |
| `pnpm run test:live`     | 显式执行会产生模型费用的集成验收               |

## 最小接入

先构建，再从 `dist/index.js` 引入；未来发布时可以改用正式包名。当前 `package.json` 设置 `private: true` 以防止误发布到 npm，不影响 GitHub 源码公开。

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

| 能力     | 接入方式                                            | 执行行为                                   |
| -------- | --------------------------------------------------- | ------------------------------------------ |
| 业务工具 | `defineTool` 后加入 `tools`                         | 校验参数和权限，再调用业务函数             |
| 文件工具 | `createFileTools({ backend })`                      | 同一执行器调用内存或本地 backend           |
| 待办     | `createTodoTool()`                                  | 替换当前 run 的 todos，可随快照/检查点保存 |
| Skill    | `await createSkillTool({ backend })` 后加入 `tools` | 元数据预加载，正文按需回填当前 Agent       |
| 命令执行 | `createExecuteTool({ backend })`                    | 只有显式注册才开放；默认文件示例不注册     |

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

## 加载 AGENTS.md 项目指令

通过 `agentsMd` 显式启用后，每次运行会自动读取选定工作区的 `AGENTS.md`，无需模型先调用文件工具。文件名可配置，因此也能读取 `CLAUDE.md` 或业务自己的规范文件。`createAgent` 本身仍是同步工厂，文件读取发生在 `run` 或消费 `stream` 后、首次模型请求之前。

```typescript
import { createAgent, createFilesystemAgentsMd } from "./dist/index.js";

const agent = createAgent({
  model,
  instructions: "你是一个文件任务助手。",
  agentsMd: createFilesystemAgentsMd({
    root: workspace, // 宿主明确选择工作区，不隐式使用 process.cwd()
    files: ["AGENTS.md"], // 默认就是此值；可按顺序补充 docs/AGENTS.md 等
    maxFileBytes: 16_384,
    maxTotalBytes: 32_768,
    onWarning: ({ file, code }) => console.warn(`项目指令 ${file}: ${code}`),
  }),
  tools: [...createFileTools({ backend })],
});
```

AGENTS.md 中可引用其他文件，例如：

```markdown
本项目使用 pnpm，修改代码后运行相关检查。
@docs/testing.md
```

引用相对所在文件解析，按深度优先顺序展开，去重并跳过引用环。`../shared.md` 可以引用工作区内的兄弟文件，越出 `root`、绝对路径及符号链接会被拒绝。引用路径不支持空格；`@owner`、邮箱不会展开，代码块里的 `@docs/rules.md` 也会被识别。引用文本保留在正文中，被引用文件带来源标题单独追加。

沿用 Eino `agentsmd` 中间件的消息语义：合并文本作为一条临时 **user 消息**，插到第一条已有 user 消息之前；`instructions` 和 `beforeModel` 返回的内容仍为 system 消息。项目指令只进入模型请求，**不写入 `RunResult.messages`**。同一 run 的各轮和重试使用同一份内容，空结果也缓存；下次 run 重新读取，并发 run 独立加载。启用加载器不会注册任何工具；Skill 仍通过 `createSkillTool` 注册到 `tools`。

| 项目           | 默认行为                                                                        |
| -------------- | ------------------------------------------------------------------------------- |
| 入口与目录范围 | 读取 `root/AGENTS.md`；多个入口按 `files` 顺序；空数组禁用读取                  |
| 引用范围       | 无空格的 `@路径`，含 `/` 或扩展名为 `.md/.txt/.mdx/.yaml/.yml/.json/.toml`      |
| 加载预算       | 单文件正文 16 KiB；最终文本 32 KiB，包含来源标题和截断提示；UTF-8 边界截断      |
| 遍历预算       | 引用深度 5；最多尝试 128 个不同路径，包含缺失文件；`maxImportDepth: 0` 关闭展开 |
| 缺失／空文件   | 跳过；缺失文件可通过 `onWarning` 观察，默认静默                                 |
| 读取失败       | 权限、非文本、非法路径等终止运行；首次模型请求不会发出                          |
| 截断／预算耗尽 | 提供告警；被截断文件不展开引用，总预算或文件数耗尽后停止后续读取                |
| 取消与超时     | 使用当前 run 的 signal 和总超时；不受工具超时控制，不进行加载重试               |

本地存储另有单文件 **1 MiB 原始读取上限**，超过时失败；这个上限与注入文本截断预算是两回事。最终模型请求仍受 `maxInputBytes` 约束。字节和文件数预算必须为正整数，不用 `0` 表示无限；只有引用深度允许 `0`。

这一版由宿主决定文件作用域：不自动向父目录搜索，也不根据工具正在访问的目录自动切换子目录规则。若显式列出 `docs/AGENTS.md`，其内容会用于整个 run。加载器只读取和注入文本，不执行其中的脚本。项目指令读取与文件工具的 `readable` 白名单独立，允许范围由加载器的 `root` 和 backend 决定；业务需要额外 ACL 时，使用 `createAgentsMd({ backend: { read(file, signal) { ... } } })` 提供自定义读取实现。

完整可运行示例：[examples/project-instructions.ts](examples/project-instructions.ts)，执行 `pnpm run demo:instructions`；示例使用真实临时文件和确定性模型，不需要 API Key，并在结束时清理目录。

## 长上下文与中断恢复

通过 `contextPolicies` 显式配置 `createToolResultReduction` 和 `createSummarization`；结果外置使用 ArtifactStore，读取能力通过 `createArtifactTool` 加入 `tools`。摘要在主模型调用前执行，生成后的工作上下文可通过 `exportState`、`serializeState` 保存，并通过 `RunInput.state` 传入下一轮。

配置 `checkpoints: { store, namespace }` 后，可在 `hooks.beforeTool` 返回 `interrupt(info)`，在工具执行前暂停。宿主取得确认后调用 `resume` / `resumeStream`；已经回填结果的工具不会再次执行。每次运行要求宿主提供 `checkpointOwner`，恢复仍执行权限检查。

内置存储有内存和本地文件两种实现。检查点采用一次领取语义，不自动重放取消、崩溃或未知副作用；业务写操作仍需要幂等控制。完整接入代码、默认值和恢复边界见 [长上下文与恢复指南](docs/context-and-resume.md)。离线示例：[examples/context-resume.ts](examples/context-resume.ts)，运行 `pnpm run demo:context`。

## V3 单 Agent 扩展

- `middlewares`：beforeAgent、beforeModel、afterModel、wrapModel、wrapTool、afterAgent；保留原 hooks 和 ContextPolicy。
- `Tool.stream`：逐段发出 `tool_output`，最终结果再写入历史；execute 工具可实时输出 stdout/stderr。
- `toolExecution.maxConcurrency`：默认 1；只有 `effect: "read"` 且 `parallelSafe: true` 的连续调用能并发，写入和命令保持串行。
- `Tool.returnDirect`：成功结果作为最终回答；完整完成同批调用后结束，避免额外模型轮次。
- `modelFailover.models`：当前模型重试耗尽后尝试备用模型；一旦展示文本，不再重试或切换。

这些能力均按需启用；具体调用顺序、代码示例、恢复兼容性与边界见 [V3 单 Agent 指南](docs/v3-single-agent.md)。可运行代码见 [examples/single-agent-v3.ts](examples/single-agent-v3.ts)。

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
  if (event.type === "tool_output") renderToolProgress(event.payload);
  if (event.type === "tool_end") renderToolStatus(event.payload);
  if (event.type === "run_end") renderFinal(event.payload.result);
}
```

`run` 消费同一个事件引擎。事件有 `schemaVersion`、`runId`、单调递增的 `seq`、`iteration` 和时间戳；类型涵盖运行、模型、工具和重试过程。事件和模型请求使用独立快照，观察回调不能改写内部历史。

完整消费时返回唯一 `run_end`。中间文本不代表完成，最终以 `RunResult.status` 为准。主动 break／return 会立即发出取消信号并清理迭代器，关闭后的消费者不会再收到终止事件。采用拉取式背压，并发时每个工具最多预取一个片段；已启动的 I/O 仍可继续，进程日志只在输出预算内缓存，没有无界事件队列。

业务配置错误在创建时抛出；运行错误以 `failed`／`cancelled` 结果返回。未知工具、无效参数和显式 `ToolError` 会回填模型，未分类异常终止运行。未完成的工具调用保留在 `pendingToolCallIds`；`historyComplete=false` 的消息不能直接作为新一轮历史。`interrupted` 结果提供检查点 ID，用于恢复待执行批次。成功结果可导出 `state`；仅传入完整 `messages` 是继续对话，不是执行恢复。

## 关键限制

| 项目     | 默认值／约束                                                 |
| -------- | ------------------------------------------------------------ |
| 模型轮数 | 20；网络重试单独计数                                         |
| 工具调用 | 总计 64，单轮最多 8，默认串行，可显式并发安全读取            |
| 超时     | run 120s、model 60s、tool 30s；父级取消优先                  |
| 重试     | 模型可重试网络／429／5xx 错误最多 2 次；已经暴露文本后不重试 |
| 体积     | 工具参数／结果各 32 KiB；工具进度、模型输入／响应各 1 MiB    |
| 副作用   | 不自动重试工具、不回滚写入、不保证 exactly-once              |
| 执行平台 | 本地进程 backend 限 macOS/Linux；普通进程组超时清理有测试    |

超时只会停止等待和后续动作，不保证终止不合作的业务函数。`outcomeUnknown` 表示副作用可能已发生，宿主应查询业务状态，不能盲目重放。`usage.known=false` 表示统计不完整，字节和时间预算不等于精确费用上限。

本地路径检查、命令白名单和进程内锁都不是沙箱。命令 backend 要求绝对命令白名单、`authorize` 回调和显式环境变量，使用 `shell=false`；授权 Node／Python 等解释器就授予了其执行能力。独立会话、外部并发进程、脱离进程组的进程和多租户隔离属于后续隔离 backend 的责任。

## 源码阅读

- [架构与扩展方式](docs/architecture.md)：模块依赖、循环和取消链路。
- [V3 单 Agent 指南](docs/v3-single-agent.md)：中间件、工具流、并发、直接返回与模型切换。
- [长上下文与恢复指南](docs/context-and-resume.md)：摘要、外置、快照、中断与存储契约。
- [验收记录](docs/acceptance.md)：各阶段对应测试与未验证部分。
- [Eino 源码](https://github.com/cloudwego/eino)：参考框架，可对照理解 Go 与 TypeScript 的实现方式。

核心代码配有中文 JSDoc，说明公开类型、执行阶段、权限边界和失败语义。构建产物由 tsc 生成，不手改 `dist/`。
