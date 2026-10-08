# Phase 6.4 Score 与 Action 执行闭环

[返回流水线手册](04-pipeline.md)

本文记录 Phase 6.4 的显式只读输入 runner：Contract 2.1.2、Score 2.1.1、Action Decision 2.1.0、Security Gate 1.0.0。Runner 会写隔离输出，不修改冻结 artifact 或 pin。

下文 30 个 capture、零调用、空 ready set 和 authority 未配置均是本阶段记录，不能代替后续 Phase 9.2 的最新状态。

## 已配置 Provider

Adapter 读取本地 OpenClaw 既有 Radar 模型选择，验证 provider / model membership 与 HTTPS endpoint，绑定不含凭据的配置 fingerprint。Secret 只留在私有 transport closure。

请求恰好一个结构化 tool result，将严格 Schema、provenance、proof 与 rubric selection 交给已接受的 Provider runtime。原始模型响应不持久化；HTTP 失败、无效 JSON、重复 tool result、provenance 不完整与 timeout 均拒绝继续。

配置存在不能证明 endpoint 连通或真实模型质量。只有完整、不可变、字段专属 evidence 通过冻结 gate 才可调用 Provider。Source identity 元数据不能静默晋升为 workload、applicability 或有界 before/after comparison evidence。

当时 30 个 capture 全部未通过 completeness gate，已配置 transport 没有收到调用；真实记录不使用 test adapter。

原文协议参考保留供查阅：[阿里云 Anthropic-compatible Messages API](https://www.alibabacloud.com/help/tc/model-studio/anthropic-api-messages)、[Claude tool schema 与 tool-choice](https://platform.claude.com/docs/claude/docs/tool-use)。这些链接不授予调用权限。

## 已提交 Registry 上下文

`readCommittedRegistryContext` 不写入。它验证 Registry pair、COMMITTED journal 和最终文件 hash，再将每个 Event / Observation 绑定到最新成功的 post-commit WRITE_RESULT audit receipt。

校验 transaction identity、source scope、Event / Observation ID、disposition 与当前 Event state。Registry 中存在记录本身不足以证明上下文有效。

Observation 的 `security` 映射为已批准 Score 的 `SEC`，identity 字节不变。Audit receipt 属于外层 Registry provenance，不重新标为 native source evidence。

## 不可变执行集合

只有既有 generator 的完整输入和 provenance 才能进入 lock。Lock 前检查 eligibility、value / provenance 一致性、Registry state / duplicate binding 及 Security scope。

首次调用最终 Score / Action evaluator 前，验证全集 content 和逐项 input / provenance / security / Registry hash。Policy hash 使用冻结 manifest 的字节 hash；未知 action 不能绕过冻结词表。不导入 Registry writer、Publisher 或 scheduler。

Manifest 独占创建并读回后才执行；Replay 精确比较确定性结果，不一致抛错。空集合的 Score / Action 调用为 0，determinism 为 NOT_APPLICABLE，不能证明生产判断质量或关闭真实 execution / calibration 债务。

隔离 synthetic 测试覆盖非空成功与失败，不计入真实记录数量。

## Security 与人工验证

缺失已批准 NVD environment / component / relationship context 保持 UNRESOLVED。没有 SCORE_READY 输入时不创造 incoming signal、cap 或 hard-filter outcome；按实际 missing-state vector 查询冻结 classification matrix，相关 SEC 记录不能执行。非 SEC N/A 使用既有冻结 applicability 规则。

当时未配置 Human Validation store，在真实报告中返回 AUTHORITY_UNAVAILABLE，不当作健康完整空 store，不能产生 priorValidation=false，也不创建 human record。运行不可用和来源 / context 缺失按既有 owner 保持 OPEN，不引入替代 Policy authority。

## 调用与授权边界

入口：`node scripts/run-radar-score-action-closure.mjs <新建的隔离运行目录>`。

目录必须是新的，manifest 不可覆盖；拒绝 Production 与 Canary namespace。检查 capture、Registry pair，以及 disabled ingestion / scheduler control。执行需遵守当前任务授权，本次翻译未调用 runner。

报告区分 configured provider 与 live call、synthetic test 与 production execution。Phase 6 当时任务允许空 ready set 完成 receipt-based evaluation closure；这不代表完整 V2 production ready 或 publication authorized。
