# Radar Production Evidence Pipeline 1.0

This adapter boundary turns source-derived candidate metadata into validated evidence and a dry `AtomicObservationCommitInput`. It does not run fetchers, write receipts, touch Registry files, or call `commitObservation`.

## Evidence boundary

The caller supplies `observedAt` once as an explicit ISO timestamp. The value is propagated unchanged to `ObservationInput`; this module has no wall clock fallback. `retrievedAt` is optional local metadata and is not part of Observation identity. Original `sourceUrl` and optional source `sourcePublishedAt` must come from the parser's item-level upstream fields. The pipeline never constructs a URL from a title/entity. HTTPS is required for production admission. Missing or invalid evidence remains receipt-eligible with structured error codes and cannot enter Registry preparation.

Source classifications are fixed in `SOURCE_EVIDENCE_MAP`; an unmapped source yields `SOURCE_AUTHORITY_UNDEFINED` and remains Registry-ineligible. These production admission rules are stricter than the frozen Contract where appropriate, without changing Contract 2.1.2 or Observation Policy 1.0. A `sourcePublishedAt` later than `observedAt` yields `TIME_ORDER_POLICY_UNDEFINED`, surfaced without an invented ordering rule.

## Parser audit and authority boundary

The README-designated script-manager parsers are intended candidates, not confirmed production authorities. Runtime scheduling remains unverified. AI, DEV, APP and SEC each have a second mac-env-sync implementation; the App LaunchAgent points to that second copy. These four Radar production integrations are blocked with `RADAR_IMPLEMENTATION_AUTHORITY_UNDEFINED` until Phase 5A.6.5 resolves which parser/config is authoritative. Skill has one inspected implementation, but scheduler activation is still unverified.

| Radar / source family | Item URL | Publication time | Audit result |
| --- | --- | --- | --- |
| AI RSS/Atom (TechCrunch, official feeds) | item link parsed and printed | pubDate/published parsed and printed | available; current Markdown boundary drops typed structure |
| HuggingFace papers/models | item/model URL emitted | papers timestamp available; models often absent | source-dependent; missing time is allowed |
| GitHub AI repositories / OpenRouter | upstream html_url or API item URL | not consistently exposed | URL available on parsed records, publication time often unavailable |
| arXiv | item id/link printed | published parsed | available; Markdown-only boundary |
| DEV GitHub Trending / HN / Show HN | repository or item URL emitted | trending/count feeds have none; HN has API timestamps | mixed; metrics sources cannot yield item publication time |
| DEV Marketplace / changelogs/releases | extension/release URL emitted | parser-dependent | available where upstream field exists |
| DEV npm Downloads | package API is aggregate counts | not an item publication record | `FIELD_NOT_AVAILABLE_FROM_SOURCE` |
| Skill Skills.sh | item href when extracted; fallback previously used aggregate trending URL | no item time | fallback URL corrected to empty; receipt-only if missing |
| Skill Linkly / GitHub | item href/html_url retained in snapshot | not consistently available | candidate URL available for individual source rows; merged multi-source row cannot be treated as one Observation |
| Skill OfficialSkills / ClawHub / SkillsMP / LobeHub | varies by CLI/page output | not consistently available | must preserve per-source row; aggregate-only rows remain receipt-only |
| APP RSS feeds (Product Hunt, 少数派, 小众软件) | RSS link parsed | published/updated parsed | available; typed handoff still needs to use raw parser output |
| APP HN | item URL available | API timestamps may exist | parser-dependent |
| APP GitHub Trending | repository URL emitted | not available from daily ranking | item URL available, publication time unavailable |
| APP AlternativeTo | source exposes `urlName`, parser forms site permalink | no item time | source-derived slug; retain only where slug is explicitly present |
| SEC NVD | feed has third-party references but no NVD item permalink | NVD published field available | references remain labeled as references; never misattribute them as the NVD item URL |
| SEC GitHub Advisories | upstream `html_url` available | `published_at` available | parser had labeled URL as `reference`; output normalized to `url` |
| SEC CISA KEV | feed entry has CVE/dateAdded but no item permalink | dateAdded is available | `FIELD_NOT_AVAILABLE_FROM_SOURCE` for item URL; no URL is fabricated |
| SEC FIRST EPSS | aggregate probability API keyed by CVE | no publication timestamp | no item evidence URL/time; cannot become Registry Observation alone |
| SEC HN | story URL or HN item URL | API timestamp available | available when parser preserves item row |

`FIELD_AVAILABLE_AND_DROPPED` applies to parser metadata that is already upstream and parsed but only rendered into prose/Markdown (notably RSS links/timestamps and SEC reference fields). `FIELD_NOT_AVAILABLE_FROM_SOURCE` applies to aggregate feeds such as npm downloads, daily GitHub Trending timestamps, FIRST EPSS and CISA item permalinks. A future adapter must preserve the former and must not synthesize the latter.

## Processing order

1. Parser provides a raw item row with source name, upstream item URL, optional publication time, and event facts.
2. `normalizeEvidence` applies static source mapping and validates evidence.
3. Ineligible candidates may be included in diagnostic receipts only; no Event/Observation identity is prepared.
4. `prepareEvidenceCommit` calls the frozen Event Identity and Observation Identity engines and returns the atomic Registry request shape.
5. Integration boundary ends before `RegistryLayer.commitObservation`.

Synthetic UPDATE behavior remains governed only by Event Policy 1.0's frozen fingerprint fields. This module does not add material fields or decide Event state.
