import { randomUUID } from "node:crypto";
import { AgentError, ModelError, toAgentError } from "../protocol/errors.js";
import type {
  Agent,
  AgentConfig,
  AgentEvent,
  EventPayloads,
  Message,
  ModelChunk,
  ModelResponse,
  RunInput,
  RunOptions,
  RunResult,
  RunState,
} from "../protocol/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { executeTool } from "../tools/executor.js";
import { abortable, byteLength, checkAbort, createScope, delay, resolveLimits } from "./control.js";
import { validateHistory, validateResponse } from "./history.js";

/**
 * 创建可复用的单 Agent。配置错误在这里同步抛出；运行中的错误通过 run_end
 * 返回。业务状态、历史、计数器和取消域都在每次迭代开始时新建。
 */
export function createAgent<C = Record<string, never>>(configuration: AgentConfig<C>): Agent<C> {
  const config = { ...configuration, hooks: { ...configuration.hooks } };
  if (typeof config.model?.generate !== "function")
    throw new AgentError("invalid_config", "A ChatModel is required");
  if (config.agentsMd !== undefined && typeof config.agentsMd?.load !== "function")
    throw new AgentError("invalid_config", "agentsMd.load must be a function");
  // 保留接收者，以支持 class 实现；创建 Agent 本身不读取文件。
  const loadAgentsMd = config.agentsMd?.load.bind(config.agentsMd);
  const baseLimits = resolveLimits(config.limits);
  const registry = new ToolRegistry(config.tools ?? []);

  /** 自然背压：消费者没有请求下一个事件时，不读取下一片模型流或启动下个工具。 */
  async function* engine(
    input: RunInput,
    options: RunOptions<C>,
    parent: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const runId = randomUUID();
    let limits = baseLimits;
    let iteration = 0;
    let callsCount = 0;
    let seq = 0;
    let observerErrors = 0;
    let messages: Message[] = [];
    const pending = new Set<string>();
    const state: RunState = { todos: [] };
    const usage = { inputTokens: 0, outputTokens: 0, known: true };
    let finalText = "";
    let error: AgentError | undefined;
    let inputValid = false;
    // 配置覆盖的非法值也走稳定终止事件，而非让异步迭代器意外抛错。
    let scope = createScope(parent, baseLimits.runTimeoutMs, "run_timeout");

    const event = <K extends keyof EventPayloads>(
      type: K,
      payload: EventPayloads[K],
    ): AgentEvent => {
      const value = structuredClone({
        schemaVersion: 1 as const,
        runId,
        seq: ++seq,
        iteration,
        timestamp: new Date().toISOString(),
        type,
        payload,
      }) as AgentEvent;
      try {
        const observed = config.hooks?.onEvent?.(structuredClone(value));
        if (observed)
          void Promise.resolve(observed).catch(() => {
            observerErrors++;
          });
      } catch {
        observerErrors++;
      }
      return value;
    };

    try {
      yield event("run_start", {});
      limits = resolveLimits(baseLimits, options.limits);
      scope.dispose();
      scope = createScope(parent, limits.runTimeoutMs, "run_timeout");
      checkAbort(scope.signal);
      if (!input || typeof input.input !== "string" || !input.input.trim())
        throw new AgentError("invalid_input", "A nonempty input is required");
      messages = structuredClone(input.messages ?? []);
      const seen = validateHistory(messages);
      inputValid = true;
      messages.push({ role: "user", content: input.input });

      // 每个 run 独立加载一次（空结果也缓存）。文件改动从下次 run 生效，
      // 不共享跨 run 的 Promise，避免并发运行串用内容或取消信号。
      const projectInstructions = loadAgentsMd
        ? await abortable(
            Promise.resolve().then(() => loadAgentsMd(scope.signal)),
            scope.signal,
          )
        : "";
      checkAbort(scope.signal);
      if (typeof projectInstructions !== "string")
        throw new AgentError("invalid_agents_md", "agentsMd.load must return text");

      while (true) {
        checkAbort(scope.signal);
        if (iteration >= limits.maxIterations)
          throw new AgentError("limit_exceeded", "maxIterations exceeded");
        iteration++;
        let extra: string | void = undefined;
        if (config.hooks?.beforeModel) {
          extra = await abortable(
            Promise.resolve().then(() =>
              config.hooks!.beforeModel!({
                runId,
                iteration,
                context: options.context,
                signal: scope.signal,
              }),
            ),
            scope.signal,
          );
          if (extra !== undefined && typeof extra !== "string")
            throw new AgentError("invalid_hook", "beforeModel must return text or void");
        }
        const request = { messages: structuredClone(messages), tools: registry.definitions() };
        // 与 Eino agentsmd 对齐：插在首条 user 消息之前，保留 system 的优先级。
        // 只修改请求快照，避免恢复历史时累积副本，也不会拆开 assistant/tool 配对。
        if (projectInstructions.trim()) {
          const firstUser = request.messages.findIndex((message) => message.role === "user");
          request.messages.splice(firstUser < 0 ? request.messages.length : firstUser, 0, {
            role: "user",
            content: projectInstructions,
          });
        }
        // 固定指令只组装进请求，不重复写入可复用历史，避免多次 run 累积副本。
        if (config.instructions)
          request.messages.unshift({ role: "system", content: config.instructions });
        if (extra) request.messages.unshift({ role: "system", content: extra });
        if (byteLength(request) > limits.maxInputBytes)
          throw new AgentError("limit_exceeded", "maxInputBytes exceeded");

        let response: ModelResponse | undefined;
        for (let attempt = 0; ; attempt++) {
          checkAbort(scope.signal);
          const modelScope = createScope(scope.signal, limits.modelTimeoutMs, "model_timeout");
          let exposed = false;
          let iterator: AsyncIterator<ModelChunk> | undefined;
          let streamFinished = false;
          let streamBytes = 0;
          let streamedText = "";
          let retry = false;
          try {
            yield event("model_start", { attempt: attempt + 1 });
            checkAbort(modelScope.signal);
            if (config.model.stream) {
              iterator = config.model
                .stream(structuredClone(request), modelScope.signal)
                [Symbol.asyncIterator]();
              while (true) {
                const next = await abortable(
                  Promise.resolve().then(() => iterator!.next()),
                  modelScope.signal,
                );
                if (next.done) {
                  streamFinished = true;
                  break;
                }
                if (response)
                  throw new AgentError(
                    "protocol_error",
                    "Chunks received after final model response",
                  );
                const chunk = next.value;
                if (chunk.type === "text_delta" && typeof chunk.text === "string") {
                  streamBytes += byteLength(chunk.text);
                  if (streamBytes > limits.maxModelResponseBytes)
                    throw new AgentError("limit_exceeded", "Model text exceeds response budget");
                  streamedText += chunk.text;
                  if (chunk.text) {
                    exposed = true;
                    yield event("text_delta", { text: chunk.text });
                  }
                } else if (chunk.type === "response") response = structuredClone(chunk.response);
                else throw new AgentError("protocol_error", "Unknown model chunk");
              }
              if (!response)
                throw new AgentError(
                  "incomplete_response",
                  "Model stream ended without a final response",
                );
              if (response.message.content !== streamedText)
                throw new AgentError("protocol_error", "Stream text differs from final response");
            } else {
              response = structuredClone(
                await abortable(
                  Promise.resolve().then(() =>
                    config.model.generate(structuredClone(request), modelScope.signal),
                  ),
                  modelScope.signal,
                ),
              );
            }
            checkAbort(modelScope.signal);
          } catch (cause) {
            usage.known = false; // 失败请求可能已消耗 token，缺少 usage 时不能报告为零费用。
            response = undefined;
            if (scope.signal.aborted) checkAbort(scope.signal);
            if (modelScope.signal.aborted) checkAbort(modelScope.signal);
            if (
              cause instanceof ModelError &&
              cause.retryable &&
              !exposed &&
              attempt < limits.maxModelRetries
            )
              retry = true;
            else throw cause;
          } finally {
            modelScope.cancel();
            modelScope.dispose();
            // 不等待不合作的 iterator.return；signal 已取消时供应商必须自行释放 I/O。
            if (iterator && !streamFinished)
              void Promise.resolve(iterator.return?.()).catch(() => {});
          }
          if (!retry) break;
          const delayMs = Math.min(limits.retryDelayMs * 2 ** attempt, 10_000);
          yield event("model_retry", { attempt: attempt + 2, delayMs });
          await delay(delayMs, scope.signal);
        }

        checkAbort(scope.signal);
        if (!response) throw new AgentError("protocol_error", "Missing model response");
        if (byteLength(response) > limits.maxModelResponseBytes)
          throw new AgentError("limit_exceeded", "maxModelResponseBytes exceeded");
        validateResponse(response, seen);
        const calls = response.message.toolCalls ?? [];
        if (
          calls.length > limits.maxToolCallsPerRound ||
          callsCount + calls.length > limits.maxToolCalls
        )
          throw new AgentError(
            "limit_exceeded",
            "Tool call budget exceeded before batch execution",
          );
        if (calls.some((call) => byteLength(call.arguments) > limits.maxToolArgumentBytes))
          throw new AgentError("limit_exceeded", "maxToolArgumentBytes exceeded");
        if (response.usage) {
          usage.inputTokens += response.usage.inputTokens;
          usage.outputTokens += response.usage.outputTokens;
        } else usage.known = false;
        messages.push(response.message);
        if (!calls.length) {
          finalText = response.message.content;
          break;
        }
        calls.forEach((call) => pending.add(call.id));
        for (const call of calls) {
          checkAbort(scope.signal);
          yield event("tool_call_ready", { call });
          checkAbort(scope.signal);
          callsCount++;
          yield event("tool_start", { id: call.id, name: call.name });
          checkAbort(scope.signal);
          const result = await executeTool(
            registry,
            call,
            { runId, toolCallId: call.id, signal: scope.signal, context: options.context, state },
            config,
            limits,
          );
          messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
          pending.delete(call.id);
          yield event("tool_end", { id: call.id, name: call.name, result });
        }
      }
    } catch (cause) {
      error = toAgentError(cause);
    } finally {
      scope.cancel();
      scope.dispose();
    }
    const result: RunResult = {
      runId,
      status: error ? (error.code === "cancelled" ? "cancelled" : "failed") : "completed",
      stopReason: error?.code ?? "stop",
      finalText,
      messages: structuredClone(messages),
      historyComplete: inputValid && pending.size === 0,
      pendingToolCallIds: [...pending],
      todos: structuredClone(state.todos),
      iterations: iteration,
      toolCalls: callsCount,
      usage,
      observerErrors,
      ...(error
        ? {
            error: {
              code: error.code,
              message: error.message,
              ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}),
            },
          }
        : {}),
    };
    yield event("run_end", { result });
  }

  const agent: Agent<C> = {
    stream(input, options) {
      const controller = new AbortController();
      const cancel = () => controller.abort(new AgentError("cancelled", "Run cancelled by caller"));
      // AbortSignal.any 不需要手动挂载一个可能泄漏的外部信号监听器。
      const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
      const generator = engine(input, options, signal);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => generator.next(),
        async return() {
          cancel();
          return generator.return(undefined);
        },
        async throw(error?: unknown) {
          cancel();
          return generator.throw(error);
        },
      };
    },
    async run(input, options) {
      for await (const item of agent.stream(input, options))
        if (item.type === "run_end") return item.payload.result;
      throw new AgentError("internal_error", "Run ended without terminal event");
    },
  };
  return agent;
}
