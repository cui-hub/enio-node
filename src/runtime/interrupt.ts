import type { InterruptRequest, JsonValue } from "../protocol/types.js";
import { assertJson } from "./state.js";

/** 在 beforeTool 返回，表示先保存状态并向宿主请求输入，不执行工具。 */
export function interrupt(info: JsonValue): InterruptRequest {
  assertJson(info);
  return { type: "interrupt", info: structuredClone(info) };
}

/** 仅执行器在调用工具之前抛出，工具执行中的普通异常不会被伪装成暂停。 */
export class ToolInterrupt extends Error {
  constructor(public readonly info: JsonValue) {
    super("Tool interrupted before execution");
  }
}
