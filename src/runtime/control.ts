import { AgentError } from "../protocol/errors.js";
import type { Limits } from "../protocol/types.js";

/** 默认值来自一期方案；不是所有 Eino 默认配置的逐项映射。 */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxIterations: 20,
  maxToolCalls: 64,
  maxToolCallsPerRound: 8,
  runTimeoutMs: 120_000,
  modelTimeoutMs: 60_000,
  toolTimeoutMs: 30_000,
  maxModelRetries: 2,
  retryDelayMs: 200,
  maxToolArgumentBytes: 32_768,
  maxToolResultBytes: 32_768,
  maxInputBytes: 1_048_576,
  maxModelResponseBytes: 1_048_576,
});

/** 限制值来自业务配置，也必须在运行时校验，拒绝 NaN、负数和无效键。 */
export function resolveLimits(...overrides: (Partial<Limits> | undefined)[]): Limits {
  const limits = Object.assign({}, DEFAULT_LIMITS, ...overrides);
  for (const [key, value] of Object.entries(limits)) {
    const minimum = key === "maxModelRetries" || key === "retryDelayMs" ? 0 : 1;
    if (
      !(key in DEFAULT_LIMITS) ||
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum
    ) {
      throw new AgentError("invalid_config", `Invalid limit: ${key}`);
    }
  }
  // 信封自身需要空间；极小上限无法表达工具错误或截断标记。
  if (limits.maxToolResultBytes < 256)
    throw new AgentError("invalid_config", "maxToolResultBytes must be >= 256");
  return limits;
}

/** 创建可释放的 deadline；父级取消原样传播，避免被误判为普通工具异常。 */
export function createScope(parent: AbortSignal, timeoutMs: number, code: string) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new AgentError(code, `Deadline exceeded: ${code}`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cancel() {
      controller.abort(new AgentError("cancelled", "Operation closed"));
    },
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

/** 把外部任意 abort reason 转为稳定 cancelled，内部 deadline 错误保留原类别。 */
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof AgentError
      ? signal.reason
      : new AgentError("cancelled", "Run cancelled");
}

/**
 * 结束等待，不承诺终止不合作的函数。挂上成功与失败处理，晚到拒绝不会成为
 * unhandled rejection；副作用是否发生由执行器另外标记 outcomeUnknown。
 */
export function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      try {
        checkAbort(signal);
      } catch (error) {
        reject(error);
      }
    };
    Promise.resolve(work).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** 退避等待同样响应取消，定时器在退出时释放。 */
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 按 UTF-8 字节边界截断，不能产生半个多字节字符。 */
export function truncateUtf8(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = Math.max(0, bytes);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/** 统一使用 UTF-8 预算，避免把 JavaScript UTF-16 字符长度误当请求大小。 */
export function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}
