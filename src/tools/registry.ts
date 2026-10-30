import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { AgentError, ToolError } from "../protocol/errors.js";
import type { JsonSchema, Tool, ToolDefinition } from "../protocol/types.js";

/** 工具只接受可移植的 Schema 子集；拒绝 $ref、format 和任意正则扩展。 */
const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "description",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

/** 递归检查 Schema 本身，参数中的 properties 名称不作为关键字解析。 */
function checkSchema(schema: JsonSchema, depth = 0): void {
  if (depth > 12 || !schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new AgentError("invalid_config", "Invalid or excessively nested tool schema");
  }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key))
      throw new AgentError("invalid_config", `Unsupported schema keyword: ${key}`);
  }
  if (schema.properties) {
    if (typeof schema.properties !== "object" || Array.isArray(schema.properties))
      throw new AgentError("invalid_config", "Invalid properties");
    for (const child of Object.values(schema.properties))
      checkSchema(child as JsonSchema, depth + 1);
  }
  if (schema.items) checkSchema(schema.items as JsonSchema, depth + 1);
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    throw new AgentError("invalid_config", "additionalProperties must be boolean");
  }
}

/** 泛型用于作者侧约束参数；真正运行仍经 Registry 的 JSON Schema 验证。 */
export function defineTool<A, C = unknown>(tool: Tool<A, C>): Tool<A, C> {
  return tool;
}

/** 注册时复制元数据，禁止运行中通过修改原始 Schema 改变验证规则。 */
export class ToolRegistry<C> {
  private readonly entries = new Map<
    string,
    { tool: Tool<unknown, C>; validate: ValidateFunction }
  >();

  constructor(tools: Tool<unknown, C>[]) {
    const ajv = new Ajv2020({
      strict: true,
      allErrors: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    for (const original of tools) {
      if (
        typeof original.name !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(original.name) ||
        this.entries.has(original.name)
      ) {
        throw new AgentError("invalid_config", `Invalid or duplicate tool name: ${original.name}`);
      }
      if (
        typeof original.description !== "string" ||
        !original.description ||
        typeof original.execute !== "function" ||
        !["read", "write", "execute"].includes(original.effect) ||
        (original.stream !== undefined && typeof original.stream !== "function") ||
        (original.parallelSafe !== undefined && typeof original.parallelSafe !== "boolean") ||
        (original.parallelSafe === true && original.effect !== "read") ||
        (original.returnDirect !== undefined && typeof original.returnDirect !== "boolean") ||
        (original.delegates !== undefined && typeof original.delegates !== "boolean") ||
        (original.delegates && original.parallelSafe)
      ) {
        throw new AgentError("invalid_config", `Invalid tool definition: ${original.name}`);
      }
      const inputSchema = structuredClone(original.inputSchema);
      checkSchema(inputSchema);
      if (inputSchema.type !== "object")
        throw new AgentError("invalid_config", "Tool schema root must be object");
      try {
        this.entries.set(original.name, {
          tool: {
            ...original,
            inputSchema,
            execute: original.execute.bind(original),
            ...(original.stream ? { stream: original.stream.bind(original) } : {}),
          },
          validate: ajv.compile(inputSchema),
        });
      } catch {
        throw new AgentError("invalid_config", `Cannot compile tool schema: ${original.name}`);
      }
    }
  }

  /** 返回深拷贝，provider 修改请求不会改变下一轮注册表。 */
  definitions(): ToolDefinition[] {
    return structuredClone(
      [...this.entries.values()].map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    );
  }

  /** 每个 run 的装配副本；保留已绑定的函数，同时隔离可变 Schema。 */
  tools(): Tool<unknown, C>[] {
    return [...this.entries.values()].map(({ tool }) => ({
      ...tool,
      inputSchema: structuredClone(tool.inputSchema),
    }));
  }

  /** 调度元数据不暴露执行函数；未知工具仍由 prepare 生成可回填错误。 */
  behavior(name: string): { parallelSafe: boolean; returnDirect: boolean; delegates: boolean } {
    const tool = this.entries.get(name)?.tool;
    return {
      parallelSafe: tool?.parallelSafe === true,
      returnDirect: tool?.returnDirect === true,
      delegates: tool?.delegates === true,
    };
  }

  /** 模型可见集合可以收窄，但不能伪造未注册工具或改变其参数契约。 */
  validateDefinitions(definitions: ToolDefinition[]): void {
    if (!Array.isArray(definitions))
      throw new AgentError("invalid_middleware", "Tools must be an array");
    const names = new Set<string>();
    for (const definition of definitions) {
      const original = this.entries.get(definition?.name)?.tool;
      if (
        !original ||
        names.has(definition.name) ||
        JSON.stringify(original.inputSchema) !== JSON.stringify(definition.inputSchema) ||
        typeof definition.description !== "string"
      )
        throw new AgentError(
          "invalid_middleware",
          "Middleware must select registered tool schemas",
        );
      names.add(definition.name);
    }
  }

  /** 参数错误属于模型可修正错误；不执行函数、不隐式强制转换字段类型。 */
  prepare(name: string, argumentsJson: string): { tool: Tool<unknown, C>; args: unknown } {
    const entry = this.entries.get(name);
    if (!entry) throw new ToolError("unknown_tool", `Tool is not registered: ${name}`);
    let args: unknown;
    try {
      args = JSON.parse(argumentsJson);
    } catch {
      throw new ToolError("invalid_json", "Tool arguments must be complete JSON");
    }
    if (!entry.validate(args)) {
      throw new ToolError(
        "invalid_arguments",
        `Arguments do not match schema: ${entry.validate.errors?.[0]?.instancePath || "/"} ${entry.validate.errors?.[0]?.keyword ?? "invalid"}`,
      );
    }
    return { tool: entry.tool, args };
  }
}
