import { AgentError } from "../protocol/errors.js";
import type { ChatModel, ModelRequest, ModelResponse } from "../protocol/types.js";
import { checkAbort } from "../runtime/control.js";

/** 脚本函数根据输入历史生成响应，无共享游标，可在并发 run 中安全复用。 */
export type ModelScript = (
  request: ModelRequest,
  signal: AbortSignal,
) => ModelResponse | Promise<ModelResponse>;

/** 离线演示/测试模型；stream 与 generate 使用相同脚本，按 Unicode 字符分片。 */
export function createScriptedModel(script: ModelScript): ChatModel {
  const generate: ChatModel["generate"] = async (request, signal) => {
    checkAbort(signal);
    const result = await script(structuredClone(request), signal);
    checkAbort(signal);
    if (!result) throw new AgentError("protocol_error", "Script did not return a response");
    return structuredClone(result);
  };
  return {
    generate,
    async *stream(request, signal) {
      const response = await generate(request, signal);
      for (const text of Array.from(response.message.content)) {
        checkAbort(signal);
        yield { type: "text_delta", text };
      }
      yield { type: "response", response };
    },
  };
}
