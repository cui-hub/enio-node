import type { ExecuteBackend, ExecuteInput } from "../backends/process.js";
import type { Tool, ToolContext } from "../protocol/types.js";
import { defineTool } from "../tools/registry.js";

/** 默认不注册。只有宿主创建 backend 并把此工具放进 tools 才会开放执行能力。 */
export function createExecuteTool<C = unknown>({
  backend,
}: {
  backend: ExecuteBackend;
}): Tool<ExecuteInput, C> {
  return defineTool({
    name: "execute",
    description: "在宿主明确授权后运行 command 与 args；不支持 shell 管道。此能力不是沙箱。",
    effect: "execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", minLength: 1, maxLength: 1024 },
        args: { type: "array", maxItems: 100, items: { type: "string", maxLength: 8192 } },
        cwd: { type: "string", maxLength: 1024 },
      },
    },
    async execute(input, ctx) {
      return { ok: true, content: JSON.stringify(await backend.execute(input, ctx.signal)) };
    },
    ...(backend.stream
      ? {
          async *stream(input: ExecuteInput, ctx: ToolContext<C>) {
            for await (const chunk of backend.stream!(input, ctx.signal)) {
              if (chunk.type === "text_delta") yield chunk;
              else
                yield {
                  type: "result" as const,
                  result: { ok: true as const, content: JSON.stringify(chunk.result) },
                };
            }
          },
        }
      : {}),
  });
}
