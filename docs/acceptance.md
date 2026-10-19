# 一期验收记录

日期：2026-10-16。环境：macOS、Node.js 24.19.0、pnpm 12.11.2。原 Node.js v18.20.4 在每次构建／测试命令结束时通过 nvm 恢复；未改写 shell 启动配置。

## 已验证

格式检查、类型检查、55 项离线测试、ESM 构建、文件报告演示和业务工具演示均执行通过。冻结锁文件安装通过，构建后的 dist/index.js 已由 Node.js 直接导入并完成“模型→文件工具→最终回答”检查。默认测试集另有 1 项显式跳过的真实模型测试；它需要 ENIO_API_KEY、ENIO_MODEL 和可选网关地址。下表区分代码能力、确定性测试与外部环境验收。

| 验收项           | 测试位置                                                    | 当前覆盖                                                           |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| A01 循环与历史   | tests/runtime.test.ts                                       | 无工具／多轮／多工具、串行顺序、事件与 run 一致                    |
| A02 参数与错误   | tests/runtime.test.ts                                       | 未知工具、无效 JSON、Schema 类型／额外字段、业务错误回填           |
| A03 预算         | tests/runtime.test.ts                                       | 轮数终止、批次工具预算不足时无部分执行                             |
| A04 流解析       | tests/provider.test.ts、runtime.test.ts                     | 交错参数片段、缺失结束帧、重复编号、截断／异常结束                 |
| A05 取消／超时   | tests/runtime.test.ts                                       | 调用前取消、写工具中取消、模型／工具 deadline、定时器释放          |
| A06 重试         | tests/provider.test.ts、runtime.test.ts                     | 429／网络重试、不可重试错误、已输出后不重试、SDK 无叠加            |
| A07 状态隔离     | tests/runtime.test.ts                                       | 同一 Agent 并发运行不共享待办和历史                                |
| A08 文件范围     | tests/filesystem.test.ts                                    | 绝对路径／穿越／符号链接／敏感文件／写目录白名单                   |
| A09 文件冲突     | tests/filesystem.test.ts                                    | 默认不覆盖、旧 hash 拒绝、精确匹配、并发写仅一个成功               |
| A10 体积限制     | tests/filesystem.test.ts、runtime.test.ts、provider.test.ts | 二进制／大文件、遍历结果限量、UTF-8 截断、JSON 信封有效            |
| A11 inline Skill | tests/skills-process.test.ts                                | 元数据与正文分离、缺失 Skill、fork／agent／model 明确拒绝          |
| A12 事件消费     | tests/runtime.test.ts                                       | 提前关闭、模型清理、事件快照、观察回调故障隔离                     |
| A13 文件任务     | tests/demo.test.ts、tests/live.test.ts                      | 离线实际文件生成、事实与来源、回读、白名单产物通过；真实模型待配置 |
| A14 命令扩展     | tests/skills-process.test.ts                                | 默认不可用、参数字面量、环境限制、输出上限、超时和普通子进程组清理 |

内存与本地文件 backend 共用行为测试。模型协议测试通过真实 openai SDK 解析模拟 HTTP/SSE，不依赖外网，不把模拟结果当成真实模型效果评测。

## 尚未验证或明确不承诺

- 真实模型端点尚未配置，未执行 live 集成测试，也未产生模型调用费用。
- 本机验证为 macOS；Linux 的代码路径兼容设计尚需在目标环境运行同一测试集。Windows 进程扩展明确不支持。
- 未做多租户隔离、恶意并发文件系统攻击或脱离进程组的进程清理保证；本地 backend 不是沙箱。
- 未实现持久化恢复、审批、跨进程幂等、子 Agent、Graph、Workflow；这些都不属于一期代码。
- 未发布 npm 包或部署服务。依赖和构建产物按项目隔离；GitHub 源码仓库地址见 README。

## 复验

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run demo
corepack pnpm run demo:business
# 配置真实模型后显式执行：
corepack pnpm run test:live
```

新增工具须增加参数、错误、权限及取消行为测试；修改文件 backend 须通过共用契约；新增 provider 须验证流片段聚合、结束原因、错误分类和实际端点兼容性。
