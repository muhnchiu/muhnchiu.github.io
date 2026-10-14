# Horizon Publish Gate — 机制说明

本目录存放 research 文章的发布门禁（Publish Gate）执行记录与审计日志。

## 职责边界（务必区分）

**本 CI Gate（`scripts/publish-gate.mjs`）只执行确定性、机器可可靠完成的检查：**

- 变更范围确定（push 事件 `before → sha` 完整 diff；基准不可用时不静默放行，exit 2）
- 仅对本次**新增或变更**且 `publish: true` 的研究文章要求 Gate 记录（历史未变更文章增量豁免，不阻断）
- 记录存在性 + `content_sha256` 匹配 + G1–G5 无 FAIL（N/A 必须附 evidence 说明不适用理由）
- 结构规则：frontmatter 可解析、必填字段、章节编号连续、无空必选项

**CI 不执行语义事实核查。** G1（来源独立性）、G3（证据措辞）、G4（适用边界）的语义判断，以及 G5 中数字/统计口径的跨章节一致性，仍由 Research/Verification/Agent 层负责。

CI 能证明的是"**签署记录与当前文章内容一致**"，不能证明"语义检查真的执行过"。若文章与记录在同一次提交里被一起篡改，CI 仍会判定一致——这是单人工作流下接受的边界，未来多人协作时应配合 GitHub 分支保护、必需状态检查与受限部署权限。

## 记录结构

每篇通过 Gate 的变更文章对应一个 `publish-gate/<slug>.json`：

```json
{
  "article": "slug",
  "checked_at": "2026-10-14T00:00:00Z",
  "content_sha256": "<article 正文的 SHA-256>",
  "status": "PASSED",
  "checks": { "G1": "PASS", "G2": "PASS", "G3": "PASS", "G4": "PASS", "G5": "PASS" },
  "evidence": {
    "G1": "来源独立性核查",
    "G2": "时效事实已标注核查日期",
    "G3": "断言强度已按证据降级",
    "G4": "适用条件已全篇附加",
    "G5": "跨章节一致性已核对"
  }
}
```

- 文章正文变化后旧记录自动失效（SHA 不匹配 → BLOCK）。
- FAIL→修复→PASS 的历史保留在 `publish-gate/audit/<slug>.jsonl`（追加式，不覆盖）。
- 示例中的 `PASSED` 不是真实验收结果，仅说明字段格式。

## 历史文章处理

**不**为未经过检查的历史已发布文章生成验收记录。历史豁免只适用于本次未变更的已发布文章；一旦历史文章发生实质修改并准备重新发布，就必须通过完整 Gate，不能因"是旧文章"而跳过。

## 偏差登记

### aa67d7c — 越权修改已发布文章（已追认）

提交 `aa67d7c`（docs: reasoning-effort — G3 gate sweep catches residual '零成本'）修改了已发布文章 `reasoning-effort-auto-selection.md` 的 6.3 节单行（"手动纪律零成本" → "无需安装工具、引入风险较低"），超出了当时"不修改已发布文章"的授权范围——该修改发生在回归测试中误落正式文件。

**追认决定（2026-10-14）**：保留该单行技术修正（内容更准确），不回滚、不再次修改该文章。追认范围**仅限该行**。本次追认不构成今后允许在回归测试中直接修改正式文章的先例——后续回归测试必须使用临时副本。

---

*Horizon V2 · 质量门禁验证阶段*
