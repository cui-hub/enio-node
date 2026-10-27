# V2 检查点样本

`v2-checkpoint.json` 在 2026-10-27 使用未修改的 `v2` tag（`bbf305bfedd5a7b0c8570caf60ce86a5085ad5c8`）实际运行生成。

生成时从 Git 导出 V2 的 `src/` 与 `package.json` 到临时目录，复用锁定依赖。脚本模型请求 `work` 工具，`hooks.beforeTool` 返回 `interrupt("confirm legacy work")`，自定义 CheckpointStore.save 原样保存 JSON。namespace 为 `legacy-v2`，checkpointOwner 为演示字符串 `owner`，无配置 instructions；工具名称和描述均为 `work`、effect 为 read、inputSchema 为 `{type: "object"}`。

样本保留 V2 的字段与绑定哈希，不含 modelIndex、setupSignature、availableTools 或 maxToolStreamBytes。`tests/v3-failover.test.ts` 使用当前运行时恢复它，校验真实跨版本兼容性。UUID 和绑定哈希均为离线测试数据，不含身份凭证。不要用新版运行时重新生成此文件。
