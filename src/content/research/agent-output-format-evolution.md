---
title: Agent 输出格式的演进——从纯文本到富媒体到可执行
subtitle: 当 Agent Skill 开始用 HTML 回答问题，输出方式正在从纯文本变为结构化页面
slug: agent-output-format-evolution
type: research
category:
  - AI编程
  - Agent Skill
topics:
  - agent-systems
  - ai-coding
tags:
  - answer-me-with-html
  - agent-skill
  - html-output
  - leviathan
  - superpowers
  - live-panel-skill
  - mortiflix
  - rich-media
events: []
source: Dev Radar 2026-10-08
created: 2026-10-08
updated: 2026-10-08
status: evolving
confidence: high
featured: false
publish: true
radar:
  - dev
related:
  - leviathan-agent-deep-memory
  - superpowers-agent-dev-methodology
---

# Agent 输出格式的演进——从纯文本到富媒体到可执行

> **知识来源**：Dev Radar 2026-10-08
>
> **创建日期**：2026-10-08
>
> **最后更新**：2026-10-08

---

## TL;DR

- **它是什么**：AI Agent 的输出方式正在从纯文本 Markdown 向结构化 HTML、动画图解、视频演进，一批 Agent Skill 在 2026 年 10 月第一周集中爆发
- **为什么现在值得关注**：answer-me-with-html 6 天内获得 2219⭐，同期还有 4 个富媒体 Agent Skill 同时登上 GitHub Trending
- **核心变化**：模型只写 Markdown 草稿（612 Token），CLI 负责生成 HTML 页面——比模型手写 HTML 节约 8 倍 Token、2.6 倍速度
- **与现有方案最大的区别**：不是让模型"学会写 HTML"，而是把结构生成委托给确定性程序，模型专注于内容
- **对当前工作流的影响**：Agent 输出的可视化体验将显著提升，复杂架构和对比分析不再依赖文字墙
- **当前结论**：这不是单个热门仓库，而是一个品类的出现——Agent Skill 正在形成自己的包管理标准

---

## 研究定义

**研究对象**：AI Agent 输出格式从纯文本向结构化 HTML、动画图解、视频的演进趋势，以 2026 年 10 月第一周 GitHub Trending 中集中出现的富媒体 Agent Skill 为证据。

**研究范围**：answer-me-with-html（2219⭐）、live-panel-skill（654⭐）、mortiflix-oss（404⭐）、mesh-avatar-studio（461⭐）、mg-styles-15（415⭐）等项目的技术方案与 Token 经济学，以及它们与 Leviathan（Agent 记忆）和 Superpowers（Agent 方法论）共同构成的新 Agent I/O 架构。

**不包含**：通用 RAG 架构讨论、Agent 编排框架对比、各项目内部代码实现细节。

**核心问题**：

1. Agent 输出从文本向富媒体演进的驱动力是什么？
2. Skill 模式比模型原生 HTML 生成好在哪里？
3. 这批项目的集中出现是巧合还是趋势？
4. 它在整个 Agent 工具链中处于什么位置？
5. 对实际 AI Coding 工作流意味着什么？

---

## 一、纵向分析：Agent 输出格式的演进

### 1. 起源

AI Agent 的默认输出一直是纯文本 Markdown。对于简单问答，文本足够。但当用户问"Redis 还是 Memcached 做缓存"或"这个仓库的模块怎么组合"时，一堵文字墙并不比一页有图表的结构化页面更好读。

模型当然可以手写 HTML。但 answer-me-with-html 的作者做了一次 Token 审计，对 9 个页面统计了模型手写 HTML 的 Token 构成：

| 页面部分 | 占比 | 用 Skill 后 |
|---------|------|-----------|
| SVG 图表（坐标和路径） | 47% | CLI 生成 |
| CSS 样式 | 15% | CLI 生成 |
| HTML 标签 | 17% | CLI 生成 |
| 文本内容 | 21% | 模型写（Markdown） |

79% 的 Token 花在了结构而非内容上。

### 2. 诞生节点

2026-10-02，QingYunA 在 GitHub 创建 answer-me-with-html。核心思路：模型只负责写 Markdown 草稿（内容层），CLI 负责将草稿转换为一页完整的 HTML 页面（结构层+视觉层）。

同一周内，多个同类项目相继出现（见横向分析）。

### 3. 演进历程

- **2026-10-02**：answer-me-with-html 创建，支持 Claude Code 插件安装
- **2026-10-02~08**：6 天内获得 2219 stars，成为本周 GitHub 开发者工具类最热门项目
- **同期**：live-panel-skill（654⭐）、mesh-avatar-studio（461⭐）、mg-styles-15（415⭐）、mortiflix-oss（404⭐）集中出现在 Trending

关键变化：Agent 输出不再只是"模型生成文本"，而是"模型生成草稿 + CLI 生成结构"的分工模式。

### 4. 决策逻辑

- **已确认事实**：模型手写 HTML 平均 4893 Token，用 Skill 只需 612 Token——8 倍节约，2.6 倍速度提升
- **已确认事实**：Skill 通过 `npx skills add` 安装，支持 70+ Agent 运行时
- **合理推断**：Token 节约不只是成本问题——更少的输出 Token 意味着更快的响应、更低的错误率、更长的对话窗口
- **合理推断**：Skill 分发模式正在形成 Agent 时代的包管理标准

### 5. 当前阶段

**快速增长期**。6 天 2219 stars，同期 5 个同类项目同时爆发，说明需求被压抑已久，一旦有人提供了正确的方案，社区快速跟进。

---

## 二、横向分析：同期富媒体 Agent 工具

### 1. 格局判断

2026 年 10 月第一周的 GitHub Trending 中，多个富媒体 Agent 工具同期爆发，共享一个模式：Agent 输出超越文本。

### 2. answer-me-with-html（2219⭐）

- **核心定位**：用一页 HTML 回答复杂问题
- **技术路线**：模型写 Markdown 草稿 → CLI 生成 HTML 页面
- **核心能力**：8 倍 Token 节约、ASD-STE100 可读性、讲解视频（18 倍 Token 节约）、always-on 模式
- **目标用户**：Claude Code / Codex / Cursor / OpenCode / Pi 用户
- **开源模式**：Agent Skill 分发，CLI 打包在 Skill 内

### 3. live-panel-skill（654⭐）

- **核心定位**：JSON 驱动的动态架构图
- **技术路线**：一个 JSON 文件 → 动态终端风格图解或浅色信息图
- **核心能力**：输出 H.264 mp4 或实时网页，也是 Claude Code Skill
- **与研究对象的核心区别**：专注架构图场景，answer-me-with-html 更通用

### 4. mortiflix-oss（404⭐）

- **核心定位**：本地动态设计工作室
- **技术路线**：Claude 逐步制作视频，用户审批每个阶段
- **核心能力**：Bring your own Claude Code or API key
- **与研究对象的核心区别**：专注视频制作，answer-me-with-html 专注信息呈现

### 5. mesh-avatar-studio（461⭐）和 mg-styles-15（415⭐）

- **核心定位**：插画转 2D 动画网格 / 15 种动态设计风格
- **共同特征**：Claude Opus 5.5 写代码生成视觉内容
- **与研究对象的核心区别**：专注视觉创意，answer-me-with-html 专注信息传达

### 6. 对比总览

| 维度 | answer-me-with-html | live-panel-skill | mortiflix-oss |
|---|---|---|---|
| 核心定位 | HTML 信息页面 | 动态架构图 | 视频制作 |
| 技术路线 | Markdown→HTML CLI | JSON→动画渲染 | Claude 逐步生成 |
| Token 节约 | 8x | 未确认 | 未确认 |
| 适合场景 | 复杂问题可视化 | 架构文档 | 视频内容创作 |
| Skill 分发 | ✅ | ✅ | ✅ |

### 7. 生态位分析

answer-me-with-html 处在 Agent 输出层的通用信息呈现位置。它不替代任何现有工具——它填补的是"Agent 回答复杂问题时，输出格式不够好"的空白。

---

## 三、横纵交汇：位置与走向

### 当前位置

Agent 工具链正在形成三层结构：
- **方法论层**：Superpowers 定义"Agent 应该做什么"
- **记忆层**：Leviathan（666⭐，连续两天 Trending）定义"Agent 如何记住"——输入端索引检索
- **输出层**：answer-me-with-html 定义"Agent 如何呈现"——输出端 Token 压缩

三层独立发展，通过 Skill 协议组合。

### 关键变量

- **Skill 协议标准化**：`npx skills add` 是否成为 Agent 时代的 `npm install`
- **模型能力提升**：如果模型原生能高效生成 HTML，Skill 方案的价值会降低
- **Agent 运行时支持**：70+ 运行时支持是否持续扩大

### 未来走向

- **路径 A**：Skill 协议成为标准，富媒体输出成为 Agent 默认能力——需要 Skill 生态持续扩展
- **路径 B**：模型原生能力提升，直接高效生成 HTML——需要模型在 SVG/CSS 生成上有突破
- **路径 C**：富媒体输出被集成到 Agent 运行时本身——需要 Claude Code/Codex 等原生支持

### 机会

1. 立即在 AI Coding 工作流中测试 answer-me-with-html
2. 跟踪 live-panel-skill 用于代码库架构文档

### 风险

1. Skill 协议碎片化（多个竞争标准）
2. 模型原生能力快速提升导致 Skill 价值下降

### 哪些东西没有改变

模型仍然是内容生成的核心——Skill 只是把结构生成从模型中剥离出来。模型的推理能力、知识储备和上下文理解没有因此改变。

### 综合判断

这不是单个热门仓库，而是一个品类的出现。一周内 5 个富媒体 Agent Skill 同时登上 Trending，且都采用 Skill 协议分发。Agent 输出正在从"文本为默认"转向"富媒体为默认"。

---

## 四、与当前工作流的关系

### 当前相关性

直接相关。当前 AI Coding 工作流中，Agent 回答复杂架构问题时输出纯文本，可读性有限。

### 能解决什么

复杂问题（架构对比、模块关系、流程图解）的可视化输出。

### 不能解决什么

不解决 Agent 的推理能力或知识广度问题——只是输出格式优化。

### 引入成本

- 学习成本：低——安装后即用，无需改变提问方式
- 部署成本：低——`npx skills add` 或 `/plugin install`
- API 成本：降低约 15%（Token 节约）
- 工作流改造：无——安装后 Agent 自动使用

### 当前建议

**测试验证**——立即安装 answer-me-with-html，在当前 Claude Code 工作流中测试复杂问题的可视化输出效果。同时跟踪 live-panel-skill 的架构图能力。

---

## 五、Action Items

- [ ] 安装 answer-me-with-html 到 Claude Code，测试 TCP 握手等复杂问题的输出效果
- [ ] 观察 live-panel-skill 是否可用于代码库架构文档

---

## 六、后续观察

- Skill 协议（`npx skills add`）是否成为 Agent 时代标准
- 模型原生 HTML 生成能力是否显著提升
- Agent 运行时是否原生集成富媒体输出
- answer-me-with-html 是否从"信息页面"扩展到交互式应用

---

## 参考资源

### 一手资料

- [answer-me-with-html GitHub](https://github.com/QingYunA/answer-me-with-html)
- [live-panel-skill GitHub](https://github.com/ythx-101/live-panel-skill)
- [mortiflix-oss GitHub](https://github.com/GTKottman/mortiflix-oss)

### 补充资料

- [Leviathan 深度记忆研究](/research/leviathan-agent-deep-memory)
- [Superpowers 方法论框架](/research/superpowers-agent-dev-methodology)

---

## 更新记录

| 日期 | 变化 |
|---|---|
| 2026-10-08 | 初始创建，基于 Dev Radar 2026-10-08 数据 |

---

*本文件由 Horizon 自动研究流程生成，可持续补充和更新。*
