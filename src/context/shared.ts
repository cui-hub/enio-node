import { AgentError } from "../protocol/errors.js";
import type { ModelRequest } from "../protocol/types.js";
import { byteLength } from "../runtime/control.js";

/** 默认按 UTF-8 字节粗估，含工具定义；业务可注入供应商 tokenizer。 */
export type TokenCounter = (request: ModelRequest, signal: AbortSignal) => number | Promise<number>;
export const estimateTokens: TokenCounter = (request) => Math.ceil(byteLength(request) / 4);

export function positive(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new AgentError("invalid_config", `Invalid context option: ${name}`);
  return value;
}

export async function countTokens(
  counter: TokenCounter,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<number> {
  const count = await counter(structuredClone(request), signal);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new AgentError("invalid_context", "Token counter must return a nonnegative integer");
  return count;
}
