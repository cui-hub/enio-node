---
name: report-summary
description: 根据工作区资料生成带来源路径的简明报告
---

读取 fixtures 目录中的所有 Markdown 资料，汇总版本、指标、风险与后续工作。
不要编造资料中不存在的数字。每部分标明来源文件路径。
使用 write_todos 记录进度；把报告写入 reports/summary.md 后，使用 read_file 回读核验。
核验通过后将待办更新为 completed，并向用户说明报告相对路径。
此 Skill 只提供指令，不授予额外文件权限或命令执行权限。
