import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveScoreInputEligibility, dispatchScoreReadyCandidate, REQUIRED_SCORE_INPUT_FIELDS } from '../../src/lib/radar-score-input/eligibility.ts';

const require = createRequire(new URL('../../package.json', import.meta.url));
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const schemaPath = resolve(new URL('../../vendor/horizon-policies/radar/score/2.1.0/radar-score-input-provenance-schema-v2.1.json', import.meta.url).pathname);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateProvenance = schema ? ajv.compile(schema) : null;

const enumValues = {
  radar: 'AI', relevanceLevel: 'DIRECT', relevanceScore: 9, impact: 7, actionability: 8, confidence: 8,
  novelty: 5, momentum: 4, radarModifier: 0, securityGate: 'N/A', risk: 'normal', priorValidation: true,
  duplicate: false, eventType: 'release', eventClass: 'OTHER', entity: 'example.entity', title: 'Example release', sourceAuthority: 'official',
};
const authorities = {
  radar: 'SCORE_INPUT_GENERATION_POLICY_2.1.0', title: 'RADAR_SOURCE_RECORD', entity: 'EVENT_POLICY_1.0',
  relevanceLevel: 'SCORE_INPUT_GENERATION_POLICY_2.1.0', relevanceScore: 'SCORE_POLICY_2.1.0', impact: 'SCORE_INPUT_RUBRIC_1.0',
  actionability: 'SCORE_INPUT_RUBRIC_1.0', confidence: 'SCORE_INPUT_RUBRIC_1.0', novelty: 'SCORE_INPUT_RUBRIC_1.0',
  momentum: 'SCORE_INPUT_GENERATION_POLICY_2.1.0', radarModifier: 'SCORE_POLICY_2.0.1_MODIFIER_RESOLVER',
  securityGate: 'SECURITY_GATE_POLICY', risk: 'RISK_POLICY_1.0', priorValidation: 'HUMAN_VALIDATION_REGISTRY',
  duplicate: 'REGISTRY_POLICY_1.0', eventType: 'EVENT_POLICY_1.0', eventClass: 'ACTION_DECISION_POLICY_2.1.0',
  sourceAuthority: 'HORIZON_SOURCE_AUTHORITY_MAP',
};
const modelFields = new Set(['impact', 'actionability', 'confidence', 'novelty']);
const derivedFields = new Set(['relevanceScore', 'duplicate', 'eventClass']);
const methodFor = (field) => field === 'priorValidation' ? 'HUMAN_AUTHORITY' : modelFields.has(field) ? 'MODEL_JUDGMENT' : derivedFields.has(field) ? 'DERIVED' : 'DETERMINISTIC';
const versionFor = (field) => ({
  radar: '2.1.0', title: '1.0', entity: '2.1.2', relevanceLevel: '2.1.0', relevanceScore: '2.1.0',
  impact: '1.0', actionability: '1.0', confidence: '1.0', novelty: '1.0', momentum: '2.1.0', radarModifier: '2.0.1',
  securityGate: '1.0', risk: '1.0', priorValidation: '1.0', duplicate: '1.0', eventType: '1.0', eventClass: '2.1.0', sourceAuthority: '1.0',
})[field];

function makeCandidate() {
  const inputs = structuredClone(enumValues);
  const provenance = {};
  for (const field of REQUIRED_SCORE_INPUT_FIELDS) {
    const method = methodFor(field);
    const row = {
      field, value: inputs[field], generationMethod: method, authority: authorities[field], generatedAt: '2026-09-30T00:00:00Z',
      observedAtRelationship: method === 'HUMAN_AUTHORITY' ? 'HUMAN_RECORD' : method === 'DERIVED' ? 'DERIVED_FROM_INPUTS' : 'SOURCE_EVIDENCE',
    };
    if (method === 'MODEL_JUDGMENT') Object.assign(row, { rubricVersion: versionFor(field), modelId: 'test-model', provider: 'test-provider', generationConfigRef: 'config:test:v1', generationConfidence: 0.9, sourceEvidence: [{ evidenceRef: `evidence:${field}`, sourceAuthority: 'official' }] });
    else if (method === 'HUMAN_AUTHORITY') Object.assign(row, { policyVersion: versionFor(field), humanValidationRecord: { resolution: 'ACTIVE_MATCH', registryVersion: '1.0', evidenceRefs: ['human:validation:1'] } });
    else if (method === 'DERIVED') Object.assign(row, { policyVersion: versionFor(field), derivedFrom: ['input:source:1'] });
    else Object.assign(row, { policyVersion: versionFor(field), ruleId: `rule:${field}:v1`, sourceEvidence: [{ evidenceRef: `evidence:${field}`, sourceAuthority: 'official' }] });
    provenance[field] = row;
  }
  return { inputs, provenance };
}

test('valid complete candidate is SCORE_READY and typed provenance validates', () => {
  const candidate = makeCandidate();
  for (const [field, row] of Object.entries(candidate.provenance)) assert.equal(validateProvenance(row), true, `${field}: ${JSON.stringify(validateProvenance.errors)}`);
  assert.deepEqual(resolveScoreInputEligibility(candidate), { status: 'SCORE_READY', reasons: [], diagnostics: [] });
});

test('field-discriminated provenance rejects wrong domains, types, ranges, enums, and unknown fields', () => {
  const valid = makeCandidate().provenance.impact;
  for (const bad of [
    { ...valid, value: '7' }, { ...valid, value: 11 }, { ...valid, value: -1 },
    { ...valid, field: 'relevanceLevel', value: { arbitrary: true } },
    { ...valid, field: 'risk', value: 'unknown-risk' }, { ...valid, field: 'notAField', value: 1 },
  ]) assert.equal(validateProvenance(bad), false, JSON.stringify(bad));
});

test('every required input needs provenance; missing record is RECEIPT_ONLY', () => {
  const candidate = makeCandidate(); delete candidate.provenance.impact;
  const result = resolveScoreInputEligibility(candidate);
  assert.equal(result.status, 'RECEIPT_ONLY'); assert.ok(result.reasons.includes('MISSING_PROVENANCE'));
});

test('each deterministic failure class is emitted exactly', () => {
  const cases = [
    ['MISSING_AUTHORITY', (c) => { c.provenance.impact.authority = 'UNKNOWN'; }],
    ['MISSING_VERSION', (c) => { delete c.provenance.impact.rubricVersion; }],
    ['MISSING_EVIDENCE', (c) => { c.provenance.impact.sourceEvidence = []; }],
    ['MISSING_TIME_RELATION', (c) => { delete c.provenance.impact.observedAtRelationship; }],
    ['INVALID_VALUE', (c) => { c.inputs.impact = 11; c.provenance.impact.value = 11; }],
  ];
  for (const [reason, mutate] of cases) { const candidate = makeCandidate(); mutate(candidate); assert.ok(resolveScoreInputEligibility(candidate).reasons.includes(reason), reason); }
});

test('unversioned model judgment is rejected and multiple failures have stable ordering', () => {
  const candidate = makeCandidate(); delete candidate.provenance.impact.rubricVersion; candidate.provenance.impact.sourceEvidence = [];
  delete candidate.provenance.impact.observedAtRelationship; candidate.inputs.impact = 99; candidate.provenance.impact.value = 99;
  const result = resolveScoreInputEligibility(candidate);
  assert.equal(result.status, 'RECEIPT_ONLY');
  assert.deepEqual(result.reasons, ['MISSING_VERSION', 'MISSING_EVIDENCE', 'MISSING_TIME_RELATION', 'INVALID_VALUE']);
});

test('unknown fields fail closed and no partial input set is accepted', () => {
  const unknown = makeCandidate(); unknown.inputs.surprise = 'x';
  assert.equal(resolveScoreInputEligibility(unknown).status, 'RECEIPT_ONLY');
  const partial = makeCandidate(); delete partial.inputs.novelty;
  assert.equal(resolveScoreInputEligibility(partial).status, 'RECEIPT_ONLY');
});

test('RECEIPT_ONLY never invokes score, signal, action, Registry scoring, or publication adapters', () => {
  const candidate = makeCandidate(); delete candidate.provenance.actionability;
  const invoked = [];
  const result = dispatchScoreReadyCandidate(candidate, () => invoked.push('score', 'signal', 'action', 'registry-scoring', 'publication'));
  assert.equal(result.status, 'RECEIPT_ONLY'); assert.deepEqual(invoked, []);
});

test('eligible candidate invokes downstream exactly once and reports no auto-promotion', () => {
  const invoked = []; const result = dispatchScoreReadyCandidate(makeCandidate(), () => { invoked.push('downstream'); return 'accepted'; });
  assert.equal(result, 'accepted'); assert.deepEqual(invoked, ['downstream']);
});
