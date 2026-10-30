# 跨版本检查点样本

## V2

`v2-checkpoint.json` 在 2026-10-27 使用未修改的 `v2` tag（`bbf305bfedd5a7b0c8570caf60ce86a5085ad5c8`）实际运行生成。

生成时从 Git 导出 V2 的 `src/` 与 `package.json` 到临时目录，复用锁定依赖。脚本模型请求 `work` 工具，`hooks.beforeTool` 返回 `interrupt("confirm legacy work")`，自定义 CheckpointStore.save 原样保存 JSON。namespace 为 `legacy-v2`，checkpointOwner 为演示字符串 `owner`，无配置 instructions；工具名称和描述均为 `work`、effect 为 read、inputSchema 为 `{type: "object"}`。

样本保留 V2 的字段与绑定哈希，不含 modelIndex、setupSignature、availableTools 或 maxToolStreamBytes。`tests/v3-failover.test.ts` 使用当前运行时恢复它，校验真实跨版本兼容性。UUID 和绑定哈希均为离线测试数据，不含身份凭证。不要用新版运行时重新生成此文件。

## V3

`v3-checkpoint.json` 在 2026-10-28 使用未修改的 `v3` tag（`35a99768b01d0a98c6fd090609cdc8ea7965d1cb`）实际运行生成。生成方式同 V2：临时导出原标签源码，复用固定依赖；未修改原绑定或装配签名。

namespace 为 `legacy-v3`、checkpointOwner 为 `owner`、instructions 为 `V3 instructions`。工具 `work` 名称和描述均为 `work`、effect 为 read、parallelSafe 为 true、Schema 为 `{type: "object"}`；并发数为 2，中间件 `legacy-v3-trace` 的 beforeAgent 原样返回 setup。模型请求 `legacy-work` 调用，beforeTool 返回 `interrupt("confirm legacy work")`。

样本包含 V3 的 modelIndex、setupSignature、availableTools，不含 V4 的 delegation、continuations、childUsage。`tests/v4-compatibility.test.ts` 验证新版能直接恢复。此样本也只能从对应旧标签生成。
