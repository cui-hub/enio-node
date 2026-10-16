import { expect, it } from "vitest";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { runFileReport } from "../examples/file-report.js";

/** A13：断言真实磁盘产物与来源，不能只检查 Agent 返回 completed。 */
it("A13: produces and rereads a report from real fixture files", async () => {
  const { root, report, result } = await runFileReport();
  try {
    expect(result.status).toBe("completed");
    expect(result.historyComplete).toBe(true);
    expect(result.todos.every((todo) => todo.status === "completed")).toBe(true);
    expect(report).toContain("1200");
    expect(report).toContain("98%");
    expect(
      result.messages.some(
        (message) => message.role === "tool" && message.toolCallId === "verify-report",
      ),
    ).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["fixtures", "reports"]);
    expect(await readdir(path.join(root, "reports"))).toEqual(["summary.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
