---
name: source-review
description: 读取指标资料，形成带来源的报告正文
context: fork
agent: reviewer
---

读取 fixtures/metrics.md，保留事实和来源相对路径，输出 Markdown 报告正文。
仅分析资料，不写文件；由父 Agent 将正文交给 writer 子任务保存和回读验证。
