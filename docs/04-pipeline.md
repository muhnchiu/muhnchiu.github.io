# 采集分析身份与评分

[返回项目入口](../README.md) · [下一章：契约](05-contracts.md)

## 处理步骤与失败定位

| 阶段 | 输入与输出 | 常见失败证据 |
| --- | --- | --- |
| 调度 | 定义 → 任务启动 | 到点没有执行记录 |
| 采集 | 来源 → 原始材料与来源状态 | 超时、空结果、部分来源失败 |
| 分析 | 原始材料 → 候选与 Markdown | 会话中断、有原始文件但无分析 |
| 归一化与验证 | 版本化文档 → 可用内部对象 | 类型、枚举、计数或引用错误 |
| 身份与 Registry | Evidence → Event / Observation | 身份冲突、无效记录或事务失败 |
| Score / Action | 完整权威输入 → 分数与建议 | authority 缺失、门禁未满足 |
| 发布 | 可公开文档 → 网站内容 | 构建、Git 或部署失败 |

此表描述完整逻辑链，各阶段是否运行需单独确认。Legacy 日常报告不能自动作为 V2 评分或 Registry 全量接入证据。

## 身份与去重

Event 标识事件；Observation 标识符合冻结规则的来源与雷达观察。重复抓取不等于新观察，事件的再次出现也不等于实质 UPDATE。

Contract 2.1.2 的 eventKey 使用 `<entity>:<canonicalEventType>:<eventIdentifier>`。entity 与 eventIdentifier 的允许模式均为 `^[a-z0-9][a-z0-9._-]*$`，事件类型使用冻结枚举。不要自行新增 material fingerprint 字段。

Registry Policy 中 `occurrences` 为关联该 eventKey 的唯一 observationId 数量，可由 Observation Registry 重建。缓存不一致需报告 `REGISTRY_OCCURRENCE_MISMATCH`，不得自动修复。

一个 Candidate 引起的 Event 与 Observation mutation 属于同一逻辑事务。成对提交、恢复、锁与 snapshot 的精确规则依冻结 Registry Policy，不由本手册重定义。

## 评分与行动

历史手册展示过相关性、影响、新颖性、可信度、Stack Fit 及加减分的模拟口径。这些模拟表不是当前 Score Policy 2.1.1 的规范来源，本章不复制为生产公式。现行分数、阈值和 Action 判定须使用对应冻结策略、包版本和权威输入。

不得补造 relevance、momentum、risk 或其他缺失判断；缺输入不等于 score = 0。Registry-only Canary 的显式 disposition 为 `SCORE_NOT_EVALUATED`，原因 `SCORE_INPUT_INCOMPLETE`，不生成默认 signal/action。

历史回放 50/50 与 Observation fixture 29/29 是指定集合的验证证据，不能推广成未来生产数据均正确。

## 深入文档

- [事件身份引擎](radar-event-identity-engine.md)
- [证据流水线](radar-evidence-pipeline-v1.md)
- [模型判断与人工验证](radar-judgment-provider-human-validation-v1.md)
- [评分与行动执行闭环](radar-score-action-execution-closure-v1.md)

## 测试样本阅读入口

[Fixtures 中文用途索引](../fixtures/README.md)区分程序直接使用的样本与历史草案；机器数据保留原字节。
