import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgent,
  createFileTools,
  createFilesystemSkills,
  createLocalFilesystem,
  createOpenAICompatibleModel,
  createSkillTool,
  createTodoTool,
} from "../src/index.js";
import type { AgentEvent, RunResult } from "../src/index.js";
import { createFileReportModel } from "./file-report-model.js";

/** 文件演示总是在新的临时工作区运行，避免改写用户工程中的现有资料。 */
export async function runFileReport(
  options: { live?: boolean; onEvent?: (event: AgentEvent) => void } = {},
): Promise<{ root: string; report: string; result: RunResult }> {
  const base = path.dirname(fileURLToPath(import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), "enio-report-"));
  await cp(path.join(base, "fixtures"), path.join(root, "fixtures"), { recursive: true });
  const backend = createLocalFilesystem({
    root,
    readable: ["fixtures/**", "reports/**"],
    writable: ["reports/**"],
  });
  const skill = await createSkillTool({
    backend: createFilesystemSkills({ root: path.join(base, "skills") }),
  });
  let model = createFileReportModel();
  if (options.live) {
    const apiKey = process.env.ENIO_API_KEY;
    const name = process.env.ENIO_MODEL;
    if (!apiKey || !name) throw new Error("Live mode requires ENIO_API_KEY and ENIO_MODEL");
    model = createOpenAICompatibleModel({
      apiKey,
      model: name,
      baseURL: process.env.ENIO_BASE_URL,
      includeUsage: process.env.ENIO_INCLUDE_USAGE !== "false",
    });
  }
  const agent = createAgent({
    model,
    instructions:
      "先加载 report-summary Skill，再按要求生成报告。只操作允许的工作区目录，记录待办，写后回读核验。",
    tools: [...createFileTools({ backend }), createTodoTool(), skill],
    hooks: { onEvent: options.onEvent },
  });
  const result = await agent.run(
    {
      input:
        "读取 fixtures 下的资料，汇总版本、指标、风险与后续工作，保留来源路径，写入 reports/summary.md 并回读检查。",
    },
    { context: {} },
  );
  if (result.status !== "completed")
    throw new Error(`Report failed: ${result.stopReason}; workspace: ${root}`);
  const report = await readFile(path.join(root, "reports/summary.md"), "utf8");
  for (const fact of [
    "1.2.0",
    "1200",
    "98%",
    "fixtures/release.md",
    "fixtures/metrics.md",
    "fixtures/risks.md",
  ]) {
    if (!report.includes(fact)) throw new Error(`Report is missing required fact/source: ${fact}`);
  }
  return { root, report, result };
}

/** CLI 只展示工具进度和最终路径，不打印密钥、原始参数或完整文件内容。 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runFileReport({
      live: process.argv.includes("--live"),
      onEvent(event) {
        if (event.type === "tool_end")
          process.stdout.write(
            `${event.payload.name}: ${event.payload.result.ok ? "ok" : event.payload.result.code}\n`,
          );
      },
    });
    process.stdout.write(
      `${result.result.finalText}\n文件：${path.join(result.root, "reports/summary.md")}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Report failed"}\n`);
    process.exitCode = 1;
  }
}
