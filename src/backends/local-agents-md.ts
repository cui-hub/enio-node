import { AgentError } from "../protocol/errors.js";
import type { AgentsMdLoader } from "../protocol/types.js";
import { createAgentsMd } from "../instructions/agents-md.js";
import type { AgentsMdOptions } from "../instructions/agents-md.js";
import { LocalFileStore } from "./local-filesystem.js";

/** 本地读取沿用 LocalFileStore；root 由宿主显式指定，不隐式使用进程工作目录。 */
export interface FilesystemAgentsMdOptions extends Omit<AgentsMdOptions, "backend"> {
  root: string;
}

/**
 * 启用后默认读取 root/AGENTS.md；可通过 files 选择其他名字或多个有序文件。
 * 引用仅允许落在 root 内，逐级拒绝符号链接。每个文件先受 1 MiB 的存储读取上限
 * 约束，再由加载器按提示词预算截断。不扫描祖先目录，也不自动加载子目录规则。
 */
export function createFilesystemAgentsMd(options: FilesystemAgentsMdOptions): AgentsMdLoader {
  if (typeof options.root !== "string" || !options.root.trim())
    throw new AgentError("invalid_config", "A project instruction root is required");
  const { root, ...loaderOptions } = options;
  return createAgentsMd({ ...loaderOptions, backend: new LocalFileStore(root) });
}
