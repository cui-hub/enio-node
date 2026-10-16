import type { ChatModel, ModelResponse, ToolCall } from "../src/index.js";

/** 确定性模型响应构造器，让测试关注可观察行为而非供应商字段。 */
export function answer(content = "done"): ModelResponse {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}
export function call(name: string, args: unknown = {}, id = "call-1"): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}
export function calling(...calls: ToolCall[]): ModelResponse {
  return {
    message: { role: "assistant", content: "", toolCalls: calls },
    finishReason: "tool_calls",
  };
}
/** 用于单次运行的有限脚本；并发测试使用按历史决定结果的无状态脚本。 */
export function sequence(...responses: ModelResponse[]): ChatModel {
  let index = 0;
  return {
    async generate() {
      const response = responses[index++];
      if (!response) throw new Error("Unexpected extra model call");
      return structuredClone(response);
    },
  };
}
