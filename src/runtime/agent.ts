import { createHash, randomUUID } from "node:crypto";
import { AgentError, toAgentError } from "../protocol/errors.js";
import type {
  Agent,
  AgentConfig,
  AgentEvent,
  EventPayloads,
  Message,
  ModelResponse,
  RunInput,
  RunOptions,
  RunResult,
  RunState,
  AgentSnapshot,
  Checkpoint,
  ResumeInput,
  RunInterrupt,
  ToolCall,
  ModelRequest,
  JsonValue,
  MiddlewareContext,
  ToolResult,
  DelegationScope,
  Usage,
} from "../protocol/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { callModel } from "./model-call.js";
import { selectBatch, runToolBatch } from "./tool-batch.js";
import { abortable, byteLength, checkAbort, createScope, resolveLimits } from "./control.js";
import { validateHistory, validateResponse } from "./history.js";
import { assertJson, validateCheckpoint, validateSnapshot } from "./state.js";
import { AgentToolInterrupt, ToolInterrupt } from "./interrupt.js";
import { inheritedHistory, validateDelegation } from "./delegation.js";

/**
 * 创建可复用的单 Agent。配置错误在这里同步抛出；运行中的错误通过 run_end
 * 返回。业务状态、历史、计数器和取消域都在每次迭代开始时新建。
 */
export function createAgent<C = Record<string, never>>(configuration: AgentConfig<C>): Agent<C> {
  if (configuration.modelFailover && !Array.isArray(configuration.modelFailover.models))
    throw new AgentError("invalid_config", "modelFailover.models must be an array");
  const config = {
    ...configuration,
    hooks: { ...configuration.hooks },
    contextPolicies: [...(configuration.contextPolicies ?? [])],
    middlewares: [...(configuration.middlewares ?? [])],
    toolExecution: { ...configuration.toolExecution },
    delegation: { ...configuration.delegation },
    modelFailover: configuration.modelFailover
      ? { ...configuration.modelFailover, models: [...configuration.modelFailover.models] }
      : undefined,
    checkpoints: configuration.checkpoints ? { ...configuration.checkpoints } : undefined,
  };
  if (typeof config.model?.generate !== "function")
    throw new AgentError("invalid_config", "A ChatModel is required");
  if (config.agentsMd !== undefined && typeof config.agentsMd?.load !== "function")
    throw new AgentError("invalid_config", "agentsMd.load must be a function");
  // 保留接收者，以支持 class 实现；创建 Agent 本身不读取文件。
  const loadAgentsMd = config.agentsMd?.load.bind(config.agentsMd);
  const baseLimits = resolveLimits(config.limits);
  const baseRegistry = new ToolRegistry(config.tools ?? []);
  const maxConcurrency = config.toolExecution.maxConcurrency ?? 1;
  const maxDepth = config.delegation.maxDepth ?? 4;
  const maxAgentCalls = config.delegation.maxCalls ?? 32;
  validateDelegation({ path: [], maxDepth, budget: { maxCalls: maxAgentCalls, calls: 0 } });
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64)
    throw new AgentError("invalid_config", "maxConcurrency must be an integer between 1 and 64");
  if (
    config.modelFailover?.models.some((model) => typeof model?.generate !== "function") ||
    (config.modelFailover?.shouldFailover !== undefined &&
      typeof config.modelFailover.shouldFailover !== "function")
  )
    throw new AgentError("invalid_config", "Invalid model failover configuration");
  const middlewareNames = new Set<string>();
  for (const middleware of config.middlewares) {
    if (
      !middleware?.name ||
      middlewareNames.has(middleware.name) ||
      ["beforeAgent", "beforeModel", "afterModel", "wrapModel", "wrapTool", "afterAgent"].some(
        (key) => {
          const value = middleware[key as keyof typeof middleware];
          return value !== undefined && typeof value !== "function";
        },
      )
    )
      throw new AgentError("invalid_config", "Invalid or duplicate middleware");
    middlewareNames.add(middleware.name);
  }
  if (
    config.checkpoints &&
    (!config.checkpoints.namespace?.trim() ||
      typeof config.checkpoints.store?.save !== "function" ||
      typeof config.checkpoints.store?.take !== "function")
  )
    throw new AgentError("invalid_config", "Checkpoint namespace and atomic store are required");
  for (const policy of config.contextPolicies)
    if (
      !policy.name ||
      (policy.beforeModel !== undefined && typeof policy.beforeModel !== "function") ||
      (policy.afterTool !== undefined && typeof policy.afterTool !== "function")
    )
      throw new AgentError("invalid_config", "Invalid context policy");
  // 函数实现无法序列化比对；实现或策略配置变更时宿主须升级 namespace。
  const fingerprint = JSON.stringify({
    namespace: config.checkpoints?.namespace,
    instructions: config.instructions,
    tools: baseRegistry.definitions(),
    effects: config.tools?.map((tool) => tool.effect),
    policies: config.contextPolicies.map((policy) => policy.name),
    // 未启用 V3 扩展时保持 V2 指纹结构，旧检查点可以继续恢复。
    ...(config.middlewares.length ? { middlewares: [...middlewareNames] } : {}),
    ...(maxConcurrency > 1 ? { maxConcurrency } : {}),
    ...(config.modelFailover ? { fallbackCount: config.modelFailover.models.length } : {}),
    ...(configuration.delegation ? { delegation: config.delegation } : {}),
    ...((config.tools ?? []).some((tool) => tool.delegates)
      ? {
          delegates: (config.tools ?? []).filter((tool) => tool.delegates).map((tool) => tool.name),
        }
      : {}),
    ...((config.tools ?? []).some((tool) => tool.parallelSafe || tool.returnDirect)
      ? {
          behaviors: (config.tools ?? []).map((tool) => [
            tool.name,
            !!tool.parallelSafe,
            !!tool.returnDirect,
          ]),
        }
      : {}),
  });
  const bindingFor = (options: RunOptions<C>) => {
    if (!config.checkpoints)
      throw new AgentError("invalid_config", "Checkpoints are not configured");
    if (!options.checkpointOwner?.trim())
      throw new AgentError("invalid_input", "checkpointOwner is required");
    return createHash("sha256")
      .update(JSON.stringify([fingerprint, options.checkpointOwner]))
      .digest("hex");
  };

  /**
   * 拉取式背压：消费者暂停时不继续拉取模型流或启动下一工具批次。
   * 已启动的并发工具仍可完成当前 next，每个工具最多预取一个片段；
   * 真实进程的 stdout/stderr 由 backend 在输出字节预算内缓存。
   */
  async function* engine(
    input: RunInput,
    options: RunOptions<C>,
    parent: AbortSignal,
    resumeInput?: ResumeInput,
  ): AsyncGenerator<AgentEvent> {
    let registry = baseRegistry;
    let runInstructions = config.instructions ?? "";
    let setupSignature: string | undefined;
    let restoredSetup: string | undefined;
    let availableTools: Set<string> | undefined;
    let activeModel = 0;
    let delegation: DelegationScope = {
      path: [],
      maxDepth,
      budget: { maxCalls: maxAgentCalls, calls: 0 },
    };
    const continuations = new Map<string, JsonValue>();
    const childUsage = new Map<string, Usage & { known: boolean }>();
    let returnedDirectly = false;
    let runId = randomUUID() as string;
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
    let seen = new Set<string>();
    let queue: ToolCall[] = [];
    let projectInstructions = "";
    let interrupted: RunInterrupt | undefined;
    let snapshot: AgentSnapshot | undefined;
    let resumeData: { data: JsonValue } | undefined;
    const capture = (): AgentSnapshot =>
      structuredClone({
        schemaVersion: 1,
        // TypeScript 允许可选字段显式为 undefined；持久化时使用省略形式。
        messages: messages.map((message) =>
          message.role === "assistant" && message.toolCalls === undefined
            ? { role: "assistant", content: message.content }
            : message,
        ),
        todos: state.todos,
        usedToolCallIds: [...seen],
      });
    // 配置覆盖的非法值也走稳定终止事件，而非让异步迭代器意外抛错。
    let scope = createScope(parent, baseLimits.runTimeoutMs, "run_timeout");

    const middlewareContext = (): MiddlewareContext<C> => ({
      runId,
      iteration,
      context: options.context,
      signal: scope.signal,
      resumed: !!resumeInput,
    });
    const finish = async () => {
      snapshot = validateSnapshot(capture());
      for (const middleware of config.middlewares) {
        if (middleware.afterAgent)
          await abortable(
            Promise.resolve().then(() =>
              middleware.afterAgent!(structuredClone(snapshot!), middlewareContext()),
            ),
            scope.signal,
          );
      }
      if (config.hooks.afterAgent)
        await abortable(
          Promise.resolve().then(() =>
            config.hooks.afterAgent!(structuredClone(snapshot!), {
              runId,
              context: options.context,
              signal: scope.signal,
            }),
          ),
          scope.signal,
        );
    };

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
      if (!resumeInput) yield event("run_start", {});
      limits = resolveLimits(baseLimits, options.limits);
      scope.dispose();
      scope = createScope(parent, limits.runTimeoutMs, "run_timeout");
      checkAbort(scope.signal);
      if (options.delegation) {
        validateDelegation(options.delegation);
        // 共享的只有全树调用计数；路径另行复制，子级可以收紧最大深度。
        delegation = {
          path: structuredClone(options.delegation.path),
          maxDepth: Math.min(
            options.delegation.maxDepth,
            config.delegation.maxDepth ?? options.delegation.maxDepth,
          ),
          budget: options.delegation.budget,
        };
        validateDelegation(delegation);
      }
      if (config.checkpoints) bindingFor(options);
      if (resumeInput) {
        assertJson(resumeInput.data);
        const binding = bindingFor(options);
        const restored = validateCheckpoint(
          await abortable(
            config.checkpoints!.store.take(resumeInput.checkpointId, binding, scope.signal),
            scope.signal,
          ),
        );
        if (restored.binding !== bindingFor(options))
          throw new AgentError("checkpoint_mismatch", "Checkpoint binding differs");
        runId = restored.runId;
        seq = restored.seq;
        iteration = restored.iteration;
        callsCount = restored.toolCalls;
        Object.assign(usage, restored.usage);
        messages = restored.state.messages;
        state.todos = restored.state.todos;
        seen = new Set(restored.state.usedToolCallIds);
        queue = restored.pendingCalls;
        queue.forEach((call) => pending.add(call.id));
        projectInstructions = restored.projectInstructions;
        activeModel = restored.modelIndex ?? 0;
        if (activeModel > (config.modelFailover?.models.length ?? 0))
          throw new AgentError("checkpoint_mismatch", "Checkpoint model index is not configured");
        restoredSetup = restored.setupSignature;
        availableTools = restored.availableTools ? new Set(restored.availableTools) : undefined;
        Object.entries(restored.continuations ?? {}).forEach(([id, value]) =>
          continuations.set(id, value),
        );
        Object.entries(restored.childUsage ?? {}).forEach(([id, value]) =>
          childUsage.set(id, value),
        );
        if (restored.delegation) {
          if (
            JSON.stringify(restored.delegation.path) !== JSON.stringify(delegation.path) ||
            restored.delegation.maxDepth !== delegation.maxDepth ||
            restored.delegation.budget.maxCalls !== delegation.budget.maxCalls
          )
            throw new AgentError(
              "checkpoint_mismatch",
              "Agent invocation path or tree budget changed",
            );
          delegation.budget.calls = Math.max(
            delegation.budget.calls,
            restored.delegation.budget.calls,
          );
        }
        limits = resolveLimits(restored.limits, options.limits);
        scope.dispose();
        scope = createScope(parent, limits.runTimeoutMs, "run_timeout");
        resumeData = { data: structuredClone(resumeInput.data) };
        inputValid = true;
        yield event("run_resumed", { checkpointId: resumeInput.checkpointId });
      } else {
        if (!input || typeof input.input !== "string" || !input.input.trim())
          throw new AgentError("invalid_input", "A nonempty input is required");
        if (input.state && input.messages)
          throw new AgentError("invalid_input", "state and messages are mutually exclusive");
        if (input.state) {
          const restored = validateSnapshot(input.state);
          messages = restored.messages;
          state.todos = restored.todos;
          seen = new Set(restored.usedToolCallIds);
        } else {
          messages = structuredClone(input.messages ?? []);
          seen = validateHistory(messages);
        }
        inputValid = true;
        messages.push({ role: "user", content: input.input });

        // 每个 run 独立加载一次（空结果也缓存）。文件改动从下次 run 生效，
        // 不共享跨 run 的 Promise，避免并发运行串用内容或取消信号。
        projectInstructions = loadAgentsMd
          ? await abortable(
              Promise.resolve().then(() => loadAgentsMd(scope.signal)),
              scope.signal,
            )
          : "";
        checkAbort(scope.signal);
        if (typeof projectInstructions !== "string")
          throw new AgentError("invalid_agents_md", "agentsMd.load must return text");
      }

      // 每个运行独立装配。工具函数保留接收者，元数据深拷贝，避免并发 run 串改配置。
      let setup = {
        instructions: runInstructions,
        tools: baseRegistry.tools(),
      };
      for (const middleware of config.middlewares) {
        if (!middleware.beforeAgent) continue;
        const update = await abortable(
          Promise.resolve().then(() => middleware.beforeAgent!(setup, middlewareContext())),
          scope.signal,
        );
        if (update !== undefined) setup = update;
        if (typeof setup?.instructions !== "string" || !Array.isArray(setup.tools))
          throw new AgentError(
            "invalid_middleware",
            "beforeAgent must return instructions and tools",
          );
      }
      registry = new ToolRegistry(setup.tools);
      runInstructions = setup.instructions;
      setupSignature = JSON.stringify({
        instructions: runInstructions,
        tools: registry.definitions(),
        behaviors: setup.tools.map((tool) => [
          tool.name,
          tool.effect,
          !!tool.parallelSafe,
          !!tool.returnDirect,
          ...(tool.delegates ? [true] : []),
        ]),
      });
      if (restoredSetup !== undefined && restoredSetup !== setupSignature)
        throw new AgentError("checkpoint_mismatch", "beforeAgent setup changed since interruption");

      while (true) {
        checkAbort(scope.signal);
        const hadCalls = queue.length > 0;
        // 恢复时优先完成已有批次；已回填的调用不再执行，也不重复请求模型。
        while (queue.length) {
          if (
            queue.length > limits.maxToolCallsPerRound ||
            callsCount + queue.length > limits.maxToolCalls ||
            queue.some((call) => byteLength(call.arguments) > limits.maxToolArgumentBytes)
          )
            throw new AgentError("limit_exceeded", "Pending tool batch exceeds current limits");
          const batch = selectBatch(queue, registry, maxConcurrency);
          // 只有消费方拉过开始事件后才启动本批次，最大在途调用数始终受配置约束。
          for (const call of batch) {
            checkAbort(scope.signal);
            yield event("tool_call_ready", { call });
            checkAbort(scope.signal);
            callsCount++;
            yield event("tool_start", { id: call.id, name: call.name });
          }
          const interruptedCalls = new Map<string, ToolInterrupt>();
          const resumeId = resumeData ? queue[0]!.id : undefined;
          for await (const item of runToolBatch({
            calls: batch,
            registry,
            config,
            limits,
            availableTools,
            continuations,
            context: {
              runId,
              signal: scope.signal,
              context: options.context,
              state,
              delegation,
              checkpointOwner: options.checkpointOwner,
              ...(registry.behavior(batch[0]!.name).delegates
                ? { messages: inheritedHistory(messages) }
                : {}),
            },
            ...(resumeId ? { resume: { id: resumeId, data: resumeData } } : {}),
          })) {
            if ("interrupt" in item) {
              // 尚未交付最终结果；恢复同一父调用时再计一次，子级已完成的步骤由其检查点保留。
              callsCount--;
              interruptedCalls.set(item.call.id, item.interrupt);
              if (item.interrupt instanceof AgentToolInterrupt)
                continuations.set(item.call.id, structuredClone(item.interrupt.continuation));
              continue;
            }
            if (item.chunk.type === "agent_event") {
              const nested = item.chunk.event;
              // 孙级用量已计入子级 run_end，只汇总直接子级，恢复后按累计值差额计入。
              if (
                item.chunk.path.length === delegation.path.length + 1 &&
                nested.type === "run_end"
              ) {
                const current = nested.payload.result.usage;
                const previous = childUsage.get(nested.runId) ?? {
                  inputTokens: 0,
                  outputTokens: 0,
                  known: true,
                };
                if (
                  current.inputTokens < previous.inputTokens ||
                  current.outputTokens < previous.outputTokens
                )
                  throw new AgentError("invalid_agent_event", "Child cumulative usage decreased");
                usage.inputTokens += current.inputTokens - previous.inputTokens;
                usage.outputTokens += current.outputTokens - previous.outputTokens;
                usage.known &&= current.known;
                childUsage.set(nested.runId, { ...current });
              }
              yield event("agent_event", { path: item.chunk.path, event: nested });
              continue;
            }
            if (item.chunk.type === "text_delta") {
              yield event("tool_output", {
                id: item.call.id,
                name: item.call.name,
                text: item.chunk.text,
                ...(item.chunk.channel ? { channel: item.chunk.channel } : {}),
              });
              continue;
            }
            const result = item.chunk.result;
            messages.push({
              role: "tool",
              toolCallId: item.call.id,
              content: JSON.stringify(result),
            });
            pending.delete(item.call.id);
            continuations.delete(item.call.id);
            queue = queue.filter((call) => call.id !== item.call.id);
            if (item.call.id === resumeId) resumeData = undefined;
            yield event("tool_end", { id: item.call.id, name: item.call.name, result });
          }
          // 并发只读批次完全收尾后保存：queue 中只剩未执行项，已完成读取不会重放。
          if (interruptedCalls.size) throw interruptedCalls.get(queue[0]!.id)!;
        }
        // 直接返回也须保持整个模型批次的工具配对；错误结果仍交给模型处理。
        const lastAssistant = [...messages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (hadCalls && lastAssistant?.role === "assistant") {
          const direct = lastAssistant.toolCalls?.find(
            (call) => registry.behavior(call.name).returnDirect,
          );
          const output =
            direct &&
            messages.find((message) => message.role === "tool" && message.toolCallId === direct.id);
          if (output) {
            const result = JSON.parse(output.content) as ToolResult;
            if (result.ok) {
              finalText = result.content;
              returnedDirectly = true;
              await finish();
              break;
            }
          }
        }
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
        const buildRequest = (): ModelRequest => {
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
          if (runInstructions)
            request.messages.unshift({ role: "system", content: runInstructions });
          if (extra) request.messages.unshift({ role: "system", content: extra });
          return request;
        };
        for (const policy of config.contextPolicies) {
          if (!policy.beforeModel) continue;
          const beforeBytes = byteLength(messages);
          const update = await abortable(
            Promise.resolve().then(() =>
              policy.beforeModel!({
                runId,
                messages: structuredClone(messages),
                request: buildRequest(),
                signal: scope.signal,
              }),
            ),
            scope.signal,
          ).catch((cause) => {
            // 策略可能已调用摘要模型，失败时无法确认完整用量。
            usage.known = false;
            throw cause;
          });
          if (!update) continue;
          const updatedIds = validateHistory(update.messages);
          if (
            update.usage &&
            [update.usage.inputTokens, update.usage.outputTokens].some(
              (value) => !Number.isSafeInteger(value) || value < 0,
            )
          )
            throw new AgentError("invalid_context", "Invalid context policy usage");
          messages = structuredClone(update.messages);
          // 扩展可保留或改写历史，但任何新编号都纳入后续去重。
          updatedIds.forEach((id) => seen.add(id));
          if (update.usage) {
            usage.inputTokens += update.usage.inputTokens;
            usage.outputTokens += update.usage.outputTokens;
          }
          if (update.usageKnown === false) usage.known = false;
          yield event("context_updated", {
            policy: policy.name,
            beforeBytes,
            afterBytes: byteLength(messages),
          });
        }
        let request = buildRequest();
        const validateRequest = (candidate: ModelRequest) => {
          if (!candidate) throw new AgentError("invalid_middleware", "Model request is required");
          validateHistory(candidate.messages);
          registry.validateDefinitions(candidate.tools);
          if (byteLength(candidate) > limits.maxInputBytes)
            throw new AgentError("limit_exceeded", "maxInputBytes exceeded");
          availableTools = new Set(candidate.tools.map((tool) => tool.name));
        };
        for (const middleware of config.middlewares) {
          if (!middleware.beforeModel) continue;
          const update = await abortable(
            Promise.resolve().then(() =>
              middleware.beforeModel!(structuredClone(request), middlewareContext()),
            ),
            scope.signal,
          );
          if (update !== undefined) request = structuredClone(update);
          validateRequest(request);
        }
        validateRequest(request);
        let response: ModelResponse | undefined;
        for await (const item of callModel({
          config,
          request,
          context: middlewareContext(),
          limits,
          activeModel,
          seen,
          validateRequest,
          onFailure: () => {
            usage.known = false;
          },
        })) {
          if (item.type === "response") {
            response = item.response;
            activeModel = item.modelIndex;
          } else if (item.type === "text_delta") yield event("text_delta", item.payload);
          else if (item.type === "model_start") yield event("model_start", item.payload);
          else if (item.type === "model_retry") yield event("model_retry", item.payload);
          else yield event("model_fallback", item.payload);
        }

        checkAbort(scope.signal);
        if (!response) throw new AgentError("protocol_error", "Missing model response");
        if (byteLength(response) > limits.maxModelResponseBytes)
          throw new AgentError("limit_exceeded", "maxModelResponseBytes exceeded");
        validateResponse(response, seen);
        const calls = response.message.toolCalls ?? [];
        if (calls.filter((call) => registry.behavior(call.name).returnDirect).length > 1)
          throw new AgentError(
            "protocol_error",
            "A model batch may contain only one returnDirect tool",
          );
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
          await finish();
          break;
        }
        calls.forEach((call) => pending.add(call.id));
        queue = [...calls];
      }
    } catch (cause) {
      if (cause instanceof ToolInterrupt && queue.length) {
        try {
          const checkpointId = randomUUID();
          const checkpoint: Checkpoint = {
            schemaVersion: 1,
            id: checkpointId,
            binding: bindingFor(options),
            runId,
            seq: seq + 2,
            iteration,
            toolCalls: callsCount,
            usage: { ...usage },
            state: capture(),
            pendingCalls: structuredClone(queue),
            projectInstructions,
            limits: { ...limits },
            info: cause.info,
            modelIndex: activeModel,
            ...(setupSignature ? { setupSignature } : {}),
            ...(availableTools ? { availableTools: [...availableTools] } : {}),
            ...(continuations.size ? { continuations: Object.fromEntries(continuations) } : {}),
            delegation: structuredClone(delegation),
            ...(childUsage.size ? { childUsage: Object.fromEntries(childUsage) } : {}),
          };
          await abortable(config.checkpoints!.store.save(checkpoint, scope.signal), scope.signal);
          interrupted = { checkpointId, call: structuredClone(queue[0]!), info: cause.info };
          yield event("run_interrupted", interrupted);
        } catch (saveError) {
          error = toAgentError(saveError);
        }
      } else {
        if (queue.some((call) => registry.behavior(call.name).delegates)) usage.known = false;
        error = toAgentError(cause);
      }
    } finally {
      scope.cancel();
      scope.dispose();
    }
    const result: RunResult = {
      runId,
      status: error
        ? error.code === "cancelled"
          ? "cancelled"
          : "failed"
        : interrupted
          ? "interrupted"
          : "completed",
      stopReason:
        error?.code ?? (interrupted ? "interrupt" : returnedDirectly ? "return_direct" : "stop"),
      finalText,
      messages: structuredClone(messages),
      historyComplete: inputValid && pending.size === 0,
      pendingToolCallIds: [...pending],
      todos: structuredClone(state.todos),
      iterations: iteration,
      toolCalls: callsCount,
      usage,
      observerErrors,
      ...(!error && snapshot ? { state: snapshot } : {}),
      ...(interrupted ? { interrupt: interrupted } : {}),
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

  const stream = (
    input: RunInput,
    options: RunOptions<C>,
    resumeInput?: ResumeInput,
  ): AsyncIterableIterator<AgentEvent> => {
    const controller = new AbortController();
    const cancel = () => controller.abort(new AgentError("cancelled", "Run cancelled by caller"));
    // AbortSignal.any 不需要手动挂载一个可能泄漏的外部信号监听器。
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const generator = engine(input, options, signal, resumeInput);
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
  };
  const agent: Agent<C> = {
    stream,
    resumeStream(input, options) {
      return stream({ input: "" }, options, input);
    },
    async resume(input, options) {
      for await (const item of agent.resumeStream(input, options))
        if (item.type === "run_end") return item.payload.result;
      throw new AgentError("internal_error", "Resume ended without terminal event");
    },
    async run(input, options) {
      for await (const item of agent.stream(input, options))
        if (item.type === "run_end") return item.payload.result;
      throw new AgentError("internal_error", "Run ended without terminal event");
    },
  };
  return agent;
}
