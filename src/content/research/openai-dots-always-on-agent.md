---
title: OpenAI Dots 与 Always-On Agent 范式的产品化
subtitle: 从单轮对话到持续自主：OpenAI 如何用 GPT-6 Astra、云计算机和插件生态定义 Always-On Agent
slug: openai-dots-always-on-agent
type: research
category:
  - AI模型
  - Agent Skill
topics:
  - agent-systems
  - model-economics
  - ai-security
tags:
  - OpenAI
  - Dots
  - GPT-6-Astra
  - DevDay-2026
  - always-on-agent
  - Codex
  - ChatGPT-Plugins
  - Apps-SDK
  - prompt-injection
  - auto-review
events:
  - openai-dots-launch
  - openai-devday-2026
  - openai-gpt-6.1-sol-release
source: AI Radar / Skill Radar 2026-09-30
created: 2026-09-30
updated: 2026-09-30
status: evolving
confidence: high
featured: false
publish: true
radar:
  - ai
  - skill
related:
  - agentic-coding-harness-design
  - agent-memory-interoperability
---

# OpenAI Dots 与 Always-On Agent 范式的产品化

## 研究定义

**研究对象**：OpenAI Dots — 2026 年 9 月 29 日 DevDay 上发布的 Always-On Agent 产品，以及它所代表的 AI 交互范式转变。

**研究范围**：Dots 的核心架构（GPT-6 Astra 驱动、独立云计算机、插件生态、跨渠道协作）、安全设计（沙箱、auto-review、权限分级、prompt injection 防护）、产品形态（primary dot + specialist dots）、与现有 Agent 生态的横向对比、Always-On Agent 范式的纵向演进。同时覆盖 DevDay 2026 同期发布的支撑能力（Codex 云环境、ChatGPT 插件应用化、Apps SDK）作为 Dots 生态的上下文。

**不包含**：GPT-6 Astra 模型本身的架构细节、ChatGPT 广告业务、OpenAI 融资财务分析、非 OpenAI Agent 产品的详细功能对比。

**核心问题**：

1. Dots 代表了 AI 交互范式的什么转变？
2. OpenAI 为 Always-On Agent 构建了哪些安全基础设施？
3. Dots 的平台化策略对 Agent 生态格局有什么长期影响？
4. Always-On Agent 范式对当前 AI 工作流意味着什么？

---

## TL;DR

- **核心变化**：2026 年 9 月 29 日 DevDay，OpenAI 发布 Dots — 基于 GPT-6 Astra 的 Always-On Agent 产品。每个 Dot 拥有独立云计算机、可连接 4000+ 应用的插件生态、跨渠道（ChatGPT/Slack/Teams）协作能力，能在用户不主动交互时自主执行"proactive research"。这不是功能升级，而是 AI 交互范式从"用户发起每一轮对话"向"Agent 持续自主工作"的转变。
- **为什么重要**：Dots 是首个由头部模型厂商官方产品化的 Always-On Agent。它将 Agent 自主性从"单次任务执行"提升到"持续承担责任"，并在安全层面引入 auto-review、Custom Rules、Activity View 等机制。这定义了 Always-On Agent 的产品基准线。
- **与现有方案最大的区别**：Dots 不是 chatbot 增强，不是 coding agent 扩展。它是一个拥有独立计算环境、跨应用权限、持续记忆和主动行动能力的 Agent。核心差异是"Always-On"——不需要用户发起每一轮交互，Dot 在后台持续工作并主动带来结果。
- **对当前工作流的影响**：当前工作流以 API 调用 + AI Coding 工具为主，Dots 的 Always-On 模式不直接适用于当前技术栈。但 Dots 的安全设计模式（auto-review、权限分级、proactive research 限制为 read-only）为自建 Agent 系统提供了参考架构。
- **当前建议**：持续观察。Dots 目前面向 Pro/Business/Enterprise 用户，未开放 API 级别集成。其安全设计模式和插件生态架构值得作为 Agent 系统设计参考。触发升级条件：Dots 开放 API 或 Apps SDK 公开发布文档。
- **置信度**：高。本文主要来源为 OpenAI 官方发布文档，一手资料充分。

---

## 一、纵向分析：从对话到自主行动的演进

### 1. 起源

AI 交互范式的演进可以划分为几个阶段：

**搜索范式（2000s-2020）**：用户发起查询，系统返回结果，交互结束。信息检索是原子操作，无持续性。

**对话范式（2022-2024）**：ChatGPT 开启。用户发起对话，模型多轮回应，对话结束。模型在单次会话中保持上下文，但不会主动发起交互，也不会在会话间保持状态。

**工具增强范式（2024-2025）**：Custom GPTs、各类 Agent 框架。模型可以调用工具（搜索、代码执行、文件操作），但每次行动仍由用户发起。Agent 在单次任务内可以多步推理和执行，但任务完成后即停止。

**编码 Agent 范式（2025-2026）**：编码 Agent 在代码库中持续工作，处理多步骤任务，但仍局限于编码场景，且每次任务仍由用户触发。

**Always-On Agent 范式（2026）**：Dots 代表的新阶段。Agent 不需要用户发起每一轮交互。它在后台持续工作，可以主动发起 proactive research，在用户不在线时也可以处理任务。它有独立计算环境、持续记忆、跨应用权限。这不是更长的对话，而是从"用户驱动"到"Agent 自主驱动 + 用户监督"的范式转变。

### 2. 诞生节点

**2026 年 9 月 29 日，DevDay 2026**。OpenAI 发布 Dots，同期发布 GPT-6.1 Sol、Codex 云环境更新、ChatGPT 插件应用化、Apps SDK 等 20+ 项公告。DevDay 回顾页面明确表述："agents that can take on ongoing responsibilities and new ways for people and AI to work together"。

Dots 的官方定位是"remarkably capable, always-on agents built to handle everything"。核心特征：

- Powered by GPT-6 Astra
- 每个 Dot 有独立云计算机
- 通过插件连接 4000+ 应用
- 跨渠道（ChatGPT / Slack / Teams）协作
- 后台 proactive research（read-only 限制）
- 从反馈中学习用户偏好
- 面向 Pro / Business Premium / Enterprise 计划推出

### 3. 演进历程

Dots 不是凭空出现的。OpenAI 在 Agent 方向的演进有清晰脉络：

**Custom GPTs（2023 年 11 月）**：用户创建自定义 GPT，配置指令和工具。但仍是对话式——用户发起每次交互。

**工具调用扩展（2024 年）**：逐步扩展 GPT 的工具调用能力——代码执行、网页浏览、DALL-E 图像生成等。工具调用从单步发展到多步。

**Assistants API 到 Apps SDK（2024-2026）**：开发者构建 Agent 应用。Assistants API 支持 function calling、code interpreter、file search。2026 年 DevDay 发布 Apps SDK。

**ChatGPT Plugins 应用化（2026 年）**：DevDay 2026 将插件从简单工具调用升级为类应用界面。官方插件页面显示已支持 Gmail、Slack、GitHub、HubSpot、Figma、Adobe、Salesforce、Outlook、SharePoint、Teams、Canva、Snowflake、Databricks、BigQuery 等。

**Codex 云环境（2026 年）**：Codex 获得可跨设备使用的可复用云环境。

**Dots（2026 年 9 月 29 日）**：上述能力的集大成——独立云计算机 + 插件生态 + 跨渠道 + 持续记忆 + 主动行动。

### 4. 决策逻辑

**为什么是 GPT-6 Astra 而不是更便宜的模型？**

官方安全博客解释：Astra 擅长理解目标、保持在请求范围内、在答案可能改变行动时提出针对性问题。Always-On Agent 的核心挑战是意图理解——在用户不全程监督时，模型必须准确理解目标、判断何时自主行动、何时需要确认。

**已确认事实**：官方文档明确 Dots 由 GPT-6 Astra 驱动。

**合理推断**：使用最强模型意味着运营成本较高，这解释了为何 Dots 首先面向 Pro/Business/Enterprise 用户。

**未知**：Dots 的具体 token 消耗量级、是否有模型降级策略。

**为什么是独立云计算机？**

官方安全博客解释：每个 Dot 有自己的云计算机，沙箱限制其代码和工具访问范围。Dot 的代码运行环境与协调系统和安全系统分离——可以创建文件和运行工具，但不能修改安全系统或关闭必需检查。这种分离确保即使 Dot 犯错或遭遇恶意指令，安全检查仍然有效。

**为什么是插件生态而不是直接集成？**

Dots 通过插件连接 4000+ 应用。这是平台化策略——插件让 OpenAI 成为 Agent 生态的中心节点，第三方应用通过插件接入，OpenAI 控制权限和交互层。DevDay 回顾提到"opening up ChatGPT as a shared surface where humans and agents can collaborate and where developers can directly launch new native experiences to our collective 1.2B weekly users"。

### 5. 当前阶段

Dots 处于**早期产品发布阶段**。判断依据：

- 官方公告明确正在渐进式推出到 Pro/Business/Enterprise 计划
- Specialist dots 仍为 preview 阶段
- Apps SDK 尚未公开文档（访问 developers.openai.com/apps-sdk 返回 403）
- 官方承认"Dots can still make mistakes"
- 插件生态虽达 4000+ 应用，但深度集成的实际可靠性待验证

---

## 二、横向分析：Always-On Agent 的竞争格局

### 1. 格局判断

Always-On Agent 是一个正在形成的产品类别：

- **直接竞争者**：暂无。Dots 是头部模型厂商首个官方产品化的 Always-On Agent
- **部分替代方案**：自托管 Agent 框架，可以实现后台自主行动，但缺乏 Dots 级别的插件生态和云计算机
- **相邻技术**：编码 Agent、对话式 Agent、Agent 框架（LangChain、CrewAI 等）
- **前代方案**：Custom GPTs、Zapier 自动化、IFTTT

### 2. 自托管 Agent 框架（开源方案）

- **核心定位**：开源 Agent 框架，用户自建 Agent 系统
- **技术路线**：本地运行 + 自定义记忆系统 + cron 调度 + 可选 API 模型
- **产品形态**：终端/CLI 为主，通过 webhook/消息平台触达用户
- **核心优势**：数据自主、可完全自定义
- **主要限制**：无独立云计算机、插件生态有限（依赖 MCP 等协议）、主动行动受限于调度系统、无 auto-review 等安全审查层
- **与 Dots 的核心区别**：自托管 vs 云托管。自托管需自己搭建安全隔离和记忆系统，Dots 将这些作为产品内置

### 3. 编码 Agent

- **核心定位**：专注于代码库内任务的 Agent
- **技术路线**：模型 + 代码执行环境 + 代码库访问
- **适用场景**：代码编写、调试、重构、PR 创建
- **主要限制**：局限于编码场景，不是通用 Agent；每次任务仍由用户触发
- **与 Dots 的核心区别**：场景专一 vs 通用。Codex 的云环境是"可复用开发环境"，Dots 的云计算机是"Agent 持续工作空间"

### 4. 对话式 Agent（ChatGPT、Claude）

- **核心定位**：多轮对话式 AI 助手
- **核心优势**：用户控制感强，每次行动由用户发起
- **主要限制**：无持续自主行动能力，会话间不保持工作状态
- **与 Dots 的核心区别**：对话式 vs 持续自主。Dots 突破了对话式的根本限制——Dot 可以在用户不交互时继续工作

### 5. RPA / 工作流自动化（Zapier、n8n）

- **核心定位**：基于规则的工作流自动化
- **核心优势**：确定性高、成本可控
- **主要限制**：无推理能力，只能执行预定义流程，无法处理意外情况
- **与 Dots 的核心区别**：规则驱动 vs 模型驱动。Dots 可以理解模糊意图、自主规划步骤、处理意外情况

### 6. 对比总览

| 维度 | Dots | 自托管 Agent | 编码 Agent | 对话式 Agent | RPA |
|---|---|---|---|---|---|
| 核心定位 | Always-On 通用 | 开源自建 | 编码场景 | 对话式 | 规则工作流 |
| 自主行动 | 持续/主动 | 受限于调度 | 单任务内 | 无 | 预定义 |
| 计算环境 | 独立云计算机 | 用户设备 | 代码环境 | 无 | 无 |
| 插件生态 | 4000+ 应用 | 有限 | 代码工具 | 工具调用 | 跨应用 API |
| 安全审查 | auto-review | 用户自建 | 无内置 | 无 | 不需要 |
| 跨渠道 | 多平台 | 自定义 | CLI/IDE | Web/App | 通知 |

### 7. 生态位分析

- **它替代谁**：部分替代 RPA 工具（用 AI 推理替代规则流程）、部分替代人工跟进任务
- **它增强谁**：增强 ChatGPT（从对话到持续 Agent）、增强 Codex（云环境持续工作）、增强插件生态（从工具到应用级交互）
- **它依赖谁**：依赖 GPT-6 Astra 模型能力、依赖插件合作伙伴的 API、依赖云基础设施
- **谁可能替代它**：Google 若将 Agents CLI + Gemini 结合做 Always-On Agent；Anthropic 若将 Claude 扩展为持续自主模式；开源社区若构建出足够完善的方案
- **差异化位置**：首个将"模型能力 + 独立计算环境 + 插件生态 + 安全审查 + 跨渠道"整合为一个产品的方案

---

## 三、横纵交汇：位置与走向

### 当前位置

Dots 的发布标志着 Always-On Agent 从概念探索进入产品化阶段。首次有头部模型厂商将"Agent 持续自主行动"作为正式产品提供。

当前形态的明确限制：

- **渐进式发布**：仅面向付费 Pro/Business/Enterprise 用户
- **平台锁定**：Dots 运行在 OpenAI 云端，无本地部署选项
- **成本不透明**：GPT-6 Astra 驱动意味着高推理成本，使用额度限制未明确
- **能力边界待验证**：官方承认"Dots can still make mistakes"
- **安全设计未大规模实战检验**：auto-review、prompt injection 防护、monitoring 在大规模真实使用中的有效性尚需验证

### 关键变量

1. **模型能力**：GPT-6 Astra 的推理、意图理解和安全对齐能力直接决定自主行动质量
2. **安全有效性**：auto-review 的准确率、prompt injection 防护的鲁棒性、monitoring 的及时性
3. **插件生态深度**：4000+ 应用的数量不等于深度集成质量。插件能做 look up 还是 modify records 是关键差异
4. **用户信任建立**：Always-On Agent 需要用户信任——让 Agent 在不监督时行动。信任是渐进过程，一次严重失误可能显著阻碍采用
5. **竞争响应**：Google、Anthropic 是否推出类似 Always-On 产品

### 未来走向

**路径 A：Always-On 成为主流交互模式**。如果 Dots 在早期用户中证明可靠，且 OpenAI 开放 Apps SDK 让开发者构建基于 Dots 的应用，Always-On Agent 可能成为 AI 交互的主流模式之一。触发条件：(1) Dots 失误率足够低，用户愿意持续授权；(2) Apps SDK 公开并形成开发者生态；(3) 至少一个竞争对手推出类似产品验证市场需求。

**路径 B：Always-On 保持高端定位**。如果 Dots 的运营成本（GPT-6 Astra 推理）使其无法下沉到更广用户群，Always-On Agent 可能长期作为高端功能存在。触发条件：(1) 模型成本未显著下降；(2) 竞争对手未推出免费替代；(3) 插件生态维护成本高，无法快速扩展。

**路径 C：安全事件导致范式回退**。如果 Always-On Agent 在大规模使用中发生严重安全事件（Agent 执行未授权敏感操作、被 prompt injection 攻击利用），可能导致用户信任崩溃、监管介入，Always-On 模式被迫回退到更保守的"用户确认每步"模式。触发条件：(1) 发生公开安全事件；(2) 监管机构施加限制；(3) auto-review 等机制在大规模使用中失效。

### 机会

1. Dots 的安全设计模式（auto-review、权限分级、read-only proactive research）可为自建 Agent 系统提供参考架构
2. 如果 Apps SDK 开放，开发者可基于 Dots 生态构建专用 Agent 应用
3. Specialist dots 的组织级身份管理为企业 Agent 治理提供新模式

### 风险

1. 平台锁定——Dots 生态完全由 OpenAI 控制
2. 安全失效——Always-On Agent 自主性越高，安全失效后果越严重
3. 隐私风险——Dot 持续访问用户数据，proactive research 持续扫描信息，隐私边界模糊
4. 成本不确定性——GPT-6 Astra 驱动的运营成本可能导致使用限制或价格调整

### 哪些东西没有改变

- AI 模型的基本限制——GPT-6 Astra 仍然会犯错，Always-On 不等于 Always-Correct
- 用户对控制权的需求——即使 Agent 可以自主行动，关键决策仍需要人类确认
- 安全与自主性的张力——Agent 自主性越高，安全风险越大，这一根本矛盾不会因 auto-review 而消失
- 数据隐私的根本约束——Agent 持续访问用户数据带来的隐私问题，不会因加密和权限管理而完全解决

### 综合判断

Dots 是 Always-On Agent 范式的第一个标杆产品。它的价值不在于立即改变所有人的 AI 使用方式，而在于定义了 Always-On Agent 的产品基准：独立计算环境、插件生态、安全审查层、跨渠道协作、权限分级。这个基准将影响后续 Agent 产品的设计方向。

Dots 的核心限制在于平台锁定和成本——它运行在 OpenAI 云端、由 GPT-6 Astra 驱动、面向付费用户。这意味着 Always-On Agent 的普惠化还需要时间和竞争来推动。

---

## 安全设计深度分析

Dots 的安全设计是本次发布中信息最充分的部分，值得单独分析。

### 沙箱隔离

每个 Dot 有独立云计算机，代码和工具在沙箱内运行。关键设计：Dot 的运行环境与协调系统和安全系统分离——可以创建文件和运行工具，但不能修改安全系统或关闭检查。用户间云环境隔离。底层 Linux 和 Chrome 浏览器由 OpenAI 维护。

### Auto-Review

Auto-review 是 Dots 安全架构的核心机制。它在动作执行前检查是否可能影响账户或共享信息，对照用户指令、Custom Rules 和安全要求判断：哪些工作可以继续、哪些需要审批、哪些必须用户亲自执行。某些敏感任务（如修改密码）始终由用户执行。

### Prompt Injection 防护

官方安全博客明确讨论了 prompt injection 威胁——网页、邮件、文档可能包含恶意指令。防护措施包括：模型层训练（拒绝有害请求）、工具限制、动作前检查、运行时监控。如果监控发现潜在有害行为，可以暂停 Dot 工作并显示警告。

### Proactive Research 限制

Dot 在用户不活跃时进行 proactive research，严格限制为 read-only——不能发送消息、不能修改应用内容、不能控制用户浏览器或计算机。这是自主性与安全的关键边界：Dot 可以"看"但不能"做"。

### Secure Sign-In

Dot 登录网站时，模型被暂停，用户通过安全登录表单提交凭据，密码直接发送到浏览器环境而不经过模型上下文。这减少了密码出现在回答中或被误共享的风险。

### Custom Rules

用户可设置规则：允许特定行动、需要审批、或阻止。内置安全要求始终适用，不可被 Custom Rules 覆盖。

### 评估

这套安全设计在 Agent 产品中属于较为完善的。核心创新是 auto-review——将安全检查从"模型训练时对齐"扩展到"运行时动作审查"。但关键问题是大规模有效性：auto-review 本身依赖模型判断，如果模型判断失误，安全机制可能失效。OpenAI 承认"Dots can still make mistakes, so always review consequential work"。

---

## DevDay 2026 支撑能力

Dots 不是孤立发布的产品，DevDay 2026 的多项公告构成了 Dots 的生态支撑：

**GPT-6.1 Sol**：新模型，在多项基准上接近 GPT-6 Astra，价格为 Astra 的五分之一。API 定价 $2/百万输入 token，$0.10/百万缓存输入 token，$10/百万输出 token。GPT-6.1 Sol 不直接驱动 Dots（Dots 用 Astra），但 Sol 的存在为 Dots 的未来模型降级提供了成本优化可能。

**ChatGPT Plugins 应用化**：插件从简单工具调用升级为类应用界面。官方插件页面已支持 Gmail、Slack、GitHub、Salesforce 等 20+ 核心企业应用。这是 Dots 4000+ 应用生态的基础。

**Codex 云环境**：可跨设备使用的可复用云环境。与 Dots 的云计算机不同——Codex 云环境面向开发者手动使用，Dots 云计算机由 Agent 自主操作。

**Apps SDK**：面向开发者的 Agent 应用构建工具。访问 developers.openai.com/apps-sdk 返回 403，文档尚未公开。DevDay 回顾提到开发者可"directly launch new native experiences to our collective 1.2B weekly users"。

---

## 参考资源

### 一手资料

- [Introducing dots (OpenAI 官方)](https://openai.com/index/introducing-dots/) — Dots 产品发布公告，2026 年 9 月 29 日
- [How we build safety, security, and privacy into dots (OpenAI 官方)](https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/) — Dots 安全设计详解，2026 年 9 月 29 日
- [DevDay 2026 Recap (OpenAI 官方)](https://openai.com/index/devday-2026-recap/) — DevDay 2026 全部公告概览，2026 年 9 月 29 日
- [Introducing GPT-6.1 Sol (OpenAI 官方)](https://openai.com/index/introducing-gpt-6-1-sol/) — GPT-6.1 Sol 模型发布公告，2026 年 9 月 29 日
- [Introducing GPT-6 Sol and Luna (OpenAI 官方)](https://openai.com/index/introducing-gpt-6-sol-and-luna/) — GPT-6 系列定价和模型层级，2026 年 9 月 22 日
- [Plugins | Connect tools and apps to ChatGPT and Codex (OpenAI 官方)](https://openai.com/business/plugins/) — 插件生态页面，列出已支持应用

### 补充资料

- AI 模型与工具雷达日报 2026-09-30 — OpenAI DevDay 动态汇总来源
- Skill 雷达日报 2026-09-30 — Agent Skill 生态动态来源
- [GPT-6.1 Sol System Card Addendum](https://deploymentsafety.openai.com/gpt-6-1-sol) — 安全评估详情

### 社区讨论

- GitHub: pskoett/self-improving-agent — OpenClaw 自我改进技能，反映开源社区对 Agent 持续改进的探索方向
- GitHub: dzhng/jevgrep — 语义代码搜索 CLI，1774 stars，反映 Agent 工具链生态活跃度

---

## Action Items

当前无需行动，继续观察。

触发条件：
- Dots 开放 API 或 Apps SDK 文档公开发布 → 评估开发者集成可能性
- Dots 发生公开安全事件 → 重新评估 Always-On Agent 安全设计
- Google 或 Anthropic 发布竞品 → 横向对比更新

---

## 更新记录

| 日期 | 变化 |
|---|---|
| 2026-09-30 | 初始创建。基于 OpenAI DevDay 2026 官方发布文档，分析 Dots 产品架构、安全设计和 Always-On Agent 范式意义。 |

---

*本文件由 Horizon 自动研究流程生成，可持续补充和更新。*