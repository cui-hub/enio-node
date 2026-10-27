import type { ArtifactStore, ContextPolicy, ToolResult } from "../protocol/types.js";
import { byteLength, truncateUtf8 } from "../runtime/control.js";
import { countTokens, estimateTokens, positive } from "./shared.js";
import type { TokenCounter } from "./shared.js";

export interface ToolReductionOptions {
  store: ArtifactStore;
  maxOutputBytes?: number;
  clearAtTokens?: number;
  keepRecentToolRounds?: number;
  tokenCounter?: TokenCounter;
  readToolName?: string;
  excludeTools?: string[];
  skipTruncation?: boolean;
  skipClear?: boolean;
}

/**
 * 两阶段压缩：工具执行后外置过长输出；下一次模型调用前外置较早工具批次。
 * 清理保留 assistant/tool 配对，原始参数与结果保存后才替换，写失败则停止运行。
 */
export function createToolResultReduction(options: ToolReductionOptions): ContextPolicy {
  const maxOutput = positive(options.maxOutputBytes ?? 50_000, "maxOutputBytes", 256);
  const threshold = positive(options.clearAtTokens ?? 160_000, "clearAtTokens");
  const keep = positive(options.keepRecentToolRounds ?? 1, "keepRecentToolRounds", 0);
  const reader = options.readToolName ?? "read_artifact";
  const excluded = new Set([reader, ...(options.excludeTools ?? [])]);
  const counter = options.tokenCounter ?? estimateTokens;
  const offload = async (
    result: ToolResult,
    content: string,
    signal: AbortSignal,
  ): Promise<ToolResult> => {
    const artifact = await options.store.write(content, signal);
    const text = `Full content: ${reader}({"id":"${artifact.id}"}).\n${truncateUtf8(result.ok ? result.content : result.message, Math.min(512, Math.floor(maxOutput / 4)))}`;
    return result.ok
      ? { ok: true, content: text, truncated: true, artifact }
      : { ...result, message: text, truncated: true, artifact };
  };
  return {
    name: "tool_result_reduction",
    async afterTool({ call, result, signal, maxResultBytes }) {
      if (
        options.skipTruncation ||
        excluded.has(call.name) ||
        result.artifact ||
        byteLength(result) <= Math.min(maxOutput, maxResultBytes ?? maxOutput)
      )
        return result;
      return offload(result, JSON.stringify(result), signal);
    },
    async beforeModel(input) {
      if (
        options.skipClear ||
        (await countTokens(counter, input.request, input.signal)) <= threshold
      )
        return;
      const messages = structuredClone(input.messages);
      const rounds = messages.flatMap((message, index) =>
        message.role === "assistant" && message.toolCalls?.length ? [index] : [],
      );
      let changed = false;
      for (const index of rounds.slice(0, Math.max(0, rounds.length - keep))) {
        const assistant = messages[index]!;
        if (assistant.role !== "assistant") continue;
        for (const call of assistant.toolCalls ?? []) {
          if (excluded.has(call.name)) continue;
          const response = messages.find(
            (message) => message.role === "tool" && message.toolCallId === call.id,
          );
          if (!response) continue;
          let result: ToolResult;
          try {
            result = JSON.parse(response.content);
          } catch {
            continue;
          }
          if (
            !result ||
            typeof result.ok !== "boolean" ||
            (result.artifact && byteLength(call.arguments) < 1024) ||
            (result.ok ? typeof result.content !== "string" : typeof result.message !== "string")
          )
            continue;
          const full = JSON.stringify({ call, result });
          // 很小的结果外置只会增加上下文，保留原状。
          if (byteLength(full) < 1024) continue;
          const reduced = await offload(result, full, input.signal);
          if (byteLength(reduced) + 2 >= byteLength(full)) continue;
          call.arguments = "{}";
          response.content = JSON.stringify(reduced);
          changed = true;
        }
      }
      return changed ? { messages } : undefined;
    },
  };
}
