# 测试样本与历史验证材料

[返回项目入口](../README.md) · [处理流水线](../docs/04-pipeline.md)

## 目录用途与保留结论

此目录保存离线输入、预期结果、Schema 草案和历史审查材料，不是生产 Registry，也不是当前冻结策略的统一入口。2026-10-08 静态检查共确认 19 个原始文件：12 个有测试、脚本或模块的直接文件名引用；其余 7 个保留为历史草案或场景清单。**全部保留，不删除原始数据。**

没有直接引用不等于无价值：历史草案可以解释评分与授权边界如何形成，但不能据其 DRAFT / REVIEW_DRAFT 状态替代冻结分发包。后续清理应先明确是否迁移历史档案以及相关审查证据的保留要求。

本说明提供中文阅读入口。原 JSON / Atom 保留原字节，不翻译字段名、枚举、case ID、URL、上游原文、hash 或其他字符串。测试可能比较字符串，hash 可能覆盖说明文字；即便是 description 也不能普遍视为可安全翻译。

## 直接使用的样本

下表的“引用入口”表示源码引用已确认，不表示本次运行了测试或验证结果已 PASS。

| 文件 | 中文用途与保留原因 | 引用入口 |
| --- | --- | --- |
| [adapter-cases-v1.json](radar-candidate-adapter/adapter-cases-v1.json) | 五套 Radar 的 40 个 Candidate adapter 场景，每类 8 个；检查状态、reason 与干式交接 | `tests/radar-candidate-adapter/adapter.test.mjs` |
| [arxiv-cs-lg-page1.atom](radar-phase6-3/arxiv-cs-lg-page1.atom) | arXiv 离线响应，复现来源解析，保留上游格式 | `tests/radar-phase6-3-source-expansion.test.mjs` |
| [nvd-cve-page1.json](radar-phase6-3/nvd-cve-page1.json) | NVD 离线响应，检查漏洞来源与身份接入 | 同上 |
| [claude-code-real-release-capture-v1.json](radar-canary/claude-code-real-release-capture-v1.json) | 真实 release 捕获基线，支持 Identity / Registry Canary 回归 | `tests/radar-canary-identity.test.mjs`、`radar-canary-registry.test.mjs`、`radar-production-registry.test.mjs` |
| [owner-proof-states-v1.json](radar-publisher/owner-proof-states-v1.json) | 隔离 Publisher 使用的 owner proof-state 输入；不是生产授权 | `tests/radar-publisher.test.mjs` |
| [state-corruption-cases-v1.json](radar-publisher/state-corruption-cases-v1.json) | 35 个状态损坏场景，防止损坏状态被当成成功提交 | `tests/radar-publisher-state-integrity.test.mjs` |
| [generation-cases-v1.json](radar-score-input/generation-cases-v1.json) | Score Input generator 实现测试；不是人工 calibration ground truth | `tests/radar-score-input/generation.test.mjs` |
| [production-dry-run-v1.json](radar-score-input/production-dry-run-v1.json) | 历史 dry-run 边界记录，区分合成验证与真实来源运行 | 同上 |
| [source-readiness-v1.json](radar-score-input/source-readiness-v1.json) | 来源字段可用性审计，避免把缺失输入当作已有 authority | 同上 |
| [provenance-schema-v2.1.json](radar-score-input/provenance-schema-v2.1.json) | 字段区分的 provenance Schema，每个消费输入对应记录，拒绝任意值与未知字段；文件标为 DRAFT，实际使用范围需按调用代码核对 | `tests/radar-score-input/eligibility.test.mjs`、`package.test.mjs`，包验证脚本与输入模块 |
| [exhaustive-delta-analysis-v2.1.json](radar-score-input/action-space/exhaustive-delta-analysis-v2.1.json) | 48,384 个 Action 组合的完整差异分析，约 13 MB；体积大但被程序读取，不可直接删除 | `scripts/verify-score-policy-v2.1-actions.mjs`、`src/lib/radar-score-action-closure/action-audit.mjs` |
| [p07-288-audit-v1.json](radar-score-input/action-space/p07-288-audit-v1.json) | P07 的 288 条差异审计，解释历史与修订 Action 的变化 | `scripts/verify-score-policy-v2.1-actions.mjs` |

## 保留的历史草案与场景清单

下面 7 个文件在本次检查的 `tests/`、`scripts/`、`src/`、`docs/` 和 fixture 数据中，未发现直接文件名引用。此结论不排除外部任务、别名或间接生成流程使用；不能由此认定其已经废弃。

| 文件 | 中文说明 | 保留边界 |
| --- | --- | --- |
| [canary-cases-v1.json](radar-publisher/canary-cases-v1.json) | 52 个隔离 Publisher 场景与预期 disposition 清单 | `normative: false`；清单存在不证明每个场景已经测试通过 |
| [action-boundary-v2.1.json](radar-score-input/action-boundary-v2.1.json) | 50 个 Action 边界案例 | REVIEW_DRAFT，保留语义审查过程 |
| [prior-validation-lifecycle-v1.json](radar-score-input/prior-validation-lifecycle-v1.json) | 23 个 priorValidation 生命周期案例 | REVIEW_DRAFT，保留投影与失效边界 |
| [prior-validation-policy-v1.json](radar-score-input/prior-validation-policy-v1.json) | 人工验证 authority、粒度、状态与投影草案 | DRAFT，不能当作现行 authority |
| [input-policy-v2.1.json](radar-score-input/input-policy-v2.1.json) | Score 输入生成、字段 provenance 与 eligibility 草案 | DRAFT，不能用于新建或替代冻结 Policy |
| [calibration-schema-v2.1.json](radar-score-input/calibration-schema-v2.1.json) | 30 个人工标注案例的结构草案，每个 Radar 6 个；输入真值独立于预期策略输出，未填充 case labels | DRAFT，不能将空 Schema 当成质量 qualification |
| [package-manifest-v2.1.json](radar-score-input/package-manifest-v2.1.json) | 2.1.0 candidate package 的角色、版本、依赖和字节 hash 记录 | DRAFT / NOT_DISTRIBUTED / frozen=false；path 指向候选包名称，不是此目录内可直接执行的分发 manifest |

## 常见英文标记

| 标记 | 中文含义 |
| --- | --- |
| fixture / cases / expected | 测试样本 / 场景 / 预期结果 |
| synthetic / real capture | 合成输入 / 真实来源捕获 |
| provenance / ground truth | 可追溯输入依据 / 独立标注真值 |
| DRAFT / REVIEW_DRAFT | 草案 / 审查草案 |
| normative: false | 不作为规范来源 |
| RECEIPT_ONLY | 只生成诊断记录，不进入后续完整处理 |
| SCORE_READY | 当前检查范围内评分输入准备完毕，不表示发布获授权 |

## 其他 fixtures 目录

- [`tests/fixtures/`](../tests/fixtures/README.md)：本地契约兼容与 Shadow runtime 场景。
- `vendor/horizon-contracts/` 下的 fixtures：独立 submodule 的版本化契约测试数据，随分发包维护；不在网站文档整理中翻译或改写。
- `artifacts/review/` 下的 fixtures：历史候选包的审查输入，保留证据快照；不能当作现行生产 package。

## 后续维护

新增案例需说明来源、覆盖、预期和引用入口。若确需改变机器数据，先检查全仓引用及 manifest / hash 依赖，再按原范围执行回归；不能通过翻译改变证据或冻结语义。缩减大文件需有确定性重建和等价性证据，不仅凭文件大小判断。
