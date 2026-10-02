import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [, , sourceTablePath, correctedTablePath, escalationMatrixPath, classificationMatrixPath, classificationFixturesPath, escalationFixturesPath, historicalProjectionPath, reviewEvidencePath] = process.argv;
if ([sourceTablePath, correctedTablePath, escalationMatrixPath, classificationMatrixPath, classificationFixturesPath, escalationFixturesPath, historicalProjectionPath, reviewEvidencePath].some((value) => !value)) {
  throw new Error('Usage: node scripts/verify-security-gate-decision-table-v2.mjs <table-v1> <table-v2> <escalation-matrix> <classification-matrix> <classification-fixtures> <escalation-fixtures> <historical-projection> <phase-5a-6-8e-4-review>');
}

const bytes = async (path) => readFile(path);
const readJson = async (path) => JSON.parse(await bytes(path));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const [sourceBytes, correctedBytes, escalationBytes, classificationBytes, classFixtureBytes, escalationFixtureBytes, historyBytes, reviewBytes] = await Promise.all([
  bytes(sourceTablePath), bytes(correctedTablePath), bytes(escalationMatrixPath), bytes(classificationMatrixPath),
  bytes(classificationFixturesPath), bytes(escalationFixturesPath), bytes(historicalProjectionPath), bytes(reviewEvidencePath),
]);
const source = JSON.parse(sourceBytes);
const corrected = JSON.parse(correctedBytes);
const escalation = JSON.parse(escalationBytes);
const classification = JSON.parse(classificationBytes);
const classFixtures = JSON.parse(classFixtureBytes);
const escalationFixtures = JSON.parse(escalationFixtureBytes);
const history = JSON.parse(historyBytes);
const review = JSON.parse(reviewBytes);

assert.equal(source.rows.length, 10012);
assert.equal(corrected.rows.length, 10012);
assert.equal(corrected.status, 'DRAFT_REVIEW');
assert.equal(corrected.supersedes, 'radar-security-gate-decision-table-v1');
assert.equal(corrected.unknownOutputRows, 0);
assert.equal(corrected.conflictingOutputRows, 0);
assert.equal(escalation.rows.length, 625);
assert.equal(classification.rows.length, 375);
assert.equal(classification.unknownDecisionRows, 0);
assert.equal(classFixtures.cases.length, 28);
assert.equal(classFixtures.structuralInvalidCases.length, 9);
assert.equal(escalationFixtures.caseCount, 28);
assert.equal(history.totalRows, 50);
assert.equal(history.provableRows, 40);
assert.equal(history.underdeterminedRows, 10);
assert.equal(history.securityRows, 10);

assert.equal(corrected.reasonCodeCorrection.sourceDecisionTableSha256, digest(sourceBytes));
assert.equal(corrected.reasonCodeCorrection.sourceEscalationMatrixSha256, digest(escalationBytes));
assert.equal(digest(sourceBytes), review.hashes.decisionTable);
assert.equal(digest(escalationBytes), review.hashes.escalationMatrix);
assert.equal(digest(classificationBytes), review.hashes.classificationMatrix);
assert.equal(digest(classFixtureBytes), review.hashes.classificationFixtures);
assert.equal(digest(escalationFixtureBytes), review.hashes.escalationFixtures);
assert.equal(digest(historyBytes), review.hashes.historicalProjection);

const vectorKey = (vector) => JSON.stringify([
  vector.activeExploitation,
  vector.supplyChainImpact,
  vector.reachableDependency,
  vector.officialEmergencyAdvisory,
]);
const escalationByVector = new Map(escalation.rows.map((row) => [vectorKey(row.keyStates), row]));
assert.equal(escalationByVector.size, 625);

function expectedReasonCodes(row, escalationRow) {
  if (!row.escalationVector) {
    if (row.disposition === 'RECEIPT_ONLY') return ['SECURITY_CLASS_INPUT_UNKNOWN'];
    if (row.disposition === 'NOT_APPLICABLE') return ['SECURITY_GATE_NOT_APPLICABLE'];
    throw new Error(`unexpected row without escalation vector: ${row.disposition}`);
  }
  const states = Object.values(row.escalationVector);
  const result = [states.includes('TRUE') ? 'SECURITY_ESCALATION_KEY_TRUE' : 'SECURITY_ESCALATION_NO_KEY_TRUE'];
  if (states.includes('UNKNOWN')) result.push('SECURITY_ESCALATION_INPUT_UNKNOWN');
  if (states.includes('MISSING')) result.push('SECURITY_ESCALATION_INPUT_MISSING');
  if (states.includes('NOT_APPLICABLE')) result.push('SECURITY_ESCALATION_NOT_APPLICABLE');
  if (row.hardFilter) result.push('SECURITY_UNRELATED_HARD_FILTER');
  if (row.capExemption) result.push('SECURITY_SIGNAL_CAP_EXEMPT_ESCALATION');
  if (row.capApplied) result.push('SECURITY_SIGNAL_CAP_APPLIED');
  assert.ok(escalationRow);
  return [...new Set(result)];
}

const withoutReasons = (row) => {
  const copy = structuredClone(row);
  delete copy.reasonCodes;
  return copy;
};

let rowsWithTrue = 0;
let reasonCodeCorrections = 0;
let semanticOutputDelta = 0;
let reasonCodeViolations = 0;
let trueWithWrongReason = 0;
let noTrueWithMissingStateReason = 0;
let fixtureReasonCodeAssertions = 0;
const semanticProjection = (row) => JSON.stringify(withoutReasons(row));
assert.equal(source.rows.length, corrected.rows.length);
for (let index = 0; index < source.rows.length; index += 1) {
  const before = source.rows[index];
  const after = corrected.rows[index];
  if (semanticProjection(before) !== semanticProjection(after)) semanticOutputDelta += 1;
  if (JSON.stringify(before.reasonCodes) !== JSON.stringify(after.reasonCodes)) reasonCodeCorrections += 1;

  if (!after.escalationVector) {
    if (JSON.stringify(after.reasonCodes) !== JSON.stringify(expectedReasonCodes(after))) reasonCodeViolations += 1;
    continue;
  }
  const matrixRow = escalationByVector.get(vectorKey(after.escalationVector));
  assert.ok(matrixRow, `decision row ${index} has no escalation matrix row`);
  assert.equal(after.escalationResult, matrixRow.escalationResult, `escalation semantic drift at row ${index}`);
  const states = Object.values(after.escalationVector);
  const hasTrue = states.includes('TRUE');
  if (hasTrue) rowsWithTrue += 1;
  const expected = expectedReasonCodes(after, matrixRow);
  if (JSON.stringify(after.reasonCodes) !== JSON.stringify(expected)) reasonCodeViolations += 1;
  if (hasTrue && (after.reasonCodes.includes('SECURITY_ESCALATION_NO_KEY_TRUE') || !after.reasonCodes.includes('SECURITY_ESCALATION_KEY_TRUE'))) trueWithWrongReason += 1;
  if (!hasTrue && states.some((state) => ['UNKNOWN', 'MISSING', 'NOT_APPLICABLE'].includes(state))
    && JSON.stringify(before.reasonCodes) !== JSON.stringify(after.reasonCodes)) noTrueWithMissingStateReason += 1;
}

assert.equal(rowsWithTrue, 5904);
assert.equal(reasonCodeCorrections, corrected.reasonCodeCorrection.reasonCodeCorrections);
assert.equal(corrected.reasonCodeCorrection.rowsWithTrue, rowsWithTrue);
assert.equal(corrected.reasonCodeCorrection.semanticOutputsChanged, 0);
assert.equal(semanticOutputDelta, 0, 'normative decision table output changed');
assert.equal(reasonCodeViolations, 0, 'reason-code predicate violation');
assert.equal(trueWithWrongReason, 0);

// Audit all 625 escalation matrix rows and their retained reason-code projection.
for (const row of escalation.rows) {
  const states = Object.values(row.keyStates);
  const expectedResult = states.includes('TRUE') ? 'ESCALATE'
    : states.some((state) => ['UNKNOWN', 'MISSING'].includes(state)) ? 'UNRESOLVED'
      : 'NO_ESCALATION';
  assert.equal(row.escalationResult, expectedResult);
  const requiredKeyReason = states.includes('TRUE') ? 'SECURITY_ESCALATION_KEY_TRUE' : 'SECURITY_ESCALATION_NO_KEY_TRUE';
  assert.ok(row.reasonCodes.includes(requiredKeyReason));
  assert.equal(row.reasonCodes.includes('SECURITY_ESCALATION_NO_KEY_TRUE'), !states.includes('TRUE'));
  const expectedCodes = [requiredKeyReason];
  if (states.includes('UNKNOWN')) expectedCodes.push('SECURITY_ESCALATION_INPUT_UNKNOWN');
  if (states.includes('MISSING')) expectedCodes.push('SECURITY_ESCALATION_INPUT_MISSING');
  if (states.includes('NOT_APPLICABLE')) expectedCodes.push('SECURITY_ESCALATION_NOT_APPLICABLE');
  expectedCodes.push(row.capExemption ? 'SECURITY_SIGNAL_CAP_EXEMPT_ESCALATION' : 'SECURITY_SIGNAL_CAP_APPLIED');
  assert.deepEqual(row.reasonCodes, expectedCodes, 'escalation matrix reason-code predicate mismatch');
}

// Fixture files are immutable inputs for this correction. Check their reason-code assertions, without changing them.
const stateNames = ['activeExploitation', 'supplyChainImpact', 'reachableDependency', 'officialEmergencyAdvisory'];
for (const fixture of escalationFixtures.cases) {
  if (fixture.inputValidity === 'INVALID_INPUT') {
    assert.equal(fixture.expected.validation, 'REJECT');
    assert.ok(['DUPLICATE_OBJECT_KEY', 'INVALID_ESCALATION_STATE', 'NULL_ESCALATION_STATE', 'NA_PROVENANCE_REQUIRED', 'TRUE_EVIDENCE_REQUIRED', 'INVALID_ESCALATION_OBJECT'].includes(fixture.expected.error));
    continue;
  }
  const keyStates = fixture.input?.keyStates ?? {};
  const states = stateNames.map((key) => Object.hasOwn(keyStates, key) ? keyStates[key] : 'MISSING');
  const result = states.includes('TRUE') ? 'ESCALATE'
    : states.some((state) => ['UNKNOWN', 'MISSING'].includes(state)) ? 'UNRESOLVED'
      : 'NO_ESCALATION';
  const codes = [states.includes('TRUE') ? 'SECURITY_ESCALATION_KEY_TRUE' : 'SECURITY_ESCALATION_NO_KEY_TRUE'];
  if (states.includes('UNKNOWN')) codes.push('SECURITY_ESCALATION_INPUT_UNKNOWN');
  if (states.includes('MISSING')) codes.push('SECURITY_ESCALATION_INPUT_MISSING');
  if (states.includes('NOT_APPLICABLE')) codes.push('SECURITY_ESCALATION_NOT_APPLICABLE');
  if (fixture.expected.capExemption) codes.push('SECURITY_SIGNAL_CAP_EXEMPT_ESCALATION');
  if (fixture.expected.reasonCodes.includes('SECURITY_SIGNAL_CAP_APPLIED')) codes.push('SECURITY_SIGNAL_CAP_APPLIED');
  assert.equal(fixture.expected.escalationResult, result, fixture.fixtureId);
  assert.deepEqual(fixture.expected.reasonCodes, codes, fixture.fixtureId);
  fixtureReasonCodeAssertions += 1;
}

function classifyFixture(input) {
  if (input.radar && input.radar !== 'SEC') return { gateApplicability: 'NOT_APPLICABLE', gateDisposition: 'NOT_APPLICABLE', signalPreserved: true };
  if (input.gateApplicability === 'NOT_APPLICABLE' && input.applicabilityRuleRef) return { gateApplicability: 'NOT_APPLICABLE', gateDisposition: 'NOT_APPLICABLE', signalPreserved: true };
  if (input.gateApplicability === 'MISSING' || input.gateApplicability === 'UNKNOWN') return { classificationResolution: 'UNRESOLVED', gateDisposition: 'RECEIPT_ONLY' };
  if (input.structuralInput) {
    const provenanceFailure = typeof input.structuralInput === 'object'
      && (input.structuralInput.dependencyRelationship === 'TRUE' || input.structuralInput.directExposure === 'NOT_APPLICABLE');
    return { classificationResolution: 'INVALID_INPUT', securityGateClass: null, reasonCode: provenanceFailure ? 'SECURITY_CLASS_PROVENANCE_INVALID' : 'SECURITY_CLASS_INVALID_INPUT' };
  }
  if (Object.hasOwn(input, 'candidateAffectedTechnology') && input.candidateAffectedTechnology === null) return { classificationResolution: 'UNRESOLVED', securityGateClass: null };
  const baselineState = input.trackedEnvironmentState ?? 'MISSING';
  const relations = input.relations ?? {};
  const values = ['directExposure', 'dependencyRelationship', 'ecosystemRelationship'].map((key) => Object.hasOwn(relations, key) ? relations[key] : 'MISSING');
  const row = classification.rows.find((entry) => entry.trackedEnvironmentState === baselineState
    && entry.relationshipStates.directExposure === values[0]
    && entry.relationshipStates.dependencyRelationship === values[1]
    && entry.relationshipStates.ecosystemRelationship === values[2]);
  assert.ok(row, `classification fixture not represented in 375-row matrix: base=${baselineState}, relations=${JSON.stringify(relations)}`);
  const result = { classificationResolution: row.classificationResolution, securityGateClass: row.securityGateClass };
  if (row.reasonCodes.length) result.reasonCode = row.reasonCodes[0];
  return result;
}
for (const fixture of classFixtures.cases) {
  const actual = classifyFixture(fixture.input);
  for (const [key, expected] of Object.entries(fixture.expected)) assert.equal(actual[key], expected, fixture.fixtureId);
  if (fixture.expected.reasonCode) fixtureReasonCodeAssertions += 1;
}
for (const fixture of classFixtures.structuralInvalidCases) {
  assert.equal(fixture.result, 'INVALID_INPUT');
  assert.ok(['SECURITY_CLASS_INVALID_INPUT', 'SECURITY_CLASS_PROVENANCE_INVALID'].includes(fixture.reasonCode));
}

console.log(JSON.stringify({
  status: 'PASS',
  rows: corrected.rows.length,
  rowsWithTrue,
  reasonCodeCorrections,
  noTrueRowsWithSameRootCauseStateReasonRestoration: noTrueWithMissingStateReason,
  remainingReasonCodeViolations: reasonCodeViolations,
  semanticOutputDelta,
  escalationMatrix: `${escalation.rows.length}/625`,
  classificationMatrix: `${classification.rows.length}/375`,
  securityClassificationFixtures: `${classFixtures.cases.length}/28`,
  structuralInvalidFixtures: `${classFixtures.structuralInvalidCases.length}/9`,
  escalationFixtures: `${escalationFixtures.caseCount}/28`,
  fixtureFilesChanged: 0,
  historicalProjection: `${history.totalRows}/50`,
  provableNonSecurity: history.provableRows,
  underdeterminedSecurity: history.underdeterminedRows,
  fixtureReasonCodeAssertions,
}, null, 2));
