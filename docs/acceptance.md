# 验收记录

最近复验：2026-10-28（一期首次验收：2026-10-16）。环境：macOS、Node.js 24.19.0、pnpm 12.11.2。原 Node.js v18.20.4 在构建／测试命令结束后通过 nvm 恢复；未改写 shell 启动配置。

## 已验证

格式检查、类型检查、191 项离线测试、ESM 构建、六个离线示例和构建后子 Agent 执行／状态序列化检查均执行通过，无依赖变更。V3 的 156 项测试全部保留，V4 新增 35 项子任务、Skill fork、预置装配和兼容性测试。冻结锁文件安装及构建后“模型→文件工具→最终回答”检查已在一期首次验收通过。默认测试集另有 1 项显式跳过的真实模型测试；它需要 ENIO_API_KEY、ENIO_MODEL 和可选网关地址。下表区分代码能力、确定性测试与外部环境验收。

| 验收项           | 测试位置                                                    | 当前覆盖                                                                                                               |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A01 循环与历史   | tests/runtime.test.ts                                       | 无工具／多轮／多工具、串行顺序、事件与 run 一致                                                                        |
| A02 参数与错误   | tests/runtime.test.ts                                       | 未知工具、无效 JSON、Schema 类型／额外字段、业务错误回填                                                               |
| A03 预算         | tests/runtime.test.ts                                       | 轮数终止、批次工具预算不足时无部分执行                                                                                 |
| A04 流解析       | tests/provider.test.ts、runtime.test.ts                     | 交错参数片段、缺失结束帧、重复编号、截断／异常结束                                                                     |
| A05 取消／超时   | tests/runtime.test.ts                                       | 调用前取消、写工具中取消、模型／工具 deadline、定时器释放                                                              |
| A06 重试         | tests/provider.test.ts、runtime.test.ts                     | 429／网络重试、不可重试错误、已输出后不重试、SDK 无叠加                                                                |
| A07 状态隔离     | tests/runtime.test.ts                                       | 同一 Agent 并发运行不共享待办和历史                                                                                    |
| A08 文件范围     | tests/filesystem.test.ts                                    | 绝对路径／穿越／符号链接／敏感文件／写目录白名单                                                                       |
| A09 文件冲突     | tests/filesystem.test.ts                                    | 默认不覆盖、旧 hash 拒绝、精确匹配、并发写仅一个成功                                                                   |
| A10 体积限制     | tests/filesystem.test.ts、runtime.test.ts、provider.test.ts | 二进制／大文件、遍历结果限量、UTF-8 截断、JSON 信封有效                                                                |
| A11 inline Skill | tests/skills-process.test.ts                                | 元数据与正文分离、缺失 Skill、未配置 fork 注册表及 inline agent/model 覆盖拒绝                                         |
| A12 事件消费     | tests/runtime.test.ts                                       | 提前关闭、模型清理、事件快照、观察回调故障隔离                                                                         |
| A13 文件任务     | tests/demo.test.ts、tests/live.test.ts                      | 离线实际文件生成、事实与来源、回读、白名单产物通过；真实模型待配置                                                     |
| A14 命令扩展     | tests/skills-process.test.ts                                | 默认不可用、参数字面量、环境限制、输出上限、超时和普通子进程组清理                                                     |
| A15 项目指令     | tests/agents-md.test.ts                                     | 本地读取、递归引用／去重／循环／深度限制、字节／文件数限制、路径与符号链接、缓存刷新、历史隔离、并发取消、超时与流消费 |

内存与本地文件 backend 共用行为测试。模型协议测试通过真实 openai SDK 解析模拟 HTTP/SSE，不依赖外网，不把模拟结果当成真实模型效果评测。

| 新增验收项     | 测试位置              | 覆盖                                                                                       |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| C01 摘要       | tests/context.test.ts | 硬输入限制前压缩、系统指令、完整工具批次、重试与备用模型、usage、超时、非法摘要与 finalize |
| C02 结果外置   | tests/context.test.ts | 截断前保存全文、较早批次参数/结果外置、最新批次保留、Unicode 分页、存储错误                |
| C03 状态导出   | tests/context.test.ts | 快照隔离、序列化/解析、跨轮使用压缩历史、调用 ID 去重、afterAgent 保存失败                 |
| R01 恢复       | tests/resume.test.ts  | 新 Agent/文件 store 实例恢复、已完成工具不重放、Todo/指令/预算/序号保留、连续中断          |
| R02 权限与竞争 | tests/resume.test.ts  | 错误身份/配置不可领取、恢复重校验权限、拒绝执行、两个 store 实例并发一次领取               |
| R03 失败边界   | tests/resume.test.ts  | 检查点保存失败、取消、未知副作用不生成可重放检查点、外置引用保留                           |

## V3 验收

| 验收项        | 测试位置                                                     | 覆盖                                                                                                                           |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| V301 中间件   | tests/v3-middleware.test.ts                                  | 生命周期与包装顺序、每次运行装配隔离、工具筛选与恢复可见范围、请求预算、Schema 防篡改、权限优先、单次 next、缓存、流文本一致性 |
| V302 工具流   | tests/v3-tools.test.ts                                       | 实时进度不写历史、执行入口只调用一次、非法或缺失最终片段、ToolError 回填、进度预算、取消和超时                                 |
| V303 受控并发 | tests/v3-tools.test.ts                                       | 最大并发数、写入屏障、默认串行、只读状态约束、并发中断后不重放完成调用、致命失败取消同批调用                                   |
| V304 直接返回 | tests/v3-tools.test.ts                                       | 完整批次配对、失败回填、多个直接返回拒绝、跨中断保留结果、新对话不复用旧结果                                                   |
| V305 模型切换 | tests/v3-failover.test.ts                                    | 重试后切换、候选耗尽、策略覆盖、已展示文本禁止切换、协议错误／deadline、运行隔离、检查点保留候选                               |
| V306 进程流   | tests/v3-process.test.ts                                     | 进程未退出即收到 stdout、stderr 与最终结果、UTF-8 跨片段／预算截断、消费提前结束清理实际进程                                   |
| V307 V2 兼容  | tests/v3-failover.test.ts、tests/fixtures/v2-checkpoint.json | 从未修改的 v2 标签实际生成旧检查点，V3 使用原绑定恢复，无新增字段也能补齐默认预算                                              |

`demo:v3` 使用两份真实仓库资料，展示中间件、失败切换、并发进度和直接交付。四个原有示例继续通过，覆盖文件报告、业务工具、项目指令，以及摘要／外置／中断恢复。`check` 脚本内部统一调用 Corepack，避免嵌套命令意外使用系统全局的旧 pnpm。

## V4 验收

V4 的具体行为验收如下，使用离线脚本模型与真实临时文件，不把确定性流程验收当作真实模型效果评测。

| 验收项         | 测试位置                       | 覆盖                                                                                                         |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| V401 隔离/事件 | tests/v4-subagents.test.ts     | 消息/todos 隔离、完整父历史继承、身份上下文、扁平路径、子直接返回、父子独立权限                              |
| V402 中断/用量 | tests/v4-subagents.test.ts     | 三层新实例与文件存储恢复、连续中断、不重复写入、owner 绑定、缺失子检查点、全树 usage 差额                    |
| V403 控制边界  | tests/v4-subagents.test.ts     | 消费提前结束、超时、子致命错误、深度/调用预算、输出预算、无终止事件、已完成子任务后的包装器错误、配置快照    |
| V404 Skill     | tests/v4-skills-deep.test.ts   | fork 与 fork_with_context、文件发现、Agent/模型白名单、无隐式脚本权限、原正文恢复、路由变化拒绝、混合 inline |
| V405 预置层    | tests/v4-skills-deep.test.ts   | 默认工具、显式文件/进程 backend、专用子任务、默认子任务恢复、关闭默认项、基础委派工具过滤                    |
| V406 文件任务  | tests/v4-demo.test.ts          | 真实文件从 Skill 分析到 writer 子任务、确认暂停、新实例恢复、报告回读、父子 todos 隔离                       |
| V407 V3 兼容   | tests/v4-compatibility.test.ts | 未修改 v3 标签实际生成的检查点，保留原 binding/setupSignature 直接恢复                                       |

`demo:v4` 已验证资料读取 1 次、报告写入 1 次，展示 reviewer/writer 的独立事件和 writer 恢复事件。构建后直接从 `dist/index.js` 导入 AgentTool、TaskTool 和 DeepAgent，完成子运行和状态 JSON 往返。

## 尚未验证或明确不承诺

- 真实模型端点尚未配置，未执行 live 集成测试，也未产生模型调用费用。
- 本机验证为 macOS；Linux 的代码路径兼容设计尚需在目标环境运行同一测试集。Windows 进程扩展明确不支持。
- 未做多租户隔离、恶意并发文件系统攻击或脱离进程组的进程清理保证；本地 backend 不是沙箱。
- 已实现工具执行前及子 Agent 调用链上的持久化中断恢复；未实现任意工具内部暂停、运行中崩溃自动续跑、业务审批系统、exactly-once、Graph、Workflow。文件领取使用 OS 排他创建；测试覆盖不同 store 实例竞争，未进行断电与磁盘故障注入。嵌套检查点逐层保存/领取，不提供跨 store 事务，孤立检查点的清理由宿主管理。
- 未发布 npm 包或部署服务。依赖和构建产物按项目隔离；GitHub 源码仓库地址见 README。

## 复验

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run demo
corepack pnpm run demo:business
corepack pnpm run demo:instructions
corepack pnpm run demo:context
corepack pnpm run demo:v3
corepack pnpm run demo:v4
# 配置真实模型后显式执行：
corepack pnpm run test:live
```

新增工具须增加参数、错误、权限及取消行为测试；修改文件 backend 须通过共用契约；新增 provider 须验证流片段聚合、结束原因、错误分类和实际端点兼容性。
