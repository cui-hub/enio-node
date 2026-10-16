import { ToolError } from "../protocol/errors.js";
import { checkAbort } from "../runtime/control.js";
import { FilesystemBackend, relativePath } from "./filesystem.js";
import type { FileEntry, FileStore, FilesystemOptions } from "./filesystem.js";

/** 内存存储用于离线测试和临时任务；不做持久化，不向其他 run 隐式注入历史。 */
export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [name, content] of Object.entries(initial))
      this.files.set(relativePath(name), content);
  }
  async list(directory: string, signal: AbortSignal): Promise<FileEntry[]> {
    checkAbort(signal);
    const prefix = directory === "." ? "" : `${directory}/`;
    const entries = new Map<string, FileEntry>();
    for (const file of this.files.keys())
      if (file.startsWith(prefix)) {
        const remaining = file.slice(prefix.length);
        const name = remaining.split("/")[0]!;
        entries.set(name, {
          path: prefix + name,
          type: remaining.includes("/") ? "directory" : "file",
        });
      }
    if (directory !== "." && !entries.size)
      throw new ToolError("not_found", "Directory does not exist");
    return [...entries.values()];
  }
  async read(file: string, signal: AbortSignal): Promise<string> {
    checkAbort(signal);
    const content = this.files.get(file);
    if (content === undefined) throw new ToolError("not_found", "File does not exist");
    return content;
  }
  async write(
    file: string,
    content: string,
    overwrite: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    const parts = file.split("/");
    if (
      parts.slice(0, -1).some((_, index) => this.files.has(parts.slice(0, index + 1).join("/"))) ||
      [...this.files.keys()].some((name) => name.startsWith(`${file}/`))
    ) {
      throw new ToolError("invalid_path", "File and directory paths conflict");
    }
    if (!overwrite && this.files.has(file))
      throw new ToolError("already_exists", "File already exists");
    if (overwrite && !this.files.has(file)) throw new ToolError("not_found", "File does not exist");
    this.files.set(file, content);
  }
}

/** 只有显式 writable 白名单才可写，内存实现也遵循相同权限契约。 */
export function createMemoryFilesystem(
  options: FilesystemOptions & { files?: Record<string, string> } = {},
): FilesystemBackend {
  return new FilesystemBackend(new MemoryFileStore(options.files), options);
}
