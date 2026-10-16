import { expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { runFileReport } from "../examples/file-report.js";

/** 真实调用会产生模型费用；只在显式运行 test:live 且宿主提供配置时执行。 */
it.skipIf(process.env.ENIO_LIVE_TEST !== "1")(
  "A13 live: verifies configured model against the file task",
  async () => {
    const { root, result } = await runFileReport({ live: true });
    try {
      expect(result.status).toBe("completed");
      expect(result.historyComplete).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  150_000,
);
