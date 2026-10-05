# Isolated Publisher — Phase 7.3

## Boundary

Frozen Publication Policy 1.0.0 owns every publication decision. The Policy loader verifies the reviewed manifest SHA-256, outer integrity, all payload and dependency hashes, canonical identity binding, main policy version and FROZEN status. Supporting files retain reviewed-source metadata; their roles are assigned by the frozen manifest. There is no default policy or candidate fallback.

`evaluateFrozenPolicy` consumes validated proof states owned by the existing pipeline. In this phase those states are explicitly simulated and signed inside a `SYNTHETIC_TEST_AUTHORIZATION` capture. They do not represent actual Score, Action, Human Validation or production Registry outputs. The synthetic adapter is the only execution adapter implemented here; production authorization remains NOT_ENABLED.

Flow: synthetic candidate/capture → frozen decision → independent synthetic authorization validation → canonical instructionId verification → isolated execution gate → local sink → receipt/audit.

## Isolation

`createIsolatedPublisher` accepts only a temporary directory named `horizon-publisher-canary-*`, under the operating-system temporary root or `/private/tmp`. No target is interpreted as a URL or filesystem path. There is no network client, website writer, scheduler or production endpoint. Test Event keys must be explicitly synthetic. Authorization proof is an authenticated HMAC from an ephemeral test key, scoped to the exact isolated directory, frozen authority identity, instruction and upstream simulated proof hashes. The key is never persisted in evidence.

The signature adapter authenticates a test fixture principal only; it does not register or enable the frozen publication authority for production. Source trust, adopt, Score and Registry presence cannot supply authorization.

## Persistence and recovery

The local `state.json` contains an append-only logical sink, idempotency map, receipts and audit rows. A single exclusive filesystem lock serializes attempts across instances. A unique temporary state file is flushed before atomic rename; the containing directory is flushed afterward. There is no stale-lock auto-removal. An abandoned lock fails closed and requires explicit operator investigation.

One atomic state image commits sink, idempotency, execution receipt and success audit together. Partial temporary files are never read as committed state. A post-commit response failure returns EXECUTION_FAILED with a reconciled commit outcome; a restarted instance detects the existing committed instruction and returns DUPLICATE_EXECUTION without sink growth. Corrupt state fails closed. Failure receipts include explicit persistence status if storage/audit is unavailable; they never claim success.

The sink stores instruction/event/observation identity, target label, payload digest, authorization reference, timestamp and status. Targets are inert labels. All audit rows for post-identity attempts include instructionId, eventKey and observationId. Enable/disable records are auditable; kill activation is persisted in control history.

## Kill switch

Default state is DISABLED. Only isolated tests explicitly enable it. A separate commit lock serializes kill activation against the final control-generation check and sink commit. Activation before that boundary prevents execution; an already committed operation precedes activation. No operation commits after an acknowledged kill. Every normal Canary store ends DISABLED; corrupted stores are killed directly.

## Frozen semantics

Instruction bytes follow RFC 8785/JCS, semantic parsing, unchanged observation-set normalization and SHA-256. No raw JSON hashing, Unicode normalization, replacement instructionId or serialization fallback is used. Authorization scope fields and required grant fields are loaded from the frozen authority model. UTC instants are checked exactly, including fractional seconds; expiry is rechecked immediately before commit. Identical same-ID grants may deduplicate; distinct applicable grants reject. Revoked, expired, unavailable, stale, invalid or conflicting authorization cannot execute.

Same instruction replay has zero sink growth. Already committed event/channel/content cannot be republished by changing only the observation set: a contradictory synthetic history proof is rejected under the frozen observation semantics.

## Verification

Run `node --test tests/radar-publisher.test.mjs`. Set `RADAR_PUBLISHER_EVIDENCE` to a temporary output file to save raw Canary evidence. This evidence requires a successful test exit and is not a Policy source of truth. Tests use no real Score/Action execution, human grants or production write paths.

The implementation is not enabled or wired into production. Production authorization, publication-history integration, public adapters and full-production acceptance remain separate authorization gates. Existing debt is not closed by these isolated test results.
