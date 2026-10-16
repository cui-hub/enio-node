import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentError, ToolError } from "../protocol/errors.js";
import { checkAbort } from "../runtime/control.js";
import { FilesystemBackend, relativePath } from "./filesystem.js";
import type { FileEntry, FileStore, FilesystemOptions } from "./filesystem.js";

/** 将已知 OS 错误变成稳定的模型可修正错误，不返回宿主绝对路径。 */
function fileError(error: unknown): never {
  if (error instanceof ToolError || error instanceof AgentError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") throw new ToolError("not_found", "File or directory does not exist");
  if (code === "EEXIST") throw new ToolError("already_exists", "File already exists");
  if (["EACCES", "EPERM", "ELOOP"].includes(code ?? ""))
    throw new ToolError("permission_denied", "Filesystem operation is not allowed", false);
  if (["EISDIR", "ENOTDIR"].includes(code ?? ""))
    throw new ToolError("invalid_path", "Unexpected file type");
  throw error;
}

/**
 * 本地受信任工作区存储。逐级 lstat 拒绝符号链接，文件打开附加 O_NOFOLLOW。
 * 这些检查不等于 OS 沙箱，仍不能防御有权修改祖先目录的恶意并发进程。
 */
export class LocalFileStore implements FileStore {
  private readonly root: string;
  constructor(
    root: string,
    private readonly maxBytes = 1_048_576,
    private readonly maxEntries = 10_000,
  ) {
    this.root = path.resolve(root);
  }

  /** 检查所有已存在的路径分量；创建父目录时逐级进行，拒绝中途出现的链接。 */
  private async resolve(file: string, signal: AbortSignal, createParents = false): Promise<string> {
    checkAbort(signal);
    const relative = relativePath(file, true);
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new ToolError("invalid_path", "Workspace root must be a real directory", false);
    // realpath 固定并验证根路径可访问，不将其返回到模型。
    await realpath(this.root);
    let current = this.root;
    const parts = relative === "." ? [] : relative.split("/");
    for (let index = 0; index < parts.length; index++) {
      checkAbort(signal);
      current = path.join(current, parts[index]!);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
          throw new ToolError("invalid_path", "Symbolic links are not allowed", false);
        if (index < parts.length - 1 && !stat.isDirectory())
          throw new ToolError("invalid_path", "Parent must be a directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (createParents && index < parts.length - 1) {
          try {
            await mkdir(current);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
          }
          const stat = await lstat(current);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new ToolError("invalid_path", "Invalid parent directory");
        } else if (index < parts.length - 1) throw error;
      }
    }
    return current;
  }

  async list(directory: string, signal: AbortSignal): Promise<FileEntry[]> {
    try {
      const resolved = await this.resolve(directory, signal);
      const entries: FileEntry[] = [];
      let visited = 0;
      for await (const entry of await opendir(resolved)) {
        checkAbort(signal);
        if (++visited > this.maxEntries)
          throw new ToolError("scan_limit", "Directory entry limit exceeded");
        // 不跟随链接、socket、设备或其他非普通文件，避免扫描触发特殊 I/O。
        if (!entry.isDirectory() && !entry.isFile()) continue;
        entries.push({
          path: directory === "." ? entry.name : `${directory}/${entry.name}`,
          type: entry.isDirectory() ? "directory" : "file",
        });
      }
      return entries;
    } catch (error) {
      return fileError(error);
    }
  }

  async read(file: string, signal: AbortSignal): Promise<string> {
    try {
      const resolved = await this.resolve(file, signal);
      const beforeOpen = await lstat(resolved);
      if (!beforeOpen.isFile())
        throw new ToolError("invalid_path", "Only regular files can be read");
      // O_NONBLOCK 防止文件在检查后被替换成 FIFO，导致 open 永远等待另一端。
      const handle = await open(
        resolved,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new ToolError("invalid_path", "Only regular files can be read");
        if (stat.size > this.maxBytes)
          throw new ToolError("file_too_large", "File exceeds size limit");
        // 多分配一个字节检测读期间增长，不能依赖打开前 stat 一次就无限读入。
        const buffer = Buffer.alloc(this.maxBytes + 1);
        let offset = 0;
        while (offset < buffer.length) {
          checkAbort(signal);
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset > this.maxBytes)
          throw new ToolError("file_too_large", "File grew beyond size limit");
        try {
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            buffer.subarray(0, offset),
          );
        } catch {
          throw new ToolError("binary_file", "File is not valid UTF-8 text");
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      return fileError(error);
    }
  }

  async write(
    file: string,
    content: string,
    overwrite: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    let mutated = false;
    let temporary: string | undefined;
    try {
      const resolved = await this.resolve(file, signal, true);
      checkAbort(signal);
      if (!overwrite) {
        // 排他创建保证“默认不覆盖”；创建中失败可能留下部分文件，必须标记未知结果。
        const handle = await open(
          resolved,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        mutated = true;
        try {
          await handle.writeFile(content, { encoding: "utf8", signal });
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        temporary = path.join(path.dirname(resolved), `.enio-${randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(content, { encoding: "utf8", signal });
          await handle.sync();
        } finally {
          await handle.close();
        }
        checkAbort(signal);
        await this.resolve(file, signal);
        // 同一目录 rename 提供替换可见性的原子性，不提供跨文件事务。
        await rename(temporary, resolved);
        temporary = undefined;
        mutated = true;
      }
    } catch (error) {
      if (mutated)
        throw new AgentError("outcome_unknown", "A file write may have partially completed", true);
      return fileError(error);
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
}

/** root 必须由宿主预先建立；默认只读，写权限需要显式 writable 白名单。 */
export function createLocalFilesystem(
  options: FilesystemOptions & { root: string },
): FilesystemBackend {
  return new FilesystemBackend(
    new LocalFileStore(options.root, options.maxFileBytes, options.maxEntries),
    options,
  );
}
