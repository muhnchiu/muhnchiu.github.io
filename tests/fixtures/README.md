# 本地测试样本说明

[返回样本总览](../../fixtures/README.md) · [契约手册](../../docs/05-contracts.md)

## 保留的文件

| 文件 | 中文用途 | 使用情况与决定 |
| --- | --- | --- |
| [v2-legacy-event-model.json](v2-legacy-event-model.json) | 实际 Contract 2.0 Legacy Event Model 的本地兼容基线 | `tests/radar-contract.test.mjs` 与 `tests/radar-validator.test.mjs` 直接读取，必须保留 |
| [radar-shadow-runtime-cases-v1.json](radar-shadow-runtime-cases-v1.json) | Synthetic offline handoff 的场景定义：AI / DEV / APP / SEC 每类 8 个场景，另有 SEC classification unresolved 与 SKILL structured input unavailable 场景 | 本次未发现直接文件名引用，作为历史 Shadow 场景设计保留；不表示实际测试执行次数或 PASS 结果 |

## 中文阅读说明

2.0 样本表达“2.0 使用已发布的 Legacy Event 模型”。其 `eventType: release` 与 `eventKey: sample-model-release-v1` 按真实 2.0 校验，不能替换为 2.1 枚举或 key 格式。样本 `publish: false`，不是公开日报。

Shadow 样本的 purpose 表示：这是合成离线结构化交接案例，Score 判断与 context 输入由测试 harness 注入，不写入 handoff facts。案例覆盖 Candidate / Score ready、来源 URL 缺失、Event identity 不完整、判断缺失、过滤、首次发现、read / adopt，以及安全分类未解决等边界。

这两个 JSON 保留原字节。名称、状态、标识和预期值是测试协议；原始标题和 purpose 也可能参与字符串或 hash 检查。中文解释放在本说明中，避免翻译改变基线。

本次只做文件与引用检查，未运行测试、Shadow runtime、模型或 Registry 写入。
