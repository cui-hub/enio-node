import { expect, it } from "vitest";
import { runAgentRolesDemo } from "../examples/agent-roles.js";

it("runs the checked-in TOML example via both delegation routes, then writes through worker", async () => {
  const demo = await runAgentRolesDemo(() => {});
  expect(demo.result.status).toBe("completed");
  expect(demo.names).toEqual(["general-purpose", "explorer", "worker", "report-reviewer"]);
  expect(demo.rolesUsed).toEqual(["report-reviewer", "report-reviewer", "worker"]);
  expect(demo.report).toContain("来源：fixtures/metrics.md");
  expect(demo.report).toContain("99.9%");
});
