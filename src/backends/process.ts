import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { AgentError, ToolError } from "../protocol/errors.js";
import { checkAbort, truncateUtf8 } from "../runtime/control.js";
import { relativePath } from "./filesystem.js";

/** 结构化命令不会被 shell 再解释；是否允许 args 由宿主策略决定。 */
export interface ExecuteInput {
  command: string;
  args?: string[];
  cwd?: string;
}
/** 输出限制是 stdout/stderr 合计字节数；truncated 表示原始输出不完整。 */
export interface ExecuteResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
/** 可替换为远端或容器执行器；该接口不意味着本地实现具备沙箱隔离。 */
export interface ExecuteBackend {
  execute(input: ExecuteInput, signal: AbortSignal): Promise<ExecuteResult>;
}
/** 命令列表与 authorize 必须同时通过，环境变量只有显式传入的键可见。 */
export interface ProcessBackendOptions {
  root: string;
  commands: string[];
  authorize(input: Readonly<ExecuteInput>): boolean | Promise<boolean>;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  timeoutMs?: number;
  killGraceMs?: number;
}

/** 本地执行仅支持 POSIX 进程组。配置命令须为绝对路径，避免 PATH 劫持。 */
export function createProcessBackend(options: ProcessBackendOptions): ExecuteBackend {
  if (process.platform === "win32")
    throw new AgentError("unsupported_platform", "Process backend currently requires macOS/Linux");
  if (
    !options.commands.length ||
    options.commands.some((command) => !path.isAbsolute(command)) ||
    typeof options.authorize !== "function"
  )
    throw new AgentError("invalid_config", "Absolute command allowlist and authorize are required");
  const maximum = options.maxOutputBytes ?? 24_576;
  const timeout = options.timeoutMs ?? 30_000;
  const grace = options.killGraceMs ?? 100;
  if ([maximum, timeout, grace].some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new AgentError("invalid_config", "Invalid process budget");
  const commands = new Set(options.commands);
  const env = { ...options.env };
  return {
    async execute(input, signal) {
      checkAbort(signal);
      const request = structuredClone(input);
      if (!commands.has(request.command) || !(await options.authorize(structuredClone(request))))
        throw new ToolError("permission_denied", "Command denied by host policy", false);
      const root = await realpath(options.root);
      const relative = relativePath(request.cwd ?? ".", true);
      let cwd = root;
      for (const part of relative === "." ? [] : relative.split("/")) {
        cwd = path.join(cwd, part);
        const stat = await lstat(cwd);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new ToolError("invalid_path", "Command cwd must be a real directory");
      }
      checkAbort(signal);
      return new Promise<ExecuteResult>((resolve, reject) => {
        const child = spawn(request.command, request.args ?? [], {
          cwd,
          env,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let bytes = 0;
        let truncated = false;
        let stopped: AgentError | undefined;
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        let forceDone = Promise.resolve();
        // 杀整个进程组，防止只结束父进程而留下普通子进程。脱离进程组者不受保证。
        const kill = (kind: NodeJS.Signals) => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, kind);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(kind);
          }
        };
        const stop = (error: AgentError) => {
          if (stopped) return;
          stopped = error;
          kill("SIGTERM");
          forceDone = new Promise<void>((done) => {
            forceTimer = setTimeout(() => {
              kill("SIGKILL");
              done();
            }, grace);
          });
        };
        const abort = () =>
          stop(
            new AgentError("cancelled", "Command cancelled; side effects may have occurred", true),
          );
        const timer = setTimeout(
          () =>
            stop(
              new AgentError(
                "tool_timeout",
                "Command timed out; side effects may have occurred",
                true,
              ),
            ),
          timeout,
        );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const collect = (chunk: Buffer, channel: "stdout" | "stderr") => {
          const remaining = Math.max(0, maximum - bytes);
          const part = chunk.subarray(0, remaining);
          bytes += part.length;
          truncated ||= part.length < chunk.length;
          if (channel === "stdout") stdout = Buffer.concat([stdout, part]);
          else stderr = Buffer.concat([stderr, part]);
        };
        child.stdout.on("data", (chunk) => collect(Buffer.from(chunk), "stdout"));
        child.stderr.on("data", (chunk) => collect(Buffer.from(chunk), "stderr"));
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        };
        child.once("error", () => {
          cleanup();
          clearTimeout(forceTimer);
          reject(new ToolError("execute_failed", "Could not start command", false));
        });
        child.once("close", (exitCode, exitSignal) => {
          cleanup();
          void forceDone.then(() => {
            if (stopped) reject(stopped);
            else {
              // stream=true 丢弃预算边缘的不完整 UTF-8 尾部，避免生成半个汉字。
              const out = truncateUtf8(new TextDecoder().decode(stdout, { stream: true }), maximum);
              const err = truncateUtf8(
                new TextDecoder().decode(stderr, { stream: true }),
                maximum - Buffer.byteLength(out),
              );
              resolve({ exitCode, signal: exitSignal, stdout: out, stderr: err, truncated });
            }
          });
        });
      });
    },
  };
}
