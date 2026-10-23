import path from "node:path";
import { AgentError } from "../protocol/errors.js";
import type { AgentsMdLoader } from "../protocol/types.js";
import { abortable, byteLength, checkAbort, truncateUtf8 } from "../runtime/control.js";

/**
 * 项目指令只需要读取原始 UTF-8 文本，不依赖工具的分页、JSON 返回体或写权限。
 * file 始终是根目录内的 POSIX 相对路径。缺失须抛出 code=not_found 或 ENOENT；
 * 自定义远端 backend 负责自己的读取体积上限、身份鉴权及 signal 传播。
 */
export interface AgentsMdBackend {
  read(file: string, signal: AbortSignal): Promise<string>;
}

/** 非致命加载信息。file 是相对路径，不携带原始异常、文件正文或凭证。 */
export interface AgentsMdWarning {
  file: string;
  code: "not_found" | "cycle" | "depth_limit" | "file_limit" | "file_truncated" | "total_limit";
  message: string;
}

/** 所有预算按单次 load 计数；省略时使用默认值，0 仅对 maxImportDepth 有效。 */
export interface AgentsMdOptions {
  backend: AgentsMdBackend;
  /** 有序的入口文件；默认 ["AGENTS.md"]，空数组表示不读取任何文件。 */
  files?: string[];
  /** 单文件正文上限（UTF-8 字节），默认 16 KiB。截断后不继续展开该文件引用。 */
  maxFileBytes?: number;
  /** 最终注入文本上限，包含文件标题和截断提示，默认 32 KiB。 */
  maxTotalBytes?: number;
  /** 入口深度为 0；默认最多 5 层引用，0 表示不展开引用。 */
  maxImportDepth?: number;
  /** 最多尝试读取的不同路径数（包含缺失文件），默认 128。 */
  maxFiles?: number;
  /** 可选观察回调；默认静默，回调失败被隔离，也不会阻塞加载。 */
  onWarning?(warning: AgentsMdWarning): void | Promise<void>;
}

const TRUNCATED = "\n[truncated]\n";
const IMPORT_EXTENSIONS = new Set([".md", ".txt", ".mdx", ".yaml", ".yml", ".json", ".toml"]);

/** 防止非法配置变成无限遍历；字节上限不使用 0 表达无限制。 */
function budget(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new AgentError("invalid_config", `Invalid agentsMd ${name}`);
  return value;
}

/**
 * 引用相对其所在文件解析，可以用 ../ 指向根目录内的兄弟文件。
 * 绝对路径、主目录简写和逃出根目录的路径均拒绝，不自动读取用户级配置。
 */
function resolveFile(file: string, directory = "."): string {
  if (
    typeof file !== "string" ||
    !file ||
    file.length > 1024 ||
    /[\x00-\x1f\x7f\\]/u.test(file) ||
    file.startsWith("~") ||
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    /^[a-z]:/iu.test(file)
  )
    throw new AgentError("invalid_agents_md_path", "Invalid project instruction path");
  const resolved = path.posix.normalize(path.posix.join(directory, file));
  if (resolved === "." || resolved === ".." || resolved.startsWith("../"))
    throw new AgentError("invalid_agents_md_path", "Project instruction path escapes its root");
  return resolved;
}

/**
 * 支持正文中的 @docs/rules.md、@rules.md，保留引用原文并单独追加被引用文件。
 * 仅识别无空格路径；前置边界避免把邮箱识别为引用。普通 @mention 不展开。
 * 这不是 Markdown 解析器：代码块里的同类引用也会展开，与 Eino 的文本扫描一致。
 */
function imports(content: string): string[] {
  const references: string[] = [];
  const pattern = /(?:^|[\s("'`\[{])@([^\s<>"'`\]\[{}(),;!?，。；！？]+)/gu;
  for (const match of content.matchAll(pattern)) {
    const reference = match[1]!.replace(/[.:]+$/u, "");
    if (reference.includes("/") || IMPORT_EXTENSIONS.has(path.posix.extname(reference)))
      references.push(reference);
  }
  return references;
}

/**
 * 创建惰性的项目指令加载器。构造时只校验配置；load 时深度优先读取入口和引用，
 * 全局去重并检测引用环。所有可变状态留在 load 内，实例可以被多个 Agent/run 复用。
 */
export function createAgentsMd(options: AgentsMdOptions): AgentsMdLoader {
  if (typeof options.backend?.read !== "function")
    throw new AgentError("invalid_config", "An agentsMd backend is required");
  if (options.files !== undefined && !Array.isArray(options.files))
    throw new AgentError("invalid_config", "agentsMd.files must be an array");
  if (options.onWarning !== undefined && typeof options.onWarning !== "function")
    throw new AgentError("invalid_config", "agentsMd.onWarning must be a function");
  const read = options.backend.read.bind(options.backend);
  const files = (options.files ?? ["AGENTS.md"]).map((file) => resolveFile(file));
  const maxFileBytes = budget(options.maxFileBytes ?? 16_384, "maxFileBytes");
  const maxTotalBytes = budget(options.maxTotalBytes ?? 32_768, "maxTotalBytes");
  const maxImportDepth = budget(options.maxImportDepth ?? 5, "maxImportDepth", 0);
  const maxFiles = budget(options.maxFiles ?? 128, "maxFiles");
  const onWarning = options.onWarning;

  /** 告警只供宿主观察；其异常不掩盖文件读取的结果。 */
  function warn(file: string, code: AgentsMdWarning["code"], message: string): void {
    try {
      void Promise.resolve(onWarning?.({ file, code, message })).catch(() => {});
    } catch {
      // 与运行事件的观察回调一致，忽略同步观察异常。
    }
  }

  return {
    async load(signal) {
      const seen = new Set<string>();
      const ancestors = new Set<string>();
      const sections: string[] = [];
      let totalBytes = 0;
      let stopped = false;

      /** 串行 DFS 保持宿主声明的顺序；达到预算后不再读取后续文件。 */
      async function visit(file: string, depth: number): Promise<void> {
        checkAbort(signal);
        if (stopped) return;
        if (ancestors.has(file)) {
          warn(file, "cycle", "Circular project instruction import skipped");
          return;
        }
        if (seen.has(file)) return;
        if (depth > maxImportDepth) {
          warn(file, "depth_limit", "Project instruction import depth exceeded");
          return;
        }
        if (seen.size >= maxFiles) {
          stopped = true;
          warn(file, "file_limit", "Project instruction file count exceeded");
          return;
        }
        seen.add(file);
        let content: string;
        try {
          content = await abortable(
            Promise.resolve().then(() => read(file, signal)),
            signal,
          );
          checkAbort(signal);
          if (typeof content !== "string") throw new Error("Backend must return text");
        } catch (error) {
          checkAbort(signal);
          const code = (error as { code?: string } | null)?.code;
          if (code === "ENOENT" || code === "not_found") {
            warn(file, "not_found", "Project instruction file does not exist");
            return;
          }
          throw new AgentError(
            "agents_md_load_failed",
            `Cannot read project instructions: ${file}`,
          );
        }
        if (!content.trim()) return;

        const header = `${sections.length ? "\n\n" : ""}Project instructions (${file}):\n\n`;
        let body = truncateUtf8(content, maxFileBytes);
        const fileTruncated = body !== content;
        let section = header + body + (fileTruncated ? TRUNCATED : "");
        if (fileTruncated) warn(file, "file_truncated", "Project instruction file truncated");

        const remaining = maxTotalBytes - totalBytes;
        if (byteLength(section) > remaining) {
          stopped = true;
          warn(file, "total_limit", "Project instruction total byte budget reached");
          const bodyBytes = remaining - byteLength(header) - byteLength(TRUNCATED);
          // 太小的预算无法容纳完整来源标题和提示，不注入半个标题。
          if (bodyBytes <= 0) return;
          body = truncateUtf8(body, bodyBytes);
          section = header + body + TRUNCATED;
        }
        sections.push(section);
        totalBytes += byteLength(section);
        if (totalBytes >= maxTotalBytes) stopped = true;
        // 不从残缺正文推断后续引用；避免截断的路径触发意外读取。
        if (stopped || fileTruncated) return;

        ancestors.add(file);
        try {
          for (const reference of imports(content)) {
            if (stopped) break;
            await visit(resolveFile(reference, path.posix.dirname(file)), depth + 1);
          }
        } finally {
          ancestors.delete(file);
        }
      }

      checkAbort(signal);
      for (const file of files) {
        if (stopped) break;
        await visit(file, 0);
      }
      checkAbort(signal);
      return sections.join("");
    },
  };
}
