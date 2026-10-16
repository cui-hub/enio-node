import { createScriptedModel } from "../src/index.js";
import type { Message, ModelResponse, ToolCall } from "../src/index.js";

/** 固定数据驱动的演示模型，演示执行语义，不伪装成真实 LLM。 */
export function createFileReportModel() {
  const call = (id: string, name: string, args: unknown): ToolCall => ({
    id,
    name,
    arguments: JSON.stringify(args),
  });
  const response = (...toolCalls: ToolCall[]): ModelResponse => ({
    message: { role: "assistant", content: "", toolCalls },
    finishReason: "tool_calls",
  });
  const sourceFiles = ["release.md", "metrics.md", "risks.md"];
  /** 通过实际 read_file 结果生成报告，文件内容变化时产物也随之变化。 */
  const readResult = (messages: Message[], id: string): string => {
    const message = messages.find(
      (message) => message.role === "tool" && message.toolCallId === id,
    );
    if (!message) throw new Error(`Missing tool result ${id}`);
    const result = JSON.parse(message.content) as { ok: boolean; content: string };
    if (!result.ok) throw new Error(`Tool failed: ${id}`);
    return (JSON.parse(result.content) as { content: string }).content;
  };
  return createScriptedModel(({ messages }) => {
    const turn = messages.filter((message) => message.role === "assistant").length;
    switch (turn) {
      case 0:
        return response(
          call("skill-report", "skill", { skill: "report-summary" }),
          call("todo-start", "write_todos", {
            todos: [{ id: "report", content: "阅读资料并生成核验报告", status: "in_progress" }],
          }),
        );
      case 1:
        return response(call("find-files", "glob", { pattern: "fixtures/*.md" }));
      case 2:
        return response(
          ...sourceFiles.map((name, index) =>
            call(`read-${index}`, "read_file", { path: `fixtures/${name}` }),
          ),
        );
      case 3: {
        const content =
          "# 项目周报\n\n" +
          sourceFiles
            .map(
              (name, index) => `${readResult(messages, `read-${index}`)}\n来源：fixtures/${name}\n`,
            )
            .join("\n");
        return response(
          call("write-report", "write_file", { path: "reports/summary.md", content }),
        );
      }
      case 4:
        return response(call("verify-report", "read_file", { path: "reports/summary.md" }));
      case 5:
        if (!readResult(messages, "verify-report").includes("1200"))
          throw new Error("Report verification failed");
        return response(
          call("todo-finish", "write_todos", {
            todos: [{ id: "report", content: "阅读资料并生成核验报告", status: "completed" }],
          }),
        );
      default:
        return {
          message: { role: "assistant", content: "报告已生成并回读核验：reports/summary.md" },
          finishReason: "stop",
        };
    }
  });
}
