# 数据契约与兼容

[返回项目入口](../README.md) · [下一章：维护](06-operations.md)

## 网站当前集合

`src/content.config.ts` 为 `src/content/radar/` 明确选择 V1 Schema。Frontmatter 与正文共同组成报告，文件名和目录用于归档。SEC 的 radar 值为 `security`。

| V1 字段 | 约束摘要 |
| --- | --- |
| title、date、radar、verdict | 必填；radar 使用五类网站枚举 |
| signalCount、highSignalCount、actionableCount、actionRequired | 非负整数；语义一致性还需对应 Validator |
| highlights | 最多 5 条；每条使用 V1 字段与枚举 |
| signal | `critical / high / medium / low` |
| action | `action / test / watch / read / explore / ignore` |
| sourceLevel | `official / ecosystem / community / media / research` |
| topics、confidence、publish | 必填；confidence 为 high / medium / low |

完整字段、可选项和严格对象约束见实际 Schema。不能将 V2 的 `adopt` 等值直接写入 V1 集合。

## 版本语义

| 契约 | 事件含义与兼容原则 |
| --- | --- |
| Historical V1 | 历史信号格式，使用 V1 路径 |
| Contract 2.0.0 | Legacy Event Model；包含 entity、eventType、eventKey、firstSeen、lastSeen、primaryRadar |
| Contract 2.1.0 | Event Identity Model 1.0，改变身份与状态表达语义 |
| Contract 2.1.1 | 历史 eventIdentifier grammar patch |
| Contract 2.1.2 | 当前 entity grammar patch；schemaVersion 仍为 2 |

2.0 与 2.1 都属于 schemaVersion 2，因此必须按明确 contract/package context dispatch，不能通过字段存在与否猜版本。2.0 使用真实发布 enum/pattern，不套用 2.1 的 eventKey 规则。

## 2.1 身份字段

必填：eventKey、canonicalEventType、eventState、materialChange、observedAt、duplicate。可选：eventOccurredAt、sourcePublishedAt、sourceAuthority。具体状态 invariants 和完整报告字段以发布 schema 为准。

2.1 不是简单给 2.0 新增 Event 字段，而是细化事件身份、观察时间、重复与变化的语义。历史 artifact 与身份不能静默重写。

## 内容维护规则

- 先确定版本，再选择 Schema / Normalizer / Validator。
- 不为迁移批量改写历史 V1 报告。
- highlights 和正文可有不同覆盖范围；编辑缩减必须说明，计数保持一致。
- 发布前验证 Frontmatter、来源、公开边界和构建。

[契约基线与不可变分发历史](radar-contract-baselines.md)提供精确版本与 pin 记录；`vendor/horizon-contracts/` 是分发入口，不能把使用手册作为 schema 替代品。
