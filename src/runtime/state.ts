import { AgentError } from "../protocol/errors.js";
import type { AgentSnapshot, Checkpoint, JsonValue, RunResult } from "../protocol/types.js";
import { byteLength, resolveLimits } from "./control.js";
import { validateHistory } from "./history.js";

/** JSON 往返前拒绝会静默丢失的值、原型对象与循环引用，避免损坏恢复状态。 */
export function assertJson(
  value: unknown,
  ancestors = new Set<unknown>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new AgentError("invalid_state", "State must contain finite, acyclic JSON data");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    throw new AgentError("invalid_state", "State must contain plain objects");
  ancestors.add(value);
  for (const item of Object.values(value)) assertJson(item, ancestors);
  ancestors.delete(value);
}

/** 公开快照只接受完整的 assistant/tool 配对，不能用它绕过检查点恢复。 */
export function validateSnapshot(value: AgentSnapshot): AgentSnapshot {
  assertJson(value);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.todos) ||
    !Array.isArray(value.usedToolCallIds)
  )
    throw new AgentError("invalid_state", "Unsupported state schema");
  const seen = validateHistory(value.messages);
  const ids = new Set(value.usedToolCallIds);
  if (
    ids.size !== value.usedToolCallIds.length ||
    value.usedToolCallIds.some((id) => typeof id !== "string" || !id || id.length > 256) ||
    [...seen].some((id) => !ids.has(id))
  )
    throw new AgentError("invalid_state", "Invalid state tool ids");
  const todos = new Set<string>();
  for (const todo of value.todos) {
    if (
      !todo ||
      typeof todo.id !== "string" ||
      !todo.id ||
      todos.has(todo.id) ||
      typeof todo.content !== "string" ||
      !["pending", "in_progress", "completed"].includes(todo.status)
    )
      throw new AgentError("invalid_state", "Invalid state todos");
    todos.add(todo.id);
  }
  return structuredClone(value);
}

/** 成功结果的快照与运行中对象隔离，业务可安全写数据库或修改副本。 */
export function exportState(result: RunResult): AgentSnapshot {
  if (result.status !== "completed" || !result.historyComplete || !result.state)
    throw new AgentError("invalid_state", "Only completed runs can export conversation state");
  return validateSnapshot(result.state);
}

export function serializeState(state: AgentSnapshot): string {
  return JSON.stringify(validateSnapshot(state));
}

export function parseState(text: string, maxBytes = 16_777_216): AgentSnapshot {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || byteLength(text) > maxBytes)
    throw new AgentError("invalid_state", "State exceeds size limit");
  try {
    return validateSnapshot(JSON.parse(text));
  } catch {
    throw new AgentError("invalid_state", "Invalid serialized state");
  }
}

/** 检查点仅允许最后一个工具批次尚未完成；补占位结果只用于校验，不送给模型。 */
export function validateCheckpoint(value: Checkpoint): Checkpoint {
  assertJson(value);
  if (
    value.schemaVersion !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.binding !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.projectInstructions !== "string" ||
    !Array.isArray(value.pendingCalls) ||
    !value.pendingCalls.length
  )
    throw new AgentError("invalid_checkpoint", "Invalid checkpoint envelope");
  for (const count of [
    value.seq,
    value.iteration,
    value.toolCalls,
    value.usage?.inputTokens,
    value.usage?.outputTokens,
  ])
    if (!Number.isSafeInteger(count) || count < 0)
      throw new AgentError("invalid_checkpoint", "Invalid checkpoint counters");
  if (typeof value.usage.known !== "boolean")
    throw new AgentError("invalid_checkpoint", "Invalid checkpoint usage");
  if (
    (value.modelIndex !== undefined &&
      (!Number.isSafeInteger(value.modelIndex) || value.modelIndex < 0)) ||
    (value.setupSignature !== undefined && typeof value.setupSignature !== "string") ||
    (value.availableTools !== undefined &&
      (!Array.isArray(value.availableTools) ||
        value.availableTools.some((name) => typeof name !== "string")))
  )
    throw new AgentError("invalid_checkpoint", "Invalid V3 checkpoint metadata");
  resolveLimits(value.limits);
  const pending = new Map<string, unknown>();
  for (const message of value.state.messages) {
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) pending.set(call.id, call);
    if (message.role === "tool") pending.delete(message.toolCallId);
  }
  if (JSON.stringify([...pending.values()]) !== JSON.stringify(value.pendingCalls))
    throw new AgentError("invalid_checkpoint", "Pending calls differ from history");
  validateSnapshot({
    ...value.state,
    messages: [
      ...value.state.messages,
      ...value.pendingCalls.map((call) => ({
        role: "tool" as const,
        toolCallId: call.id,
        content: "validation-only",
      })),
    ],
  });
  return structuredClone(value);
}
