---
title: 免费模型档位的经济学
subtitle: 当免费推理从平台赠品变成新实验室的分发渠道，评测成本趋零与数据纪律成为同一枚硬币的两面
slug: free-model-tier-economics
type: research
category:
  - AI模型
  - 模型经济学
topics:
  - model-economics
  - inference
  - open-models
tags:
  - openrouter
  - nemotron-3
  - inkling
  - laguna-s-2.1
  - north-mini-code
  - gemma-4
  - gemini-4-argon
  - free-tier
  - rate-limit
  - model-evaluation
  - data-policy
source: AI Radar 2026-10-11
created: 2026-10-11
updated: 2026-10-14
status: evolving
confidence: high
featured: false
publish: true
radar:
  - ai
related:
  - ai-coding-tiered-model-routing
  - frontier-model-tiered-pricing
---

# 免费模型档位的经济学：从平台赠品到新实验室分发渠道

## 1. 研究概览

**一句话结论**：2026-10-11 的 OpenRouter API 快照显示，免费模型档位（`:free` 端点）已覆盖部分大型模型厂商与新实验室的端点。这说明免费档不仅能承担开发者试用入口，也可能成为厂商争取开发者采用的分发渠道；但供给结构是否持续向旗舰模型迁移，仍需要连续快照验证。

**关键发现**：
- 供给侧（2026-10-11 原始研究记录值，无快照存档、历史不可回放）：平台共 458 个模型，15 个免费端点。构成上，NVIDIA 的 Nemotron 3 / 3.5 共 5 个免费端点在列（nemotron-3：Ultra 550B-A55B MoE 旗舰、Super 120B-A12B、Nano-Omni 30B-A3B 推理版；nemotron-3.5：Lightning、Content-Safety 分类器），Thinking Machines、Poolside、Cohere、Google 等厂商模型与一线大厂同列。免费档已不局限于社区小模型。
- 机制可查询、可管理：双层限流（每分钟 + 每天，按账户历史充值分档）、`GET /api/v1/key` 的 `free_model_daily_requests` 动态配额字段、付费/免费分开的训练数据政策开关。
- 待核实的后续供给信号（未独立核验）：文章更新记录中提到的 Google Gemini 4 Argon（`google/gemini-4-argon:free`）进入免费通道，涉及两个独立的待核验事实——(1) Google 是否正式发布该模型及其发布时间与规格；(2) OpenRouter 是否在该日期的免费模型列表中实际提供该端点。模型官方发布属实不自动证明免费端点存在，反之亦然。截至 2026-10-14 独立核验，OpenRouter 当前模型列表**无** `google/gemini-4-argon:free` 端点（仅有付费 `google/gemini-4-argon` 与 `:batch`），与原始 10-14 记录冲突；不排除当时短暂上线后下线（免费档流动性的可能解释，非已证实案例）。在完成解决该冲突前，保留为未解决待核验项，不作为已确认事实。

**当前决策**：将免费档定位为「模型评测层 + 隔离的非关键实验任务」，**有条件可用**——用于备选模型冒烟测试与对比评测、非关键实验任务的零成本试验；不作为生产依赖；涉及项目内部或客户数据的上下文，在确认训练政策前不默认发送到免费端点。

**五层可信度标注**（事实材料 + 分析推断分开，避免单一「高」掩盖不同不确定性）：
- 机制结构（限流分档、配额字段、数据政策开关）：一手验证（官方文档 2026-10-11 抓取）
- 供给快照（458 模型 / 15 免费端点 / Nemotron 3 全系在列）：一手验证（API 实测 2026-10-11）
- 各免费端点的模型规格（参数规模、激活数、上下文）：平台描述口径（未独立核验）
- 限流**具体数值**：未验证（官方文档表格为前端渲染，静态抓取未能读取，仅保留历史公开口径）
- 商业动机与行业趋势（厂商获客逻辑、供给向头部集中的判断）：分析推断（基于机制与快照，非直接观察）

## 2. 免费模型供给发生了什么

**起点**：开源权重的免费可得解决了模型获取，但推理成本始终存在——每次前向计算都要 GPU 时间承担。所谓「免费模型档」，本质是平台或厂商替用户支付推理成本。因此免费档的形态从来不是慈善，而是一种营销与数据预算：谁付钱、换来什么，决定它的供给结构与存续时间。

**演进**：早期（约 2024-2025）聚合平台免费池以社区模型、小参数、限时预览为主，角色接近平台引流与长尾填充，对严肃使用者价值有限（质量不稳、随时下线）。中期一线大厂开始把轻量自家模型（如 Gemma 系列）放进免费档，目的从平台引流转向厂商生态卡位。

**当前快照（2026-10-11 原始研究记录值）**：平台共 458 个模型，15 个免费端点（无快照存档，历史不可独立回放；本数值不得与后续时点数据直接对比以推断变动幅度或长期趋势）。构成上出现两个特征：其一，NVIDIA 的 Nemotron 3 / 3.5 共 5 个免费端点在列（nemotron-3：Ultra 550B-A55B MoE 旗舰、Super 120B-A12B、Nano-Omni 30B-A3B 推理版；nemotron-3.5：Lightning、Content-Safety 分类器）；其二，多家新实验室模型与一线厂商同列——Thinking Machines 的 Inkling（平台描述口径：975B 总参 / A41B 激活的开源权重多模态 MoE，规格未独立核验）、Poolside 的 Laguna S 2.1（平台描述口径：118B/A8B 编码模型，规格未独立核验）、Cohere 首个编码向模型 North Mini Code（30B/A3B 稀疏 MoE，规格未独立核验）、Google Gemma 4 两个尺寸（26B-A4B 与 31B，平台描述口径为 256K 上下文的多模态稠密模型，规格未独立核验）。

**边界**：以上是**单次状态快照**（2026-10-11）。各模型何时进出免费档无公开记录，免费档是流动供给而非稳定目录；「旗舰模型出现在免费档」是单点观察，说明供给质量上移，但不构成任何单模型的可用性承诺，也不等同于「供给持续向旗舰迁移」的长期趋势——后者需要连续快照才能判断。

## 3. 免费推理背后的经济学

这是本文标题所指的「经济学」核心——免费档里三方各自交换什么，谁在为什么付钱。

**厂商侧：免费档是获客与卡位渠道**。聚合平台是开发者选模型的比较购物入口，免费货架位置带来零摩擦试用。对 Thinking Machines、Poolside 这类新实验室，免费档是切入已被头部占据的开发者工作流的低成本路径。真实负载数据与反馈常被引为动机之一，但具体遥测安排均未公开确认。

**平台侧：供给多样性 + 转化漏斗**。免费档扩充平台供给，吸引开发者把工作流建在平台上；免费用户向付费模型转化的漏斗价值真实存在。

**用户侧：零货币成本，换一组非货币代价**。得到零货币成本的评测与兜底能力，付出的是限流忍耐、数据政策不确定性、无可用性 SLA、以及「随时下线」的流动性风险。

**免费不是成本消失，而是成本承担主体发生转移**——推理的 GPU 成本从用户账单转移到厂商营销预算与平台补贴；「数据换服务」的交易本质没有变，只是被机制显式化了。

## 4. 使用机制与获取路径

**机制三组**（官方文档一手验证，2026-10-11）：

- **双层限流，按历史充值分档**：免费端点同时受每分钟与每日请求数限制，限额档位由账户累计充值金额决定（充值越多档位越高）。文档说明更高档位从低于门槛一个信用点开始生效（吸收充值手续费）。具体数值以官方文档表格为准——该表格为前端渲染，本次静态抓取未能读取当前数值；历史公开口径为低档每天 50 次、高档每天 1000 次、每分钟 20 次，**当前数值未验证**。
- **动态配额可查询**：`GET /api/v1/key` 返回的 `free_model_daily_requests` 字段报告当日已用 / 上限 / 剩余，程序化使用可据此做配额管理；每分钟限额不在该字段中。
- **数据政策独立开关**：账号设置中付费与免费模型分别设置「是否允许路由到可能用数据训练的提供商」；关闭后平台不路由到训练型提供商；另可按单次请求过滤提供商数据政策；Business / Enterprise 计划支持 EU / US 区域内路由。

**BYOK 豁免**：自带上游密钥的请求不受免费限额门控——自带密钥等于自己向上游付费，平台不再提供免费补贴。

**四种获取路径的交换结构**（比的是成本结构，不是技术优劣；BYOK 属于接入与结算路径，与前三种的「模型获取来源」维度不完全相同，保留在表中但需注明维度差异）：

| 获取路径 | 货币成本 | 隐性代价 | 适合场景 | 不适合场景 |
|---|---|---|---|---|
| 免费档（`:free`） | 0 | 双层限流、数据政策不确定性、无 SLA、供给可随时变动 | 模型冒烟测试、对比评测、非关键实验、个人实验 | 生产主路径、敏感数据、高吞吐任务 |
| 付费 API | 按 token 计费 | 成本随用量线性增长；不自动等于 SLA 保障 | 生产环境、用量可预期、愿意付费换确定性的场景 | 用量极低且对成本敏感的偶发场景 |
| BYOK 自带密钥（接入/结算路径） | 上游 API 计费 | 自担上游配额与账单，平台侧免费豁免不适用 | 已有某厂商账号、想在统一工具链中复用其额度 | 想借平台免费补贴的场景 |
| 自托管开源权重 | 硬件 + 电力 + 运维 | 时间固定成本、弹性上限受硬件约束 | 隐私敏感、离线、大批量稳定负载 | 突发弹性需求、无硬件环境 |

**数据政策维度需要拆成三项边界**（本次文档验证）：免费端点的零货币价格通常伴随更严格的请求配额和供给不确定性；**数据训练与日志留存政策则取决于实际路由的提供商及账户配置，需要单独核验**。三项不能合并成一句「数据换服务」：
- **训练用途**：是否允许路由到「可能用请求数据训练的提供商」——账号/请求级开关可关闭。
- **日志留存**：请求与响应是否被平台或提供商记录留存——与训练用途是独立的政策维度。
- **提供商路由**：实际被路由到哪个提供商——Business / Enterprise 的区域内路由影响这一项。

四种路径中，免费档的数据政策风险最显性（默认可能路由到训练型提供商，需显式关闭）；付费路径通常可通过选择承诺不训练的提供商规避；自托管路径数据不出本地，边界最清晰。

**供给热度不等于质量**：本次快照中免费档模型的政策与规格信息来自平台描述口径，无独立质量评测佐证；任何「免费档模型可以替代付费主力」的结论都需要自测数据，下载量与榜单位置只能说明获取热度。

## 5. 工程价值与采用建议

**当前工作流接入位置**：当前 API 模型栈包含 OpenRouter，免费档可直接使用，无需新增账号或配置。合理位置有两个，风险不同需区分：

- **模型评测层**——新模型进入视野后，先用免费端点跑冒烟测试与固定样本对比（隔离实验环境，低代价可回退），再决定是否付费引入。
- **隔离的非关键实验任务**——与既有「AI 编程分层模型路由」结构衔接，承担探索性、低风险任务的零成本试验位。注意「隔离实验」不等于「自动故障转移或生产降级」——双层限流与数据政策决定它不适合承担任何主路径或高频路径。

**数据纪律（硬边界）**：涉及项目内部信息或客户数据的上下文，在确认训练政策之前不应发送到免费端点。

**决策**：将免费档正式纳入模型评测流程，**有条件可用**；针对**具有稳定 SLA、明确容量保障或生产连续性要求的核心负载**，不纳入其生产调用链路。可信度分层：机制侧（官方文档）与供给侧（API 快照）共同支持「评测可用」；「生产不可依赖」是有条件的工程判断——双层限流、无 SLA、供给随时变动决定它不适合承担主路径与高频路径，但**非关键、可降级、可随时切换的生产场景**（如低优先任务在付费端点不可用时的兜底试验位）不在禁止之列，是否采用须逐场景评估限流实测与数据政策。各端点规格为平台描述口径，具体限流数值未验证；商业动机判断为分析推断。

**重新评估条件**（任一满足即升级，需逐项核验，不只看 SLA / 高频）：
- 某免费端点明确承诺不参与训练**且**给出可用性 SLA；
- 账号对某个免费端点形成高频稳定依赖，且限流实测不构成瓶颈；
- 实际数据政策（训练 / 日志留存 / 提供商路由三项）、任务质量、限流行为、延迟、退出机制均经核验可接受。

**未来走向**（恢复可观测触发信号，避免只留情景叙述）：
- 路径 A（评测基础设施化）：一线厂商持续维持旗舰级免费供给、限额机制透明稳定。触发信号：连续免费端点快照显示旗舰端点留存率不降、平台免费限额未收紧。
- 路径 B（收窄为体验层）：厂商发现免费流量转化率低于预期，旗舰撤出，供给回到小模型与限时预览。触发信号：未来数月旗舰端点陆续消失、免费档平均模型规模与质量下滑。
- 路径 C（数据交易显式化）：监管或舆论推动「免费服务换训练数据」的披露要求提高。触发信号：主要平台引入强制数据用途披露或标准化数据条款标签；合规敏感用户数据政策变化。

**Action Items**：
- 现在：用免费端点对 North Mini Code（编码向）跑一次固定样本的对比盲测，记录与当前在用代码模型的输出差异基线（零货币成本，配额消耗可控）。
- 触发条件：任何包含项目内部信息或客户数据的上下文发送到免费端点之前，先在账号设置确认免费档训练开关已关闭；未关闭则禁止发送。

## 6. 证据与参考资料

**证据分层**：
- 一手验证（2026-10-11 研究时点）：机制三组（限流分档 / 配额字段 / 数据政策开关）来自官方文档抓取；供给快照（458 模型 / 15 免费端点）为**研究时点记录值，无快照存档，历史不可回放**，不得作为可复现基线与后续时点直接对比变动幅度。
- 平台描述口径（未独立核验，**不得标记 verified**）：各免费端点模型规格（参数规模、激活数、上下文、模型类型）——来自 OpenRouter 平台描述，未向模型原始发布方核验。
- 未验证：限流具体数值（官方文档表格前端渲染，静态抓取未读取，仅留历史公开口径）。
- 分析推断：三方商业动机、供给向头部集中的趋势判断（基于机制与单次快照，非连续数据）。
- 无独立质量评测：任何「替代付费主力」结论需自测数据支撑。

**未解决的待核验供给信号**：Google Gemini 4 Argon（`google/gemini-4-argon:free`）——原始 10-14 记录称其进入免费通道，但 2026-10-14 独立核验中 OpenRouter 当前列表**未找到**该 `:free` 端点（仅有付费 `google/gemini-4-argon` 与 `:batch`），两记录冲突。可能解释（当时短暂上线后下线）仅为可能，非已证实案例。涉及两个独立待核验事实——(1) Google 官方发布该模型的时间与规格；(2) OpenRouter 免费列表是否（曾）实际提供该端点。二者均未独立核验，不作为已确认事实。

**参考资源**

一手：
- OpenRouter Models API（2026-10-11 实测抓取，458 模型 / 15 免费端点数据来源）：https://openrouter.ai/api/v1/models
- OpenRouter Docs — API 限额与免费使用限制（双层限流、分档机制、`free_model_daily_requests` 字段，本次抓取验证）：https://openrouter.ai/docs/api-reference/limits
- OpenRouter Docs — 隐私与日志（付费/免费分开的训练政策开关、按请求政策过滤、区域路由，本次抓取验证）：https://openrouter.ai/docs/features/privacy-and-logging

补充：
- NVIDIA Nemotron 3 Ultra 免费端点页（平台模型页，描述口径）：https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free
- Thinking Machines Inkling 免费端点页（平台模型页，描述口径）：https://openrouter.ai/thinkingmachines/inkling:free
- Google Gemini 4 Argon 官方发布与 Model Card：待核验（Verification 前未列入已确认来源）
- 注：`google/gemini-4-argon:free` 在 2026-10-14 独立核验的 OpenRouter 当前列表未确认（仅付费端点 + `:batch`），与原始 10-14 记录冲突，见 C11

社区：暂无验证到的实质性社区讨论；免费档模型榜单位置为热度信号，不作为正式参考。

**最后核查时间**：2026-10-14

**更新记录**：
- 2026-10-11 初次研究（基于 AI Radar 2026-10-11 信号 + OpenRouter API/官方文档一手验证）。
- 2026-10-14 供给侧信号（未解决待核验）：Google Gemini 4 Argon（`google/gemini-4-argon:free`，记录口径称 2026-10-13 官方全量开放、Model Card 已发布）出现在原始记录中，但同日独立核验未在当前列表确认该 `:free` 端点（仅有付费端点与 `:batch`），两记录冲突；「曾短暂上线后下线」仅为可能解释，非已证实下线案例。不作为已确认事实进入关键发现。
- 2026-10-14 Editorial Round 2（依据独立 Verification Round 1 + 用户审查意见）：
  - F-001：458/15 标记为「原始研究记录值，无快照存档、历史不可回放」，禁止与后续时点直接对比变动幅度
  - F-002：Nemotron「全系 3」修正为「Nemotron 3 / 3.5 共 5 个免费端点」，区分产品线
  - F-003：补 10-14 独立核验未找到 gemini-4-argon:free，登记为未解决记录冲突
  - F-004：各端点规格标注「未独立核验，不得标记 verified」
  - 结论边界：「生产不可依赖」限定为有条件判断（针对稳定 SLA/容量保障/连续性要求高的核心负载），非绝对禁止
  - 补齐机器可读 Research Asset（C1-C13，动态数据含 observed_at/retrieved_at/snapshot_hash）+ Coverage Report
  - 全部 claim verification_status=unverified；C7-C10 官方机制列为 Round 2 优先复核项，Editorial 未授予任何 verified

---

## Research Asset（机器可读 claim 结构）

```yaml
research_asset:
  schema_version: "v0.1"
  article: "free-model-tier-economics"
  claims:
    # —— 供给侧动态数据(区分 observed_at / retrieved_at / 快照状态) ——
    - id: C1
      claim: "2026-10-11 OpenRouter 平台共 458 个模型条目，其中 15 个 :free 端点"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - id: E1
          source: "OpenRouter Models API /api/v1/models（研究时点抓取）"
          evidence_status: missing        # 原始快照无存档文件，不可回放
          observed_at: "2026-10-11"
          retrieved_at: "2026-10-11（研究记录值）"
          snapshot_hash: null            # 快照不存在，不补造哈希
      verification_status: unverified
      boundary: "历史记录值，非可复现基线；不得与后续时点数据直接对比变动幅度或推断长期趋势"
      depends_on: []
      applicable_to: [openrouter, free-tier]
    - id: C2
      claim: "NVIDIA Nemotron 3 / 3.5 共 5 个 :free 端点（3 系: ultra-550b-a55b / super-120b-a12b / nano-omni-30b-a3b-reasoning；3.5 系: lightning / content-safety）"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - id: E1
          source: "OpenRouter Models API（2026-10-14 独立核验 /tmp/ro-models-1014.json）"
          evidence_status: archived
          observed_at: "2026-10-14"
          retrieved_at: "2026-10-14"
          snapshot_hash: "sha256:/tmp/ro-models-1014.json（待绑定完整哈希）"
          detail: "nvidia 5 个 :free 端点确认；3 系与 3.5 系跨产品线"
        - id: E2
          source: "2026-10-11 研究记录值（无存档）"
          evidence_status: missing
      verification_status: unverified
      boundary: "10-14 确认 5 个 nvidia :free 端点；10-11 记录值不可回放；产品线 3/3.5 区分基于 10-14 端点命名"
      depends_on: [C1]
      applicable_to: [openrouter, nvidia]
    - id: C3
      claim: "Thinking Machines Inkling 免费端点存在（inkling:free / inkling-small:free）；参数 975B 总参 / A41B 激活为平台描述口径"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "OpenRouter Models API 2026-10-14"
          evidence_status: archived
          detail: "端点存在确认；规格 975B/A41B 为平台描述，未向模型发布方核验"
      verification_status: unverified
      boundary: "端点存在=10-14 已核对；规格=平台口径，不得标记 verified"
      depends_on: []
      applicable_to: [openrouter, thinking-machines]
    - id: C4
      claim: "Poolside Laguna S 2.1 免费端点存在（laguna-s-2.1:free / laguna-xs-2.1:free）；118B/A8B 为平台描述口径"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "OpenRouter Models API 2026-10-14"
          evidence_status: archived
      verification_status: unverified
      boundary: "端点存在=10-14 已核对；规格未独立核验"
      depends_on: []
      applicable_to: [openrouter, poolside]
    - id: C5
      claim: "Cohere North Mini Code 免费端点存在（north-mini-code:free）；30B/A3B 稀疏 MoE 为平台描述口径"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "OpenRouter Models API 2026-10-14"
          evidence_status: archived
      verification_status: unverified
      boundary: "端点存在=10-14 已核对；规格未独立核验"
      depends_on: []
      applicable_to: [openrouter, cohere]
    - id: C6
      claim: "Google Gemma 4 两尺寸免费端点存在（gemma-4-26b-a4b-it:free / gemma-4-31b-it:free）；256K 上下文=平台描述（10-14 API context_length=262144≈256K）"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "OpenRouter Models API 2026-10-14"
          evidence_status: archived
          detail: "context_length=262144 与 256K 口径一致"
      verification_status: unverified
      boundary: "端点存在 + 上下文口径=10-14 已核对"
      depends_on: []
      applicable_to: [openrouter, google-gemma]
    # —— 平台机制（官方文档；C7-C10 = Round 2 优先复核项） ——
    - id: C7
      claim: "免费端点受每分钟 + 每天双层限流，限额档位按账户历史充值金额分档"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "OpenRouter Docs /docs/api-reference/limits（2026-10-11 研究时点抓取）"
          evidence_status: archived
      verification_status: unverified
      boundary: "支撑'生产不可依赖'核心判断的关键机制；Round 2 须重新读取文档复核，旧研究描述不得直接继承为本轮已核实事实"
      priority_r2_review: true
      depends_on: []
      applicable_to: [openrouter]
    - id: C8
      claim: "GET /api/v1/key 的 free_model_daily_requests 字段报告当日已用/上限/剩余；每分钟限额不在该字段"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "OpenRouter Docs（2026-10-11 研究时点抓取）"
          evidence_status: archived
      verification_status: unverified
      boundary: "Round 2 优先复核项"
      priority_r2_review: true
      depends_on: [C7]
      applicable_to: [openrouter]
    - id: C9
      claim: "账号设置中付费/免费模型分开的训练数据政策开关；可按单次请求过滤提供商数据政策；Business/Enterprise 支持区域路由"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "OpenRouter Docs /docs/features/privacy-and-logging（2026-10-11 研究时点抓取）"
          evidence_status: archived
      verification_status: unverified
      boundary: "数据纪律硬边界依据；Round 2 优先复核项"
      priority_r2_review: true
      depends_on: []
      applicable_to: [openrouter]
    - id: C10
      claim: "BYOK（自带上游密钥）请求不受免费限额门控"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "OpenRouter Docs（2026-10-11 研究时点抓取）"
          evidence_status: archived
      verification_status: unverified
      boundary: "Round 2 优先复核项"
      priority_r2_review: true
      depends_on: [C7]
      applicable_to: [openrouter]
    # —— 待核验 / 推断类 ——
    - id: C11
      claim: "Gemini 4 Argon 免费端点信号：原始 10-14 记录称进入免费通道；10-14 独立核验当前列表未找到 gemini-4-argon:free（仅有付费与 :batch）；记录冲突未解决"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - id: E1
          source: "原始 2026-10-14 研究记录"
          evidence_status: archived
          detail: "称 google/gemini-4-argon:free 出现在免费档位"
        - id: E2
          source: "OpenRouter Models API 2026-10-14 独立核验"
          evidence_status: archived
          detail: "google 厂商条目仅 gemini-4-argon（付费）+ :batch，无 :free"
      verification_status: unverified
      boundary: "两记录冲突；'曾上线后下线'仅为可能解释，非已证实下线案例；官方发布事实（时间/规格）亦未独立核验"
      depends_on: []
      applicable_to: [openrouter, google-gemini]
    - id: C12
      claim: "免费不是成本消失，而是推理成本承担主体从用户账单转移到厂商营销预算/平台补贴（分析性表述）"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "机制 + 供给侧综合分析（基于 C1-C10）"
          evidence_status: archived
      verification_status: unverified
      boundary: "分析推断，非厂商已证实的官方商业声明"
      depends_on: [C7, C9]
      applicable_to: [free-tier]
    - id: C13
      claim: "厂商获客渠道 / 新实验室分发渠道 / 平台转化漏斗 = 三方商业动机（分析推断）"
      claim_hash: "pending-r2-recompute"
      evidence_refs:
        - source: "基于机制与单次快照的推断，非直接观察"
          evidence_status: archived
      verification_status: unverified
      boundary: "分析推断；具体遥测安排均未公开确认；不得表述为厂商已证实的商业战略"
      depends_on: [C1, C12]
      applicable_to: [free-tier]

  counterexamples:
    - "单次快照（458/15）不可回放，不能证明免费供给的长期升级或向旗舰迁移趋势"
    - "旗舰模型出现在免费档 ≠ 该模型可用性或质量已确认；供给热度不等于质量"
    - "462/14（10-14）与 458/15（10-11）仅能说明两个记录值不同，因历史无存档无法独立确认变动数量与原因"
    - "Gemini 4 Argon 未找到 :free 端点不等于该模型从未免费，仅当前未确认"

  unknowns:
    - "458/15 原始快照无存档，历史不可回放，无法重建"
    - "限流具体数值（低档 50 / 高档 1000 / 每分钟 20）为历史公开口径，当前值未验证（官方文档表格前端渲染，静态抓取未读取）"
    - "各免费端点模型规格（参数/激活/上下文）为平台描述口径，未向模型发布方核验"
    - "C7-C10 官方机制文档本轮未重新抓取，与 10-11 研究时点是否存在政策差异未知"
    - "Gemini 4 Argon 官方发布时间/规格 + 免费端点是否（曾）提供，均未独立核验"

  predictions:
    - hypothesis: "免费档成为标准评测入口（先免费评测、后付费引入）"
      observable_signal: "连续免费端点快照显示旗舰端点留存率不降、平台免费限额未收紧"
      review_cadence: "每月"
      current_evidence: "仅单次记录值，无连续数据"
    - hypothesis: "旗舰供给收窄为体验层"
      observable_signal: "旗舰端点陆续消失、免费档平均模型规模与质量下滑"
      review_cadence: "每月"
      current_evidence: "10-11 记录 15 个 / 10-14 核验 14 个 :free，两个时点记录值不同（不可独立确认变动原因）"
    - hypothesis: "数据交易显式化（免费服务换训练数据）"
      observable_signal: "主要平台引入强制数据用途披露或标准化数据条款标签"
      review_cadence: "政策更新时"
      current_evidence: "无，属监管/市场情景"

  test_plan:
    - id: T1
      type: "current-api-snapshot"
      description: "2026-10-14 独立拉取 OpenRouter Models API，核对端点总数 / :free 数 / 厂商构成 / 免费判定（pricing 双 0）"
      status: "executed"
      result_evidence: "/tmp/ro-models-1014.json（total_count=462, :free=14, allZero pricing=true）"
    - id: T2
      type: "historical-snapshot-replay"
      description: "回放 2026-10-11 的 458/15 快照"
      status: "blocked"
      result_evidence: null
      notes: "原始快照无存档文件，API 为动态数据不可回放；历史值仅作研究记录，不升级为已核验事实"
    - id: T3
      type: "official-docs-recheck"
      description: "重新读取 OpenRouter 官方文档核对 C7-C10（限流分档/配额字段/数据政策开关/BYOK）"
      status: "planned"
      result_evidence: null
      notes: "Round 2 优先复核项；若文档已变化须记录当前政策与 10-11 研究时点差异"
    - id: T4
      type: "rate-limit-probe"
      description: "实测双层限流当前数值"
      status: "blocked"
      result_evidence: null
      notes: "官方文档表格前端渲染，静态抓取无法读取，需浏览器/账号实测"
    - id: P1
      type: "gemini-argon-reconciliation"
      description: "解决 C11 记录冲突：核验 gemini-4-argon:free 是否（曾）存在"
      status: "planned"
      result_evidence: null
      notes: "需 OpenRouter 免费端点历史列表或官方说明；当前仅能记录'10-14 未找到 :free'"

  # 动态数据规范：observed_at / retrieved_at / snapshot_hash；历史快照缺失标 missing，不补造哈希
```

## Editorial Coverage Report（Round 2 草案）

```yaml
coverage_report:
  article: "free-model-tier-economics"
  editorial_version: "round2"
  research_asset_version: "round2-C1-C13"
  mechanical_checks:
    endpoint_ids_preserved: true          # 各 :free 端点 ID / 厂商条目完整
    numbers_458_15_marked_as_record: true # F-001 已标记为记录值不可回放
    nemotron_lineage_split: true          # F-002 已区分 3 / 3.5 产品线
    spec_fields_marked_unverified: true   # F-004 规格均标平台口径
    no_false_precision: true              # 限流 50/1000/20 保持'未验证'，无伪精确数值
  semantic_checks:
    - item: "核心结论：评测可用，生产不可依赖"
      claim_id: [C7, C8, C9, C10]
      status: "corrected"
      notes: "第 5 节已限定为'针对稳定 SLA/容量保障/连续性要求高的核心负载'，非绝对禁止；保留非关键可降级场景"
    - item: "历史数字 458/15"
      claim_id: [C1]
      status: "omitted → corrected"
      notes: "F-001：标记为原始记录值、无存档、不可回放，禁止与后续时点对比变动幅度"
    - item: "动态事实 Nemotron 端点"
      claim_id: [C2]
      status: "omitted → corrected"
      notes: "F-002：'全系 3' 修正为 'Nemotron 3 / 3.5 共 5 端点'，区分产品线"
    - item: "Gemini 4 Argon 待核验"
      claim_id: [C11]
      status: "omitted → corrected"
      notes: "F-003：补 10-14 独立核验未找到 :free，登记为记录冲突；'曾上线后下线'仅可能解释非已证实"
    - item: "商业推断限定语"
      claim_id: [C12, C13]
      status: "preserved"
      notes: "'分析推断，非直接观察' 限定保留；未升级为厂商已证实动机"
    - item: "反例（单次快照≠趋势 / 热度≠质量）"
      claim_id: [C1, C11]
      status: "preserved"
      notes: "counterexamples 完整保留"
    - item: "未来情景可观测信号"
      status: "preserved"
      notes: "路径 A/B/C 触发信号保留"
    - item: "C7-C10 官方机制复核"
      claim_id: [C7, C8, C9, C10]
      status: "pending"
      notes: "Round 1 未重新读取官方文档；列为 Round 2 优先复核项，不自行标 verified"
  verdict: "pending_review"
  fail_reasons: []
  notes: >
    内容保真 Round 1 已 PASS_WITH_NOTES（历史保留）；本轮为结构补齐（Research Asset + Coverage）
    + F-001~F-004 修订。全部 claim verification_status=unverified。C7-C10 未重新核验前不得升级为
    verified。未创建 Gate PASS。
```

---

*本研究保留原始来源与决策结论；「评测可用、生产不可依赖」判断基于机制侧与供给侧一手验证；各免费端点模型规格为平台描述口径、限流具体数值未验证、商业动机为分析推断，替代性结论需自测数据支撑；Gemini 4 Argon 供给信号待独立核验。*
