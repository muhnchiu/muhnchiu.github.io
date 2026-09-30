import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RADAR_CANONICAL_TOPIC_SET } from '../src/lib/radar-topics.ts';
import { shouldBlockRadarBuild, validateRadarSemantics } from '../src/lib/radar-validator.ts';
import { normalizeRadar } from '../vendor/horizon-contracts/radar/v2/normalize.mjs';
import { normalizeRadarV21 } from '../vendor/horizon-contracts/radar/v2/2.1.2/normalize.mjs';
import { normalizeRadarForContract } from '../src/lib/radar-contract-dispatch.ts';

const fixturePath = new URL('../vendor/horizon-contracts/radar/v2/fixtures/v2/v2-nested-source-publish-false.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const canonicalTopics = RADAR_CANONICAL_TOPIC_SET;
const codes = (result) => result.errors.map(({ code }) => code);

test('valid V2 passes with an explicit score-policy warning', () => {
  const result = validateRadarSemantics(normalizeRadar(fixture), canonicalTopics);
  assert.equal(result.valid, true);
  assert.equal(result.skipped, false);
  assert.ok(result.warnings.some(({ code }) => code === 'SCORE_POLICY_UNDEFINED'));
});

test('count semantics enforce signal, high signal, actionable, and actionRequired alias', () => {
  assert.ok(codes(validateRadarSemantics({ ...fixture, signalCount: 2 }, canonicalTopics)).includes('RADAR_COUNT_MISMATCH'));
  assert.ok(codes(validateRadarSemantics({ ...fixture, highSignalCount: 0 }, canonicalTopics)).includes('HIGH_SIGNAL_COUNT_MISMATCH'));
  assert.ok(codes(validateRadarSemantics({ ...fixture, actionableCount: 1 }, canonicalTopics)).includes('ACTIONABLE_COUNT_MISMATCH'));
  assert.ok(codes(validateRadarSemantics({ ...fixture, actionRequired: 0 }, canonicalTopics)).includes('ACTION_REQUIRED_MISMATCH'));
});

test('primary/related Radar ownership rules are enforced', () => {
  const mismatch = { ...fixture, highlights: [{ ...fixture.highlights[0], primaryRadar: 'ai' }, ...fixture.highlights.slice(1)] };
  assert.ok(codes(validateRadarSemantics(mismatch, canonicalTopics)).includes('PRIMARY_RADAR_MISMATCH'));
  const self = { ...fixture, highlights: [{ ...fixture.highlights[0], relatedRadars: ['dev'] }, ...fixture.highlights.slice(1)] };
  assert.ok(codes(validateRadarSemantics(self, canonicalTopics)).includes('RELATED_RADAR_SELF_REFERENCE'));
  const duplicate = { ...fixture, highlights: [{ ...fixture.highlights[0], relatedRadars: ['ai', 'ai'] }, ...fixture.highlights.slice(1)] };
  assert.ok(codes(validateRadarSemantics(duplicate, canonicalTopics)).includes('RELATED_RADAR_DUPLICATE'));
});

test('event chronology must be ordered and not extend beyond report date', () => {
  const withHighlight = (change) => ({ ...fixture, highlights: [{ ...fixture.highlights[0], ...change }, ...fixture.highlights.slice(1)] });
  assert.ok(codes(validateRadarSemantics(withHighlight({ firstSeen: '2026-09-25', lastSeen: '2026-09-24' }), canonicalTopics)).includes('EVENT_DATE_INVALID'));
  assert.ok(codes(validateRadarSemantics(withHighlight({ firstSeen: '2026-09-25', lastSeen: '2026-09-25' }), canonicalTopics)).includes('EVENT_DATE_INVALID'));
});

test('unsafe source URLs and noncanonical topics are rejected', () => {
  for (const url of ['file:///etc/passwd', 'http://localhost/source', 'http://127.0.0.1/source', '/Users/private/source']) {
    const unsafe = { ...fixture, highlights: [{ ...fixture.highlights[0], source: { ...fixture.highlights[0].source, url } }, ...fixture.highlights.slice(1)] };
    assert.ok(codes(validateRadarSemantics(unsafe, canonicalTopics)).includes('SOURCE_URL_UNSAFE'), url);
  }
  const unknown = { ...fixture, topics: ['unknown-topic'] };
  assert.ok(codes(validateRadarSemantics(unknown, canonicalTopics)).includes('UNKNOWN_CANONICAL_TOPIC'));
});

test('whyItMatters must be present and distinct from its display title', () => {
  const first = fixture.highlights[0];
  const empty = { ...fixture, highlights: [{ ...first, whyItMatters: '  ' }, ...fixture.highlights.slice(1)] };
  assert.ok(codes(validateRadarSemantics(empty, canonicalTopics)).includes('WHY_IT_MATTERS_EMPTY'));
  const duplicate = { ...fixture, highlights: [{ ...first, whyItMatters: first.title }, ...fixture.highlights.slice(1)] };
  assert.ok(codes(validateRadarSemantics(duplicate, canonicalTopics)).includes('WHY_IT_MATTERS_DUPLICATE'));
});

test('publish:false is preserved, V1 skips V2 rules, and no score threshold is invented', () => {
  const valid = validateRadarSemantics(fixture, canonicalTopics);
  assert.equal(fixture.publish, false);
  assert.equal(valid.valid, true);
  const v1 = { schemaVersion: undefined, sourceSchemaVersion: 1, signalCount: 100, highSignalCount: 99, actionRequired: 88, highlights: [] };
  const legacy = validateRadarSemantics(v1, canonicalTopics);
  assert.equal(legacy.valid, true);
  assert.equal(legacy.skipped, true);

  const invalidPublished = validateRadarSemantics({ ...fixture, signalCount: 99, publish: true }, canonicalTopics);
  assert.equal(shouldBlockRadarBuild(invalidPublished, true), true);
  assert.equal(shouldBlockRadarBuild(invalidPublished, false), false);

  const unusualScoreSignal = { ...fixture, highlights: [{ ...fixture.highlights[0], score: 1 }, ...fixture.highlights.slice(1)] };
  const scoreResult = validateRadarSemantics(unusualScoreSignal, canonicalTopics);
  assert.equal(scoreResult.errors.some(({ code }) => code === 'SCORE_POLICY_MISMATCH'), false);
  assert.ok(scoreResult.warnings.some(({ code }) => code === 'SCORE_POLICY_UNDEFINED'));
});

test('event keys cannot be copied verbatim from display titles', () => {
  const first = fixture.highlights[0];
  const copied = { ...fixture, highlights: [{ ...first, title: 'same release', eventKey: 'same-release' }, ...fixture.highlights.slice(1)] };
  assert.ok(codes(validateRadarSemantics(copied, canonicalTopics)).includes('EVENT_KEY_TITLE_DERIVED'));
});

test('Contract 2.0 retains the legacy Event model and does not require Event Identity fields', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/v2-legacy-event-model.json', import.meta.url), 'utf8'));
  const normalized = normalizeRadarForContract(fixture, '2.0.0');
  const result = validateRadarSemantics(normalized, canonicalTopics);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.skipped, false);
  assert.equal(normalized.highlights[0].eventType, 'release');
  assert.equal(normalized.highlights[0].canonicalEventType, undefined);
});

test('Contract 2.1.2 uses the Event Identity Model 1.0 invariants', () => {
  const v21Path = new URL('../vendor/horizon-contracts/radar/v2/2.1.2/fixtures/v2.1/valid-events.json', import.meta.url);
  const v21 = JSON.parse(readFileSync(v21Path, 'utf8'));
  const normalized = normalizeRadarV21(v21);
  const result = validateRadarSemantics(normalized, canonicalTopics);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.skipped, false);

  const invalidState = structuredClone(normalized);
  invalidState.highlights[0].duplicate = true;
  const rejected = validateRadarSemantics(invalidState, canonicalTopics);
  assert.ok(codes(rejected).includes('EVENT_STATE_INVARIANT'));
  assert.equal(shouldBlockRadarBuild(rejected, true), true);
});

test('Contract 2.1.2 keeps report date separate from each observation and source timestamp', () => {
  const v21Path = new URL('../vendor/horizon-contracts/radar/v2/2.1.2/fixtures/v2.1/valid-events.json', import.meta.url);
  const v21 = JSON.parse(readFileSync(v21Path, 'utf8'));
  const normalized = normalizeRadarV21(v21);
  assert.equal(normalized.date, '2026-09-29');
  assert.equal(normalized.highlights[0].observedAt, '2026-09-29T08:45:00+08:00');
  assert.equal(normalized.highlights[0].sources[0].sourcePublishedAt, '2026-09-28T19:00:00+08:00');
  assert.equal(normalized.highlights[0].eventOccurredAt, '2026-09-28T18:00:00+08:00');
});
