import type {
  AgentConfig,
  Limits,
  RunState,
  ToolCall,
  ToolChunk,
  ToolContext,
} from "../protocol/types.js";
import { AgentError } from "../protocol/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { streamTool } from "../tools/executor.js";
import { checkAbort } from "./control.js";
import { ToolInterrupt } from "./interrupt.js";

/** 只合并队头连续的显式安全读取；未知工具、写工具和直接返回工具构成顺序屏障。 */
export function selectBatch<C>(
  queue: ToolCall[],
  registry: ToolRegistry<C>,
  maximum: number,
): ToolCall[] {
  const batch = [queue[0]!];
  if (
    !registry.behavior(batch[0]!.name).parallelSafe ||
    registry.behavior(batch[0]!.name).returnDirect
  )
    return batch;
  for (const call of queue.slice(1, maximum)) {
    const behavior = registry.behavior(call.name);
    if (!behavior.parallelSafe || behavior.returnDirect) break;
    batch.push(call);
  }
  return batch;
}

/** 并发读取不共享可写 todos；误声明 parallelSafe 的状态写入会显式失败。 */
function readonlyState(state: RunState): RunState {
  const copy = structuredClone(state);
  copy.todos.forEach(Object.freeze);
  Object.freeze(copy.todos);
  return Object.freeze(copy);
}

type BatchItem =
  { call: ToolCall; chunk: ToolChunk } | { call: ToolCall; interrupt: ToolInterrupt };

/**
 * 每个工具最多挂起一个 next，没有无限进度队列。消费方暂停时停止继续拉取。
 * 中断等待本批其他只读调用收尾，已完成结果由 Loop 回填后再保存检查点；
 * 致命错误则取消同批调用，且绝不产生可重放检查点。
 */
export async function* runToolBatch<C>(input: {
  calls: ToolCall[];
  registry: ToolRegistry<C>;
  context: Omit<ToolContext<C>, "toolCallId" | "resume">;
  resume?: { id: string; data: ToolContext<C>["resume"] };
  config: AgentConfig<C>;
  limits: Limits;
  availableTools?: ReadonlySet<string>;
}): AsyncGenerator<BatchItem> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.context.signal, controller.signal]);
  const iterators = input.calls.map((call) =>
    streamTool(
      input.registry,
      call,
      {
        ...input.context,
        signal,
        toolCallId: call.id,
        state: input.calls.length > 1 ? readonlyState(input.context.state) : input.context.state,
        ...(input.resume?.id === call.id ? { resume: input.resume.data } : {}),
      },
      input.config,
      input.limits,
      input.availableTools,
    ),
  );
  type Settled =
    { index: number; next: IteratorResult<ToolChunk> } | { index: number; error: unknown };
  const pending = new Map<number, Promise<Settled>>();
  const pull = (index: number) =>
    pending.set(
      index,
      Promise.resolve()
        .then(() => iterators[index]!.next())
        .then(
          (next): Settled => ({ index, next }),
          (error): Settled => ({ index, error }),
        ),
    );
  try {
    checkAbort(signal);
    iterators.forEach((_, index) => pull(index));
    while (pending.size) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.index);
      const call = input.calls[settled.index]!;
      if ("error" in settled) {
        if (settled.error instanceof ToolInterrupt) yield { call, interrupt: settled.error };
        else throw settled.error;
      } else if (!settled.next.done) {
        checkAbort(input.context.signal);
        yield { call, chunk: settled.next.value };
        checkAbort(signal);
        pull(settled.index);
      }
    }
  } finally {
    controller.abort(new AgentError("cancelled", "Tool batch closed"));
    // 不等待不合作的业务实现；子执行器的 abortable 会结束等待并吸收迟到拒绝。
    for (const iterator of iterators)
      void Promise.resolve()
        .then(() => iterator.return(undefined))
        .catch(() => {});
  }
}
