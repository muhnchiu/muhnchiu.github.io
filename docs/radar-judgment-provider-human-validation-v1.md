# JudgmentProvider and Human Validation implementation

This infrastructure binds SCORE_INPUT_RUBRIC_1.0 to its frozen payload, manifest and integrity hashes. `loadRubric` verifies the package and dependencies and freezes the loaded object. Only that object can authorize evaluation; copied or mutable alternate rubrics are rejected.

## Provider authority

An explicitly configured adapter supplies structured MODEL_JUDGMENT clause assessments. The request includes the complete frozen rubric, captured source/context text, immutable hashes, claim bindings, event/observation identities, run and source context. Context evidence requires an independently approved context verifier; it cannot replace native change facts. Required conditional classes can cite approved applicability evidence; absence is never assumed to mean not applicable.

The runtime validates schema, every frozen predicate ID, evidence types and references, provider identity/version/config, observation identity and request fingerprint. TRUE and FALSE assessments need explicit cited proof. It applies the frozen greatest-proven-level rule, including higher UNKNOWN blocking. No numeric fallback, field inference or alternative rubric exists. Transport is bounded and abortable. Responses with extra keys or unrestricted provider data are rejected; persisted packages contain only allowlisted metadata, judgments and evidence references/hashes, not raw transport data or captured text.

The adapter owns factual entailment of model assessments. Schema/hashes prove binding and integrity, not the truth of a model's natural-language reasoning. Isolated synthetic protocol fixtures do not establish real model quality or stability. Production transport and credentials are not configured by this task.

## Replay and stability

Packages are content addressed with canonical SHA-256, written with exclusive creation and compared byte-for-byte on repeat. Their directory must already exist and be an explicitly isolated store. Production namespace writes are rejected. Replay checks hashes, typed provenance, proof binding and frozen predicate selection without invoking transport. A package store is trusted captured evidence, not a cryptographic human/model identity authority; an untrusted external package requires separately authenticated import.

Bounded stability uses 2–10 repetitions and reports status/value, proven predicates, reason codes and reference agreement separately. Evaluation timestamps and response bytes need not match. Disagreement affecting values/status is surfaced; there is no majority vote. Real records currently exercise repeated fail-closed evidence availability, with zero model calls. Real probabilistic judgment stability remains unmeasured.

## Human authority

Human Validation uses an independent read-only authority port: `readSnapshot` supplies a complete healthy authenticated snapshot and lookup receipt; `verifyIdentity` independently authenticates the validator and authorization. Caller strings, model confidence, Registry presence and score/publication states cannot create authority. No human store write API is exposed.

Canonical records preserve frozen ENTITY_LEVEL scope (version, capabilities, usage, environment) and add event/observation trace binding. Event-wide applicability must be explicitly authenticated. Records include hashes, human identity, authentication references and ACTIVE/STALE/REVOKED status. Existing authority storage owns append-only lifecycle transitions/history; this module performs no transitions or silent repair. Malformed rows invalidate the lookup, cross-scope rows cannot match, independent conflicting active records and equal-time ambiguities fail closed. No TTL or automated ACTIVE promotion is added.

An unconfigured production store yields UNAVAILABLE, not a fabricated healthy empty lookup. Healthy complete no-match yields NO_VALIDATION. Bridging to priorValidation also requires the legitimate lookup receipt to already exist in candidate evidence. Scope mismatch, unavailable authority and missing receipt cannot become positive validation.

## Projection boundary

`projectScoreInputs` invokes the existing input generator only, supplies the four rubric-owned fields and authenticated priorValidation context, and requires event/observation/evidence bindings. Partial packages remain receipts. It does not execute Score/Action. Read-only projection does not invent committed Registry transaction results from record presence.

Run isolated tests with `node --test tests/radar-judgment-provider.test.mjs`. Run the real-record read-only projection with `node scripts/project-radar-judgment-readiness.mjs /explicit/isolated/output-directory`. Source capture and Registry hashes are checked; scheduler and ingestion must be disabled. Report artifacts may be copied to the authorized state report directory after inspection. No Publisher, ingestion runner or Registry writer is imported by projection.
