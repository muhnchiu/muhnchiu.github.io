# 隔离 Publisher 与 Phase 7.3 Canary

[返回治理手册](08-governance.md)

本文保留 Phase 7.3 的隔离实现与验证边界。Synthetic Canary 成功不能作为生产发布授权。

## 决策边界

Frozen Publication Policy 1.0.0 决定所有 publication。Loader 校验已审查 manifest SHA-256、外层 integrity、payload / dependency hash、canonical identity、主策略版本与 FROZEN 状态。Supporting file 保留审查来源元数据，由冻结 manifest 分配角色，无默认策略或 candidate fallback。

`evaluateFrozenPolicy` 消费既有流水线拥有的已验证 proof state。此阶段这些状态是 `SYNTHETIC_TEST_AUTHORIZATION` capture 内显式模拟并签署的，不代表真实 Score、Action、Human Validation 或生产 Registry 输出。这里只实现 synthetic adapter，生产 authorization 为 NOT_ENABLED。

流程：Synthetic candidate / capture → 冻结决策 → 独立 synthetic authorization 验证 → canonical instructionId 验证 → 隔离执行门禁 → local sink → receipt / audit。

## 隔离

`createIsolatedPublisher` 仅接受操作系统临时根下名为 `horizon-publisher-canary-*` 的临时目录。Target 是无行为标签，不能解释成 URL 或文件路径。模块没有网络客户端、网站 writer、scheduler 或生产 endpoint；测试 Event key 必须明确 synthetic。

Authorization proof 使用短期测试 key 的已认证 HMAC，绑定隔离目录、冻结 authority identity、instruction 和模拟上游 proof hash。Key 不存入 evidence。

签名 adapter 只认证 fixture principal，不登记或启用生产 publication authority。Source trust、adopt、Score 或 Registry 存在均不能提供授权。

## 持久化与恢复

`state.json` 同时包含逻辑 append-only sink、idempotency map、receipt 与 audit。单一独占文件系统锁串行化多实例尝试；唯一临时状态文件 flush 后 atomic rename，再 flush 父目录。不会自动删除 stale lock；遗留锁必须拒绝继续，由操作者调查。

一个原子状态镜像同时提交 sink、幂等记录、执行 receipt 与成功 audit。Partial temp 文件不会作为 committed state 读取。

提交后响应失败返回 EXECUTION_FAILED，并包含核对后的 commit outcome；重启实例识别已提交 instruction，返回 DUPLICATE_EXECUTION，sink 不增长。Corrupt state 拒绝继续。存储或 audit 不可用时，失败 receipt 明确记录 persistence status，不宣称成功。

Sink 保留 instruction / Event / Observation identity、target label、payload digest、authorization reference、时间与状态。Identity 后的 audit 行包含 instructionId、eventKey、observationId；enable / disable 可审计，kill 激活写 control history。

## Kill switch

默认 DISABLED，仅隔离测试显式启用。独立 commit lock 串行化 kill 激活、最终 control-generation 检查与 sink commit。该边界前激活阻止执行，已经 committed 的操作先于激活；kill 被确认后不再 commit。正常 Canary store 最终 DISABLED，损坏 store 直接执行 kill。

## 冻结语义

Instruction 字节遵循 RFC 8785 / JCS、semantic parsing、既有 Observation-set normalization 和 SHA-256。不使用 raw JSON hash、Unicode normalization、替代 instructionId 或 serialization fallback。

Authorization scope 与必需 grant 字段来自冻结 authority model。精确检查 UTC instant（含小数秒），commit 前再次检查 expiry。相同 ID 的相同 grant 可去重，多个不同适用 grant 被拒绝；revoked、expired、unavailable、stale、invalid 或 conflicting authorization 均不能执行。

相同 instruction 回放不增加 sink。已提交的 event / channel / content 不能仅通过更改 Observation set 再发布；矛盾的 synthetic history proof 按冻结 Observation semantics 拒绝。

## 验证

入口：`node --test tests/radar-publisher.test.mjs`。`RADAR_PUBLISHER_EVIDENCE` 可指定临时文件保存 Canary evidence；只有测试成功退出时证据有效，且它不是 Policy source of truth。

测试不使用真实 Score / Action、human grant 或生产写路径。本文所述实现未接入生产；生产 authorization、publication history、公用 adapter 与完整生产验收分别有门禁，隔离结果不关闭既有债务。
