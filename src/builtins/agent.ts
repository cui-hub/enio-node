import { createHash } from "node:crypto";
import { AgentError, ToolError } from "../protocol/errors.js";
import type {
  Agent,
  AgentPathStep,
  JsonValue,
  RunResult,
  Tool,
  ToolChunk,
  ToolContext,
} from "../protocol/types.js";
import { defineTool } from "../tools/registry.js";
import { AgentToolInterrupt } from "../runtime/interrupt.js";
import { checkAbort } from "../runtime/control.js";
import {
  transportChildEvent,
  validateChildEvent,
  validateDelegation,
  validatePath,
} from "../runtime/delegation.js";
import { validateHistory } from "../runtime/history.js";

/** 子 Agent 是宿主提供的实例；工具名/描述进入父模型，身份和模型配置不会成为参数。 */
export interface AgentToolOptions<C> {
  name: string;
  description: string;
  agent: Agent<C>;
  /** isolated 仅传子任务要求；inherit 复制完整父对话，不复制父 todos 或临时指令。 */
  history?: "isolated" | "inherit";
  /** 默认 execute，保守标记潜在副作用；声明 read 须确保子树所有工具均只读。 */
  effect?: Tool["effect"];
}

/** 引用的是子 Agent 自己保存的检查点；不把函数、调用栈或业务 context 持久化。 */
interface ChildContinuation {
  kind: "agent-tool";
  name: string;
  history: "isolated" | "inherit";
  checkpointId: string;
}

/** 把 Agent 适配为工具；run 与 stream 都只消费一次同样的子事件链。 */
export function createAgentTool<C = unknown>(
  options: AgentToolOptions<C>,
): Tool<{ request: string }, C> {
  const { name, description, agent, history = "isolated", effect = "execute" } = options;
  if (
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) ||
    !description?.trim() ||
    !["isolated", "inherit"].includes(history) ||
    !["read", "write", "execute"].includes(effect) ||
    typeof agent?.stream !== "function" ||
    typeof agent?.resumeStream !== "function"
  )
    throw new AgentError(
      "invalid_config",
      "Agent tool requires a name, description and resumable Agent",
    );

  async function* stream(
    { request }: { request: string },
    ctx: ToolContext<C>,
  ): AsyncGenerator<ToolChunk> {
    checkAbort(ctx.signal);
    const scope = ctx.delegation ?? { path: [], maxDepth: 4, budget: { maxCalls: 32, calls: 0 } };
    validateDelegation(scope);
    if (scope.path.length >= scope.maxDepth)
      throw new ToolError("agent_depth_exceeded", "Maximum child Agent depth reached", false);
    const path: AgentPathStep[] = [
      ...scope.path,
      { name, parentRunId: ctx.runId, toolCallId: ctx.toolCallId },
    ];
    const childOptions = {
      context: ctx.context as C,
      signal: ctx.signal,
      checkpointOwner: createHash("sha256")
        .update(JSON.stringify([ctx.checkpointOwner ?? ctx.runId, ctx.runId, ctx.toolCallId, name]))
        .digest("hex"),
      delegation: { ...scope, path },
    };
    let continuation: ChildContinuation | undefined;
    if (ctx.continuation !== undefined) {
      const value = ctx.continuation as unknown as ChildContinuation;
      if (
        !value ||
        value.kind !== "agent-tool" ||
        value.name !== name ||
        value.history !== history ||
        typeof value.checkpointId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value.checkpointId) ||
        !ctx.resume
      )
        throw new AgentError(
          "checkpoint_mismatch",
          "Invalid child continuation or missing resume input",
        );
      continuation = value;
    } else {
      if (scope.budget.calls >= scope.budget.maxCalls)
        throw new ToolError("agent_calls_exceeded", "Maximum child Agent calls reached", false);
      scope.budget.calls++;
    }
    const messages = history === "inherit" ? structuredClone(ctx.messages ?? []) : [];
    validateHistory(messages);
    // 工具层不注入系统指令；子 Agent 独立配置自身权限、模型和运行状态。
    const events = continuation
      ? agent.resumeStream(
          { checkpointId: continuation.checkpointId, data: ctx.resume!.data },
          childOptions,
        )
      : agent.stream({ input: request, messages }, childOptions);
    let result: RunResult | undefined;
    for await (const event of events) {
      checkAbort(ctx.signal);
      if (result) throw new AgentError("invalid_agent_event", "Child emitted events after run_end");
      if (event.type === "agent_event") {
        validatePath(event.payload.path);
        if (
          event.payload.path.length <= path.length ||
          JSON.stringify(event.payload.path.slice(0, path.length)) !== JSON.stringify(path)
        )
          throw new AgentError("invalid_agent_event", "Grandchild path differs from its parent");
        validateChildEvent(event.payload.event);
        yield { type: "agent_event", ...event.payload };
      } else {
        const transported = transportChildEvent(event);
        if (transported.type === "run_end") result = transported.payload.result;
        yield { type: "agent_event", path, event: transported };
      }
    }
    if (!result) throw new AgentError("incomplete_agent_run", "Child ended without run_end");
    if (result.status === "interrupted") {
      if (!result.interrupt)
        throw new AgentError("invalid_agent_event", "Child interrupt reference is missing");
      const saved: ChildContinuation = {
        kind: "agent-tool",
        name,
        history,
        checkpointId: result.interrupt.checkpointId,
      };
      throw new AgentToolInterrupt(
        {
          agent: name,
          path: path as unknown as JsonValue,
          child: {
            checkpointId: result.interrupt.checkpointId,
            call: result.interrupt.call as unknown as JsonValue,
            info: result.interrupt.info,
          },
        },
        saved as unknown as JsonValue,
      );
    }
    if (result.status !== "completed")
      throw new AgentError(
        result.error?.code ?? "subagent_failed",
        "Child Agent did not complete",
        result.error?.outcomeUnknown,
      );
    yield { type: "result", result: { ok: true, content: result.finalText } };
  }
  return defineTool({
    name,
    description,
    effect,
    delegates: true,
    inputSchema: {
      type: "object",
      properties: { request: { type: "string", minLength: 1, maxLength: 24576 } },
      required: ["request"],
      additionalProperties: false,
    },
    stream,
    async execute(args, ctx) {
      for await (const chunk of stream(args, ctx)) if (chunk.type === "result") return chunk.result;
      throw new AgentError("incomplete_agent_run", "Child did not produce a tool result");
    },
  });
}

/** 一组命名子 Agent 共用 task 工具，模型只能选择宿主注册的名称。 */
export function createTaskTool<C = unknown>({
  agents,
}: {
  agents: AgentToolOptions<C>[];
}): Tool<{ agent: string; request: string }, C> {
  if (!agents.length)
    throw new AgentError("invalid_config", "Task tool requires at least one child Agent");
  const tools = new Map(agents.map((entry) => [entry.name, createAgentTool(entry)]));
  if (tools.size !== agents.length)
    throw new AgentError("invalid_config", "Duplicate child Agent name");
  const pick = (name: string) => {
    const tool = tools.get(name);
    if (!tool) throw new ToolError("agent_not_found", "Child Agent is not registered", false);
    return tool;
  };
  return defineTool({
    name: "task",
    description:
      "委派独立子任务，返回最终结果。可选 Agent：\n" +
      agents.map((entry) => `${entry.name}: ${entry.description}`).join("\n"),
    effect: agents.every((entry) => entry.effect === "read") ? "read" : "execute",
    delegates: true,
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: [...tools.keys()] },
        request: { type: "string", minLength: 1, maxLength: 24576 },
      },
      required: ["agent", "request"],
      additionalProperties: false,
    },
    execute(args, ctx) {
      return pick(args.agent).execute({ request: args.request }, ctx);
    },
    stream(args, ctx) {
      return pick(args.agent).stream!({ request: args.request }, ctx);
    },
  });
}
