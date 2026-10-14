# Gate 审计日志

FAIL→修复→PASS 的历史以 JSONL 追加记录在 `publish-gate/audit/<slug>.jsonl`，不覆盖。
每行一条：`{"ts": "...", "slug": "...", "result": "PASS|FAIL", "reason": "...", "commit": "..."}`。
当前暂无记录（门禁刚建立）。
