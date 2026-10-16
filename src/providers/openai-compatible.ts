import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { AgentError, ModelError } from "../protocol/errors.js";
import type { ChatModel, ModelRequest, ModelResponse, ToolCall, Usage } from "../protocol/types.js";
import { byteLength, checkAbort } from "../runtime/control.js";

/** 只暴露通信配置，模型循环和自动重试始终由 Runner 管理。 */
export interface OpenAICompatibleOptions {
  model: string;
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** 不支持 stream_options 的兼容网关可关闭 usage；结果会标记 usage.known=false。 */
  includeUsage?: boolean;
  /** 测试或宿主传输代理入口；不能将该函数序列化进模型请求。 */
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
}

/** 归一化供应商结束原因；不把旧 function_call、拒答或缺失 finish 当成功。 */
function finishReason(value: string | null | undefined): ModelResponse["finishReason"] {
  if (
    value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "content_filter"
  )
    return value;
  throw new AgentError("protocol_error", "Unsupported or missing model finish reason");
}

/** 将供应商错误转换为稳定错误码，避免把含凭证/输入的原始响应交给模型。 */
function modelError(error: unknown, signal: AbortSignal): never {
  checkAbort(signal);
  if (error instanceof AgentError) throw error;
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const retryable = status === undefined || status === 429 || (status >= 500 && status <= 599);
    throw new ModelError(
      status ? `model_http_${status}` : "model_network_error",
      status ? `Model request failed with HTTP ${status}` : "Model connection failed",
      retryable,
    );
  }
  throw new ModelError("model_error", "Model transport or protocol failed", false);
}

/** 提交工具的 JSON Schema 与执行器使用同一份定义；不静默削减约束。 */
function requestBody(
  request: ModelRequest,
  options: OpenAICompatibleOptions,
): ChatCompletionCreateParamsBase {
  const messages: ChatCompletionMessageParam[] = request.messages.map((message) => {
    if (message.role === "tool")
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    if (message.role === "assistant")
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    return { role: message.role, content: message.content };
  });
  return {
    model: options.model,
    messages,
    n: 1,
    max_completion_tokens: options.maxOutputTokens ?? 4096,
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
  };
}

/**
 * OpenAI-compatible Chat Completions 适配器。只使用官方 SDK 的 HTTP/SSE 层。
 * maxRetries=0 避免与 Runner 重试叠加；signal 负责整体运行取消。
 */
export function createOpenAICompatibleModel(options: OpenAICompatibleOptions): ChatModel {
  if (!options.model || !options.apiKey)
    throw new AgentError("invalid_config", "model and apiKey are required");
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    timeout: options.timeoutMs ?? 60_000,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const maximum = options.maxResponseBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maximum) || maximum < 256)
    throw new AgentError("invalid_config", "Invalid provider response budget");
  return {
    async generate(request, signal) {
      checkAbort(signal);
      try {
        const result = await client.chat.completions.create(
          { ...requestBody(request, options), stream: false },
          { signal },
        );
        if (byteLength(result) > maximum)
          throw new AgentError("limit_exceeded", "Provider response exceeds byte budget");
        const choice = result.choices[0];
        if (!choice || result.choices.length !== 1)
          throw new AgentError("protocol_error", "Expected exactly one model choice");
        const calls = choice.message.tool_calls?.map((call) => {
          if (call.type !== "function")
            throw new AgentError("protocol_error", "Only function tools are supported");
          return { id: call.id, name: call.function.name, arguments: call.function.arguments };
        });
        return {
          message: {
            role: "assistant",
            content: choice.message.content ?? "",
            ...(calls?.length ? { toolCalls: calls } : {}),
          },
          finishReason: choice.message.refusal
            ? "content_filter"
            : finishReason(choice.finish_reason),
          ...(result.usage
            ? {
                usage: {
                  inputTokens: result.usage.prompt_tokens,
                  outputTokens: result.usage.completion_tokens,
                },
              }
            : {}),
        };
      } catch (error) {
        return modelError(error, signal);
      }
    },
    async *stream(request, signal) {
      checkAbort(signal);
      try {
        const stream = await client.chat.completions.create(
          {
            ...requestBody(request, options),
            stream: true,
            ...(options.includeUsage !== false ? { stream_options: { include_usage: true } } : {}),
          },
          { signal },
        );
        try {
          let content = "";
          let finish: ModelResponse["finishReason"] | undefined;
          let usage: Usage | undefined;
          let bytes = 0;
          let refused = false;
          const calls = new Map<number, ToolCall>();
          for await (const chunk of stream) {
            checkAbort(signal);
            bytes += byteLength(chunk);
            if (bytes > maximum)
              throw new AgentError("limit_exceeded", "Provider stream exceeds byte budget");
            if (chunk.usage)
              usage = {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
              };
            if (chunk.choices.length > 1)
              throw new AgentError("protocol_error", "Multiple model choices are unsupported");
            const choice = chunk.choices[0];
            if (!choice) continue; // 末尾 usage 帧允许 choices 为空。
            if (choice.index !== 0 || finish)
              throw new AgentError(
                "protocol_error",
                "Unexpected model choice or data after finish",
              );
            const delta = choice.delta;
            if (delta.function_call || delta.audio || (delta.role && delta.role !== "assistant"))
              throw new AgentError("protocol_error", "Unsupported stream payload");
            if (delta.refusal) refused = true;
            if (delta.content) {
              content += delta.content;
              yield { type: "text_delta", text: delta.content };
            }
            for (const part of delta.tool_calls ?? []) {
              if (
                !Number.isSafeInteger(part.index) ||
                part.index < 0 ||
                part.index > 63 ||
                (part.type && part.type !== "function")
              )
                throw new AgentError("protocol_error", "Invalid tool stream index/type");
              const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
              call.id += part.id ?? "";
              call.name += part.function?.name ?? "";
              call.arguments += part.function?.arguments ?? "";
              calls.set(part.index, call);
            }
            if (choice.finish_reason) finish = finishReason(choice.finish_reason);
          }
          if (!finish)
            throw new AgentError("incomplete_response", "Stream ended without finish_reason");
          const ordered = [...calls].sort(([a], [b]) => a - b);
          if (ordered.some(([index], position) => index !== position))
            throw new AgentError("protocol_error", "Tool stream indexes must be contiguous");
          yield {
            type: "response",
            response: {
              message: {
                role: "assistant",
                content,
                ...(ordered.length ? { toolCalls: ordered.map(([, call]) => call) } : {}),
              },
              finishReason: refused ? "content_filter" : finish,
              ...(usage ? { usage } : {}),
            },
          };
        } finally {
          // 提前结束消费时主动关闭底层 SSE，即使服务端仍在继续产生 token。
          stream.controller.abort();
        }
      } catch (error) {
        modelError(error, signal);
      }
    },
  };
}
