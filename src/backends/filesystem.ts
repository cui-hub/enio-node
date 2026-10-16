import { createHash } from "node:crypto";
import path from "node:path";
import picomatch from "picomatch";
import { ToolError } from "../protocol/errors.js";
import { byteLength, checkAbort, truncateUtf8 } from "../runtime/control.js";

/** 列表只返回相对路径与类型；不向模型暴露宿主绝对路径。 */
export interface FileEntry {
  path: string;
  type: "file" | "directory";
}
/** 读结果包含内容版本，供后续写入/编辑进行乐观冲突检测。 */
export interface FileRead {
  content: string;
  hash: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}
/** 文件策略由宿主配置，不能由模型工具参数覆盖。 */
export interface FilesystemOptions {
  readable?: string[];
  writable?: string[];
  excluded?: string[];
  maxFileBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
  maxScanBytes?: number;
}
/** 内存和本地实现共同满足此存储接口；操作前必须响应 signal。 */
export interface FileStore {
  list(directory: string, signal: AbortSignal): Promise<FileEntry[]>;
  read(file: string, signal: AbortSignal): Promise<string>;
  write(file: string, content: string, overwrite: boolean, signal: AbortSignal): Promise<void>;
}
/** 对外 backend 契约允许以后替换为容器/远程实现。 */
export interface FileSystemBackend {
  /** 页码式 cursor 仅对当前目录快照稳定，目录并发变化时应重新列举。 */
  ls(
    input: { path?: string; limit?: number; cursor?: number },
    signal: AbortSignal,
  ): Promise<{ entries: FileEntry[]; nextCursor?: number }>;
  /** 行号从 1 开始，返回 hash 对应完整文件，正文最多 24 KiB。 */
  readFile(
    input: { path: string; startLine?: number; lineCount?: number },
    signal: AbortSignal,
  ): Promise<FileRead>;
  /** 默认排他创建；overwrite=true 时 expectedHash 必须匹配。 */
  writeFile(
    input: { path: string; content: string; overwrite?: boolean; expectedHash?: string },
    signal: AbortSignal,
  ): Promise<{ path: string; hash: string }>;
  /** 精确且唯一命中才替换；同一 backend 内的写操作按路径加锁。 */
  editFile(
    input: { path: string; oldText: string; newText: string; expectedHash: string },
    signal: AbortSignal,
  ): Promise<{ path: string; hash: string }>;
  /** 有界遍历，不跟随符号链接；truncated 表示还有未返回的匹配。 */
  glob(
    input: { pattern: string; limit?: number },
    signal: AbortSignal,
  ): Promise<{ paths: string[]; truncated: boolean }>;
  /** literal 为普通文本，不是正则；扫描预算与返回数量分别受限。 */
  grep(
    input: { literal: string; pattern?: string; limit?: number },
    signal: AbortSignal,
  ): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>;
}

/** 统一拒绝 POSIX/Windows 绝对路径、反斜线和目录穿越。路径不做 URL 解码。 */
export function relativePath(value: string, directory = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    value.split("/").includes("..")
  ) {
    throw new ToolError(
      "invalid_path",
      "Only workspace-relative paths without traversal are allowed",
      false,
    );
  }
  const normalized = path.posix.normalize(value || ".");
  if (!directory && normalized === ".")
    throw new ToolError("invalid_path", "A file path is required");
  return normalized.replace(/\/$/, "");
}

/** 查询 pattern 只作为受限 glob 编译，不接受任意正则或超长表达式。 */
export function globMatcher(pattern: string): (value: string) => boolean {
  if (
    !pattern ||
    pattern.length > 512 ||
    pattern.startsWith("!") ||
    pattern.includes("\\") ||
    pattern.split("/").includes("..") ||
    path.isAbsolute(pattern)
  )
    throw new ToolError("invalid_pattern", "Invalid glob pattern");
  return picomatch(pattern, { dot: true, noext: true, nobrace: true });
}

/** 文件 hash 是冲突前置条件，不是身份或权限凭据。 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 直接调用 backend 时也校验数值，不仅依赖模型入口 Schema。 */
function bounded(value: number | undefined, fallback: number, max: number, min = 1): number {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new ToolError("invalid_arguments", "Numeric file limit is out of range");
  return number;
}

/**
 * 共享文件行为：权限、查询范围、hash 前置条件及每路径互斥。锁只覆盖同一
 * backend 实例，不能对抗其他进程；业务应为一个工作区复用一个 backend。
 */
export class FilesystemBackend implements FileSystemBackend {
  private readonly readable: ((file: string) => boolean)[];
  private readonly writable: ((file: string) => boolean)[];
  private readonly excluded: ((file: string) => boolean)[];
  private readonly locks = new Map<string, Promise<void>>();
  private readonly maxEntries: number;
  private readonly maxDepth: number;
  private readonly maxFileBytes: number;
  private readonly maxScanBytes: number;

  constructor(
    private readonly store: FileStore,
    options: FilesystemOptions = {},
  ) {
    this.readable = (options.readable ?? ["**"]).map(globMatcher);
    this.writable = (options.writable ?? []).map(globMatcher);
    this.excluded = [
      "**/.git",
      "**/.git/**",
      "**/.env",
      "**/.env.*",
      ...(options.excluded ?? []),
    ].map(globMatcher);
    this.maxEntries = bounded(options.maxEntries, 10_000, 100_000);
    this.maxDepth = bounded(options.maxDepth, 16, 64);
    this.maxFileBytes = bounded(options.maxFileBytes, 1_048_576, 16_777_216);
    this.maxScanBytes = bounded(options.maxScanBytes, 8_388_608, 67_108_864);
  }

  private isExcluded(file: string): boolean {
    const parts = file.split("/");
    return parts.some((_, index) =>
      this.excluded.some((match) => match(parts.slice(0, index + 1).join("/"))),
    );
  }

  private checkPath(file: string, mode: "read" | "write"): string {
    const normalized = relativePath(file);
    const allowed = mode === "read" ? this.readable : this.writable;
    if (this.isExcluded(normalized) || !allowed.some((match) => match(normalized)))
      throw new ToolError("permission_denied", `Path is not allowed for ${mode}`, false);
    return normalized;
  }

  /** 列目录不等于读取文件；返回目录以便导航，但隐藏禁止访问的文件和敏感目录。 */
  async ls(input: { path?: string; limit?: number; cursor?: number }, signal: AbortSignal) {
    checkAbort(signal);
    const directory = relativePath(input.path ?? ".", true);
    if (this.isExcluded(directory))
      throw new ToolError("permission_denied", "Directory is excluded", false);
    const limit = bounded(input.limit, 100, 500);
    const cursor = bounded(input.cursor, 0, this.maxEntries, 0);
    const all = (await this.store.list(directory, signal)).filter(
      (entry) =>
        !this.isExcluded(entry.path) &&
        (entry.type === "directory" || this.readable.some((match) => match(entry.path))),
    );
    if (all.length > this.maxEntries)
      throw new ToolError("scan_limit", "Directory contains too many entries");
    const entries = all.sort((a, b) => a.path.localeCompare(b.path)).slice(cursor, cursor + limit);
    return { entries, ...(cursor + limit < all.length ? { nextCursor: cursor + limit } : {}) };
  }

  private async readText(file: string, signal: AbortSignal): Promise<string> {
    checkAbort(signal);
    const content = await this.store.read(file, signal);
    if (byteLength(content) > this.maxFileBytes)
      throw new ToolError("file_too_large", "File exceeds the configured size limit");
    if (content.includes("\0"))
      throw new ToolError("binary_file", "Only UTF-8 text files are supported");
    return content;
  }

  /** 对内容分页，但用完整文件计算 hash，确保后续修改检测的是同一版本。 */
  async readFile(
    input: { path: string; startLine?: number; lineCount?: number },
    signal: AbortSignal,
  ): Promise<FileRead> {
    const file = this.checkPath(input.path, "read");
    const startLine = bounded(input.startLine, 1, 1_000_000);
    const lineCount = bounded(input.lineCount, 200, 10_000);
    const original = await this.readText(file, signal);
    const lines = original.split("\n");
    const selected = lines.slice(startLine - 1, startLine - 1 + lineCount).join("\n");
    const content = truncateUtf8(selected, 24_576);
    const endLine = content ? startLine + content.split("\n").length - 1 : startLine - 1;
    return {
      content,
      hash: contentHash(original),
      startLine,
      endLine,
      truncated: content !== selected || startLine - 1 + lineCount < lines.length,
    };
  }

  /** 先等待前一个写入，再读取 hash；避免两个并发调用同时通过旧版本检查。 */
  private async withLock<T>(file: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(file) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(file, current);
    try {
      await previous;
      checkAbort(signal);
      return await work();
    } finally {
      release();
      if (this.locks.get(file) === current) this.locks.delete(file);
    }
  }

  /** 覆盖检查在锁内完成；普通创建把排他性委托给底层 store。 */
  async writeFile(
    input: { path: string; content: string; overwrite?: boolean; expectedHash?: string },
    signal: AbortSignal,
  ) {
    const file = this.checkPath(input.path, "write");
    if (typeof input.content !== "string" || byteLength(input.content) > this.maxFileBytes)
      throw new ToolError("file_too_large", "Write content exceeds file limit");
    return this.withLock(file, signal, async () => {
      if (input.overwrite) {
        if (!input.expectedHash)
          throw new ToolError("conflict", "Overwriting requires expectedHash");
        if (contentHash(await this.readText(file, signal)) !== input.expectedHash)
          throw new ToolError("conflict", "File changed since it was read");
      }
      checkAbort(signal);
      await this.store.write(file, input.content, input.overwrite === true, signal);
      return { path: file, hash: contentHash(input.content) };
    });
  }

  /** 不做模糊替换，零命中和多命中都必须交回模型重新决定。 */
  async editFile(
    input: { path: string; oldText: string; newText: string; expectedHash: string },
    signal: AbortSignal,
  ) {
    const file = this.checkPath(input.path, "write");
    return this.withLock(file, signal, async () => {
      if (!input.oldText || !input.expectedHash)
        throw new ToolError("invalid_arguments", "oldText and expectedHash are required");
      const original = await this.readText(file, signal);
      if (contentHash(original) !== input.expectedHash)
        throw new ToolError("conflict", "File changed since it was read");
      const first = original.indexOf(input.oldText);
      if (first < 0 || original.indexOf(input.oldText, first + 1) >= 0)
        throw new ToolError("edit_mismatch", "oldText must match exactly once");
      const content =
        original.slice(0, first) + input.newText + original.slice(first + input.oldText.length);
      if (byteLength(content) > this.maxFileBytes)
        throw new ToolError("file_too_large", "Edited content exceeds file limit");
      checkAbort(signal);
      await this.store.write(file, content, true, signal);
      return { path: file, hash: contentHash(content) };
    });
  }

  /** 有界广度优先遍历，禁止从用户 pattern 直接驱动无上限全盘扫描。 */
  private async *walk(signal: AbortSignal): AsyncGenerator<string> {
    const queue = [{ directory: ".", depth: 0 }];
    let visited = 0;
    for (let index = 0; index < queue.length; index++) {
      const { directory, depth } = queue[index]!;
      checkAbort(signal);
      for (const entry of await this.store.list(directory, signal)) {
        if (++visited > this.maxEntries)
          throw new ToolError("scan_limit", "Workspace traversal limit exceeded");
        if (this.isExcluded(entry.path)) continue;
        if (entry.type === "directory") {
          if (depth >= this.maxDepth)
            throw new ToolError("scan_limit", "Workspace depth limit exceeded");
          queue.push({ directory: entry.path, depth: depth + 1 });
        } else if (this.readable.some((match) => match(entry.path))) yield entry.path;
      }
    }
  }

  /** 多观察一个匹配再标记 truncated，避免把恰好等于 limit 当成被截断。 */
  async glob(input: { pattern: string; limit?: number }, signal: AbortSignal) {
    const match = globMatcher(input.pattern);
    const limit = bounded(input.limit, 100, 500);
    const paths: string[] = [];
    for await (const file of this.walk(signal)) {
      if (!match(file)) continue;
      if (paths.length >= limit) return { paths, truncated: true };
      paths.push(file);
    }
    return { paths, truncated: false };
  }

  /** 只检索可读文本；二进制跳过，其他读取错误保留给调用者处理。 */
  async grep(input: { literal: string; pattern?: string; limit?: number }, signal: AbortSignal) {
    if (!input.literal || input.literal.length > 4096)
      throw new ToolError("invalid_arguments", "A bounded nonempty literal is required");
    const match = globMatcher(input.pattern ?? "**");
    const limit = bounded(input.limit, 100, 500);
    const matches: { path: string; line: number; text: string }[] = [];
    let scanned = 0;
    for await (const file of this.walk(signal)) {
      if (!match(file)) continue;
      let text: string;
      try {
        text = await this.readText(file, signal);
      } catch (error) {
        if (error instanceof ToolError && error.code === "binary_file") continue;
        throw error;
      }
      scanned += byteLength(text);
      if (scanned > this.maxScanBytes) return { matches, truncated: true };
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++)
        if (lines[index]!.includes(input.literal)) {
          if (matches.length >= limit) return { matches, truncated: true };
          matches.push({ path: file, line: index + 1, text: truncateUtf8(lines[index]!, 512) });
        }
    }
    return { matches, truncated: false };
  }
}
