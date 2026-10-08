# 项目概览

[返回项目入口](../README.md) · [下一章：架构](02-architecture.md)

## 目标与范围

Horizon Radar 将分散的技术信息整理为五类日报、重点信号、行动建议和长期知识归档。阅读者可以从 verdict 开始，再查看 highlights 和原始来源。行动建议用于辅助决策，不表示系统有权自动安装、购买或处置。

系统主要运行在个人 Mac，使用 OpenClaw 完成任务与分析，使用 GitHub Actions 和 GitHub Pages 展示公开内容。现有日报运行不以新增云基础设施为前提。

## 三条工作线

1. **日常运行**：采集、分析、Markdown 日报、Legacy Publisher、Pages。
2. **V2 情报质量**：版本化 Contract、事件与观察身份、Registry、Score 和跨雷达关联。
3. **治理授权**：策略冻结、运行授权、资格验证、历史承诺与防回滚。

某模块通过测试或某网页已经上线，只证明相应范围内的结果，不能替代其他工作线的验收。

## 仓库职责

| 组件 | 维护范围 |
| --- | --- |
| `muhnchiu.github.io` | Astro 页面、公开 Markdown、网站 Schema、消费者和部署工作流；本套跨仓库手册的主入口 |
| `script-manager` | 五套 Collector、脚本维护与 Legacy Publisher |
| `horizon-contracts` | 版本化数据契约、Normalizer 与兼容验证 |
| `horizon-policies` | 冻结策略的版本化分发 |
| 本地运行环境 | 调度、原始材料、分析日志、私有 Registry 和授权证据 |

独立仓库地址由 `.gitmodules` 核对。脚本仓库的远端和本地运行位置由维护者管理，不在公开手册中记录私有配置。

## 演进背景

系统从单类采集脚本发展到 AI、DEV、SKILL、APP、SEC 五套雷达，随后加入契约、验证、身份、台账、评分和发布治理。复杂度来自信息可信、跨天去重、可追溯与授权边界等要求。

历史材料有不同阶段编号体系。定位具体工作时应使用完整任务名、策略版本和验证工件，不仅依赖一个 Phase 数字。

## 术语

| 名称 | 含义 |
| --- | --- |
| Collector | 访问公开来源并保存材料的采集器 |
| Frontmatter | Markdown 顶部的结构化元数据 |
| Normalizer / Validator | 格式归一化 / 契约与规则校验 |
| Event / Observation | 持续可识别的事件 / 某来源与雷达对事件的观察 |
| Registry | 私有身份记录与状态台账 |
| material change | 冻结规则认定的实质变化 |
| Shadow / Canary | 有范围限制、隔离副作用的验证运行 |
| Trusted Head | 为历史承诺提供可信高水位与防回滚约束的权威机制 |

## 文档依据

本套文档整理自《Horizon Radar 完整使用与架构手册》，版本 1.0，日期 2026-10-08，并核对本仓库 README、package scripts、内容 Schema、部署工作流和契约基线。Word 原档保留为长期档案，不复制进公开仓库。

手册中的 OpenClaw 修复和上线叙述属于历史报告摘要；本文不将其冒充新完成的实时验收。规范冲突时以对应冻结 artifact 和显式版本上下文为准，文档不能修改冻结定义。
