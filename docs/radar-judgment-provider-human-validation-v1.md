# JudgmentProvider 与人工验证实现

[返回流水线手册](04-pipeline.md)

本文记录 SCORE_INPUT_RUBRIC_1.0 接入时的基础设施与验证边界。下文“零模型调用”“未配置 authority”等是当时的验证记录，不能替代后续资格验证与管理实现的当前结果。

`loadRubric` 验证冻结 payload、manifest、integrity 和依赖 hash，并冻结加载对象。只有该对象可以授权 evaluation；复制或可变的替代 rubric 被拒绝。

## Provider 权威

显式配置的 adapter 提供结构化 MODEL_JUDGMENT clause assessment。请求绑定完整冻结 rubric、捕获的来源与上下文文本、不可变 hash、claim、Event / Observation、run 与 source context。

上下文证据需要独立批准的 verifier，不能替代原生变化事实。条件类别可引用批准的 applicability evidence，缺失不能默认为不适用。

Runtime 校验 Schema、每个冻结 predicate ID、证据类型和引用、Provider identity / version / config、Observation identity 和 request fingerprint。TRUE / FALSE 均需显式引用证明，并应用冻结的 greatest-proven-level 规则，较高层 UNKNOWN 会阻断选择。不存在数值 fallback、字段推断或替代 rubric。

传输有界且可中止。额外键和不受限 Provider 数据被拒绝；持久化包仅包含 allowlist 元数据、判断、引用与 hash，不含原始 transport 数据或捕获文本。

Adapter 负责判断事实是否支持 assessment；Schema / hash 证明绑定与完整性，不能证明模型推理为真。Synthetic fixture 不能证明真实模型质量或稳定性；本阶段不配置生产 transport 和凭据。

## 回放与稳定性

包使用 canonical SHA-256 内容寻址，以独占创建写入，重复时逐字节比较。目录必须预先存在且显式隔离；拒绝生产 namespace 写入。

Replay 验证 hash、类型化 provenance、proof binding 和冻结 predicate selection，不调用 transport。包存储是可信捕获证据，不是密码学身份权威；不可信外部包需单独认证导入。

有界稳定性重复 2–10 次，分别报告 status / value、proven predicate、reason code 和引用一致性；时间戳和响应字节无需相同。影响值或状态的分歧必须暴露，不采用多数投票。

该阶段真实记录仅验证了证据不可用时重复拒绝继续，模型调用为 0；真实概率判断稳定性当时未测量。

## 人工验证权威

Human Validation 使用独立只读 authority port：`readSnapshot` 提供完整、健康、已认证 snapshot 和 lookup receipt；`verifyIdentity` 独立认证 validator 与授权。调用者字符串、模型 confidence、Registry 存在或 Score / Publication 状态不能创建 authority；无 human store 写 API。

Canonical record 保留冻结 ENTITY_LEVEL 的 version、capabilities、usage、environment 范围，并增加 Event / Observation trace binding。Event-wide applicability 必须显式认证。

记录包含 hash、human identity、authentication reference 与 ACTIVE / STALE / REVOKED 状态。既有 authority storage 负责 append-only lifecycle history；此模块不转换状态、不静默修复、不增加 TTL、不自动晋升 ACTIVE。

Malformed row 使 lookup 无效；跨 scope 记录不能匹配；独立冲突的 ACTIVE 记录和同时间歧义均拒绝继续。

未配置生产 store 返回 UNAVAILABLE，不伪造健康空 lookup；健康、完整但无匹配返回 NO_VALIDATION。映射到 priorValidation 还要求 Candidate evidence 已有合法 lookup receipt。scope 不匹配、authority 不可用和 receipt 缺失不能变为正向验证。

## 评分输入投影

`projectScoreInputs` 只调用既有 input generator，提供四个 rubric-owned 字段和已认证 priorValidation，要求 Event / Observation / Evidence 绑定。Partial package 仍是 receipt；不执行 Score / Action，不由记录存在推断 Registry 已提交。

验证入口：`node --test tests/radar-judgment-provider.test.mjs`。

真实记录投影入口：`node scripts/project-radar-judgment-readiness.mjs <独立隔离输出目录>`。这会写验证输出，不是零写入命令；执行前须满足源码要求的 capture / Registry hash 检查，并禁用相关 scheduler 与 ingestion。检查后才可将报告复制到获授权的状态报告目录。投影不导入 Publisher、ingestion runner 或 Registry writer。
