import type { ModelError } from "./errors.js";

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
  | { ok: true; content: string; truncated?: boolean; artifact?: ArtifactReference }
  | {
      ok: false;
      code: string;
      message: string;
      retryableByModel: boolean;
      truncated?: boolean;
      artifact?: ArtifactReference;
    };

/** 只允许 JSON 数据进入检查点；身份、客户端、函数和 AbortSignal 留在宿主。 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 完整工具结果的不可变外置引用；id 不是宿主文件路径。 */
export interface ArtifactReference {
  id: string;
  bytes: number;
}
export interface ArtifactStore {
  write(content: string, signal: AbortSignal): Promise<ArtifactReference>;
  read(id: string, signal: AbortSignal): Promise<string>;
}

/** 对模型可见的工具元数据，不包含执行函数、权限对象或服务客户端。 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** 运行内待办，可随快照/检查点保存；不承担工作流或跨 Agent 调度。 */
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
  /** 仅中断所在调用收到恢复数据。恢复仍经过权限检查与 beforeTool。 */
  resume?: { data: JsonValue };
  /** 仅委派工具收到的完整历史副本；不包含当前未完成工具批次或临时系统指令。 */
  messages?: Message[];
  /** 子任务继续执行所需的 JSON 引用，由框架保存和恢复，不是模型参数。 */
  continuation?: JsonValue;
  /** 内部传播运行树预算和路径；工具作者不得修改其计数器。 */
  delegation?: DelegationScope;
  /** 宿主身份只供子任务派生检查点绑定，不发送给模型或事件。 */
  checkpointOwner?: string;
}

/** 路径中的每一段描述由哪个父调用进入哪个子 Agent，重名任务也可准确区分。 */
export interface AgentPathStep {
  name: string;
  parentRunId: string;
  toolCallId: string;
}

/** 同一运行树共享调用计数；消息和 todos 则各 Agent 独立。恢复时重建共享引用。 */
export interface DelegationScope {
  path: AgentPathStep[];
  maxDepth: number;
  budget: { maxCalls: number; calls: number };
}

/** execute 使用方法签名，允许不同参数类型的工具进入同一注册表。 */
export interface Tool<A = unknown, C = unknown> extends ToolDefinition {
  effect: "read" | "write" | "execute";
  /** 仅 read 工具可显式开启；作者承诺不修改共享业务状态及 ToolContext.state。 */
  parallelSafe?: boolean;
  /** 成功结果作为最终回答；同一模型批次最多一个，仍会完成批次内其他调用。 */
  returnDirect?: boolean;
  /** AgentTool / fork Skill 使用；委派工具始终串行，允许传播可恢复子任务中断。 */
  delegates?: boolean;
  execute(args: A, context: ToolContext<C>): Promise<ToolResult>;
  /** 存在时 Runner 优先消费此流。须以唯一 result 片段结束；execute 保留兼容入口。 */
  stream?(args: A, context: ToolContext<C>): AsyncIterable<ToolChunk>;
}

/** 进度是展示数据，不写入历史；最终 result 才经过外置/截断并回填模型。 */
export type ToolChunk =
  | { type: "text_delta"; text: string; channel?: "stdout" | "stderr" }
  | { type: "agent_event"; path: AgentPathStep[]; event: LocalAgentEvent }
  | { type: "result"; result: ToolResult };

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

/** 当前运行的生命周期信息；context 由宿主提供，resumed 区分新运行和检查点恢复。 */
export interface MiddlewareContext<C> {
  runId: string;
  iteration: number;
  context: Readonly<C>;
  signal: AbortSignal;
  resumed: boolean;
}
/** 每个模型尝试独立提供；modelIndex=0 为主模型，后续索引为备用模型，attempt 从 1 开始。 */
export interface ModelCallContext<C> extends MiddlewareContext<C> {
  modelIndex: number;
  attempt: number;
}

/** beforeAgent 修改当前运行的装配，不能改变可复用 Agent 的原始配置。 */
export interface AgentSetup<C> {
  instructions: string;
  tools: Tool<unknown, C>[];
}

/** next 在一次模型尝试中最多调用一次；需要重试交给 Runner 的统一预算。 */
export type ModelEndpoint = (request: ModelRequest) => AsyncIterable<ModelChunk>;
/** 工具参数已校验且权限已通过；next 不接受新参数，防止在鉴权后偷换调用。 */
export type ToolEndpoint = () => AsyncIterable<ToolChunk>;

/**
 * 单 Agent 中间件。普通钩子按注册顺序执行，包装器按 A(B(endpoint)) 嵌套。
 * 请求改写仅影响当前模型轮次；持久化历史压缩继续使用 ContextPolicy。
 * 中间件是受信任的宿主代码，必须把 signal 传递给其自身启动的 I/O。
 */
export interface AgentMiddleware<C = unknown> {
  name: string;
  beforeAgent?(
    setup: AgentSetup<C>,
    context: MiddlewareContext<C>,
  ): AgentSetup<C> | void | Promise<AgentSetup<C> | void>;
  beforeModel?(
    request: ModelRequest,
    context: MiddlewareContext<C>,
  ): ModelRequest | void | Promise<ModelRequest | void>;
  afterModel?(
    response: ModelResponse,
    context: ModelCallContext<C>,
  ): ModelResponse | void | Promise<ModelResponse | void>;
  wrapModel?(
    request: ModelRequest,
    context: ModelCallContext<C>,
    next: ModelEndpoint,
  ): AsyncIterable<ModelChunk>;
  wrapTool?(
    call: Readonly<ToolCall>,
    context: ToolContext<C>,
    next: ToolEndpoint,
  ): AsyncIterable<ToolChunk>;
  afterAgent?(state: AgentSnapshot, context: MiddlewareContext<C>): void | Promise<void>;
}

/** 主模型重试耗尽后尝试备用模型；默认仅切换可重试 ModelError。 */
export interface ModelFailover {
  models: ChatModel[];
  /** 仅针对 ModelError 调用；取消、协议错误和已输出文本的流不可通过此策略重放。 */
  shouldFailover?(error: ModelError): boolean;
}

/** 宿主显式传入历史，框架不维护隐藏的全局会话。 */
export interface RunInput {
  input: string;
  messages?: Message[];
  /** 上一轮成功结束的工作上下文；与 messages 互斥，包含压缩历史和 todos。 */
  state?: AgentSnapshot;
}

/** 可持久化的对话状态，不包含临时系统指令和业务 context。 */
export interface AgentSnapshot {
  schemaVersion: 1;
  messages: Message[];
  todos: Todo[];
  /** 摘要删除历史后仍保留调用编号，避免同一对话重复使用旧 id。 */
  usedToolCallIds: string[];
}

/** beforeTool 返回此对象时在实际执行前暂停；不能把取消当作可恢复中断。 */
export interface InterruptRequest {
  type: "interrupt";
  info: JsonValue;
}
export interface RunInterrupt {
  checkpointId: string;
  call: ToolCall;
  info: JsonValue;
}

/** 检查点恢复同一次运行；messages 允许尾部带尚未执行的工具调用。 */
export interface Checkpoint {
  schemaVersion: 1;
  id: string;
  binding: string;
  runId: string;
  seq: number;
  iteration: number;
  toolCalls: number;
  usage: Usage & { known: boolean };
  state: AgentSnapshot;
  pendingCalls: ToolCall[];
  projectInstructions: string;
  limits: Limits;
  info: JsonValue;
  /** V3 可选扩展；旧检查点按主模型索引 0 恢复。 */
  modelIndex?: number;
  /** 校验 beforeAgent 动态装配在恢复时仍一致，不序列化工具函数。 */
  setupSignature?: string;
  /** 保存发生中断的模型轮次可见工具集合；恢复时仍不能调用被隐藏的工具。 */
  availableTools?: string[];
  /** V4：待执行委派调用的子检查点引用；已完成调用不会留在这里。 */
  continuations?: Record<string, JsonValue>;
  /** V4：运行树预算与当前路径，调用次数跨中断累计。 */
  delegation?: DelegationScope;
  /** V4：已计入父 usage 的直接子任务累计用量，用于恢复后按差额统计。 */
  childUsage?: Record<string, Usage & { known: boolean }>;
}

/**
 * take 必须原子消费且先校验 binding；同一检查点只可恢复一次。
 * 不自动重放崩溃后已领取的检查点，以免重复外部副作用。
 */
export interface CheckpointStore {
  save(checkpoint: Checkpoint, signal: AbortSignal): Promise<void>;
  take(id: string, binding: string, signal: AbortSignal): Promise<Checkpoint>;
}

/** 策略获得隔离快照；request 包含临时指令，用于计算实际输入预算。 */
export interface ContextPolicyInput {
  runId: string;
  messages: Message[];
  request: ModelRequest;
  signal: AbortSignal;
}
export interface ContextUpdate {
  messages: Message[];
  usage?: Usage;
  usageKnown?: boolean;
}
export interface ContextPolicy {
  name: string;
  beforeModel?(input: ContextPolicyInput): Promise<ContextUpdate | undefined>;
  afterTool?(input: {
    runId: string;
    call: ToolCall;
    result: ToolResult;
    signal: AbortSignal;
    /** 运行时硬上限，外置策略应在触及此上限之前保存完整结果。 */
    maxResultBytes?: number;
  }): Promise<ToolResult>;
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
  /** 单次工具调用可对外输出的进度文本总字节数，与最终结果预算独立。 */
  maxToolStreamBytes: number;
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
  status: "completed" | "failed" | "cancelled" | "interrupted";
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
  /** 仅成功结束提供完整可复用状态；中断通过 checkpointId 恢复。 */
  state?: AgentSnapshot;
  interrupt?: RunInterrupt;
}

/** 事件判别联合允许业务在检查 type 后安全读取 payload。 */
export interface LocalEventPayloads {
  run_start: Record<string, never>;
  model_start: { attempt: number; modelIndex?: number };
  text_delta: { text: string };
  tool_call_ready: { call: ToolCall };
  tool_start: { id: string; name: string };
  tool_end: { id: string; name: string; result: ToolResult };
  tool_output: { id: string; name: string; text: string; channel?: "stdout" | "stderr" };
  model_retry: { attempt: number; delayMs: number; modelIndex?: number };
  model_fallback: { from: number; to: number; code: string };
  context_updated: { policy: string; beforeBytes: number; afterBytes: number };
  run_interrupted: RunInterrupt;
  run_resumed: { checkpointId: string };
  run_end: { result: RunResult };
}

/** 子事件保持原 runId/seq；多层委派只增加 path，不反复嵌套整个事件信封。 */
export interface EventPayloads extends LocalEventPayloads {
  agent_event: { path: AgentPathStep[]; event: LocalAgentEvent };
}

type Events<P> = {
  [K in keyof P]: {
    schemaVersion: 1;
    runId: string;
    seq: number;
    iteration: number;
    timestamp: string;
    type: K;
    payload: P[K];
  };
}[keyof P];
export type LocalAgentEvent = Events<LocalEventPayloads>;
/** seq 只保证单次 run 内有序；协议版本独立于包版本。 */
export type AgentEvent = Events<EventPayloads>;

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
  ): Promise<boolean | void | InterruptRequest> | boolean | void | InterruptRequest;
  /** 成功结束时等待宿主保存工作上下文；失败/取消/中断不调用。 */
  afterAgent?(
    state: AgentSnapshot,
    context: { runId: string; context: Readonly<C>; signal: AbortSignal },
  ): void | Promise<void>;
  /** 观察回调只接受事件快照；异常被隔离，不影响业务结果。 */
  onEvent?(event: AgentEvent): void | Promise<void>;
}

/**
 * 项目指令来源。Runner 每次 run 首轮请求前调用一次，后续轮次复用返回的文本。
 * 实现必须向 I/O 传播 signal；返回空文本表示没有项目指令，不向历史写入内容。
 */
export interface AgentsMdLoader {
  load(signal: AbortSignal): Promise<string>;
}

/** 可复用配置；具体 Skill 工具通过工厂显式注册，避免异步隐式初始化。 */
export interface AgentConfig<C> {
  model: ChatModel;
  modelFailover?: ModelFailover;
  middlewares?: AgentMiddleware<C>[];
  /** 默认 1；只并发连续且 parallelSafe=true 的只读调用，其他调用是顺序屏障。 */
  toolExecution?: { maxConcurrency?: number };
  /** 默认最多嵌套 4 层、启动 32 个子任务。maxCalls 由根运行统一控制；子级可收紧 maxDepth。 */
  delegation?: { maxDepth?: number; maxCalls?: number };
  instructions?: string;
  /** 可选项目指令加载器；按 Eino 的方式作为临时 user 消息注入模型请求。 */
  agentsMd?: AgentsMdLoader;
  tools?: Tool<unknown, C>[];
  /** 按数组顺序执行，通常先 reduction 再 summarization。 */
  contextPolicies?: ContextPolicy[];
  checkpoints?: { store: CheckpointStore; namespace: string };
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
  /** 启用检查点时必传；由宿主根据登录身份/会话生成，不接受模型指定。 */
  checkpointOwner?: string;
  /** 框架委派入口使用；应用通常省略，不应自行伪造路径或修改共享预算。 */
  delegation?: DelegationScope;
}

export interface ResumeInput {
  checkpointId: string;
  data: JsonValue;
}

/** stream 是惰性迭代器；return() 会立即发出取消信号，再清理引擎。 */
export interface Agent<C> {
  run(input: RunInput, options: RunOptions<C>): Promise<RunResult>;
  stream(input: RunInput, options: RunOptions<C>): AsyncIterableIterator<AgentEvent>;
  resume(input: ResumeInput, options: RunOptions<C>): Promise<RunResult>;
  resumeStream(input: ResumeInput, options: RunOptions<C>): AsyncIterableIterator<AgentEvent>;
}
