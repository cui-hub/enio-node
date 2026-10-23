import { AgentError, ToolError, toAgentError } from "../protocol/errors.js";
import type { AgentConfig, Limits, ToolCall, ToolContext, ToolResult } from "../protocol/types.js";
import {
  abortable,
  byteLength,
  checkAbort,
  createScope,
  truncateUtf8,
} from "../runtime/control.js";
import type { ToolRegistry } from "./registry.js";
import { ToolInterrupt } from "../runtime/interrupt.js";
import { assertJson } from "../runtime/state.js";

/** 保留有效的外层 JSON 信封；预算包含 JSON 转义，不只计算原字符串字节数。 */
export function normalizeToolResult(value: ToolResult, maximum: number): ToolResult {
  if (!value || typeof value !== "object" || typeof value.ok !== "boolean")
    throw new AgentError("invalid_tool_result", "Tool must return a ToolResult");
  let result: ToolResult;
  if (value.ok) {
    if (typeof value.content !== "string")
      throw new AgentError("invalid_tool_result", "Tool content must be text");
    result = { ok: true, content: value.content, ...(value.truncated ? { truncated: true } : {}) };
  } else {
    if (
      typeof value.code !== "string" ||
      typeof value.message !== "string" ||
      typeof value.retryableByModel !== "boolean"
    ) {
      throw new AgentError("invalid_tool_result", "Invalid tool error result");
    }
    result = {
      ok: false,
      code: truncateUtf8(value.code, 64),
      message: value.message,
      retryableByModel: value.retryableByModel,
      ...(value.truncated ? { truncated: true } : {}),
    };
  }
  if (value.artifact) {
    if (
      !/^[a-f0-9-]{36}$/.test(value.artifact.id) ||
      !Number.isSafeInteger(value.artifact.bytes) ||
      value.artifact.bytes < 0
    )
      throw new AgentError("invalid_tool_result", "Invalid artifact reference");
    result.artifact = { id: value.artifact.id, bytes: value.artifact.bytes };
  }
  if (byteLength(result) <= maximum) return result;
  const original = result.ok ? result.content : result.message;
  let low = 0;
  let high = byteLength(original);
  result.truncated = true;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const text = truncateUtf8(original, mid);
    const candidate = result.ok ? { ...result, content: text } : { ...result, message: text };
    if (byteLength(candidate) <= maximum) low = mid;
    else high = mid - 1;
  }
  return result.ok
    ? { ...result, content: truncateUtf8(original, low) }
    : { ...result, message: truncateUtf8(original, low) };
}

/** 内置和业务工具共用此执行器，权限、hook、超时都在同一条链路上。 */
export async function executeTool<C>(
  registry: ToolRegistry<C>,
  call: ToolCall,
  context: ToolContext<C>,
  config: AgentConfig<C>,
  limits: Limits,
): Promise<ToolResult> {
  const scope = createScope(context.signal, limits.toolTimeoutMs, "tool_timeout");
  const ctx = { ...context, signal: scope.signal };
  let sideEffectStarted = false;
  let executionStarted = false;
  let toolFinished = false;
  try {
    checkAbort(scope.signal);
    const { tool, args } = registry.prepare(call.name, call.arguments);
    if (config.allowTool) {
      const allowed = await abortable(
        Promise.resolve().then(() =>
          config.allowTool!(
            {
              name: tool.name,
              description: tool.description,
              inputSchema: structuredClone(tool.inputSchema),
              effect: tool.effect,
            },
            ctx,
          ),
        ),
        scope.signal,
      );
      if (!allowed) throw new ToolError("permission_denied", "Host policy denied this tool", false);
    }
    if (config.hooks?.beforeTool) {
      const allowed = await abortable(
        Promise.resolve().then(() => config.hooks!.beforeTool!(Object.freeze({ ...call }), ctx)),
        scope.signal,
      );
      if (allowed === false)
        throw new ToolError("permission_denied", "beforeTool denied this call", false);
      if (allowed && typeof allowed === "object") {
        if (allowed.type !== "interrupt")
          throw new AgentError("invalid_hook", "Invalid beforeTool response");
        assertJson(allowed.info);
        throw new ToolInterrupt(structuredClone(allowed.info));
      }
    }
    checkAbort(scope.signal);
    sideEffectStarted = tool.effect !== "read";
    executionStarted = true;
    const result = await abortable(
      Promise.resolve().then(() => {
        checkAbort(scope.signal);
        return tool.execute(args, ctx);
      }),
      scope.signal,
    );
    checkAbort(scope.signal);
    toolFinished = true;
    // 先验证结果形状，再让外置策略读取完整文本，最后应用硬性输出上限。
    let transformed = normalizeToolResult(result, Number.MAX_SAFE_INTEGER);
    for (const policy of config.contextPolicies ?? []) {
      if (!policy.afterTool) continue;
      transformed = await abortable(
        Promise.resolve().then(() =>
          policy.afterTool!({
            runId: context.runId,
            call: structuredClone(call),
            result: structuredClone(transformed),
            signal: scope.signal,
            maxResultBytes: limits.maxToolResultBytes,
          }),
        ),
        scope.signal,
      );
      transformed = normalizeToolResult(transformed, Number.MAX_SAFE_INTEGER);
    }
    return normalizeToolResult(transformed, limits.maxToolResultBytes);
  } catch (error) {
    if (!scope.signal.aborted && !executionStarted && error instanceof ToolInterrupt) throw error;
    // 取消优先于迟到的业务错误，避免超时后又进入下一轮重试写操作。
    if (!scope.signal.aborted && !toolFinished && error instanceof ToolError) {
      return normalizeToolResult(
        {
          ok: false,
          code: error.code,
          message: error.message,
          retryableByModel: error.retryableByModel,
        },
        limits.maxToolResultBytes,
      );
    }
    let failure = error;
    if (scope.signal.aborted) {
      try {
        checkAbort(scope.signal);
      } catch (abortError) {
        failure = abortError;
      }
    }
    const fatal = toAgentError(failure);
    throw new AgentError(fatal.code, fatal.message, sideEffectStarted || fatal.outcomeUnknown);
  } finally {
    scope.cancel();
    scope.dispose();
  }
}
