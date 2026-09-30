# Horizon Radar V2 Phase 5A.3 — Identity Engine

This implementation is pinned to Contract 2.1.2 at distribution commit `5ac615eda0de0b0fa1d2cc398309fc2657bacc49`, Event Policy 1.0, Event Replay 1.0, Observation Policy 1.0, Observation Fixture 1.0, and Score Policy 2.0. The Contract 2.1.2 `schemaVersion` remains `2`; no contract, policy, replay, fixture, or production registry artifact is changed.

## Event identity

`buildEventKey` accepts explicit entity, canonical event type, and event identifier segments. It validates the frozen Contract 2.1.2 grammar and Event Policy 1.0 event type registry. It does not extract identifiers from titles or silently rewrite entity names. This is required for exact replay of dotted identifiers such as `deepseek-v4.1` and `glm-5.2-openrouter`.

`buildEventFingerprint` hashes a JSON object containing only non-null Event Policy 1.0 fact fields: `version`, `cveId`, `activeExploitation`, `supplyChainImpact`, `reachableDependency`, and `officialEmergencyAdvisory`. Keys are sorted before JSON serialization. Text and intelligence metadata do not enter the hash. Pricing terms, API availability, and license are not frozen fingerprint fields; changes limited to those properties cannot produce UPDATE and are reported as `POLICY_FIELD_NOT_FROZEN` at the decision boundary.

`resolveEventState` compares a caller-provided in-memory prior-event collection. An unseen key is NEW; an existing key with the same frozen fingerprint is DUPLICATE; a changed fingerprint under the same canonical event type is UPDATE. A cross-type match cannot become UPDATE. The module does not access a registry, filesystem, network, clock, or random source.

The frozen Event Replay records fingerprints as opaque expected values and does not include the underlying fact payload. Replay therefore feeds those exact fingerprint values into the state resolver and separately tests fingerprint construction from fact objects. This preserves the 50-row baseline without reverse engineering or fabricating facts.

## Observation identity

`canonicalizeSourceUrl` applies only Observation Policy 1.0: lowercase HTTP(S) scheme and hostname, remove fragments and default ports, remove trailing slash from non-root paths, preserve path and query. `buildObservationIdentity` hashes UTF-8 `eventKey + "\\n" + canonicalSourceUrl + "\\n" + radar` and returns the first 16 lowercase SHA-256 hex characters. Source metadata and all time fields remain outside identity. `resolveObservationTimes` derives first/last observed times from explicit `observedAt` values only.

Observation Fixture 1.0 is independent of the Event Replay. No source URL or observedAt is inferred from the Event Replay's report date.

## Contract and scoring boundary

Event Identity output maps to Contract 2.1.2 fields `eventKey`, `canonicalEventType`, `eventState`, `materialChange`, `observedAt`, and `duplicate`; observations remain represented by the Contract's source/time fields. Contract semantics enforce the state invariants. Phase 4 owns score behavior: `duplicate: true` continues to trigger the existing duplicate hard filter, while NEW/UPDATE continue through the existing score path. No score rule is reimplemented here.

## Verification entrypoints

`npm run test:contract` runs frozen Event Replay, Event Policy fingerprint/update checks, Observation Fixture identity and invalid-input checks, and the Contract package tests. `npm run test:phase4` runs the frozen score policy replay. `npm run build` runs contract and Phase 3 prebuild checks before generating the site.
