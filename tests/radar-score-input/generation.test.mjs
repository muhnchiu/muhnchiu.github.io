import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mapSourceEvidence } from '../../src/lib/radar-evidence-pipeline.mjs';
import { generateScoreInputs, dispatchGeneratedScore, scoreInputAuthorityAudit } from '../../src/lib/radar-score-input/generator.ts';
import { runScoreInputProductionDryRun } from '../../src/lib/radar-score-input/dry-run.ts';
import { validateProvenanceRecord } from '../../src/lib/radar-score-input/provenance.ts';
import { CONSUMED_INPUTS, REQUIRED_INPUTS, CONDITIONAL_INPUTS, actionPolicy } from '../../src/lib/radar-score-input/policy.ts';

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/radar-score-input/generation-cases-v1.json', import.meta.url), 'utf8'));
const now = '2026-10-01T01:00:00Z';
const sourceByRadar = { AI: 'OpenAI News', DEV: 'Claude Code Changelog', APP: 'Product Hunt', SEC: 'GitHub Security Advisories', SKILL: 'ClawHub' };
const eventByRadar = { AI: 'model-release', DEV: 'version-update', APP: 'release', SEC: 'security-cve', SKILL: 'skill-release' };

function buildCandidate(radar = 'AI') {
  const sourceName = sourceByRadar[radar];
  const mapped = mapSourceEvidence(sourceName);
  const ref = `source:${radar.toLowerCase()}:1`;
  const evidence = [{ evidenceRef: ref, sourceName, sourceAuthority: mapped.sourceAuthority, sourceUrl: `https://example.org/${radar.toLowerCase()}/item-1`, observedAt: now, description: 'Synthetic fixture evidence for interface conformance.' }];
  const eventType = eventByRadar[radar];
  const entity = `example.${radar.toLowerCase()}`;
  const eventKey = `${entity}:${eventType}:initial`;
  return {
    candidate: {
      radar, sourceName, title: `Synthetic ${radar} item`, sourceUrl: evidence[0].sourceUrl, observedAt: now,
      evidence, version: '1.2.3', capabilityScope: ['read-only'], intendedUsage: 'bounded local evaluation',
      eventIdentity: { entity, canonicalEventType: eventType, eventKey, eventIdentifier: 'initial', evidenceRefs: [ref], identityEngineVersion: '2.1.2' },
    },
    context: {
      generatedAt: now, candidateObservationObservedAt: now, trackedEnvironmentRef: 'fixture-env:v1',
      securityAssessment: { gate: radar === 'SEC' ? 'DIRECTLY_EXPOSED' : 'N/A', ruleId: 'FIXTURE_SECURITY_GATE_RULE_V1', authority: 'SECURITY_GATE_POLICY', evidenceRefs: [ref], policyVersion: '1.0', escalation: { activeExploitation: false, supplyChainImpact: false, reachableDependency: false, officialEmergencyAdvisory: false }, escalationRuleId: 'FIXTURE_SECURITY_ESCALATION_RULE_V1', escalationEvidenceRefs: [ref] },
      priorValidationLookup: { complete: true, healthy: true, authority: 'EXPLICIT_HUMAN_VALIDATION', resolution: 'ACTIVE_MATCH', registryVersion: '1.0', evidenceRefs: [ref], completeLookupReceipt: 'fixture-human-lookup:v1', record: { validationId: 'human-validation-1', recordVersion: '1', validatedBy: 'fixture-human', validatedAt: now, status: 'ACTIVE', entity, validatedVersion: '1.2.3', validatedCapabilities: ['read-only'], validatedUsage: 'bounded local evaluation', validatedEnvironment: 'fixture-env:v1', evidenceRefs: [ref], createdByAuthority: 'EXPLICIT_HUMAN_VALIDATION' } },
      registryResult: { committed: true, registryWriteStatus: 'COMMITTED', eventKey, eventState: 'NEW', duplicate: false, transactionId: 'fixture-tx-1', observationId: 'fixture-observation-1', policyVersion: '1.0' },
    },
  };
}

function provider(valueOverrides = {}) {
  return ({ field, rubricVersion, evidence }) => ({
    value: Object.hasOwn(valueOverrides, field) ? valueOverrides[field] : ({ relevanceLevel: 'DIRECT', impact: 7, actionability: 8, confidence: 8, novelty: 5, momentum: 4, risk: 'normal' })[field],
    rubricVersion, modelId: 'fixture-model-v1', provider: 'offline-fixture', generationConfigRef: 'fixture-rubric:v1',
    generationConfidence: field === 'risk' ? 0.8 : 0.9, evidenceRefs: evidence.map((row) => row.evidenceRef),
  });
}

async function readyCandidate(radar = 'AI', contextEdits = {}, candidateEdits = {}, judgment = provider()) {
  const base = buildCandidate(radar);
  const candidate = { ...base.candidate, ...candidateEdits };
  const context = { ...base.context, ...contextEdits };
  return { candidate, context, result: await generateScoreInputs(candidate, context, judgment) };
}

test('frozen package derives exactly 19 unique inputs and unique authorities', () => {
  assert.equal(scoreInputAuthorityAudit.consumedInputs, 19);
  assert.equal(scoreInputAuthorityAudit.missingAuthority, 0);
  assert.equal(scoreInputAuthorityAudit.competingAuthority, 0);
  assert.equal(scoreInputAuthorityAudit.unknownAuthority, 0);
  assert.equal(new Set(CONSUMED_INPUTS.map((row) => row.field)).size, 19);
  assert.deepEqual(new Set([...REQUIRED_INPUTS, ...CONDITIONAL_INPUTS]), new Set(CONSUMED_INPUTS.map((row) => row.field)));
});

test('complete typed generation returns all 19 inputs, unique authority provenance, and deterministic output', async () => {
  const first = await readyCandidate('AI');
  const second = await readyCandidate('AI');
  assert.equal(first.result.status, 'SCORE_READY', JSON.stringify(first.result.generationFailures));
  assert.equal(Object.keys(first.result.inputs).length, 19);
  assert.equal(Object.keys(first.result.provenance).length, 19);
  assert.deepEqual(first.result, second.result);
  for (const [field, row] of Object.entries(first.result.provenance)) assert.equal(validateProvenanceRecord(row).valid, true, `${field}: ${validateProvenanceRecord(row).errors.join(';')}`);
});

test('all 30 five-Radar conformance fixtures produce their declared disposition', async () => {
  assert.equal(fixture.caseCount, 30);
  assert.equal(fixture.calibrationGroundTruth, 'NOT_PRESENT');
  for (const radar of ['AI', 'DEV', 'APP', 'SEC', 'SKILL']) assert.equal(fixture.cases.filter((row) => row.radar === radar).length, 6);
  for (const row of fixture.cases) {
    const base = buildCandidate(row.radar);
    const candidate = structuredClone(base.candidate);
    const context = structuredClone(base.context);
    if (row.scenario === 'missing-source-evidence') candidate.evidence = [];
    if (row.scenario === 'missing-human-validation') delete context.priorValidationLookup;
    if (row.scenario === 'missing-committed-registry-result') delete context.registryResult;
    if (row.scenario === 'unmapped-source') candidate.sourceName = 'Unknown Source';
    if (row.scenario === 'missing-event-identity') delete candidate.eventIdentity;
    const result = await generateScoreInputs(candidate, context, provider());
    assert.equal(result.status, row.expectedDisposition, `${row.caseId}: ${JSON.stringify(result.generationFailures)}`);
    if (result.status === 'RECEIPT_ONLY') { assert.equal(result.inputs, null); assert.equal(result.provenance, null); }
  }
});

test('every consumed field has individually valid provenance; type, authority, version, evidence, and time failures reject', async () => {
  const { result } = await readyCandidate('AI');
  assert.equal(result.status, 'SCORE_READY');
  for (const row of CONSUMED_INPUTS) {
    const valid = structuredClone(result.provenance[row.field]);
    assert.equal(validateProvenanceRecord(valid).valid, true, `${row.field} valid record`);
    const wrongType = { ...valid, value: null };
    assert.equal(validateProvenanceRecord(wrongType).valid, false, `${row.field} null value`);
    assert.equal(validateProvenanceRecord({ ...valid, authority: 'UNKNOWN' }).valid, false, `${row.field} authority`);
    assert.equal(validateProvenanceRecord({ ...valid, observedAtRelationship: 'UNKNOWN' }).valid, false, `${row.field} observedAt relationship`);
    const versioned = structuredClone(valid);
    delete versioned[versioned.generationMethod === 'MODEL_JUDGMENT' ? 'rubricVersion' : 'policyVersion'];
    assert.equal(validateProvenanceRecord(versioned).valid, false, `${row.field} method version`);
    if (valid.sourceEvidence) assert.equal(validateProvenanceRecord({ ...valid, sourceEvidence: [] }).valid, false, `${row.field} evidence`);
  }
});

test('unknown, unsupported, unversioned, and evidence-free model judgments fail closed', async () => {
  for (const badProvider of [
    () => ({ value: 7, rubricVersion: '', modelId: 'm', provider: 'p', generationConfigRef: 'c', generationConfidence: 0.9, evidenceRefs: ['source:ai:1'] }),
    (request) => ({ ...provider()(request), authority: 'UNSUPPORTED_MODEL_AUTHORITY' }),
    (request) => ({ ...provider()(request), evidenceRefs: [] }),
  ]) {
    const { result } = await readyCandidate('AI', {}, {}, badProvider);
    assert.equal(result.status, 'RECEIPT_ONLY');
    assert.equal(result.inputs, null);
  }
});

test('risk is score-independent, model results must meet frozen level thresholds, and conflicts never fall through', async () => {
  for (const [level, confidence] of [['low', 0.8], ['normal', 0.65], ['high', 0.8]]) {
    const judgment = (request) => ({ ...provider({ risk: level })(request), generationConfidence: confidence });
    const { result } = await readyCandidate('AI', {}, { score: 100000 }, judgment);
    assert.equal(result.status, 'SCORE_READY', `${level}: ${JSON.stringify(result.generationFailures)}`);
    assert.equal(result.inputs.risk, level);
    assert.equal(Object.hasOwn(result.inputs, 'score'), false);
  }
  const conflictProvider = (request) => { if (request.field === 'risk') throw new Error('must not be consulted'); return provider()(request); };
  const conflict = await readyCandidate('AI', { deterministicRiskResolution: { status: 'CONFLICT' } }, {}, conflictProvider);
  assert.equal(conflict.result.status, 'RECEIPT_ONLY');
  assert.ok(conflict.result.receiptOnlyReasons.includes('RISK_UNRESOLVED'));
  assert.ok(!conflict.result.generationFailures.some((row) => row.code === 'MODEL_JUDGMENT_FAILED' && row.field === 'risk'));
  const noEvidence = await readyCandidate('AI', { trackedEnvironmentRef: undefined }, {}, provider());
  assert.equal(noEvidence.result.status, 'RECEIPT_ONLY');
  assert.ok(noEvidence.result.receiptOnlyReasons.includes('RISK_UNRESOLVED'));
});

test('deterministic decisive risk facts precede model judgments and require cited frozen-rule evidence', async () => {
  const judgment = (request) => { assert.notEqual(request.field, 'risk'); return provider()(request); };
  const decisive = await readyCandidate('AI', { deterministicRiskResolution: { status: 'DECISIVE', value: 'high', ruleId: 'RISK_POLICY_1.0_RULE', authority: 'RISK_POLICY_1.0', evidenceRefs: ['source:ai:1'], policyVersion: '1.0' } }, {}, judgment);
  assert.equal(decisive.result.status, 'SCORE_READY');
  assert.equal(decisive.result.inputs.risk, 'high');
  assert.equal(decisive.result.provenance.risk.generationMethod, 'DETERMINISTIC');
});

test('priorValidation is human-only: ACTIVE exact scope true; STALE, REVOKED and no active record false; incomplete/self-created fails', async () => {
  const active = await readyCandidate('AI'); assert.equal(active.result.inputs.priorValidation, true);
  for (const [resolution, status] of [['LATEST_STALE', 'STALE'], ['LATEST_REVOKED', 'REVOKED']]) {
    const base = buildCandidate('AI'); base.context.priorValidationLookup.resolution = resolution; base.context.priorValidationLookup.record.status = status;
    const result = await generateScoreInputs(base.candidate, base.context, provider());
    assert.equal(result.status, 'SCORE_READY', JSON.stringify(result.generationFailures)); assert.equal(result.inputs.priorValidation, false);
  }
  const none = buildCandidate('AI'); Object.assign(none.context.priorValidationLookup, { resolution: 'NO_ACTIVE_RECORD', record: undefined });
  const noneResult = await generateScoreInputs(none.candidate, none.context, provider());
  assert.equal(noneResult.status, 'SCORE_READY', JSON.stringify(noneResult.generationFailures)); assert.equal(noneResult.inputs.priorValidation, false);
  const missing = await readyCandidate('AI', { priorValidationLookup: undefined }); assert.equal(missing.result.status, 'RECEIPT_ONLY');
  const self = buildCandidate('AI'); self.context.priorValidationLookup.record.createdByAuthority = 'RADAR_OUTPUT';
  const selfResult = await generateScoreInputs(self.candidate, self.context, provider()); assert.equal(selfResult.status, 'RECEIPT_ONLY');
});

test('unknown and missing Registry result never synthesizes duplicate', async () => {
  const missing = await readyCandidate('AI', { registryResult: undefined });
  assert.equal(missing.result.status, 'RECEIPT_ONLY');
  assert.ok(missing.result.missingRequiredInputs.includes('duplicate'));
});

test('receipt-only cannot call Score or Action; no Registry or Publisher adapter exists in dispatcher', async () => {
  const { result } = await readyCandidate('AI', { registryResult: undefined });
  let scoreCalls = 0; let actionCalls = 0;
  const dispatched = dispatchGeneratedScore(result, () => { scoreCalls++; return 'scored'; }, () => { actionCalls++; return 'adopt'; });
  assert.equal(dispatched.status, 'RECEIPT_ONLY'); assert.equal(scoreCalls, 0); assert.equal(actionCalls, 0);
});

test('dry production boundary prepares identity only and stops before commitObservation', async () => {
  const c = buildCandidate('AI').candidate;
  const raw = { sourceName: c.sourceName, title: c.title, sourceUrl: c.sourceUrl, sourcePublishedAt: now, evidenceRef: c.evidence[0].evidenceRef, entity: c.eventIdentity.entity, canonicalEventType: c.eventIdentity.canonicalEventType, eventIdentifier: 'initial', eventFacts: { releaseVersion: '1.2.3' }, version: c.version, intendedUsage: c.intendedUsage, capabilityScope: c.capabilityScope };
  const out = await runScoreInputProductionDryRun(raw, { radar: 'ai', observedAt: now, generatedAt: now, structuredHandoffVerified: true, context: { trackedEnvironmentRef: 'fixture-env:v1', securityAssessment: buildCandidate('AI').context.securityAssessment }, judgmentProvider: provider() });
  assert.equal(out.identityPrepared, true); assert.equal(out.observationCommitPrepared, true); assert.equal(out.commitObservationCalled, false);
  assert.equal(out.status, 'RECEIPT_ONLY');
  assert.ok(out.scoreGeneration.receiptOnlyReasons.includes('REGISTRY_RESULT_UNAVAILABLE'));
});

test('Skill and unavailable NVD/CISA item URLs stay receipt-only; no URL is synthesized from references', async () => {
  const skill = await runScoreInputProductionDryRun({}, { radar: 'skill', observedAt: now, generatedAt: now, structuredHandoffVerified: false });
  assert.equal(skill.status, 'RECEIPT_ONLY'); assert.equal(skill.reason, 'SKILL_STRUCTURED_INPUT_UNAVAILABLE'); assert.equal(skill.commitObservationCalled, false);
  for (const sourceName of ['NVD', 'CISA KEV']) {
    const noUrl = await runScoreInputProductionDryRun({ sourceName, title: 'CVE item', references: ['https://third-party.example/advisory'] }, { radar: 'sec', observedAt: now, generatedAt: now, structuredHandoffVerified: true });
    assert.equal(noUrl.status, 'RECEIPT_ONLY'); assert.equal(noUrl.observationCommitPrepared, false); assert.equal(noUrl.commitObservationCalled, false);
  }
});

test('source readiness audit explicitly maps all 19 inputs across five Radars and keeps every current source receipt-only', () => {
  const readiness = JSON.parse(readFileSync(new URL('../../fixtures/radar-score-input/source-readiness-v1.json', import.meta.url), 'utf8'));
  assert.equal(readiness.radarCount, 5);
  assert.equal(readiness.inputCountPerRadar, 19);
  for (const radar of readiness.sourceReadiness) {
    assert.equal(radar.disposition, 'RECEIPT_ONLY');
    assert.equal(radar.inputs.length, 19);
    assert.equal(new Set(radar.inputs.map((row) => row.field)).size, 19);
  }
  assert.equal(readiness.sourceReadiness.find((row) => row.radar === 'SKILL').receiptOnlyReason, 'SKILL_STRUCTURED_INPUT_UNAVAILABLE');
  assert.equal(readiness.constraints.nvdThirdPartyReferencesNotSubstituted, true);
  assert.equal(readiness.constraints.cisaItemUrlNotSynthesized, true);
  assert.equal(readiness.constraints.productionAutoPromotion, 0);
});

test('deterministic relevance and momentum require explicit policy authority, version, rule, and evidence', async () => {
  const base = buildCandidate('AI');
  const explicit = structuredClone(base.context);
  explicit.relevanceResolution = { value: 'DIRECT', ruleId: 'POLICY_RELEVANCE_RULE_V1', evidenceRefs: ['source:ai:1'], policyVersion: '2.1.0', authority: 'SCORE_INPUT_GENERATION_POLICY_2.1.0' };
  explicit.momentumResolution = { value: 4, ruleId: 'POLICY_MOMENTUM_RULE_V1', evidenceRefs: ['source:ai:1'], policyVersion: '2.1.0', authority: 'SCORE_INPUT_GENERATION_POLICY_2.1.0' };
  const result = await generateScoreInputs(base.candidate, explicit, provider());
  assert.equal(result.status, 'SCORE_READY', JSON.stringify(result.generationFailures));
  assert.equal(result.provenance.relevanceLevel.generationMethod, 'DETERMINISTIC');
  assert.equal(result.provenance.momentum.generationMethod, 'DETERMINISTIC');
  explicit.momentumResolution.authority = 'UNSUPPORTED_AUTHORITY';
  const rejected = await generateScoreInputs(base.candidate, explicit, provider());
  assert.equal(rejected.status, 'RECEIPT_ONLY');
  assert.ok(rejected.receiptOnlyReasons.includes('MOMENTUM_RULE_AUTHORITY_INVALID'));
});

test('candidate evidence authority, identity binding, and observation chronology fail closed', async () => {
  const authority = buildCandidate('AI'); authority.candidate.evidence[0].sourceAuthority = 'secondary';
  assert.equal((await generateScoreInputs(authority.candidate, authority.context, provider())).status, 'RECEIPT_ONLY');
  const identity = buildCandidate('AI'); identity.candidate.eventIdentity.eventKey = 'other:event:wrong';
  assert.equal((await generateScoreInputs(identity.candidate, identity.context, provider())).status, 'RECEIPT_ONLY');
  const time = buildCandidate('AI'); time.context.generatedAt = '2026-09-30T00:00:00Z';
  assert.equal((await generateScoreInputs(time.candidate, time.context, provider())).status, 'RECEIPT_ONLY');
});

test('production dry-run evidence records zero promotion, scoring, Registry, and Publisher calls', () => {
  const dry = JSON.parse(readFileSync(new URL('../../fixtures/radar-score-input/production-dry-run-v1.json', import.meta.url), 'utf8'));
  assert.equal(dry.productionRadarExecuted, false);
  assert.equal(dry.radars.length, 5);
  assert.ok(dry.radars.every((row) => row.disposition === 'RECEIPT_ONLY'));
  assert.equal(dry.syntheticBoundaryConformance.partialScoreInputsExposed, false);
  assert.equal(dry.syntheticBoundaryConformance.commitObservationCalled, false);
  assert.equal(dry.productionAutoPromotion, 0);
  assert.equal(dry.registryModified, false);
  assert.equal(dry.publisherRun, false);
});

test('missing item URLs and invalid evidence observation times cannot enter score-ready inputs', async () => {
  for (const sourceName of ['NVD', 'CISA KEV']) {
    const base = buildCandidate('SEC');
    base.candidate.sourceName = sourceName;
    base.candidate.evidence[0].sourceName = sourceName;
    base.candidate.evidence[0].sourceAuthority = mapSourceEvidence(sourceName).sourceAuthority;
    delete base.candidate.evidence[0].sourceUrl;
    const result = await generateScoreInputs(base.candidate, base.context, provider());
    assert.equal(result.status, 'RECEIPT_ONLY');
    assert.ok(result.receiptOnlyReasons.includes('SOURCE_ITEM_URL_MISSING'));
  }
  const badTime = buildCandidate('AI'); delete badTime.candidate.evidence[0].observedAt;
  const result = await generateScoreInputs(badTime.candidate, badTime.context, provider());
  assert.equal(result.status, 'RECEIPT_ONLY');
  assert.ok(result.receiptOnlyReasons.includes('SOURCE_EVIDENCE_OBSERVED_AT_MISSING'));
});
