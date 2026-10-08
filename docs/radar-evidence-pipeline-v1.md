# 生产证据流水线 1.0

[返回流水线手册](04-pipeline.md)

本文保留 Phase 5A.6.4 的 adapter 边界与来源审计记录。下文的调度未验证、重复实现和 blocker 是该阶段的检查结果，不能直接作为后续所有阶段的当前状态。

该 adapter 将来源 Candidate 元数据转换为已验证 Evidence 与尚未提交的 `AtomicObservationCommitInput`。它不运行 fetcher、不写 receipt、不访问 Registry 文件、不调用 `commitObservation`。

## 证据边界

调用者一次性提供显式 ISO observedAt，原样传入 ObservationInput，无系统时钟 fallback。retrievedAt 是可选本地元数据，不参与 Observation identity。原始 sourceUrl 和可选 sourcePublishedAt 必须来自 parser 的单条上游记录，不能由标题或 entity 拼接。

生产准入要求 HTTPS。缺失或无效证据仍可用于结构化错误 receipt，但不能进入 Registry preparation。

来源分类由 `SOURCE_EVIDENCE_MAP` 固定；未映射来源返回 `SOURCE_AUTHORITY_UNDEFINED`，不能入 Registry。生产准入可以比 Contract 更严格，但不改变 Contract 2.1.2 或 Observation Policy 1.0。sourcePublishedAt 晚于 observedAt 时返回 `TIME_ORDER_POLICY_UNDEFINED`，不自行创造时间顺序规则。

## 历史 parser 与权威检查

当时 README 指定的 script-manager parser 只是候选实现，生产 authority 与调度尚未确认。AI、DEV、APP、SEC 各存在另一份环境同步仓库实现，APP LaunchAgent 指向第二份副本，因此记录 `RADAR_IMPLEMENTATION_AUTHORITY_UNDEFINED`，待 Phase 5A.6.5 裁决。SKILL 当时仅检查到一份实现，但调度激活仍未验证。

| Radar / 来源 | 单条 URL | 发布时间 | 当时检查结论 |
| --- | --- | --- | --- |
| AI RSS / Atom | 已解析并输出 item link | 已解析 pubDate / published | 字段可用，但 Markdown 边界丢失类型结构 |
| Hugging Face Papers / Models | 输出论文或模型 URL | Papers 有时间，Models 常缺失 | 随来源变化；时间缺失可允许 |
| GitHub AI / OpenRouter | html_url 或 API item URL | 未稳定暴露 | URL 可用，发布时间常不可用 |
| arXiv | 输出 item id / link | published 已解析 | 字段可用，交接仅 Markdown |
| DEV Trending / HN / Show HN | repository 或 item URL | 排行无时间，HN 有 API 时间 | 指标源不能充当发布记录 |
| DEV Marketplace / changelog / release | extension 或 release URL | 取决于 parser | 上游字段存在时可用 |
| DEV npm Downloads | aggregate package API | 不是单条发布记录 | FIELD_NOT_AVAILABLE_FROM_SOURCE |
| SKILL Skills.sh | 提取到时为 item href | 无 item 时间 | 聚合 URL fallback 已改为空；缺失时仅 receipt |
| SKILL Linkly / GitHub | snapshot 保留 href / html_url | 不稳定 | 单来源记录 URL 可用，合并行不能当作单个 Observation |
| SKILL OfficialSkills / ClawHub / SkillsMP / LobeHub | 随 CLI / 页面输出变化 | 不稳定 | 保留逐来源行；聚合行仅 receipt |
| APP RSS | RSS link | published / updated | 可用，但需直接交接 parser 原始结构 |
| APP HN | item URL | API 可能有时间 | 取决于 parser |
| APP Trending | repository URL | 日排行无发布时间 | URL 可用，时间不可用 |
| APP AlternativeTo | 上游 urlName 转 permalink | 无 item 时间 | 只有明确 slug 才保留来源派生 URL |
| SEC NVD | 有第三方 references，无 NVD item permalink | NVD published 可用 | references 不得误标为 NVD item URL |
| SEC GitHub Advisories | html_url | published_at | parser 原先标 reference，输出归一为 url |
| SEC CISA KEV | CVE / dateAdded，无 item permalink | dateAdded 可用 | item URL 不可用，不伪造 |
| SEC FIRST EPSS | 以 CVE 为键的聚合概率 API | 无发布时间 | 无单条证据 URL / 时间，不能独自成为 Observation |
| SEC HN | story URL 或 HN item URL | API 时间 | parser 保留单条记录时可用 |

`FIELD_AVAILABLE_AND_DROPPED` 表示上游已提供且 parser 已解析，但只渲染为文字而丢失结构的字段。`FIELD_NOT_AVAILABLE_FROM_SOURCE` 表示上游没有该字段，例如下载指标、排行发布时间、EPSS、CISA item permalink。Adapter 应保留前者，不得合成后者。

## 处理顺序

1. Parser 提供 sourceName、上游 item URL、可选发布时间和事件事实。
2. `normalizeEvidence` 应用静态来源映射并验证。
3. 不合格 Candidate 只进入诊断 receipt，不准备 Event / Observation identity。
4. `prepareEvidenceCommit` 调用冻结身份引擎，返回原子 Registry 请求结构。
5. 边界结束于 `RegistryLayer.commitObservation` 之前。

Synthetic UPDATE 仅由冻结 fingerprint 字段约束；此模块不新增 material 字段，也不决定 Event state。
