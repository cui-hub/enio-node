import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { runV4Demo } from "../examples/subagents-v4.js";

it("V4 file task forks a skill, delegates a writer, and resumes fresh instances without redoing work", async () => {
  const demo = await runV4Demo(() => {});
  try {
    const report = await readFile(path.join(demo.root, "reports/summary.md"), "utf8");
    const source = await readFile(path.join(demo.root, "fixtures/metrics.md"), "utf8");
    expect(report).toContain(source);
    expect(report).toContain("来源：fixtures/metrics.md");
    expect(demo.result.runId).toBe(demo.first.runId);
    expect(demo.result.historyComplete).toBe(true);
    expect(demo.sourceReads).toBe(1);
    expect(demo.writes).toBe(1);
    expect(demo.result.todos).toEqual([]);
    const nested = demo.events.filter((event) => event.type === "agent_event");
    expect(new Set(nested.map((event) => event.payload.event.runId)).size).toBe(2);
    expect(nested.some((event) => event.payload.event.type === "run_resumed")).toBe(true);
  } finally {
    await rm(demo.root, { recursive: true, force: true });
  }
});
