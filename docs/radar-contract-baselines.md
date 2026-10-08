# Horizon Radar 契约基线

[返回契约手册](05-contracts.md)

本文保留版本语义、兼容调度和不可变分发历史。实际字段与校验约束以相应发布包为准。

## 版本含义

多个契约共用 `schemaVersion: 2`。因此，输入所属的集合、目录或 API 必须提供明确的 package / contract 版本上下文；消费者不得根据某些 Event 字段是否存在猜测版本。

| 契约包 | 事件模型 | 权威基线 |
| --- | --- | --- |
| Historical V1 | 历史信号模型，没有 Contract 2 的事件身份 | 原始 V1 契约与 Normalizer |
| Contract 2.0.0 | Legacy Event Model：entity、eventType、eventKey、firstSeen、lastSeen、primaryRadar | 已发布的 2.0 schema 与 fixture，保持不可变 |
| Contract 2.1.0（历史） | Event Identity Model 1.0：eventKey、canonicalEventType、eventState、materialChange、observedAt、duplicate，以及已发布的可选时间和权威字段 | 已发布的 2.1 schema、Normalizer、invariants 与 fixture |
| Contract 2.1.1（历史） | Event Identity Model 1.0，修补 eventIdentifier grammar | 已发布的 2.1.1 包；schemaVersion 仍为 2 |
| Contract 2.1.2 | Event Identity Model 1.0，修补 entity 段 grammar | 接受包含点号和下划线的既有 entity；其他段和语义不变 |

此前任务中“Contract 2.0 不要求 Event 字段”的假设是错误的。2.1 不只是新增字段，而是细化事件身份和观察的含义：2.0 用旧字段描述 entity/type 及 first/last-seen 时间窗；2.1 用 canonical identity、状态、实质变化、观察时间、重复标记和来源时间分别表达不同语义。不得将 2.1 的 key 格式与 invariants 追溯应用于 2.0。

## 兼容与确定性调度

- V1 文档使用 V1 Schema / Normalizer。
- 2.0 文档通过 `2.0.0` 包上下文选择真实发布的 2.0 Schema / Normalizer。
- 2.1.0、2.1.1、2.1.2 分别选择明确版本的发布包及其 invariants。
- 2.1.2 的 entity 段模式为 `^[a-z0-9][a-z0-9._-]*$`，不重写 eventKey，不改变 canonicalEventType 或 eventIdentifier 的既有规则。
- 仅有 schemaVersion 2 无法区分 2.0 与 2.1；输入必须按版本集合或包根目录组织，并传递版本上下文。
- 不存在受支持的“2.0 without Event fields”基线。

## 不可变分发历史

| 分发提交 | 用途 |
| --- | --- |
| `c71fd8cc9f409324163a16cc760ef807e7317827` | 既有历史分发，继续保留 |
| `b64716f31214031314fbe7ceb040e173918e377c` | 仅修正 2.0 compatibility fixture 的错误 eventType 枚举 |
| `ae81486cdfe12a8164f6f30381131a372bae3e93` | 2.1.1 支持带点号、下划线的 eventIdentifier，保留 2.1.0 artifact |
| `5ac615eda0de0b0fa1d2cc398309fc2657bacc49` | 2.1.2 修正 Frozen Event Replay 的 entity grammar 不匹配 |

Horizon 的本地基线 fixture 位于 `tests/fixtures/`，与分发 fixture 分别维护。2.0 的真实 eventType 枚举为：`release`、`product-update`、`security-advisory`、`vulnerability`、`research-publication`、`adoption-signal`、`policy-change`、`other`。其 eventKey 只按已发布 2.0 pattern 校验。

## 网站内容边界

`src/content/radar/` 当前明确走历史 V1 Markdown 校验路径。契约测试覆盖版本包 fixture 与显式 dispatcher；引入 2.0 / 2.1 生产内容需要接入版本化集合或包根，不能根据字段猜版本。
