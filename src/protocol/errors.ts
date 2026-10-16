/** 框架内部可安全展示的错误。禁止把供应商完整错误体直接作为 message 传入。 */
export class AgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

/** 可回填给模型的预期业务错误；未分类异常会终止运行，避免掩盖程序缺陷。 */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryableByModel = true,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** provider 将网络/HTTP 错误归一化，只有 retryable=true 才进入模型重试策略。 */
export class ModelError extends AgentError {
  constructor(
    code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(code, message);
  }
}

/** 未分类异常只返回稳定摘要；详细异常由业务自己的日志机制记录。 */
export function toAgentError(error: unknown): AgentError {
  return error instanceof AgentError
    ? error
    : new AgentError("internal_error", "Unclassified runtime failure");
}
