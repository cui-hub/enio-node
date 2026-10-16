import { AgentError } from "../protocol/errors.js";
import type { Message, ModelResponse, ToolCall } from "../protocol/types.js";

/** 每个调用必须拥有稳定且唯一的 id；在任何执行开始之前整批检查。 */
export function validateCalls(calls: ToolCall[], seen = new Set<string>()): void {
  if (!Array.isArray(calls)) throw new AgentError("protocol_error", "toolCalls must be an array");
  for (const call of calls) {
    if (
      !call ||
      typeof call.id !== "string" ||
      !call.id ||
      call.id.length > 256 ||
      seen.has(call.id) ||
      typeof call.name !== "string" ||
      !call.name ||
      call.name.length > 64 ||
      typeof call.arguments !== "string"
    ) {
      throw new AgentError("protocol_error", "Invalid or duplicate tool call");
    }
    seen.add(call.id);
  }
}

/** 校验完整历史并返回所有已使用 id，防止后续响应复用旧调用编号。 */
export function validateHistory(messages: Message[]): Set<string> {
  if (!Array.isArray(messages)) throw new AgentError("invalid_input", "History must be an array");
  const seen = new Set<string>();
  const pending = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message.content !== "string")
      throw new AgentError("invalid_input", "Message content must be text");
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId))
        throw new AgentError("invalid_input", "Unmatched or duplicate tool result");
    } else {
      if (pending.size) throw new AgentError("invalid_input", "Tool results are incomplete");
      if (!["system", "user", "assistant"].includes(message.role))
        throw new AgentError("invalid_input", "Unsupported message role");
      if (message.role === "assistant" && message.toolCalls) {
        validateCalls(message.toolCalls, seen);
        message.toolCalls.forEach((call) => pending.add(call.id));
      }
    }
  }
  if (pending.size) throw new AgentError("invalid_input", "History contains unfinished tool calls");
  return seen;
}

/** 适配器也可能是业务注入实现，所以 Runner 再次检查响应协议。 */
export function validateResponse(response: ModelResponse, seen: Set<string>): void {
  if (
    !response ||
    response.message?.role !== "assistant" ||
    typeof response.message.content !== "string"
  ) {
    throw new AgentError("protocol_error", "Model must return an assistant message");
  }
  if (response.finishReason !== "stop" && response.finishReason !== "tool_calls") {
    throw new AgentError("incomplete_response", "Model response did not finish normally");
  }
  const calls = response.message.toolCalls ?? [];
  validateCalls(calls, seen);
  if ((response.finishReason === "tool_calls") !== calls.length > 0) {
    throw new AgentError("protocol_error", "finishReason and tool calls disagree");
  }
  if (
    response.usage &&
    [response.usage.inputTokens, response.usage.outputTokens].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    throw new AgentError("protocol_error", "Invalid model usage");
  }
}
