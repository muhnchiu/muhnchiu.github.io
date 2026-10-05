# Phase 6.4 Score / Action execution closure

This explicit read-only runner uses Contract 2.1.2, Score 2.1.1, Action Decision 2.1.0 and Security Gate 1.0.0. Frozen artifacts and pins remain unchanged.

## Configured provider

The adapter reads the existing Radar model selection from the local OpenClaw config, validates its provider/model membership and HTTPS endpoint, and binds the configuration to a fingerprint that excludes credentials. The secret stays in the private transport closure. The adapter requests exactly one structured tool result and delegates strict schema, provenance, proof and rubric selection checks to the accepted provider runtime. No raw model response is persisted. HTTP failures, invalid JSON, duplicate tool results, incomplete provenance and timeouts fail closed.

Protocol references: [Alibaba Cloud Anthropic-compatible Messages API](https://www.alibabacloud.com/help/tc/model-studio/anthropic-api-messages), [Claude tool schema and tool-choice contract](https://platform.claude.com/docs/claude/docs/tool-use).

Configuration does not prove endpoint connectivity or real model quality. A provider call is permitted only after complete, immutable, field-specific evidence passes the frozen evidence gate. Source identity metadata is not silently promoted into tracked workload, applicability or bounded before/after comparison evidence. The current 30 captures all fail this completeness gate; configured transport receives no calls. No test adapter is used for these real records.

## Committed Registry context

`readCommittedRegistryContext` performs no writes. It validates the Registry pair, COMMITTED journal and final file hashes, then binds each Event/Observation to its latest successful post-commit WRITE_RESULT audit receipt. It verifies transaction identity, source scope, event/observation IDs, disposition and current event state. Registry presence alone is insufficient. The existing `security` Observation Radar value is mapped to the already-approved Score `SEC` value; identity bytes are unchanged. The audited receipt is outer Registry provenance and is not relabeled as native source evidence.

## Immutable execution set

Only the existing generator's complete inputs and provenance enter the lock. Eligibility, value/provenance equality, Registry state and duplicate binding, and resolved Security scope are checked before locking. Content and individual input/provenance/security/Registry hashes are verified for the entire set before any terminal Score/Action evaluator call. Policy hashes are the byte hashes in the frozen manifest. Unknown actions cannot bypass the frozen vocabulary. No Registry writer, Publisher or scheduler is imported.

The manifest is created exclusively and read back before execution. Replay compares exact deterministic results and throws on disagreement. An empty set has zero Score/Action calls and determinism NOT_APPLICABLE; it does not demonstrate production decision quality or close real execution/calibration debt. Isolated synthetic tests exercise nonempty success and failure cases and are never included in real-record counts.

## Security and Human Validation

Missing approved NVD environment/component/relationship context stays UNRESOLVED. Without SCORE_READY inputs no incoming signal, cap or hard-filter outcome is invented. The frozen classification matrix is queried for the actual missing-state vector; these SEC records cannot enter execution. Non-SEC N/A is the existing frozen applicability rule.

An unconfigured Human Validation store yields AUTHORITY_UNAVAILABLE in the real-record report. It is not a complete healthy empty store and cannot create priorValidation=false. No human records are created. Operational unavailability and missing source/context evidence remain OPEN debt under their existing frozen owners; they do not introduce replacement policy authority.

## Invocation

`node scripts/run-radar-score-action-closure.mjs /explicit/isolated/run-directory`

The directory must be new because its manifest cannot be overwritten. Production and Canary output namespaces are rejected. Every accepted capture, Registry pair and disabled ingestion/scheduler control is checked. Reports must distinguish configured provider from live provider calls, and isolated test executions from production executions. Phase 6 receipt-based evaluation closure can complete with an empty ready set under the current task rule. Full V2 production remains NOT_READY and publication NOT_AUTHORIZED.
