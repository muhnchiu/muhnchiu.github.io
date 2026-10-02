import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verificationRoot = join(repositoryRoot, 'fixtures/radar-score-input/action-space');

export function decideAction(x) {
  if (x.signal === 'filtered') return 'ignore';
  if (x.risk === 'high' && x.signal === 'high') return 'read';
  if (x.risk === 'high' && ['medium', 'low'].includes(x.signal)) return 'watch';
  if (x.signal === 'high' && x.eventClass === 'VERSION_RELEASE') return 'read';
  const p05 = x.signal === 'high' && x.eventClass === 'FIRST_DISCOVERY' && x.actionability >= 7 && x.relevanceScore >= 8;
  if (p05) return 'test';
  if (x.signal === 'high' && x.eventClass === 'FIRST_DISCOVERY' && !p05 && x.impact >= 6) return 'read';
  if (x.signal === 'high' && x.eventClass === 'FIRST_DISCOVERY' && !p05 && x.impact < 6) return 'read';
  if (x.signal === 'high' && x.eventClass === 'OTHER' && x.priorValidation === true && x.risk === 'low' && x.relevanceLevel === 'DIRECT' && x.relevanceScore >= 8 && x.actionability >= 7 && x.confidence >= 6 && x.impact >= 7) return 'adopt';
  if (x.signal === 'high' && x.actionability >= 5) return 'test';
  if (x.signal === 'high' && x.actionability < 5) return 'read';
  if (x.signal === 'medium' && x.actionability >= 6 && x.relevanceScore >= 7) return 'test';
  if (x.signal === 'medium' && x.impact >= 5) return 'read';
  if (x.signal === 'medium' && x.impact < 5) return 'watch';
  if (x.signal === 'low' && x.actionability >= 4) return 'read';
  if (x.signal === 'low' && x.actionability < 4) return 'watch';
  throw new Error(`Unassigned action tuple: ${JSON.stringify(x)}`);
}

export async function verifyActionSpace(evidenceRoot = verificationRoot) {
  const artifact = JSON.parse(await readFile(join(evidenceRoot, 'exhaustive-delta-analysis-v2.1.json'), 'utf8'));
  const audit = JSON.parse(await readFile(join(evidenceRoot, 'p07-288-audit-v1.json'), 'utf8'));
  const columns = artifact.columns;
  let p07ViolationCount = 0;
  const adopt = { historicalMatrix: 0, historicalEngine: 0, previousCandidate: 0, finalCandidate: 0 };
  for (const row of artifact.rows) {
    const x = Object.fromEntries(columns.map((column, i) => [column, row[i]]));
    if (decideAction(x) !== x.revisedCandidateAction) throw new Error(`Action mismatch: ${JSON.stringify(x)}`);
    if (x.historicalMatrixAction === 'adopt') adopt.historicalMatrix++;
    if (x.historicalEngineAction === 'adopt') adopt.historicalEngine++;
    if (x.previousCandidateAction === 'adopt') adopt.previousCandidate++;
    if (x.revisedCandidateAction === 'adopt') adopt.finalCandidate++;
  }
  for (const row of audit.rows) {
    if (!(row.signal === 'high' && row.eventClass === 'FIRST_DISCOVERY' && row.actionability >= 7 && row.risk !== 'high' && [1, 3, 5].includes(row.relevanceScore) && decideAction(row) === 'read')) p07ViolationCount++;
  }
  return { combinationCount: artifact.rows.length, deterministic: artifact.determinism.exactlyOneActionPerCombination && artifact.determinism.ambiguous === 0 && artifact.determinism.unassigned === 0, historicalMatrixDelta: artifact.counts.historicalMatrixDelta, historicalEngineDelta: artifact.counts.historicalEngineDelta, intentionalSemanticDelta: artifact.counts.intentionalSemanticDelta288, unknownDelta: artifact.counts.unknown, unintendedDelta: artifact.counts.unintended, adopt, p07Rows: audit.rows.length, p07ViolationCount };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await verifyActionSpace(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
  if (result.combinationCount !== 48384 || !result.deterministic || result.p07Rows !== 288 || result.p07ViolationCount !== 0 || result.adopt.finalCandidate > 8) process.exitCode = 1;
}
