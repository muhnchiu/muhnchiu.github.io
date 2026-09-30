# Horizon Radar contract baselines

## Version meanings

`schemaVersion: 2` is shared by two versioned contracts. The package/contract version is therefore part of the input context and must be supplied by the collection, directory, or API that owns the document. A consumer must never infer the package version from which Event fields happen to be present.

| Contract package | Event model | Baseline |
| --- | --- | --- |
| Historical V1 | Legacy signal model; no Contract 2 Event identity | Original V1 contract and normalizer |
| Contract 2.0.0 | Legacy Event model (`entity`, `eventType`, `eventKey`, `firstSeen`, `lastSeen`, `primaryRadar`) | Published 2.0 schema and fixtures are authoritative and immutable |
| Contract 2.1.0 (historical) | Event Identity Model 1.0 (`eventKey`, `canonicalEventType`, `eventState`, `materialChange`, `observedAt`, `duplicate`, with the published optional timestamps/authority) | Published 2.1 schema, normalizer, invariants and fixtures |
| Contract 2.1.1 (historical) | Event Identity Model 1.0 with event identifier grammar patch | Published 2.1.1 schema, normalizer, invariants and fixtures; schemaVersion remains 2 |
| Contract 2.1.2 (current) | Event Identity Model 1.0 with entity segment grammar patch | Published 2.1.2 schema accepts existing dotted/underscored entity identities; all other event key segments and semantics remain unchanged |

The earlier task assumption that Contract 2.0 did not require Event fields was incorrect. Contract 2.1 is not merely the addition of Event fields: it refines the meaning of an Event identity and observation. In 2.0, the legacy fields describe entity/type and a first/last-seen window under the original 2.0 rules. In 2.1, `eventKey` participates in the canonical identity model while state, material change, observation time, duplicate status, and source timestamps express distinct event/observation semantics. The 2.1 key format and invariants must not be applied retroactively to 2.0.

## Compatibility and deterministic dispatch

- V1 documents use the V1 schema/normalizer.
- Contract 2.0 documents use the actual published 2.0 schema/normalizer, selected by package context `2.0.0`.
- Contract 2.1.1 documents use the published 2.1.1 schema/normalizer and Event Identity invariants, selected by explicit package context `2.1.1`. Contract 2.1.2 is selected only by package context `2.1.2`; its patch changes the entity segment grammar to `^[a-z0-9][a-z0-9._-]*$`, without rewriting event keys or changing the canonical event type and identifier grammars. Contracts 2.1.0 and 2.1.1 remain historical immutable packages.
- A schema version of `2` alone is insufficient to select between 2.0 and 2.1. Keep those documents in version-specific collection/package contexts and pass that context to validation/normalization.
- There is no supported “2.0 without Event fields” baseline.

The prior immutable distribution commit `c71fd8cc9f409324163a16cc760ef807e7317827` remains in history. The prior Horizon pin `b64716f31214031314fbe7ceb040e173918e377c` corrected only the 2.0 compatibility fixture's invalid `eventType` enum. Contract 2.1.1 remains pinned in history at `ae81486cdfe12a8164f6f30381131a372bae3e93`; it adds the dotted/underscored event identifier grammar while preserving the 2.1.0 artifact. Contract 2.1.2 is distributed at `5ac615eda0de0b0fa1d2cc398309fc2657bacc49` and resolves the frozen Event Replay entity grammar mismatch. Horizon's local baseline test fixture is maintained separately under `tests/fixtures/` and uses the true 2.0 `eventType` enum (`release`, `product-update`, `security-advisory`, `vulnerability`, `research-publication`, `adoption-signal`, `policy-change`, `other`). Its 2.0 `eventKey` is validated only by the published 2.0 pattern.

## Current Horizon content

The current `src/content/radar/` collection contains historical V1 Markdown documents. It is validated through the V1 path. Contract-package fixtures and the explicit package-context dispatcher are exercised by the contract tests; introducing 2.0 or 2.1 production content requires wiring a versioned collection/package root rather than guessing from document fields.
