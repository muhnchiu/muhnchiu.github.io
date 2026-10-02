import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { aggregateDailyEvidence, privacyGuard, STOP_CONDITIONS } from '../../src/lib/radar-shadow-runtime/validation-aggregator.mjs';
import { canonicalizeJcs } from '../../src/lib/radar-shadow-runtime/handoff.mjs';
import { runValidation } from '../../scripts/run-radar-shadow-validation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

const base = {
  date: '2026-10-02', validationRunIds: ['2026-10-02/DEV/run1'], sourcesExpected: ['DEV'],
  runs: [{ sourcesObserved: ['DEV'], recordsReceived: 1, records: [{ recordId: 'release-001', sourceFamily: 'Claude Code Changelog', candidateDisposition: 'CANDIDATE_READY', persistenceClassification: 'RECEIPT_ONLY', identityDisposition: 'UNRESOLVED', terminalOutcome: 'IDENTITY_UNRESOLVED', errorCode: 'IDENTITY_AUTHORITY_UNRESOLVED' }] }],
};

test('known unresolved outcomes are PASS_WITH_DEBT and do not become STOP', () => {
  for (const terminalOutcome of ['IDENTITY_UNRESOLVED', 'SCORE_INPUT_INCOMPLETE', 'SECURITY_GATE_UNRESOLVED', 'SOURCE_NOT_OBSERVED', 'SKILL_STRUCTURED_INPUT_UNAVAILABLE']) {
    const input = structuredClone(base);
    input.runs[0].records[0].terminalOutcome = terminalOutcome;
    input.runs[0].records[0].errorCode = terminalOutcome;
    const out = aggregateDailyEvidence(input);
    assert.equal(out.dayStatus, 'PASS_WITH_DEBT', terminalOutcome);
    assert.deepEqual(out.stopConditionsTriggered, []);
  }
});

test('every required injected STOP counter yields FAILED and stable condition code', () => {
  for (const [counter, expected] of Object.entries(STOP_CONDITIONS)) {
    const out = aggregateDailyEvidence({ ...base, injections: { [counter]: 1 } });
    assert.equal(out.dayStatus, 'FAILED', counter);
    assert.ok(out.stopConditionsTriggered.includes(expected), counter);
  }
});

test('state corruption, idempotency and batch isolation injections are STOPs', () => {
  for (const [counter, expected] of [['stateCorruptionCount', 'SHADOW_STATE_CORRUPTION'], ['idempotencyViolationCount', 'SHADOW_IDEMPOTENCY_FAILURE'], ['batchIsolationFailureCount', 'SHADOW_BATCH_ISOLATION_FAILURE']]) {
    const out = aggregateDailyEvidence({ ...base, injections: { [counter]: 1 } });
    assert.equal(out.dayStatus, 'FAILED');
    assert.ok(out.stopConditionsTriggered.includes(expected));
  }
});

test('same input produces byte-identical semantic aggregation ten times', () => {
  const outputs = Array.from({ length: 10 }, () => aggregateDailyEvidence(base));
  const canonical = JSON.stringify(outputs[0]);
  for (const output of outputs.slice(1)) assert.equal(JSON.stringify(output), canonical);
});

test('privacy guard rejects secrets, private headers, local paths and email addresses', () => {
  for (const value of ['api_key=secret123', 'Bearer abc.def.ghi', 'Cookie: session=abc', '/Users/alice/private/file', 'person@example.com']) assert.equal(privacyGuard(value), true, value);
  assert.equal(privacyGuard({ recordId: 'release-001', reasonCode: 'IDENTITY_AUTHORITY_UNRESOLVED' }), false);
});

test('daily status has no PARTIAL_PASS and unresolved source coverage is debt', () => {
  const out = aggregateDailyEvidence({ ...base, runs: [] });
  assert.equal(out.dayStatus, 'PASS_WITH_DEBT');
  assert.deepEqual(out.sourcesNotObserved, ['DEV']);
  assert.ok(['PASS', 'PASS_WITH_DEBT', 'FAILED'].includes(out.dayStatus));
});

test('isolated harness consumes structured input, validates daily schema, and reports zero production effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'horizon-shadow-validation-'));
  try {
    const records = [{
      handoffVersion: '1.0', radar: 'DEV', runId: 'synthetic-run-0001', observedAt: '2026-10-02T00:00:00.000Z',
      source: { sourceKey: 'DEV|fixture', sourceName: 'Claude Code Changelog', sourceUrl: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.286', sourceAuthority: 'official', sourceLevel: 'official', sourceItemId: 'fixture-001' },
      record: { recordId: 'fixture-001', recordType: 'release', facts: { tag_name: 'v2.1.286', name: 'Claude Code v2.1.286' }, sourcePublishedAt: '2026-10-01T00:00:00.000Z', evidenceUrl: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.286' },
      versions: { collectorVersion: '1.0.0', parserVersion: '1.0.0' },
    }];
    const batch = Buffer.from(JSON.stringify({ manifest: { handoffVersion: '1.0', radar: 'DEV', runId: 'synthetic-run-0001', collectorVersion: '1.0.0', recordCount: 1, recordsSha256: hash(Buffer.from(canonicalizeJcs(records))), createdAt: '2026-10-02T00:00:00.000Z' }, records }));
    const path = join(root, 'synthetic.json');
    await writeFile(path, batch);
    const evidence = await runValidation({ inputPaths: [path], inputKinds: ['SYNTHETIC'], stateRoot: join(root, 'isolated-state'), date: '2026-10-02', clock: () => '2026-10-02T00:00:00.000Z' });
    const schema = JSON.parse(await readFile(new URL('../../src/lib/radar-shadow-runtime/radar-shadow-validation-daily-schema-v1.json', import.meta.url), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv);
    assert.equal(ajv.compile(schema)(evidence.dailyEvidence), true);
    assert.equal(evidence.dailyEvidence.dayStatus, 'PASS_WITH_DEBT');
    assert.equal(evidence.productionRegistryWrites, 0);
    assert.equal(evidence.publisherInvocations, 0);
    assert.equal(evidence.deployment, 0);
    assert.equal(evidence.v1BehavioralDelta, 0);
    assert.equal(evidence.silentFallback, 0);
    assert.equal(evidence.observationWindowStarted, false);
    assert.equal(evidence.capturedInputs[0].sha256, hash(batch));
    assert.equal(evidence.policyDebtObservationEntriesWritten, evidence.dailyEvidence.policyDebtObserved.length);
    const debtLog = await readFile(join(root, 'isolated-state', 'policy-debt-observations.jsonl'), 'utf8');
    assert.equal(debtLog.trim().split('\n').length, evidence.policyDebtObservationEntriesWritten);
    assert.equal(privacyGuard(evidence), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
