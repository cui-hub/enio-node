import type { FileSystemBackend } from "../backends/filesystem.js";
import type { JsonSchema, Tool } from "../protocol/types.js";
import { defineTool } from "../tools/registry.js";

const filePath = { type: "string", minLength: 1, maxLength: 1024 };
const text = { type: "string" };
const limit = { type: "integer", minimum: 1, maximum: 500 };

/** 统一关闭额外字段，避免模型把身份、权限或 backend 配置塞入参数。 */
function objectSchema(properties: Record<string, unknown>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** 六个文件工具都只依赖 backend 接口，不持有本地文件系统或模型实例。 */
export function createFileTools<C = unknown>({
  backend,
}: {
  backend: FileSystemBackend;
}): Tool<unknown, C>[] {
  return [
    defineTool<Parameters<FileSystemBackend["ls"]>[0], C>({
      name: "ls",
      description: "列出工作区目录；使用 cursor 分页。路径必须相对工作区。",
      effect: "read",
      inputSchema: objectSchema(
        { path: filePath, limit, cursor: { type: "integer", minimum: 0 } },
        [],
      ),
      async execute(args, ctx) {
        return { ok: true, content: JSON.stringify(await backend.ls(args, ctx.signal)) };
      },
    }),
    defineTool<Parameters<FileSystemBackend["readFile"]>[0], C>({
      name: "read_file",
      description: "分页读取 UTF-8 文本并返回文件 hash；写入或编辑前保存 hash。",
      effect: "read",
      inputSchema: objectSchema(
        {
          path: filePath,
          startLine: { type: "integer", minimum: 1 },
          lineCount: { type: "integer", minimum: 1, maximum: 10000 },
        },
        ["path"],
      ),
      async execute(args, ctx) {
        return { ok: true, content: JSON.stringify(await backend.readFile(args, ctx.signal)) };
      },
    }),
    defineTool<Parameters<FileSystemBackend["writeFile"]>[0], C>({
      name: "write_file",
      description: "默认创建新文件；覆盖需 overwrite=true 且 expectedHash 与当前文件一致。",
      effect: "write",
      inputSchema: objectSchema(
        {
          path: filePath,
          content: text,
          overwrite: { type: "boolean" },
          expectedHash: { type: "string", minLength: 64, maxLength: 64 },
        },
        ["path", "content"],
      ),
      async execute(args, ctx) {
        return { ok: true, content: JSON.stringify(await backend.writeFile(args, ctx.signal)) };
      },
    }),
    defineTool<Parameters<FileSystemBackend["editFile"]>[0], C>({
      name: "edit_file",
      description: "使用 expectedHash 检查冲突；oldText 必须恰好命中一次，再精确替换为 newText。",
      effect: "write",
      inputSchema: objectSchema(
        {
          path: filePath,
          oldText: { type: "string", minLength: 1 },
          newText: text,
          expectedHash: { type: "string", minLength: 64, maxLength: 64 },
        },
        ["path", "oldText", "newText", "expectedHash"],
      ),
      async execute(args, ctx) {
        return { ok: true, content: JSON.stringify(await backend.editFile(args, ctx.signal)) };
      },
    }),
    defineTool<Parameters<FileSystemBackend["glob"]>[0], C>({
      name: "glob",
      description: "在工作区有界遍历并返回匹配 glob 的可读文件；不跟随符号链接。",
      effect: "read",
      inputSchema: objectSchema(
        { pattern: { type: "string", minLength: 1, maxLength: 512 }, limit },
        ["pattern"],
      ),
      async execute(args, ctx) {
        return { ok: true, content: JSON.stringify(await backend.glob(args, ctx.signal)) };
      },
    }),
    defineTool<Parameters<FileSystemBackend["grep"]>[0], C>({
      name: "grep",
      description: "按字面量查找文本，返回文件、行号与片段；literal 不是正则表达式。",
      effect: "read",
      inputSchema: objectSchema(
        {
          literal: { type: "string", minLength: 1, maxLength: 4096 },
          pattern: { type: "string", minLength: 1, maxLength: 512 },
          limit,
        },
        ["literal"],
      ),
      async execute(args, ctx) {
        return { ok: true, content: JSON.stringify(await backend.grep(args, ctx.signal)) };
      },
    }),
  ];
}
