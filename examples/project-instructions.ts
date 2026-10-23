import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgent, createFilesystemAgentsMd, createScriptedModel } from "../src/index.js";

/** 离线演示：真实读取 AGENTS.md 与引用文件，检查模型收到的临时消息及历史隔离。 */
const root = await mkdtemp(path.join(tmpdir(), "enio-project-instructions-"));
try {
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "AGENTS.md"), "本项目使用 pnpm。\n@docs/report-rules.md\n");
  await writeFile(path.join(root, "docs/report-rules.md"), "报告必须列出来源路径。\n");

  const agent = createAgent({
    instructions: "你是一个文件任务助手。",
    // root 是宿主选定的工作区。若要叠加子目录规则，在 files 中显式按顺序列出。
    agentsMd: createFilesystemAgentsMd({ root }),
    model: createScriptedModel(({ messages }) => {
      const instructions = messages.find((message) =>
        message.content.includes("Project instructions (AGENTS.md)"),
      );
      assert.equal(instructions?.role, "user");
      assert.ok(instructions.content.includes("本项目使用 pnpm"));
      assert.ok(instructions.content.includes("报告必须列出来源路径"));
      // ScriptedModel 只验证传输链路，不用于评估真实模型是否遵守指令。
      return {
        message: { role: "assistant", content: "已收到项目约定：使用 pnpm，报告列出来源路径。" },
        finishReason: "stop",
      };
    }),
  });
  const result = await agent.run({ input: "准备生成项目报告" }, { context: {} });
  assert.equal(result.status, "completed");
  assert.equal(
    result.messages.some(({ content }) => content.includes("Project instructions (AGENTS.md)")),
    false,
  );
  process.stdout.write(`${result.finalText}\n项目指令未写入返回的会话历史。\n`);
} finally {
  // 演示文件只用于验证读取能力，结束后清理，不影响真实工作区的 AGENTS.md。
  await rm(root, { recursive: true, force: true });
}
