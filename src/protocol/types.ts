/** 核心协议与供应商无关。所有进入历史的内容都必须可序列化。 */
export type JsonSchema = Record<string, unknown>;

/** 保留原始 JSON 参数，执行器负责解析和验证，模型适配器不能执行工具。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** assistant 与 tool 的关联必须通过 id 保持，不能依赖工具名称。 */
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** Tool 只返回文本；业务 JSON 应先序列化成 content，外层信封保持有效。 */
export type ToolResult =
  | { ok: true; content: string; truncated?: boolean }
  | { ok: false; code: string; message: string; retryableByModel: boolean; truncated?: boolean };

/** 对模型可见的工具元数据，不包含执行函数、权限对象或服务客户端。 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** 运行内待办，不是持久化任务、工作流或跨 Agent 调度。 */
export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** 每次运行新建；只能在工具中通过当前上下文访问，禁止放进共享 Agent 配置。 */
export interface RunState {
  todos: Todo[];
}

/** context 由宿主注入，身份和客户端不接受模型覆盖；signal 必须向下游传播。 */
export interface ToolContext<C = unknown> {
  runId: string;
  toolCallId: string;
  signal: AbortSignal;
  context: Readonly<C>;
  state: RunState;
}

/** execute 使用方法签名，允许不同参数类型的工具进入同一注册表。 */
export interface Tool<A = unknown, C = unknown> extends ToolDefinition {
  effect: "read" | "write" | "execute";
  execute(args: A, context: ToolContext<C>): Promise<ToolResult>;
}

/** 未收到 usage 时不能把费用当作零；known=false 表示统计不完整。 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** 已完成的模型响应；只有 stop / tool_calls 可以推进正常执行链路。 */
export interface ModelResponse {
  message: Extract<Message, { role: "assistant" }>;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
  usage?: Usage;
}

/** 流式适配器输出文本片段和唯一最终响应，参数碎片在适配器内部聚合。 */
export type ModelChunk =
  { type: "text_delta"; text: string } | { type: "response"; response: ModelResponse };

/** 每次模型请求使用历史快照，避免 provider 意外修改 Runner 的消息状态。 */
export interface ModelRequest {
  messages: Message[];
  tools: ToolDefinition[];
}

/** generate 为必选；有 stream 时 run 和 stream 都使用流式路径以保持语义一致。 */
export interface ChatModel {
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
  stream?(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}

/** 宿主显式传入历史，框架不维护隐藏的全局会话。 */
export interface RunInput {
  input: string;
  messages?: Message[];
}

/** 各预算独立计数：模型重试不增加 iteration，工具尝试（包括参数错误）计数。 */
export interface Limits {
  maxIterations: number;
  maxToolCalls: number;
  maxToolCallsPerRound: number;
  runTimeoutMs: number;
  modelTimeoutMs: number;
  toolTimeoutMs: number;
  maxModelRetries: number;
  retryDelayMs: number;
  maxToolArgumentBytes: number;
  maxToolResultBytes: number;
  maxInputBytes: number;
  maxModelResponseBytes: number;
}

/** 终止错误不包含原始凭证、参数、堆栈或供应商响应体。 */
export interface RunError {
  code: string;
  message: string;
  outcomeUnknown?: boolean;
}

/** historyComplete=false 的历史仅供诊断，不可直接作为下一轮模型输入。 */
export interface RunResult {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  stopReason: string;
  finalText: string;
  messages: Message[];
  historyComplete: boolean;
  pendingToolCallIds: string[];
  todos: Todo[];
  iterations: number;
  toolCalls: number;
  usage: Usage & { known: boolean };
  observerErrors: number;
  error?: RunError;
}

/** 事件判别联合允许业务在检查 type 后安全读取 payload。 */
export interface EventPayloads {
  run_start: Record<string, never>;
  model_start: { attempt: number };
  text_delta: { text: string };
  tool_call_ready: { call: ToolCall };
  tool_start: { id: string; name: string };
  tool_end: { id: string; name: string; result: ToolResult };
  model_retry: { attempt: number; delayMs: number };
  run_end: { result: RunResult };
}

/** seq 只保证单次 run 内有序；协议版本独立于包版本。 */
export type AgentEvent = {
  [K in keyof EventPayloads]: {
    schemaVersion: 1;
    runId: string;
    seq: number;
    iteration: number;
    timestamp: string;
    type: K;
    payload: EventPayloads[K];
  };
}[keyof EventPayloads];

/** hooks 只处理当前请求或调用，不直接改写历史，也不能绕过权限。 */
export interface Hooks<C> {
  beforeModel?(context: {
    runId: string;
    iteration: number;
    context: Readonly<C>;
    signal: AbortSignal;
  }): Promise<string | void> | string | void;
  beforeTool?(
    call: Readonly<ToolCall>,
    context: ToolContext<C>,
  ): Promise<boolean | void> | boolean | void;
  /** 观察回调只接受事件快照；异常被隔离，不影响业务结果。 */
  onEvent?(event: AgentEvent): void | Promise<void>;
}

/** 可复用配置；具体 Skill 工具通过工厂显式注册，避免异步隐式初始化。 */
export interface AgentConfig<C> {
  model: ChatModel;
  instructions?: string;
  tools?: Tool<unknown, C>[];
  limits?: Partial<Limits>;
  hooks?: Hooks<C>;
  /** 默认允许已注册工具；提供此回调可实施业务 ACL。false 变成工具错误。 */
  allowTool?(
    tool: ToolDefinition & { effect: Tool["effect"] },
    context: ToolContext<C>,
  ): boolean | Promise<boolean>;
}

/** 每次调用必须显式传 context；可以复用客户端，但运行内状态始终独立。 */
export interface RunOptions<C> {
  context: C;
  signal?: AbortSignal;
  limits?: Partial<Limits>;
}

/** stream 是惰性迭代器；return() 会立即发出取消信号，再清理引擎。 */
export interface Agent<C> {
  run(input: RunInput, options: RunOptions<C>): Promise<RunResult>;
  stream(input: RunInput, options: RunOptions<C>): AsyncIterableIterator<AgentEvent>;
}
