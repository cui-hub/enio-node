import { AgentError } from "../protocol/errors.js";
import type { JsonValue } from "../protocol/types.js";

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
