# 治理门禁与授权

[返回项目入口](../README.md) · [下一章：路线图](09-roadmap.md)

## 状态的含义

**IMPLEMENTED** 表示代码存在；**TESTED** 表示规定集合通过；**ACTIVE** 需要实际运行证据；**AUTHORIZED** 需要对应授权。FROZEN 是规范冻结，PASS 是某任务范围的验收，均不能自动授予下一阶段权限。

本手册是描述性使用文档，不能新增 Policy、授权、签名权威或改变冻结 semantics。具体运行以现行策略、授权与证据为准。

## 当前受限门禁

| 项目 | 2026-10-08 文档基线 |
| --- | --- |
| Domain Snapshot Profile 2.0 | NOT_FROZEN |
| MODEL_B Signature Binding | 决策通过；不能替代 Trusted Head qualification |
| Trusted Head | BLOCKED，无已验证部署权威 |
| 相关 Runtime Authorization | NOT_GRANTED |
| Provider Qualification | BLOCKED；不得由本文推定调用许可 |
| 完整受治理 V2 Publication / Publisher | 未解锁 |
| Phase 9.2 | INCOMPLETE |
| 系统级 Capability Debt | 3 OPEN / 0 CLOSED |

以上限制针对相应能力和完整治理链，不能解释为已授权身份 ingest 或所有历史 isolated canary 从未存在。每个受控 slice 的授权范围须查原任务。

## 授权与隔离

Legacy Publisher 和 V2 Publisher 使用不同边界；Legacy 网站可发布不证明 V2 已授权。Identity-only Canary 不评估 Score，不输出默认 Action，也不证明 Publication Ready。

校验签名有效不等于具有签署权限。新 Profile 不静默迁移旧身份、历史签名或承诺。Root、Principal、Key、Grant 的变更必须遵守专门授权，本文不提供操作步骤。

本地签名链或锁无法单独证明全链恢复后的强防回滚。外部 Trusted Head 未 qualified 时保持阻塞；日常 Pages 维护不以新增付费云服务为前提。

## 债务口径

系统级 Phase 9.2 的 3 OPEN / 0 CLOSED 和历史 Phase 8 细粒度 27 OPEN / 6 CLOSED 属于不同台账范围，不应相加。历史受控 Registry 36 Events / 36 Observations 是某时点基线，不能作为永久实时数量或全链授权证明。

Deferred 不等于 CLOSED，UNKNOWN 应明确标记。任务要求 STOP 时，先停止依赖步骤并报告缺口，不补造权威输入或修改规则以获得 PASS。

## 相关实现文档

[隔离发布器 Canary](radar-publisher-isolated-canary-v1.md)记录特定隔离场景。阅读时核对任务、版本与授权范围，不能把隔离结果扩展为完整生产授权。
