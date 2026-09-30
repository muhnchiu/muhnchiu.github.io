import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { normalizeRadar, normalizeRadarV1, normalizeRadarV2 } from '../vendor/horizon-contracts/radar/v2/normalize.mjs';
import { normalizeRadarV21 } from '../vendor/horizon-contracts/radar/v2/2.1.1/normalize.mjs';
import { validateRadarV21Semantics } from '../vendor/horizon-contracts/radar/v2/2.1.1/validator.mjs';
import { normalizeRadarV21 as normalizeRadarV212 } from '../vendor/horizon-contracts/radar/v2/2.1.2/normalize.mjs';
import { validateRadarV21Semantics as validateRadarV212Semantics } from '../vendor/horizon-contracts/radar/v2/2.1.2/validator.mjs';
import { normalizeRadarForContract } from '../src/lib/radar-contract-dispatch.ts';

const base = new URL('../vendor/horizon-contracts/radar/v2/', import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, base), 'utf8'));
const v1 = readJson('fixtures/v1/v1-legacy-signals.json');
const v1Explore = readJson('fixtures/v1/v1-explore-publish-false.json');
const v2 = readJson('fixtures/v2/v2-nested-source-publish-false.json');
const schema = readJson('radar-v2.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
ajv.addKeyword('x-radar-count-semantics');
const validateV2 = ajv.compile(schema);
const v21Base = new URL('../vendor/horizon-contracts/radar/v2/2.1.1/', import.meta.url);
const readV21Json = (path) => JSON.parse(readFileSync(new URL(path, v21Base), 'utf8'));
const v21 = readV21Json('fixtures/v2.1/valid-events.json');
const v21Schema = readV21Json('radar-v2.schema.json');
const validateV21 = ajv.compile(v21Schema);
const v212Base = new URL('../vendor/horizon-contracts/radar/v2/2.1.2/', import.meta.url);
const readV212Json = (path) => JSON.parse(readFileSync(new URL(path, v212Base), 'utf8'));
const v212 = readV212Json('fixtures/v2.1/valid-events.json');
const v212Schema = readV212Json('radar-v2.schema.json');
const validateV212 = ajv.compile(v212Schema);
const v210Base = new URL('../vendor/horizon-contracts/radar/v2/2.1.0/', import.meta.url);
const v210Schema = JSON.parse(readFileSync(new URL('radar-v2.schema.json', v210Base), 'utf8'));
const validateV210 = ajv.compile(v210Schema);
const localV20 = JSON.parse(readFileSync(new URL('./fixtures/v2-legacy-event-model.json', import.meta.url), 'utf8'));
const distributedV20 = readV21Json('fixtures/compatibility/v2-legacy-event-model.json');

test('shared V1 fixtures normalize and preserve legacy counts/actions', () => {
  const normalized = normalizeRadarV1(v1);
  assert.equal(normalized.sourceSchemaVersion, 1);
  assert.equal(normalized.countSemantics, 'v1-legacy');
  assert.equal(normalized.signalCount, v1.signalCount);
  assert.equal(normalized.highlights[0].signal, 'high');
  assert.equal(normalized.highlights[0].action, 'adopt');
  assert.equal(normalizeRadar(v1Explore).highlights[0].action, 'read');
  assert.equal(normalizeRadar(v1Explore).publish, false);
});

test('shared V2 fixture validates and normalizes nested sources/publish:false', () => {
  assert.equal(validateV2(v2), true);
  const normalized = normalizeRadarV2(v2);
  assert.equal(normalized.sourceSchemaVersion, 2);
  assert.equal(normalized.countSemantics, 'v2-highlights');
  assert.equal(normalized.publish, false);
  assert.equal(normalized.highlights[0].sources[0].name, 'ZCode repository');
  assert.deepEqual(normalized.highlights[0].relatedRadars, ['ai']);
});

test('actual Contract 2.0 legacy Event fixture validates against the published 2.0 schema and enum', () => {
  assert.equal(validateV2(localV20), true);
  assert.equal(localV20.highlights[0].eventType, 'release');
  assert.equal(normalizeRadarForContract(localV20, '2.0.0').highlights[0].eventType, 'release');
  assert.equal(normalizeRadarForContract(localV20, '2.0.0').highlights[0].eventKey, 'sample-model-release-v1');
  assert.equal(validateV2({ ...localV20, highlights: [{ ...localV20.highlights[0], eventType: 'model-release' }] }), false);
  assert.throws(() => normalizeRadarForContract(localV20, '2.1.1'));
});

test('corrected distributed compatibility fixture passes the authoritative 2.0 schema', () => {
  assert.equal(validateV2(v2), true, 'authoritative Contract 2.0 fixture');
  assert.equal(validateV2(distributedV20), true, 'distributed Contract 2.0 compatibility fixture');
  assert.equal(distributedV20.highlights[0].eventType, 'release');
  assert.equal(normalizeRadarForContract(distributedV20, '2.0.0').highlights[0].eventType, 'release');
  assert.equal(validateV2({ ...distributedV20, highlights: [{ ...distributedV20.highlights[0], eventType: 'model-release' }] }), false);
});

test('unsupported schema versions and V1-only enums are rejected by the shared normalizer', () => {
  assert.throws(() => normalizeRadar({ ...v2, schemaVersion: 3 }), /Unsupported Radar schemaVersion/);
  assert.equal(validateV2({ ...v2, schemaVersion: 3 }), false);
  assert.equal(validateV2({ ...v2, highlights: [{ ...v2.highlights[0], signal: 'critical' }] }), false);
  assert.equal(validateV2({ ...v2, highlights: [{ ...v2.highlights[0], action: 'action' }] }), false);
  assert.equal(validateV2({ ...v2, highlights: [{ ...v2.highlights[0], action: 'explore' }] }), false);
});

test('malformed nested source, radar, confidence, score type, and unknown fields are rejected', () => {
  const highlight = v2.highlights[0];
  assert.equal(validateV2({ ...v2, highlights: [{ ...highlight, source: 'flat-source' }] }), false);
  assert.equal(validateV2({ ...v2, radar: 'unknown' }), false);
  assert.equal(validateV2({ ...v2, reportConfidence: 'certain' }), false);
  assert.equal(validateV2({ ...v2, highlights: [{ ...highlight, score: '82' }] }), false);
  assert.equal(validateV2({ ...v2, accidentalField: true }), false);
  assert.equal(validateV2({ ...v2, highlights: [{ ...highlight, accidentalField: true }] }), false);
});

test('normalization is deterministic and does not mutate inputs', () => {
  const before = structuredClone(v2);
  assert.deepEqual(normalizeRadar(v2), normalizeRadar(v2));
  assert.deepEqual(v2, before);
});

test('Contract 2.1.1 fixture validates, normalizes event/source times, and keeps date distinct', () => {
  assert.equal(validateV21(v21), true);
  assert.equal(validateRadarV21Semantics(v21).valid, true);
  const normalized = normalizeRadarV21(v21);
  assert.equal(normalized.date, '2026-09-29');
  assert.equal(normalized.highlights[0].eventOccurredAt, '2026-09-28T18:00:00+08:00');
  assert.equal(normalized.highlights[0].sources[0].sourcePublishedAt, '2026-09-28T19:00:00+08:00');
  assert.equal(normalized.highlights[0].observedAt, '2026-09-29T08:45:00+08:00');
  assert.notEqual(normalized.date, normalized.highlights[0].observedAt);
  assert.notEqual(normalized.highlights[0].observedAt, normalized.highlights[0].sources[0].sourcePublishedAt);
  assert.notEqual(normalized.highlights[0].sources[0].sourcePublishedAt, normalized.highlights[0].eventOccurredAt);
  assert.equal(normalized.highlights[0].sources.length, 3);
  assert.equal(normalized.highlights[1].eventOccurredAt, undefined);
  assert.equal(normalized.highlights[1].sources[0].sourcePublishedAt, undefined);
});

test('Contract 2.1.1 invalid fixtures fail schema and semantic validation', () => {
  const invalid = readV21Json('fixtures/v2.1/invalid-cases.json');
  for (const fixture of invalid) {
    if (fixture.expectedError === 'EVENT_KEY_TYPE_MISMATCH') assert.equal(validateV21(fixture.report), true, fixture.name);
    else assert.equal(validateV21(fixture.report), false, fixture.name);
    assert.ok(validateRadarV21Semantics(fixture.report).errors.some(({ code }) => code === fixture.expectedError), fixture.name);
  }
});

test('Contract 2.1.1 accepts dotted identifiers while historical 2.1.0 grammar stays unchanged', () => {
  const report = structuredClone(v21);
  report.highlights[0].eventKey = 'claude-code:version-update:2.1.281';
  report.highlights[0].canonicalEventType = 'version-update';
  assert.equal(validateV21(report), true);
  assert.equal(validateV210(report), false);
  assert.equal(validateRadarV21Semantics(report).valid, true);

  const grammar = readV21Json('fixtures/v2.1/event-key-grammar.json');
  const pattern = new RegExp(v21Schema.$defs.eventKey.pattern);
  for (const fixture of grammar.valid) assert.match(fixture.eventKey, pattern);
  for (const eventKey of grammar.invalid) assert.doesNotMatch(eventKey, pattern);
  assert.deepEqual(grammar.collisionPair, ['claude-code:version-update:2.1.281', 'claude-code:version-update:2-1-281']);
});

test('Contract 2.1.2 accepts F3, F7 and F10 without rewriting frozen event keys', () => {
  const grammar = readV212Json('fixtures/v2.1.2/event-key-grammar.json');
  const oldPattern = new RegExp(v21Schema.$defs.eventKey.pattern);
  const newPattern = new RegExp(v212Schema.$defs.eventKey.pattern);
  const replayKeys = [
    'deepseek-v4.1:model-release:initial',
    'deepseek-v4.1:model-release:initial',
    'glm-5.2-openrouter:pricing-change:pricing',
  ];
  assert.deepEqual(replayKeys, [grammar.valid[0], grammar.valid[0], grammar.valid[1]]);
  for (const eventKey of replayKeys) {
    assert.doesNotMatch(eventKey, oldPattern);
    assert.match(eventKey, newPattern);
  }
  for (const eventKey of grammar.valid) assert.match(eventKey, newPattern, eventKey);
  for (const eventKey of grammar.invalid) assert.doesNotMatch(eventKey, newPattern, eventKey);
  assert.deepEqual(v212Schema.$defs.eventType.enum, v21Schema.$defs.eventType.enum);
  assert.equal(
    v212Schema.$defs.eventKey.pattern.replace('^[a-z0-9][a-z0-9._-]*:', '^[a-z0-9]+(?:-[a-z0-9]+)*:'),
    v21Schema.$defs.eventKey.pattern,
  );

  const normalized = normalizeRadarV212(v212);
  assert.equal(normalized.contractVersion, '2.1.2');
  const deepseek = structuredClone(v212);
  deepseek.highlights[0].entity = 'deepseek-v4.1';
  deepseek.highlights[0].eventKey = replayKeys[0];
  assert.equal(validateV212(deepseek), true);
  assert.equal(validateRadarV212Semantics(deepseek).valid, true);
  assert.equal(normalizeRadarV212(deepseek).highlights[0].eventKey, replayKeys[0]);
});

test('V1, Contract 2.0, 2.1.1 and 2.1.2 dispatch only through explicit package context', () => {
  const normalizedV1 = normalizeRadarForContract(v1, 'v1');
  assert.equal(normalizedV1.signalCount, v1.signalCount);
  assert.equal(normalizedV1.sourceSchemaVersion, 1);

  const normalizedV20 = normalizeRadarForContract(localV20, '2.0.0');
  assert.equal(normalizedV20.sourceSchemaVersion, 2);
  assert.equal(normalizedV20.highlights[0].eventType, 'release');
  assert.equal(normalizedV20.highlights[0].canonicalEventType, undefined);

  const normalizedV21 = normalizeRadarForContract(v21, '2.1.1');
  assert.equal(normalizedV21.contractVersion, '2.1.1');
  assert.equal(normalizedV21.highlights[0].canonicalEventType, v21.highlights[0].canonicalEventType);
  const normalizedV212 = normalizeRadarForContract(v212, '2.1.2');
  assert.equal(normalizedV212.contractVersion, '2.1.2');
  assert.equal(normalizedV212.highlights[0].canonicalEventType, v212.highlights[0].canonicalEventType);
  const oldGrammarReport = structuredClone(v212);
  oldGrammarReport.highlights[0].entity = 'deepseek-v4.1';
  oldGrammarReport.highlights[0].eventKey = 'deepseek-v4.1:model-release:initial';
  assert.throws(() => normalizeRadarForContract(oldGrammarReport, '2.1.1'), /eventKey/);
  assert.throws(() => normalizeRadarForContract(v1, '2.0.0'), /schemaVersion: 2/);
  assert.throws(() => normalizeRadarForContract(v21, '2.0.0'), /eventType|primaryRadar|entity|firstSeen/);
  assert.throws(() => normalizeRadarForContract(localV20, 'v1'), /versionless V1/);
});
