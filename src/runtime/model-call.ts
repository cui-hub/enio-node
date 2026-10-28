import { AgentError, ModelError } from "../protocol/errors.js";
import type {
  AgentConfig,
  EventPayloads,
  Limits,
  MiddlewareContext,
  ModelChunk,
  ModelEndpoint,
  ModelRequest,
  ModelResponse,
} from "../protocol/types.js";
import { abortable, byteLength, checkAbort, createScope, delay } from "./control.js";
import { validateResponse } from "./history.js";

/** 内部事件不创建公共序号，统一交由主 Loop 编号，保证重试/切换也在同一事件流。 */
type ModelEvent =
  | {
      [K in "model_start" | "model_retry" | "model_fallback" | "text_delta"]: {
        type: K;
        payload: EventPayloads[K];
      };
    }["model_start" | "model_retry" | "model_fallback" | "text_delta"]
  | { type: "response"; response: ModelResponse; modelIndex: number };

/**
 * 一轮逻辑模型调用：逐模型重试、失败切换、包装器执行和流协议验证。
 * 成功模型仅在当前 run 内粘滞使用；输出过文本后任何失败都不可重放。
 */
export async function* callModel<C>(input: {
  config: AgentConfig<C>;
  request: ModelRequest;
  context: MiddlewareContext<C>;
  limits: Limits;
  activeModel: number;
  seen: Set<string>;
  validateRequest(request: ModelRequest): void;
  onFailure(): void;
}): AsyncGenerator<ModelEvent> {
  const { config, request, context, limits } = input;
  const models = [config.model, ...(config.modelFailover?.models ?? [])];
  const order = [
    input.activeModel,
    ...models.map((_, index) => index).filter((index) => index !== input.activeModel),
  ];
  for (let position = 0; position < order.length; position++) {
    const modelIndex = order[position]!;
    const model = models[modelIndex]!;
    let switchError: ModelError | undefined;
    for (let attempt = 0; ; attempt++) {
      checkAbort(context.signal);
      const scope = createScope(context.signal, limits.modelTimeoutMs, "model_timeout");
      const ctx = { ...context, signal: scope.signal, modelIndex, attempt: attempt + 1 };
      let iterator: AsyncIterator<ModelChunk> | undefined;
      let finished = false;
      let exposed = false;
      let text = "";
      let bytes = 0;
      let response: ModelResponse | undefined;
      let retry = false;
      try {
        yield { type: "model_start", payload: { attempt: attempt + 1, modelIndex } };
        // 非流式模型仍只产生最终响应；包装器可以自行增加流式片段。
        let endpoint: ModelEndpoint = async function* (candidate) {
          checkAbort(scope.signal);
          input.validateRequest(candidate);
          if (model.stream) yield* model.stream(structuredClone(candidate), scope.signal);
          else
            yield {
              type: "response",
              response: await model.generate(structuredClone(candidate), scope.signal),
            };
        };
        for (const middleware of [...(config.middlewares ?? [])].reverse()) {
          if (!middleware.wrapModel) continue;
          const inner = endpoint;
          let invoked = false;
          endpoint = (candidate) =>
            middleware.wrapModel!(structuredClone(candidate), ctx, (nextRequest) => {
              checkAbort(scope.signal);
              if (invoked)
                throw new AgentError(
                  "invalid_middleware",
                  "Model next may only be called once per attempt",
                );
              invoked = true;
              return inner(structuredClone(nextRequest));
            });
        }
        iterator = endpoint(structuredClone(request))[Symbol.asyncIterator]();
        while (true) {
          const next = await abortable(
            Promise.resolve().then(() => iterator!.next()),
            scope.signal,
          );
          if (next.done) {
            finished = true;
            break;
          }
          if (response)
            throw new AgentError("protocol_error", "Chunks received after final model response");
          const chunk = next.value;
          if (chunk?.type === "text_delta" && typeof chunk.text === "string") {
            bytes += byteLength(chunk.text);
            if (bytes > limits.maxModelResponseBytes)
              throw new AgentError("limit_exceeded", "Model text exceeds response budget");
            text += chunk.text;
            if (chunk.text) {
              exposed = true;
              yield { type: "text_delta", payload: { text: chunk.text } };
            }
          } else if (chunk?.type === "response") response = structuredClone(chunk.response);
          else throw new AgentError("protocol_error", "Unknown model chunk");
        }
        if (!response)
          throw new AgentError(
            "incomplete_response",
            "Model stream ended without a final response",
          );
        validateResponse(response, new Set(input.seen));
        for (const middleware of config.middlewares ?? []) {
          if (!middleware.afterModel) continue;
          const update = await abortable(
            Promise.resolve().then(() => middleware.afterModel!(structuredClone(response!), ctx)),
            scope.signal,
          );
          if (update !== undefined) response = structuredClone(update);
          validateResponse(response, new Set(input.seen));
        }
        if ((model.stream || exposed) && response.message.content !== text)
          throw new AgentError(
            "protocol_error",
            "Stream text differs from final response; transform both in wrapModel",
          );
        if (byteLength(response) > limits.maxModelResponseBytes)
          throw new AgentError("limit_exceeded", "maxModelResponseBytes exceeded");
        checkAbort(scope.signal);
      } catch (cause) {
        input.onFailure();
        response = undefined;
        if (context.signal.aborted) checkAbort(context.signal);
        if (scope.signal.aborted) checkAbort(scope.signal);
        if (cause instanceof ModelError && !exposed) {
          if (cause.retryable && attempt < limits.maxModelRetries) retry = true;
          else if (
            position + 1 < order.length &&
            (config.modelFailover?.shouldFailover?.(cause) ?? cause.retryable)
          )
            switchError = cause;
          else throw cause;
        } else throw cause;
      } finally {
        scope.cancel();
        scope.dispose();
        if (iterator && !finished)
          void Promise.resolve()
            .then(() => iterator!.return?.())
            .catch(() => {});
      }
      if (response) {
        yield { type: "response", response, modelIndex };
        return;
      }
      if (switchError) break;
      if (!retry) throw new AgentError("internal_error", "Model attempt ended without a result");
      const delayMs = Math.min(limits.retryDelayMs * 2 ** attempt, 10_000);
      yield { type: "model_retry", payload: { attempt: attempt + 2, delayMs, modelIndex } };
      await delay(delayMs, context.signal);
    }
    yield {
      type: "model_fallback",
      payload: { from: modelIndex, to: order[position + 1]!, code: switchError!.code },
    };
  }
}
