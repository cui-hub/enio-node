import type { ArtifactStore, Tool } from "../protocol/types.js";
import { ToolError } from "../protocol/errors.js";
import { defineTool } from "../tools/registry.js";
import { byteLength, truncateUtf8 } from "../runtime/control.js";

/** 读取外置结果，按 UTF-8 字节分页。不会把任意路径开放给模型。 */
export function createArtifactTool<C = unknown>({
  store,
  name = "read_artifact",
  pageBytes = 4096,
}: {
  store: ArtifactStore;
  name?: string;
  pageBytes?: number;
}): Tool<{ id: string; offset?: number }, C> {
  if (!Number.isSafeInteger(pageBytes) || pageBytes < 4) throw new Error("pageBytes must be >= 4");
  return defineTool({
    name,
    description: "按 id 读取外置工具结果；offset 是 UTF-8 字节偏移，使用 nextOffset 继续读取。",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 36, maxLength: 36 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute({ id, offset = 0 }, ctx) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
        throw new ToolError("invalid_arguments", "Artifact id must be a UUID");
      const text = await store.read(id, ctx.signal);
      const buffer = Buffer.from(text);
      if (offset > buffer.length || (offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80))
        throw new ToolError("invalid_offset", "Offset must be a valid UTF-8 boundary");
      const content = truncateUtf8(buffer.subarray(offset).toString("utf8"), pageBytes);
      const next = offset + byteLength(content);
      return {
        ok: true,
        content: JSON.stringify({
          id,
          content,
          totalBytes: buffer.length,
          ...(next < buffer.length ? { nextOffset: next } : {}),
        }),
      };
    },
  });
}
