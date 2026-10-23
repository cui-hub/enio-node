import { randomUUID } from "node:crypto";
import { AgentError, ToolError } from "../protocol/errors.js";
import type { ArtifactStore, CheckpointStore, Checkpoint } from "../protocol/types.js";
import { byteLength, checkAbort } from "../runtime/control.js";
import { validateCheckpoint } from "../runtime/state.js";
import { LocalFileStore } from "./local-filesystem.js";

const defaultMaxBytes = 16_777_216;
/** id 只能是内部 UUID，不能解释为相对路径或 URL。 */
function checkId(id: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    throw new AgentError("invalid_id", "Invalid storage id");
}
function checkSize(text: string, maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || byteLength(text) > maximum)
    throw new AgentError("storage_limit", "Stored content exceeds configured limit");
}

/** 内存实现用于测试；每个 store 实例拥有独立命名空间。 */
export function createMemoryArtifactStore(maxBytes = defaultMaxBytes): ArtifactStore {
  checkSize("", maxBytes);
  const values = new Map<string, string>();
  return {
    async write(content, signal) {
      checkAbort(signal);
      checkSize(content, maxBytes);
      const id = randomUUID();
      values.set(id, content);
      return { id, bytes: byteLength(content) };
    },
    async read(id, signal) {
      checkAbort(signal);
      checkId(id);
      const text = values.get(id);
      if (text === undefined)
        throw new ToolError("artifact_not_found", "Artifact not found", false);
      return text;
    },
  };
}

/** root 须预先创建；建议按租户/会话分目录，工厂不替业务做身份鉴权。 */
export function createFileArtifactStore({
  root,
  maxBytes = defaultMaxBytes,
}: {
  root: string;
  maxBytes?: number;
}): ArtifactStore {
  checkSize("", maxBytes);
  const files = new LocalFileStore(root, maxBytes);
  return {
    async write(content, signal) {
      checkSize(content, maxBytes);
      const id = randomUUID();
      await files.write(`${id}.txt`, content, false, signal);
      return { id, bytes: byteLength(content) };
    },
    async read(id, signal) {
      checkId(id);
      return files.read(`${id}.txt`, signal);
    },
  };
}

function bound(checkpoint: Checkpoint, binding: string): Checkpoint {
  const value = validateCheckpoint(checkpoint);
  if (value.binding !== binding)
    throw new AgentError("checkpoint_mismatch", "Checkpoint owner or agent configuration differs");
  return value;
}

/** 无 await 的检查与删除是本进程内的原子领取；跨进程使用持久化实现。 */
export function createMemoryCheckpointStore(maxBytes = defaultMaxBytes): CheckpointStore {
  checkSize("", maxBytes);
  const values = new Map<string, Checkpoint>();
  const issued = new Set<string>();
  return {
    async save(checkpoint, signal) {
      checkAbort(signal);
      const value = validateCheckpoint(checkpoint);
      checkSize(JSON.stringify(value), maxBytes);
      if (issued.has(value.id))
        throw new AgentError("checkpoint_exists", "Checkpoint already exists");
      issued.add(value.id);
      values.set(value.id, value);
    },
    async take(id, binding, signal) {
      checkAbort(signal);
      checkId(id);
      const value = values.get(id);
      if (!value)
        throw new AgentError("checkpoint_unavailable", "Checkpoint is missing or consumed");
      const result = bound(value, binding);
      values.delete(id);
      return result;
    },
  };
}

/**
 * .json 保存状态，.claimed 通过 O_EXCL 原子创建，防止两个进程重复执行。
 * 领取后即使崩溃也不自动解锁；宿主须核对副作用后决定如何补偿。
 * 文件保留便于诊断，生命周期/TTL 由宿主管理，不把检查点暴露给模型文件工具。
 */
export function createFileCheckpointStore({
  root,
  maxBytes = defaultMaxBytes,
}: {
  root: string;
  maxBytes?: number;
}): CheckpointStore {
  checkSize("", maxBytes);
  const files = new LocalFileStore(root, maxBytes);
  return {
    async save(checkpoint, signal) {
      const value = validateCheckpoint(checkpoint);
      const text = JSON.stringify(value);
      checkSize(text, maxBytes);
      await files.write(`${value.id}.json`, text, false, signal);
    },
    async take(id, binding, signal) {
      checkId(id);
      let value: Checkpoint;
      try {
        value = bound(JSON.parse(await files.read(`${id}.json`, signal)), binding);
      } catch (error) {
        if (error instanceof ToolError && error.code === "not_found")
          throw new AgentError("checkpoint_unavailable", "Checkpoint not found");
        throw error;
      }
      try {
        await files.write(`${id}.claimed`, "consumed", false, signal);
      } catch (error) {
        if (error instanceof ToolError && error.code === "already_exists")
          throw new AgentError("checkpoint_unavailable", "Checkpoint already consumed");
        throw error;
      }
      return value;
    },
  };
}
