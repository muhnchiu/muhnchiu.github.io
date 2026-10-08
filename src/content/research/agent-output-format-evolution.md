---
title: "Agent 输出格式的演进：从文本到富媒体到可执行"
subtitle: "当 Agent Skill 开始用 HTML 回答问题，输出方式正在从纯文本变为结构化页面"
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

# Agent 输出格式的演进：从文本到富媒体到可执行

> 2026 年 10 月第一周，GitHub Trending 上集中出现了一批不约而同解决同一个问题的项目：让 Agent 的输出不再只是一段纯文本。

## 一、研究定义

本文聚焦 2026-10-02 至 2026-10-08 期间 GitHub Trending 上涌现的一组项目，它们共同指向一个趋势：**Agent 输出格式正在从纯文本 Markdown 演进为结构化 HTML 页面、动画图表乃至视频**。我们将这一演进分为三个阶段——文本输出、富媒体输出、可执行输出——并分析其技术驱动力和生态含义。

研究范围限定于 Agent 输出环节，不涉及通用 RAG 讨论或 Agent 编排框架本身。

## 二、背景与问题

当前几乎所有 AI Agent 的默认输出方式是纯文本 Markdown。对于"写一个函数""解释一段代码"这类线性问题，文本回答足够清晰。但面对以下场景时，纯文本的结构性缺陷暴露无遗：

- **架构对比**：需要在两种方案之间并列展示优劣势、依赖关系和迁移路径。
- **流程说明**：需要表达时序、分支、并行和状态流转。
- **数据可视化**：需要图表、热力图、拓扑结构。

大模型并非不能写 HTML。问题在于，当模型被要求"直接输出完整 HTML 页面"时，它会将大量 token 花费在非内容性的结构代码上。一项对模型原生 HTML 输出的 token 分析显示如下分布：

| Token 类别 | 占比 |
|---|---|
| SVG 路径与属性 | 47% |
| CSS 样式定义 | 15% |
| HTML 标签结构 | 17% |
| 实际文本内容 | 21% |

**79% 的 token 消耗在结构代码上，只有 21% 是真正的信息内容。** 这意味着模型每回答一个复杂问题，有近四分之三的算力浪费在"画框"而非"写字"上。这不仅仅是成本问题——更慢的生成速度、更长的上下文窗口占用、更低的用户信息获取效率，都是这一模式的连锁代价。当 Agent 被嵌入到持续对话场景中时，每次追问都触发一轮完整的结构代码生成，token 浪费随对话轮次线性放大。一个十轮的架构讨论，意味着模型十次重复生成几乎相同的 SVG 路径和 CSS 规则——而这些代码在语义层面对对话毫无增量。

## 三、核心发现：answer-me-with-html

2026 年 10 月 2 日，仓库 `answer-me-with-html` 在 GitHub 上创建。六天内获得 **2219 stars**，增速远超同期同类型的工具项目。

它的做法简单但关键：

1. **模型只写 Markdown 草稿**（约 612 tokens），专注于内容本身。
2. **CLI 工具将草稿渲染为完整 HTML 页面**（等价于约 4893 tokens 的手写 HTML）。
3. 页面包含内联 SVG 图表、CSS 样式、响应式布局——全部由 CLI 生成，不需要模型操心。

效果是显著的：**token 消耗降低 8 倍，生成速度提升 2.6 倍**。模型只负责思考和写作，结构化展示交给确定性代码完成。这意味着同一预算下，Agent 可以回答更多更复杂的问题，而非把算力浪费在画框上。

该工具的几个设计细节值得注意：

- **ASD-STE100 简化技术英语**：页面文本遵循航空维修文档的简化英语标准，确保非母语用户也能快速理解。这不是花哨的文案，而是工程化的可读性。
- **跨运行时兼容**：已在 Claude Code、Codex、Cursor、OpenCode、Pi 五种 Agent 运行时中验证可用。
- **视频生成**：除了 HTML 页面，同一套 Markdown 草稿可以驱动生成解释视频，相比模型手写视频脚本，token 消耗降低 18 倍。
- **Always-on 模式**：页面不是一次性的快照，而是随对话持续更新——用户追问后页面自动刷新内容。

**核心判断**：answer-me-with-html 不是"又一个 HTML 模板"，它是一种让 Agent 以最小 token 成本输出最大信息密度答案的输出协议。

## 四、趋势串联：同期出现的富媒体 Agent 工具

answer-me-with-html 并非孤立现象。在 2026-10-02 至 10-08 的同一周 GitHub Trending 中，至少有四个项目指向同一方向：

- **live-panel-skill**（654 stars）：从 JSON 配置直接生成动画架构图。用户描述组件和关系，Agent 输出可交互的动画拓扑图，而非 ASCII 框线。
- **mortiflix-oss**（404 stars）：Claude 逐步制作视频，用户在每个阶段审核确认。本质上是将 Agent 的视频输出从"一锤子买卖"变为"可协作的渐进式制作"。
- **mesh-avatar-studio**（461 stars）：将静态插画转换为带骨骼绑定的 2D 网格动画头像。Agent 可以为文档或演示生成动态角色。
- **mg-styles-15**（415 stars）：由 Claude Opus 5.5 制作的 15 种动态设计风格模板，Agent 输出时选择风格即可套用。

这五个项目在同一周集中出现，指向一个清晰的信号：**Agent 输出正在集体突破文本边界**。它们的共同模式是——模型负责内容决策，确定性代码负责渲染实现。值得注意的是，这些项目覆盖了输出格式的多个层次：静态页面（answer-me-with-html）、动画图表（live-panel-skill）、可控视频制作（mortiflix-oss）、动画角色（mesh-avatar-studio）和风格模板（mg-styles-15）。从静态到动态，从单一到多样，富媒体输出的覆盖面正在快速扩展。

## 五、与 Agent 记忆的关联

`Leviathan`（666 stars，连续两天 Trending）解决的是 Agent I/O 的**输入端**：通过索引化检索，让 Agent 在常量上下文窗口内查询超大规模数据集。它让 Agent"读得多"。

`answer-me-with-html` 解决的是**输出端**：让 Agent 以最少 token 产出最高信息密度的结构化回答。它让 Agent"说得好"。

两者合在一起，勾勒出一个新的 Agent I/O 架构轮廓：

> **索引化检索输入 + 富媒体结构化输出 = 常量窗口下的高带宽 Agent**

这个架构的意义在于：它不依赖模型上下文窗口的无限扩张。即使在 128K 或 200K 窗口限制下，通过输入端索引检索（Leviathan 路线）和输出端结构化渲染（answer-me-with-html 路线），Agent 依然能处理大规模数据并输出高密度信息。

## 六、与 Agent 方法论的关联

`Superpowers`（发布于 2026-10-04）定义了一种跨 16 种 Agent 运行时可组合的 Skill 方法论。它回答的问题是：Agent 的能力如何被封装、分发和组合。

answer-me-with-html 本身就是一个 Agent Skill，而非独立应用。它不需要 npm install，不需要独立部署——它被安装为一个 Skill，在 Agent 会话中被调用。这体现了 Superpowers 所定义的生态模式：

- **记忆层**（Leviathan）：解决"知道什么"
- **输出层**（answer-me-with-html）：解决"怎么说"
- **方法论层**（Superpowers）：解决"能力如何组织和分发"

三层正在同一周内快速成型，这不是巧合——Agent 生态正在从"能用的工具堆"演进为"有结构的系统"。

## 七、技术分析

### 为什么 Skill 模式优于模型原生 HTML 生成？

模型原生生成 HTML 的问题在于——模型在生成 SVG 路径坐标和 CSS 属性时，不仅消耗 token，还容易出错。一个坐标偏移、一个闭合标签遗漏，整张图就崩了。而 Skill 模式将这一步交给确定性 CLI 程序：

- 模型写内容（21% token），CLI 写结构（79% token）
- CLI 输出是确定性的，不存在"画歪了"的问题
- 模型上下文窗口不被结构代码占满，可以用来思考更深的问题

### Token 经济学

以一个典型的架构对比问题为例：

| 方式 | 模型 token | 等价 HTML token | 总成本 |
|---|---|---|---|
| 模型手写 HTML | ~4893 | — | 4893 |
| answer-me-with-html | ~612 | 4893（CLI 生成） | 612 |

CLI 生成的部分不消耗模型 token，不计入 API 费用。这就是 8 倍降本的来源。

### 内聚 CLI，无需 npm install

answer-me-with-html 的 CLI 工具打包在 Skill 内部。安装 Skill 即获得渲染能力，不依赖项目已装的 npm 包。这降低了使用门槛——尤其对于非前端开发者，不需要理解 `vite build` 或 `webpack` 配置。

### Always-on 更新

页面不是一次性快照。当用户在 Agent 会话中追问或补充信息后，CLI 重新渲染页面，内容实时更新。这使 HTML 输出从"静态报告"升级为"动态文档"，更接近一个可交互的仪表盘而非一张截图。

## 八、判断与建议

### 这不是一个热门仓库，是一个品类 emergence

一周内出现 5 个方向一致的项目，stars 总和超过 4000——这不是某个开发者的偶然灵感，而是一个品类的集中爆发。Agent 输出格式的升级正在从"可能性"变为"默认期望"。

### Agent Skill 作为分发模式

answer-me-with-html 的分发方式值得注意：它不是 npm 包，不是 SaaS 服务，而是一个 Agent Skill。这意味着它的安装受众直接是 Agent 运行时（Claude Code、Cursor 等），而非人类开发者。**Skill 正在成为 Agent 生态的原生分发单元**，就像 npm 是 Node 生态的分发单元一样。

### 富媒体输出将从"新颖"变为"预期"

当用户发现 Agent 可以输出带动画的架构图、可交互的对比表格和解释视频后，纯文本回答将逐渐被视为"低配"。这不是审美问题——信息密度的差距是客观的：一张拓扑图的传递效率远超十段文字描述。

### 建议

1. **立即测试 answer-me-with-html**：在当前的 Agent 工作流中安装并评估其在架构说明、方案对比等场景下的效果。门槛极低——安装 Skill 即可用。
2. **关注 live-panel-skill**：如果你的高频场景是画架构图和流程图，这个项目的 JSON 配置驱动模式可能比通用 HTML 更直接。
3. **建立 Token 对比基线**：在引入富媒体输出 Skill 前后，测量同一类问题的 token 消耗和回答质量，用数据而非感觉判断收益。

## 九、不包含

本文不讨论以下内容：

- 通用 RAG 架构与检索增强生成的技术实现
- Agent 编排框架（如 LangChain、CrewAI 等）的功能对比
- 各仓库的代码级实现细节分析

## 结论

2026 年 10 月第一周的趋势数据指向一个清晰的转折点：Agent 输出格式正在从"文本默认、富媒体例外"切换为"富媒体默认、文本兜底"。驱动这一转变的不是模型能力的天花板——模型早已能写 HTML——而是 Skill 模式将"写结构代码"这一高 token 成本工作从模型迁移到了确定性 CLI。

当输入端有 Leviathan 做索引化检索，输出端有 answer-me-with-html 做结构化渲染，中间有 Superpowers 做能力组合——Agent 的 I/O 带宽正在被系统性地扩展，而非依赖模型窗口的线性增长。

这不是某个仓库的胜利，是一个品类的诞生。当输出格式从文本默认切换为富媒体默认，Agent 与人类之间的信息传递带宽将被重新定义——而这，可能比模型本身的能力提升影响更为深远。
