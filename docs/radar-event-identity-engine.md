# Event 与 Observation 身份引擎

[返回流水线手册](04-pipeline.md)

本文记录 Phase 5A.3 的实现边界。该阶段使用 Contract 2.1.2，分发提交 `5ac615eda0de0b0fa1d2cc398309fc2657bacc49`，以及 Event Policy 1.0、Event Replay 1.0、Observation Policy 1.0、Observation Fixture 1.0、Score Policy 2.0。Score Policy 2.0 是本阶段的历史验证上下文，不表示后续评分包未升级。

Contract 2.1.2 的 schemaVersion 仍为 2；本实现不修改契约、冻结策略、回放、fixture 或生产 Registry artifact。

## Event 身份

`buildEventKey` 接收显式 entity、canonicalEventType 和 eventIdentifier，校验冻结 grammar 与 Event Policy 1.0 类型注册表。它不从标题推断标识，也不静默改写 entity。这样才能精确回放 `deepseek-v4.1`、`glm-5.2-openrouter` 等既有身份。

`buildEventFingerprint` 只对 Event Policy 1.0 中非 null 的事实字段构造 JSON 并计算 hash：`version`、`cveId`、`activeExploitation`、`supplyChainImpact`、`reachableDependency`、`officialEmergencyAdvisory`。键先排序；文本与 intelligence 元数据不参与 hash。

`pricingTerms`、`apiAvailability`、`license` 不是冻结 fingerprint 字段，仅这些字段变化不能产生 UPDATE，决策边界报告 `POLICY_FIELD_NOT_FROZEN`。

`resolveEventState` 比较调用者提供的内存 prior-event 集合：未出现的 key 为 NEW；已有 key 且 fingerprint 相同为 DUPLICATE；同 canonicalEventType 下 fingerprint 改变为 UPDATE；跨类型匹配不能成为 UPDATE。模块不访问 Registry、文件系统、网络、时钟或随机源。

Frozen Event Replay 将 fingerprint 作为不透明预期值，不包含原始事实 payload。回放直接将这些值送入 state resolver，另行从事实对象测试 fingerprint 构造，保留 50 行基线，不反推或伪造事实。

## Observation 身份

`canonicalizeSourceUrl` 只应用 Observation Policy 1.0：HTTP(S) scheme 和 hostname 转小写，移除 fragment 与默认端口，移除非根路径末尾斜线，保留其余 path 和 query。

`buildObservationIdentity` 按冻结分隔规则将 eventKey、canonicalSourceUrl、radar 拼接后，以 UTF-8 计算 SHA-256，返回前 16 个小写十六进制字符。分隔符是单个换行字节（LF，0x0A），不是反斜线与字母 n 两个字符；实现中的模板字符串为 `${eventKey}\n${canonicalSourceUrl}\n${radar}`。来源元数据和所有时间字段不参与身份。

`resolveObservationTimes` 仅从显式 observedAt 推导 first/last observed 时间。Observation Fixture 1.0 独立于 Event Replay；不得由报告日期推断 sourceUrl 或 observedAt。

## 契约与评分边界

Event 输出映射到 Contract 2.1.2 的 eventKey、canonicalEventType、eventState、materialChange、observedAt、duplicate；Observation 由来源与时间字段表示。契约负责状态 invariants。

该阶段由 Phase 4 负责评分行为：duplicate 为 true 继续触发现有重复硬过滤，NEW / UPDATE 继续进入既有评分路径。身份引擎不重新实现评分规则。

## 验证入口

- `npm run test:contract`：Event Replay、fingerprint / UPDATE、Observation identity 与 invalid-input，以及契约包测试。
- `npm run test:phase4`：冻结 Score Policy 回放。
- `npm run build`：执行 package.json 的 prebuild 后构建网站；现行 prebuild 还包括 Registry 检查，完整清单以 package.json 为准。

这些是验证入口说明，本次文档翻译未运行测试或构建。
