import { AgentError } from "../protocol/errors.js";
import type {
  AgentPathStep,
  DelegationScope,
  LocalAgentEvent,
  Message,
  Usage,
} from "../protocol/types.js";
import { assertJson } from "./json.js";

/** 这里仅定义跨 Agent 的数据契约，不依赖具体预置 Agent 或工具。 */
export function validateDelegation(value: DelegationScope): void {
  if (
    !value ||
    !Array.isArray(value.path) ||
    value.path.length > 16 ||
    !Number.isSafeInteger(value.maxDepth) ||
    value.maxDepth < 0 ||
    value.maxDepth > 16 ||
    !Number.isSafeInteger(value.budget?.maxCalls) ||
    value.budget.maxCalls < 1 ||
    value.budget.maxCalls > 1024 ||
    !Number.isSafeInteger(value.budget.calls) ||
    value.budget.calls < 0 ||
    value.budget.calls > value.budget.maxCalls ||
    value.path.length > value.maxDepth
  ) {
    throw new AgentError("invalid_delegation", "Invalid agent path or delegation budget");
  }
  validatePath(value.path);
}

/** 对 JSON 存储和第三方 Agent 返回的路径做边界验证。 */
export function validatePath(path: AgentPathStep[]): void {
  if (
    !Array.isArray(path) ||
    path.length > 16 ||
    path.some(
      (step) =>
        !step ||
        typeof step.name !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(step.name) ||
        typeof step.parentRunId !== "string" ||
        !step.parentRunId ||
        typeof step.toolCallId !== "string" ||
        !step.toolCallId,
    )
  )
    throw new AgentError("invalid_delegation", "Invalid child event path");
}

/** 只提供配对完整的过去对话，丢弃当前整个未完成批次；子任务拥有自己的系统指令。 */
export function inheritedHistory(messages: Message[]): Message[] {
  let end = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.toolCalls?.length) {
      end = i;
      break;
    }
  }
  return structuredClone(messages.slice(0, end).filter((message) => message.role !== "system"));
}

/** 用量从子任务终止事件汇总；检查累计值，避免重复计费或被非法数值污染。 */
export function validateChildUsage(value: Usage & { known: boolean }): void {
  if (
    !value ||
    typeof value.known !== "boolean" ||
    [value.inputTokens, value.outputTokens].some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
  )
    throw new AgentError("invalid_agent_event", "Invalid child usage");
}

/** 可选 toolCalls 的 undefined 与省略等价；沿用快照规则，令嵌套事件可安全 JSON 序列化。 */
export function transportChildEvent(event: LocalAgentEvent): LocalAgentEvent {
  const copy = structuredClone(event);
  if (copy.type === "run_end" && Array.isArray(copy.payload?.result?.messages)) {
    copy.payload.result.messages = copy.payload.result.messages.map((message) =>
      message.role === "assistant" && message.toolCalls === undefined
        ? { role: "assistant", content: message.content }
        : message,
    );
  }
  validateChildEvent(copy);
  return copy;
}

/** 嵌套事件属于展示数据；禁止递归信封，并验证会影响父统计的终止字段。 */
export function validateChildEvent(event: LocalAgentEvent): void {
  assertJson(event as unknown);
  const types = [
    "run_start",
    "model_start",
    "text_delta",
    "tool_call_ready",
    "tool_start",
    "tool_end",
    "tool_output",
    "model_retry",
    "model_fallback",
    "context_updated",
    "run_interrupted",
    "run_resumed",
    "run_end",
  ];
  if (
    !event ||
    event.schemaVersion !== 1 ||
    !types.includes(event.type) ||
    typeof event.runId !== "string" ||
    !event.runId ||
    !Number.isSafeInteger(event.seq) ||
    event.seq < 1 ||
    !Number.isSafeInteger(event.iteration) ||
    event.iteration < 0 ||
    typeof event.timestamp !== "string" ||
    !event.payload ||
    typeof event.payload !== "object"
  )
    throw new AgentError("invalid_agent_event", "Invalid child event envelope");
  if (event.type === "run_end") {
    const result = event.payload.result;
    if (
      !result ||
      result.runId !== event.runId ||
      !["completed", "failed", "cancelled", "interrupted"].includes(result.status) ||
      typeof result.finalText !== "string"
    )
      throw new AgentError("invalid_agent_event", "Invalid child terminal event");
    validateChildUsage(result.usage);
  }
}
