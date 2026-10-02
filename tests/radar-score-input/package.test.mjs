import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyCandidatePackage, verifyFrozenScorePolicyPackage, PACKAGE_SERIALIZATION } from '../../scripts/verify-score-policy-v2.1-package.mjs';
import { verifyActionSpace } from '../../scripts/verify-score-policy-v2.1-actions.mjs';
import { decideAction } from '../../scripts/verify-score-policy-v2.1-actions.mjs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { evaluateRadarPolicy } from '../../src/lib/radar-intelligence/score-policy.ts';

const require = createRequire(new URL('../../package.json', import.meta.url));
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (x) => `${JSON.stringify(x, null, 2)}\n`;
const packageRoot = resolve(new URL('../../vendor/horizon-policies/radar/score/2.1.0', import.meta.url).pathname);

async function makePackage() {
  const root = await mkdtemp(join(tmpdir(), 'score-policy-v21-package-'));
  const names = Array.from({ length: 11 }, (_, i) => `payload-${String(i + 1).padStart(2, '0')}.json`);
  const payloads = [];
  for (const name of names) {
    const bytes = Buffer.from(json({ name, status: 'DRAFT' }));
    await writeFile(join(root, name), bytes);
    payloads.push({ path: name, role: 'SCHEMA', version: '2.1.0-candidate', sha256: hash(bytes) });
  }
  const manifest = { artifact: 'score-policy-v2.1.0', packageVersion: '2.1.0-candidate', status: 'DRAFT', artifacts: payloads };
  const manifestBytes = Buffer.from(json(manifest));
  await writeFile(join(root, 'radar-score-policy-v2.1.0-manifest.json'), manifestBytes);
  const integrity = { packageIdentity: manifest.artifact, packageVersion: manifest.packageVersion, manifestFilename: 'radar-score-policy-v2.1.0-manifest.json', manifestSha256: hash(manifestBytes), payloadCount: 11, serialization: PACKAGE_SERIALIZATION };
  await writeFile(join(root, 'package-integrity.json'), Buffer.from(json(integrity)));
  return { root, names };
}

test('package path resolution and hash verification succeeds for 11 payloads', async () => {
  const { root } = await makePackage();
  try { assert.deepEqual(await verifyCandidatePackage(root), { status: 'PASS', payloadCount: 11, resolved: 11, failures: [] }); }
  finally { await rm(root, { recursive: true, force: true }); }
  const result = await verifyFrozenScorePolicyPackage(packageRoot);
  assert.deepEqual(result, { status: 'PASS', payloadCount: 11, resolved: 11, failures: [] });
  const manifest = JSON.parse(await readFile(join(packageRoot, 'radar-score-policy-v2.1.0-manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'FROZEN');
  assert.equal(manifest.artifacts.length, 11);
  assert.equal(manifest.compatibilityResult, 'PASS_BY_PINNED_REGRESSION_EVIDENCE');
  const replay = JSON.parse(await readFile(join(packageRoot, 'radar-score-replay-v2.0.1-compatibility.json'), 'utf8'));
  const scorePolicy = JSON.parse(await readFile(join(packageRoot, 'radar-score-policy-v2.1.0.json'), 'utf8'));
  const actionPolicy = JSON.parse(await readFile(join(packageRoot, 'radar-action-decision-policy-v2.1.0.json'), 'utf8'));
  assert.equal(replay.fixtures.length, 50);
  for (const fixture of replay.fixtures) {
    const scored = evaluateRadarPolicy(fixture);
    const input = fixture.input;
    const weighted = Object.entries(scorePolicy.scoreCalculation.weights).reduce((sum, [dimension, weight]) => {
      const value = dimension === 'relevance' ? scorePolicy.scoreCalculation.relevanceMap[input.relevanceLevel] : input[dimension];
      return sum + value * weight;
    }, 0);
    const baseScore = Math.floor(weighted * 10);
    const directBonus = input.relevanceLevel === 'DIRECT' && (input.impact >= 7 || input.actionability >= 7)
      ? Math.min(scorePolicy.directBonus.value, scorePolicy.directBonus.cap) : 0;
    assert.equal(scored.baseScore, baseScore, `baseScore ${fixture.id}`);
    assert.equal(scored.directBonus, directBonus, `directBonus ${fixture.id}`);
    assert.equal(scored.modifier, fixture.radarModifier, `modifier ${fixture.id}`);
    assert.equal(scored.finalScore, Math.max(0, Math.min(100, baseScore + directBonus + input.radarModifier)), `finalScore ${fixture.id}`);
    assert.equal(scored.finalScore, fixture.finalScore, `replay score ${fixture.id}`);
    assert.equal(scored.signal, fixture.signal, `replay signal ${fixture.id}`);
    assert.equal(scored.action, fixture.action, `replay action ${fixture.id}`);
    assert.equal(scored.filtered, fixture.filtered, `replay filter ${fixture.id}`);
    assert.equal(scored.filterReason, fixture.filterReason, `replay filter reason ${fixture.id}`);
    const eventType = input.eventType;
    const eventClass = actionPolicy.eventClassMapping.historicalScore2Adapter.FIRST_DISCOVERY.includes(eventType)
      ? 'FIRST_DISCOVERY'
      : actionPolicy.eventClassMapping.historicalScore2Adapter.VERSION_RELEASE.includes(eventType) ? 'VERSION_RELEASE' : 'OTHER';
    assert.equal(decideAction({ signal: scored.signal, eventClass, risk: input.risk, priorValidation: input.priorValidation,
      relevanceLevel: input.relevanceLevel, relevanceScore: input.relevanceScore, actionability: input.actionability,
      impact: input.impact, confidence: input.confidence }), fixture.action, `2.1 action ${fixture.id}`);
  }
});

test('package validator classifies path, escape, duplicate, hash, and undeclared failures', async () => {
  const { root, names } = await makePackage();
  try {
    const manifestPath = join(root, 'radar-score-policy-v2.1.0-manifest.json');
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));
    const mutateAndCheck = async (mutate, expected) => {
      const manifest = structuredClone(original); mutate(manifest);
      const bytes = Buffer.from(json(manifest)); await writeFile(manifestPath, bytes);
      const integrity = JSON.parse(await readFile(join(root, 'package-integrity.json'), 'utf8'));
      integrity.manifestSha256 = hash(bytes); integrity.payloadCount = manifest.artifacts.length;
      await writeFile(join(root, 'package-integrity.json'), Buffer.from(json(integrity)));
      const result = await verifyCandidatePackage(root);
      assert.ok(result.failures.some((failure) => failure.code === expected), `${expected}: ${JSON.stringify(result.failures)}`);
    };
    await mutateAndCheck((m) => { m.artifacts[0].path = 'absent.json'; }, 'PATH_NOT_FOUND');
    await mutateAndCheck((m) => { m.artifacts[0].path = '../escape.json'; }, 'PATH_ESCAPE');
    await mutateAndCheck((m) => { m.artifacts[1].path = m.artifacts[0].path; }, 'DUPLICATE_PAYLOAD');
    await mutateAndCheck((m) => { m.artifacts[0].sha256 = '0'.repeat(64); }, 'HASH_MISMATCH');
    await writeFile(join(root, 'undeclared.json'), '{}');
    await writeFile(manifestPath, Buffer.from(json(original)));
    await writeFile(join(root, 'package-integrity.json'), Buffer.from(json({ packageIdentity: original.artifact, packageVersion: original.packageVersion, manifestFilename: 'radar-score-policy-v2.1.0-manifest.json', manifestSha256: hash(Buffer.from(json(original))), payloadCount: 11 })));
    assert.ok((await verifyCandidatePackage(root)).failures.some((failure) => failure.code === 'UNDECLARED_PAYLOAD'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('outer integrity is deterministic and binds manifest bytes without a cycle', async () => {
  const { root } = await makePackage();
  try {
    const bytes = await readFile(join(root, 'package-integrity.json'));
    const x = JSON.parse(bytes); const manifestBytes = await readFile(join(root, x.manifestFilename));
    assert.equal(x.manifestSha256, hash(manifestBytes));
    assert.equal(x.serialization, PACKAGE_SERIALIZATION);
    assert.equal(bytes.toString('utf8'), json(x));
    const regenerated = Buffer.from(json({ ...x })); assert.deepEqual(regenerated, bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('package generator emits byte-identical manifest and integrity from unchanged inputs', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'score-policy-v21-build-'));
  const a = join(parent, 'a'); const b = join(parent, 'b');
  const builder = resolve(new URL('../../scripts/build-score-policy-v2.1-conformance.mjs', import.meta.url).pathname);
  try {
    execFileSync(process.execPath, [builder, a], { stdio: 'ignore' });
    execFileSync(process.execPath, [builder, b], { stdio: 'ignore' });
    for (const actual of ['radar-score-policy-v2.1.0-manifest.json', 'package-integrity.json']) {
      assert.deepEqual(await readFile(join(a, actual)), await readFile(join(b, actual)), actual);
    }
    assert.deepEqual(readdirSync(a).sort(), readdirSync(b).sort());
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('typed provenance schema and calibration schema compile; labels remain separate', async () => {
  const provenance = JSON.parse(await readFile(join(packageRoot, 'radar-score-input-provenance-schema-v2.1.json'), 'utf8'));
  const calibration = JSON.parse(await readFile(join(packageRoot, 'radar-score-calibration-dataset-schema-v2.1.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv);
  const validate = ajv.compile(provenance); const validateCalibration = ajv.compile(calibration);
  const base = { field: 'impact', value: 7, generationMethod: 'MODEL_JUDGMENT', authority: 'SCORE_INPUT_RUBRIC_1.0', rubricVersion: '1.0', modelId: 'm', provider: 'p', generationConfigRef: 'cfg', generationConfidence: 0.9, sourceEvidence: [{ evidenceRef: 'e', sourceAuthority: 'official' }], observedAtRelationship: 'SOURCE_EVIDENCE', generatedAt: '2026-09-30T00:00:00Z' };
  assert.equal(validate(base), true);
  assert.equal(validate({ ...base, field: 'relevanceLevel', value: { arbitrary: true } }), false);
  assert.equal(validate({ ...base, field: 'mystery', value: 1 }), false);
  const dim = { value: 7, evidenceRefs: ['evidence:ground-truth'] };
  const caseBase = {
    candidateIdentity: { entity: 'example.entity' },
    evidenceProvenanceSnapshot: { candidateObservation: { observationId: 'obs-1', observedAt: '2026-09-30T00:00:00Z' }, sourceEvidence: [{ evidenceRef: 'source:1', sourceAuthority: 'official' }] },
    INPUT_GROUND_TRUTH: { relevance: { level: 'DIRECT', evidenceRefs: ['source:1'] }, impact: dim, actionability: dim, confidence: dim, novelty: dim, momentum: dim, risk: { level: 'normal', evidenceRefs: ['source:1'] } },
    EXPECTED_POLICY_OUTPUT: { expectedScore: 80, expectedSignal: 'high', expectedAction: 'read', expectedFilter: { filtered: false, filterReason: null }, expectedEventState: 'NEW' },
    labelStatus: 'UNLABELED', reviewers: [{ reviewer: 'r1', reviewedAt: '2026-09-30T00:00:00Z', labelStatus: 'UNLABELED', notes: '' }, { reviewer: 'r2', reviewedAt: '2026-09-30T00:00:00Z', labelStatus: 'UNLABELED', notes: '' }],
  };
  const radars = ['AI', 'DEV', 'APP', 'SEC', 'SKILL'];
  const dataset = radars.flatMap((radar) => Array.from({ length: 6 }, (_, i) => ({ ...structuredClone(caseBase), radar, caseId: `CAL-${radar}-${String(i + 1).padStart(2, '0')}` })));
  assert.equal(validateCalibration(dataset), true, JSON.stringify(validateCalibration.errors));
  dataset[0].INPUT_GROUND_TRUTH.expectedSignal = 'high';
  assert.equal(validateCalibration(dataset), false, 'expected output cannot be moved into ground truth');
});

test('authority map covers consumed policy inputs once and excludes policy outputs', async () => {
  const policy = JSON.parse(await readFile(join(packageRoot, 'radar-score-input-generation-policy-v2.1.0.json'), 'utf8'));
  const rows = policy.authorityMap.consumedScoreInputs;
  const counts = new Map(); for (const row of rows) counts.set(row.field, (counts.get(row.field) ?? 0) + 1);
  const classifiedInputSet = new Set([...policy.requiredFields, ...policy.conditionalFields]);
  assert.deepEqual([...counts.keys()].sort(), [...classifiedInputSet].sort());
  assert.ok(rows.every((row) => row.primaryAuthority && row.valueDomain && row.classification));
  assert.ok([...counts.values()].every((count) => count === 1));
  assert.deepEqual(policy.authorityMap.outputsExcluded, ['baseScore', 'directBonus', 'finalScore', 'signal', 'filtered', 'filterReason', 'action', 'eventState']);
  assert.equal(policy.authorityMap.competingPrimaryAuthorities, 0);
  assert.equal(policy.authorityMap.missingAuthorities, 0);
  assert.equal(policy.authorityMap.unknownAuthorityEntries, 0);
  const ownership = policy.authorityMap.classificationDefinitions.OUTPUT_OWNERSHIP;
  assert.match(ownership.eventIdentityState, /^Event Policy 1\.0/);
  assert.match(ownership.observationIdentity, /^Observation Policy 1\.0/);
  assert.match(ownership.persistentRows, /^Registry Policy 1\.0/);
  assert.match(ownership.calibration, /^Calibration Dataset/);
  assert.equal(new Set(Object.values(ownership)).size, Object.keys(ownership).length);
});

test('independent Action Decision recomputation preserves exhaustive deltas and ADOPT guards', async () => {
  const result = await verifyActionSpace();
  assert.deepEqual(result, {
    combinationCount: 48384, deterministic: true, historicalMatrixDelta: 8488, historicalEngineDelta: 4520,
    intentionalSemanticDelta: 288, unknownDelta: 0, unintendedDelta: 0,
    adopt: { historicalMatrix: 72, historicalEngine: 16, previousCandidate: 8, finalCandidate: 8 }, p07Rows: 288, p07ViolationCount: 0,
  });
});

test('all 50 Action Boundary Fixtures match the final reviewed ordered rules', async () => {
  const set = JSON.parse(await readFile(join(packageRoot, 'radar-action-boundary-fixtures-v2.1.0.json'), 'utf8'));
  assert.equal(set.cases.length, 50);
  for (const fixture of set.cases) assert.equal(decideAction(fixture.actionPolicyInput), fixture.expected.proposedAction, fixture.fixtureId);
});

test('all 23 priorValidation lifecycle fixtures match deterministic human-only transitions', async () => {
  const fixtureSet = JSON.parse(await readFile(join(packageRoot, 'radar-prior-validation-lifecycle-fixtures-v1.0.json'), 'utf8'));
  assert.equal(fixtureSet.cases.length, 23);
  const transition = (fixture) => {
    const trigger = fixture.inputTrigger;
    if (trigger === 'CONFLICTING_ACTIVE_RECORDS') return 'UNRESOLVED';
    if (trigger.startsWith('EXPLICIT_HUMAN_VALIDATION') || trigger.startsWith('EXPLICIT_HUMAN_REVALIDATION')) return 'ACTIVE';
    if (/SECURITY_REGRESSION|ACTIVE_EXPLOITATION/.test(trigger)) return 'REVOKED';
    if (/MAJOR_VERSION_CHANGE|MAJOR_CAPABILITY_CHANGE|LICENSE_CHANGE|PRICE_EXCEEDS|MATERIAL_API_AVAILABILITY_CHANGE|MATERIAL_OWNERSHIP_OR_MAINTAINER_CHANGE/.test(trigger)) return 'STALE';
    return fixture.initialStatus;
  };
  for (const fixture of fixtureSet.cases) {
    const actual = transition(fixture);
    assert.equal(actual, fixture.expectedStatus, fixture.fixtureId);
    const expectedProjection = actual === 'UNRESOLVED' ? null : actual === 'ACTIVE';
    assert.equal(fixture.expectedPriorValidation, expectedProjection, `${fixture.fixtureId} projection`);
    if (fixture.initialStatus === 'NONE' && actual === 'ACTIVE') assert.match(fixture.inputTrigger, /^EXPLICIT_HUMAN_/);
  }
});
