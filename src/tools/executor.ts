import { AgentError, ToolError, toAgentError } from "../protocol/errors.js";
import type {
  AgentConfig,
  Limits,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolChunk,
  ToolEndpoint,
} from "../protocol/types.js";
import {
  abortable,
  byteLength,
  checkAbort,
  createScope,
  truncateUtf8,
} from "../runtime/control.js";
import type { ToolRegistry } from "./registry.js";
import { AgentToolInterrupt, ToolInterrupt } from "../runtime/interrupt.js";
import { validateChildEvent, validatePath } from "../runtime/delegation.js";
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
export async function* streamTool<C>(
  registry: ToolRegistry<C>,
  call: ToolCall,
  context: ToolContext<C>,
  config: AgentConfig<C>,
  limits: Limits,
  availableTools?: ReadonlySet<string>,
): AsyncGenerator<ToolChunk> {
  const scope = createScope(context.signal, limits.toolTimeoutMs, "tool_timeout");
  const ctx = { ...context, signal: scope.signal };
  let sideEffectStarted = false;
  let executionStarted = false;
  let toolFinished = false;
  let iterator: AsyncIterator<ToolChunk> | undefined;
  let streamFinished = false;
  let delegates = false;
  try {
    checkAbort(scope.signal);
    const { tool, args } = registry.prepare(call.name, call.arguments);
    delegates = tool.delegates === true;
    if (availableTools && !availableTools.has(call.name))
      throw new ToolError(
        "tool_not_available",
        "Tool is not available in this model request",
        false,
      );
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
    executionStarted = true;
    // 包装器位于权限检查之后；next 无参数且只可调用一次，不能绕过校验或重复写入。
    let endpoint: ToolEndpoint = async function* () {
      checkAbort(scope.signal);
      sideEffectStarted = tool.effect !== "read";
      if (tool.stream) {
        for await (const chunk of tool.stream(args, ctx)) {
          // 业务已交付结果后包装器再报错，不得伪装成可重试的业务失败。
          if (chunk?.type === "result") toolFinished = true;
          // 子 Agent 已终止时副作用可能已经完成，包装器不能在 final result 之前把失败伪装成可重试。
          if (
            delegates &&
            chunk?.type === "agent_event" &&
            chunk.path.length === (context.delegation?.path.length ?? 0) + 1 &&
            chunk.event.type === "run_end" &&
            chunk.event.payload.result.status !== "interrupted"
          )
            toolFinished = true;
          yield chunk;
        }
      } else {
        const result = await tool.execute(args, ctx);
        toolFinished = true;
        yield { type: "result", result };
      }
    };
    for (const middleware of [...(config.middlewares ?? [])].reverse()) {
      if (!middleware.wrapTool) continue;
      const inner = endpoint;
      let invoked = false;
      endpoint = () =>
        middleware.wrapTool!(Object.freeze({ ...call }), ctx, () => {
          checkAbort(scope.signal);
          if (invoked)
            throw new AgentError("invalid_middleware", "Tool next may only be called once");
          invoked = true;
          return inner();
        });
    }
    iterator = endpoint()[Symbol.asyncIterator]();
    let raw: ToolResult | undefined;
    let outputBytes = 0;
    while (true) {
      const next = await abortable(
        Promise.resolve().then(() => iterator!.next()),
        scope.signal,
      );
      if (next.done) {
        streamFinished = true;
        break;
      }
      if (raw)
        throw new AgentError("invalid_tool_stream", "Tool emitted chunks after its final result");
      const chunk = next.value;
      if (
        chunk?.type === "text_delta" &&
        typeof chunk.text === "string" &&
        (chunk.channel === undefined || chunk.channel === "stdout" || chunk.channel === "stderr")
      ) {
        outputBytes += byteLength(chunk.text);
        if (outputBytes > limits.maxToolStreamBytes)
          throw new AgentError("limit_exceeded", "Tool stream exceeds progress budget");
        if (chunk.text) yield structuredClone(chunk);
      } else if (chunk?.type === "agent_event" && delegates) {
        validatePath(chunk.path);
        validateChildEvent(chunk.event);
        const prefix = context.delegation?.path ?? [];
        const child = chunk.path[prefix.length];
        if (
          JSON.stringify(chunk.path.slice(0, prefix.length)) !== JSON.stringify(prefix) ||
          !child ||
          child.parentRunId !== context.runId ||
          child.toolCallId !== context.toolCallId
        )
          throw new AgentError("invalid_agent_event", "Child event does not belong to this call");
        outputBytes += byteLength(chunk);
        if (outputBytes > limits.maxToolStreamBytes)
          throw new AgentError("limit_exceeded", "Nested events exceed tool stream budget");
        yield structuredClone(chunk);
      } else if (chunk?.type === "result")
        raw = normalizeToolResult(chunk.result, Number.MAX_SAFE_INTEGER);
      else throw new AgentError("invalid_tool_stream", "Invalid tool stream chunk");
    }
    if (!raw) throw new AgentError("invalid_tool_stream", "Tool stream ended without a result");
    checkAbort(scope.signal);
    toolFinished = true;
    // 外置策略拿到完整最终结果，展示用进度永远不进入工作历史或检查点。
    let transformed = raw;
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
    yield { type: "result", result: normalizeToolResult(transformed, limits.maxToolResultBytes) };
  } catch (error) {
    if (!scope.signal.aborted && delegates && !toolFinished && error instanceof AgentToolInterrupt)
      throw error;
    if (!scope.signal.aborted && !executionStarted && error instanceof ToolInterrupt) throw error;
    if (!scope.signal.aborted && !toolFinished && error instanceof ToolError) {
      yield {
        type: "result",
        result: normalizeToolResult(
          {
            ok: false,
            code: error.code,
            message: error.message,
            retryableByModel: error.retryableByModel,
          },
          limits.maxToolResultBytes,
        ),
      };
      return;
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
    if (iterator && !streamFinished)
      void Promise.resolve()
        .then(() => iterator!.return?.())
        .catch(() => {});
  }
}

/** 保留非流式内部入口；与 Runner 使用同一执行路径，不会重复执行工具。 */
export async function executeTool<C>(
  registry: ToolRegistry<C>,
  call: ToolCall,
  context: ToolContext<C>,
  config: AgentConfig<C>,
  limits: Limits,
): Promise<ToolResult> {
  for await (const chunk of streamTool(registry, call, context, config, limits))
    if (chunk.type === "result") return chunk.result;
  throw new AgentError("invalid_tool_stream", "Tool ended without a result");
}
