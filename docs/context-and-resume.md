# 长上下文、状态导出与中断恢复

V4 已将工具前中断扩展到嵌套子 Agent：父检查点保存子检查点引用，恢复沿原调用链继续。本文讲解单个 Loop 的基础协议，新增字段、层级用量与跨 store 限制见 [V4 子 Agent 指南](v4-subagents.md)。

V2 在单 Agent Loop 上增加可组合的上下文策略与持久化恢复。机制参考本工作区 Eino 的 `adk/middlewares/summarization`、`reduction`、`handler.go` 和 `runner.go`。这是独立 TypeScript 实现，API 和部分默认值不同，不提供 Go 检查点格式兼容性，也没有引入子 Agent、Workflow 或 Graph。

V3 保留本页接入方式，并增加中间件、流式工具、并发读取、直接返回和主模型切换，详见 [V3 单 Agent 指南](v3-single-agent.md)。启用并发时，中断会等待同批读取收尾，已完成结果仍不会重放；检查点另保存模型选择、动态装配签名和本轮工具可见范围。

## 三种状态的边界

| 状态            | 保存什么                                                          | 如何使用                                                                          |
| --------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 完整审计记录    | 原始输入、模型响应与工具输出                                      | 业务自己持久化；不能只靠压缩后的 messages 重建原文                                |
| `AgentSnapshot` | 完整配对的工作消息、todos、已使用工具调用 ID                      | `exportState` → `serializeState` → `parseState`，下一轮通过 `RunInput.state` 传入 |
| `Checkpoint`    | 上述状态、未完成工具批次、计数器、usage、AGENTS.md 缓存、事件序号 | `resume` / `resumeStream` 恢复同一次任务，不重复提交用户消息                      |

快照不包含 API Key、业务 context、客户端、函数或 AbortSignal。`instructions` 与 AGENTS.md 仍不混入对话快照；新一轮 run 重新加载项目指令，恢复同一次 run 使用检查点中的项目指令。原始工具结果是否含敏感内容由业务工具决定，存储需要按业务权限隔离。

## 长上下文接入

```typescript
const artifacts = createFileArtifactStore({ root: artifactDirectory });
const agent = createAgent({
  model,
  tools: [...businessTools, createArtifactTool({ store: artifacts })],
  contextPolicies: [
    createToolResultReduction({
      store: artifacts,
      maxOutputBytes: 16_384,
      clearAtTokens: 60_000,
      keepRecentToolRounds: 1,
    }),
    createSummarization({
      model: summaryModel,
      triggerTokens: 80_000,
      keepRecentMessages: 4,
      maxRetries: 1,
    }),
  ],
});
```

策略按数组顺序运行：建议先清理工具内容，再做摘要。注册策略不会隐式注册读取工具，`createArtifactTool` 必须显式加入 `tools`。相同 ArtifactStore 必须在后续会话和恢复执行时可访问。内存存储只适合单进程示例，文件存储需要预先创建 root。

### 摘要

每次主模型调用前，策略根据实际请求（含临时指令和工具定义）估计 Token。`triggerTokens` 或 `triggerMessages` 任一超过阈值便触发。默认 Token 阈值 160,000；默认计数器是 UTF-8 字节数 / 4 的粗估，与 Eino 的用量基线估算不同，可通过 `tokenCounter` 接入准确的 tokenizer。业务应根据模型窗口与输出预算配置阈值。

摘要模型只接收被压缩的历史及摘要指令，工具列表为空。默认保留所有历史 system 消息与末尾四条消息；保留边界若落在 tool 结果内，会向前扩展到对应 assistant，避免拆开完整工具批次。`keepRecentMessages: 0` 可以压缩所有非 system 历史。没有可压缩前缀时不调用摘要模型。

摘要内容作为带标识的 user 消息写入工作上下文。空摘要、工具调用、非法结束原因、超出摘要大小限制、非法 finalize 消息配对都会使本次运行失败；变大的摘要不会替换原历史。`finalize` 可定制保留策略；`transcriptReference` 只引用业务已保存的原文，不自动写聊天日志。

摘要默认不重试；可设置 `maxRetries`、`retryDelayMs` 和 `fallbackModels`。重试只针对 `ModelError.retryable`，备用模型在当前模型失败后尝试。`timeoutMs` 约束摘要及整理过程，信号同时传播给模型。已成功返回的摘要用量并入运行 usage；发生失败请求时 `known=false`，不把未知费用当零。

### 工具结果外置与历史清理

工具结果先验证结构，再通过 `afterTool`，最后应用运行时 `maxToolResultBytes` 硬限制。超过配置阈值或硬限制的结果会先完整保存，再替换为片段、读取说明和 `artifact: { id, bytes }` 引用。内置 ArtifactStore 使用 UUID，不接受模型指定文件路径；单条存储默认上限 16 MiB，可配置。

每次主模型调用前，reduction 还可清理较早的完整工具批次：把原参数与结果保存到 ArtifactStore，将历史参数替换为 `{}`、结果替换为引用。最近若干轮与 `excludeTools` 中的工具保持原状。读取工具默认被排除，避免读取外置内容时又把自身输出外置。较小内容不会外置以免增加上下文。

`read_artifact` 按 UTF-8 字节分页，返回 `nextOffset`；其 pageBytes 应小于运行时工具结果限制，为 JSON 转义和元数据留空间。结果内容是原始 ToolResult JSON 或清理时的 `{call, result}` JSON。工具参数和输出均属于数据，不是新增系统指令。

外置存储失败时终止运行。若之前执行的是有副作用的工具，结果标记 `outcomeUnknown`，宿主应查询业务操作结果；框架不会自动重试该工具。框架不能追回工具内部已经截断的内容。

## 导出与下一轮对话

```typescript
const result = await agent.run({ input: "处理任务" }, { context });
if (result.status === "completed") {
  await database.save(conversationId, serializeState(exportState(result)));
}

const state = parseState(await database.load(conversationId));
const next = await agent.run({ input: "继续处理下一项", state }, { context });
```

`state` 与 `messages` 互斥。快照包含 todos，但不重新注入独立的 Todo 提示词；模型仍通过对话和工具结果了解计划。压缩删掉的工具 ID 保存在快照中，防止下一轮复用旧 ID。默认解析上限 16 MiB。

也可使用 `hooks.afterAgent(snapshot, { runId, context, signal })` 保存最终状态；该钩子只在成功结束调用并等待完成。钩子收到深拷贝，修改它不会污染运行结果；保存失败会使运行失败。失败、取消或中断不能用 `exportState` 冒充成功的完整对话；中断使用检查点恢复。完整聊天记录的保存、用户身份与会话并发管理仍属于宿主。

## 中断与恢复

```typescript
const agent = createAgent({
  model,
  tools: [cancelOrder],
  checkpoints: {
    store: createFileCheckpointStore({ root: checkpointDirectory }),
    namespace: "order-assistant-v1",
  },
  hooks: {
    beforeTool(call, ctx) {
      if (call.name !== "cancel_order") return;
      if (!ctx.resume) return interrupt({ question: "是否确认取消该订单？" });
      return ctx.resume.data === true; // false 回填 permission_denied，不执行工具
    },
  },
});

const options = { context, checkpointOwner: `${trustedUserId}:${conversationId}` };
const result = await agent.run({ input: "取消订单" }, options);
if (result.status === "interrupted") {
  // 向用户展示 result.interrupt.info，保存 checkpointId 与该业务会话的关联。
  const resumed = await agent.resume(
    { checkpointId: result.interrupt!.checkpointId, data: confirmedByUser },
    options,
  );
}
```

这里只在 `beforeTool` 返回 `interrupt(info)` 时暂停。参数校验和 `allowTool` 先执行，实际工具函数尚未开始。暂停保存整个未完成批次，前面已经回填的工具不会重跑。恢复数据仅传给中断所在调用，该调用完成后清除；如果下一个工具也需要确认，会产生新的检查点。

```mermaid
sequenceDiagram
  participant Host as 业务宿主
  participant Loop as Agent Loop
  participant Store as CheckpointStore
  participant Tool as 业务工具
  Host->>Loop: run
  Loop->>Loop: 参数/权限校验，beforeTool 请求中断
  Loop->>Store: save 状态与未完成调用
  Loop-->>Host: interrupted + checkpointId
  Host->>Loop: resume(checkpointId, 确认数据)
  Loop->>Store: 校验绑定并原子 take
  Loop->>Loop: 恢复状态，重新校验权限与 beforeTool
  Loop->>Tool: 执行中断所在调用
  Tool-->>Loop: 结果
  Loop->>Loop: 继续剩余工具与模型循环
  Loop-->>Host: completed + 工作快照
```

启用检查点时，每次 run/resume 都要求宿主提供 `checkpointOwner`。检查点绑定该值、namespace、指令、工具定义与 effect、策略名称，以及启用的 V3 中间件名称、并发度、工具行为和备用模型数量；静态绑定不匹配时不能领取。V3 beforeAgent 的动态装配在领取后另行校验，一旦不匹配，该检查点已被消费，详见 V3 指南。业务 context 不序列化，恢复时重新注入。函数实现和策略详细配置无法可靠哈希，改变这些逻辑或 Backend 时必须升级 namespace。

`CheckpointStore.take` 的契约是校验绑定后原子消费。同一检查点只能被一次 resume 领取。内存实现适合测试；文件实现通过排他创建 `.claimed` 防止多个进程同时恢复。文件 `.json` 和 `.claimed` 保留供诊断，TTL 与清理由业务管理。不要把检查点目录注册为模型可读写工作区。

恢复保留 runId、事件序号、已消耗的模型轮次、工具次数和累计 usage；本次恢复的墙钟 deadline 重新开始。宿主可通过 `options.limits` 显式调整限制。事件新增 `context_updated`、`run_interrupted`、`run_resumed`；中断段以 `run_end(status=interrupted)` 结束，恢复段以 `run_resumed` 开始。

### 明确的恢复边界

- 支持工具执行前的持久化暂停，不支持任意 JavaScript 调用栈、进行中的 SSE 或工具内部执行到一半的自动恢复。
- 取消、超时和未知副作用不是可恢复暂停，不自动生成可重放检查点。
- 检查点一旦领取，进程崩溃或调用方中止消费都不会自动释放，以免重复写操作。需要业务核对执行结果并补偿，不能声称 exactly-once。
- 业务写操作仍需要独立幂等键；可以关联稳定的 runId/toolCallId，但业务操作 ID 的语义由服务决定。
- 使用新的 Agent 实例恢复时，必须配置兼容的模型、工具、指令、策略和可访问的存储。检查点无法恢复已删除的外置内容。
- V4 已增加子 Agent 中断沿调用链恢复；定向多节点恢复、自动进程崩溃续跑仍未实现。此页的 V2 基础机制针对单 Agent 工具边界设计，嵌套恢复限制见 V4 指南。

## 验证入口

`tests/context.test.ts` 验证摘要、配对、费用、超时、状态导出、外置与分页；`tests/resume.test.ts` 验证中途批次恢复、拒绝确认、身份与配置绑定、并发领取、存储失败和取消。

运行 `pnpm run demo:context` 可离线体验完整链路。示例使用真实临时文件保存检查点与外置结果，模拟模型和用户确认，不调用付费模型或实际订单服务。
