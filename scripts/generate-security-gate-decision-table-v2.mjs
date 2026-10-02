import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { deriveEscalationReasonCodes } from './security-gate-reason-codes.mjs';

const [, , sourceTablePath, escalationMatrixPath, outputPath] = process.argv;
if (!sourceTablePath || !escalationMatrixPath || !outputPath) {
  throw new Error('Usage: node scripts/generate-security-gate-decision-table-v2.mjs <decision-table-v1.json> <escalation-matrix-v1.json> <output-v2.json>');
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const table = await readJson(sourceTablePath);
const escalationMatrix = await readJson(escalationMatrixPath);
const sourceTableBytes = await readFile(sourceTablePath);
const escalationMatrixBytes = await readFile(escalationMatrixPath);
assert.equal(table.rows.length, 10012, 'source decision table must contain 10012 rows');
assert.equal(escalationMatrix.rows.length, 625, 'escalation matrix must contain 625 rows');

const vectorKey = (vector) => JSON.stringify([
  vector.activeExploitation,
  vector.supplyChainImpact,
  vector.reachableDependency,
  vector.officialEmergencyAdvisory,
]);
const escalationByVector = new Map(escalationMatrix.rows.map((row) => [vectorKey(row.keyStates), row]));
assert.equal(escalationByVector.size, 625, 'escalation matrix contains duplicate vectors');

function expectedReasonCodes(row, escalationRow) {
  if (!row.escalationVector) {
    if (row.disposition === 'RECEIPT_ONLY') return ['SECURITY_CLASS_INPUT_UNKNOWN'];
    if (row.disposition === 'NOT_APPLICABLE') return ['SECURITY_GATE_NOT_APPLICABLE'];
    throw new Error(`unexpected non-escalation row disposition: ${row.disposition}`);
  }

  const codes = deriveEscalationReasonCodes(row.escalationVector);
  if (row.hardFilter) codes.push('SECURITY_UNRELATED_HARD_FILTER');
  if (row.capExemption) codes.push('SECURITY_SIGNAL_CAP_EXEMPT_ESCALATION');
  if (row.capApplied) codes.push('SECURITY_SIGNAL_CAP_APPLIED');
  assert.ok(escalationRow, 'decision row vector is absent from escalation matrix');
  return [...new Set(codes)];
}

const rowsWithTrue = table.rows.filter((row) => row.escalationVector && Object.values(row.escalationVector).includes('TRUE')).length;
assert.equal(rowsWithTrue, 5904, 'TRUE-vector affected row count differs from reviewed freeze preflight');
const rows = table.rows.map((row) => {
  const escalationRow = row.escalationVector ? escalationByVector.get(vectorKey(row.escalationVector)) : undefined;
  if (escalationRow) assert.equal(row.escalationResult, escalationRow.escalationResult, 'refusing to alter escalation result');
  return {
    ...row,
    reasonCodes: expectedReasonCodes(row, escalationRow),
  };
});
const reasonCodeCorrections = rows.filter((row, index) => JSON.stringify(row.reasonCodes) !== JSON.stringify(table.rows[index].reasonCodes)).length;

const corrected = {
  ...table,
  artifact: 'radar-security-gate-decision-table-v2',
  phase: '5A.6.8e.4.1',
  status: 'DRAFT_REVIEW',
  supersedes: 'radar-security-gate-decision-table-v1',
  reasonCodeCorrection: {
    rootCause: 'DECISION_TABLE_REASON_CODE_GENERATOR',
    reasonCodeCorrections,
    rowsWithTrue,
    semanticOutputsChanged: 0,
    sourceDecisionTableSha256: hash(sourceTableBytes),
    sourceEscalationMatrixSha256: hash(escalationMatrixBytes),
  },
  rows,
};
await writeFile(outputPath, `${JSON.stringify(corrected, null, 2)}\n`);
console.log(JSON.stringify({
  status: 'DRAFT_REVIEW',
  artifact: corrected.artifact,
  rows: rows.length,
  rowsWithTrue,
  reasonCodeCorrections,
  escalationResultsChanged: 0,
  outputPath,
}, null, 2));
