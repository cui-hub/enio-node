import { ToolError } from "../protocol/errors.js";
import type { Todo, Tool } from "../protocol/types.js";
import { defineTool } from "../tools/registry.js";

/** 整表替换便于模型维护小型计划；写入当前 run 状态，可随显式快照或检查点延续。 */
export function createTodoTool<C = unknown>(): Tool<{ todos: Todo[] }, C> {
  return defineTool({
    name: "write_todos",
    description: "替换当前运行的待办列表；每项 id 唯一，状态为 pending/in_progress/completed。",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "content", "status"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 64 },
              content: { type: "string", minLength: 1, maxLength: 1000 },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
          },
        },
      },
    },
    async execute({ todos }, ctx) {
      if (new Set(todos.map((todo) => todo.id)).size !== todos.length)
        throw new ToolError("invalid_arguments", "Todo ids must be unique");
      ctx.state.todos = structuredClone(todos);
      return { ok: true, content: JSON.stringify({ todos: ctx.state.todos }) };
    },
  });
}
