import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { runShadowRuntime } from '../../src/lib/radar-shadow-runtime/orchestrator.mjs';
import { validateHandoffBatchBytes, canonicalizeJcs } from '../../src/lib/radar-shadow-runtime/handoff.mjs';
import { adaptProductionCandidate } from '../../src/lib/radar-candidate-adapter/adapters.ts';
import { normalizeRadarV1 } from '../../vendor/horizon-contracts/radar/v2/normalize.mjs';
import { writeExclusiveAtomic } from '../../src/lib/radar-shadow-runtime/state-store.mjs';
import { evaluateSecurityGateV100 } from '../../src/lib/radar-shadow-runtime/security-gate-v1.0.0.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const observedAt = '2026-10-02T00:00:00.000Z';
const resultSchema = JSON.parse(await readFile(new URL('../../src/lib/radar-shadow-runtime/result-schema-v1.json', import.meta.url), 'utf8'));
const resultSchemaValidator = new Ajv2020({ allErrors: true, strict: false });
addFormats(resultSchemaValidator);
const validateShadowRecord = resultSchemaValidator.compile(resultSchema);

function envelope({ radar = 'DEV', sourceName = 'Claude Code Changelog', recordId = 'release-0001', runId = 'shadow-run-0001', url = 'https://github.com/anthropics/claude-code/releases/tag/v2.1.286', facts = { tag_name: 'v2.1.286', name: 'Claude Code v2.1.286' } } = {}) {
  const authority = ['HuggingFace Papers', 'GitHub Security Advisories'].includes(sourceName) ? 'primary' : sourceName === 'Product Hunt' ? 'community' : 'official';
  return {
    handoffVersion: '1.0', radar, runId, observedAt,
    source: { sourceKey: `${radar.toLowerCase()}-fixture-v1`, sourceName, sourceUrl: url, sourceAuthority: authority, sourceLevel: sourceName === 'HuggingFace Papers' ? 'research' : sourceName === 'Product Hunt' ? 'ecosystem' : 'official', sourceItemId: recordId },
    record: { recordId, recordType: 'structured-fixture', facts, sourcePublishedAt: null, evidenceUrl: url },
    versions: { collectorVersion: '1.0.0', parserVersion: '1.0.0' },
  };
}

function batch(records, { radar = records[0]?.radar ?? 'DEV', runId = records[0]?.runId ?? 'shadow-run-0001', collectorVersion = '1.0.0' } = {}) {
  return Buffer.from(JSON.stringify({ manifest: { handoffVersion: '1.0', radar, runId, collectorVersion, recordCount: records.length, recordsSha256: digest(Buffer.from(canonicalizeJcs(records))), createdAt: observedAt }, records }));
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'horizon-shadow-test-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const stateRoot = (root) => join(root, 'state');

const fixedClock = () => observedAt;
const semanticKeys = ['candidateDisposition','candidateReason','evidenceDisposition','evidenceReason','identityDisposition','identityReason','scoreEligibility','scoreEligibilityReason','securityDisposition','securityReason','evaluationDisposition','action','terminalOutcome','errorCode'];
const semanticProjection = (result) => result.records.map((row) => Object.fromEntries(semanticKeys.map((key) => [key, row[key]])));

test('isolates records, records receipt-only outcomes, and persists atomic run structure', async () => withRoot(async (root) => {
  const good = envelope({ recordId: 'release-good01' });
  const fourGood = [good, ...['release-good02', 'release-good03', 'release-good04'].map((recordId) => envelope({ recordId }))];
  const invalid = envelope({ recordId: 'release-bad001' }); delete invalid.record.facts;
  const result = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch([...fourGood, invalid]), clock: fixedClock });
  assert.equal(result.status, 'COMPLETED_WITH_ERRORS');
  assert.equal(result.records.length, 5);
  assert.equal(result.records[0].terminalOutcome, 'IDENTITY_UNRESOLVED');
  assert.equal(result.records[4].terminalOutcome, 'ERROR');
  assert.equal(result.metrics.records_received, 5);
  const files = await readdir(join(stateRoot(root), 'runs', good.runId));
  assert.deepEqual(files.sort(), ['errors.jsonl', 'metadata.json', 'metrics.json', 'records.jsonl']);
  const saved = (await readFile(join(stateRoot(root), 'runs', good.runId, 'records.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(saved.length, 5);
  assert.equal(saved[0].persistenceClassification, 'RECEIPT_ONLY');
  for (const row of saved) assert.equal(validateShadowRecord(row), true, JSON.stringify(validateShadowRecord.errors));
}));

test('two receipt-only records do not block three valid siblings in a batch', async () => withRoot(async (root) => {
  const records = [
    envelope({ recordId: 'release-ok0001' }), envelope({ recordId: 'release-ok0002' }), envelope({ recordId: 'release-ok0003' }),
    envelope({ recordId: 'release-agg0001', sourceName: 'npm Downloads', facts: { package: 'sample', downloads: 12 } }),
    envelope({ recordId: 'release-unknown1', sourceName: 'Unknown Source', facts: { title: 'unsupported item' } }),
  ];
  const result = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch(records), clock: fixedClock });
  assert.equal(result.records.length, 5);
  assert.equal(result.records.filter((row) => row.terminalOutcome === 'IDENTITY_UNRESOLVED').length, 3);
  assert.equal(result.records.filter((row) => row.terminalOutcome === 'RECEIPT_ONLY').length, 2);
  assert.equal(result.metrics.records_error, 0);
}));

test('covers synthetic AI, DEV, APP, SEC candidates and keeps missing identity fail-closed', async () => withRoot(async (root) => {
  const cases = [
    envelope({ radar: 'AI', sourceName: 'HuggingFace Papers', recordId: 'ai-record-0001', runId: 'ai-run-000001', url: 'https://huggingface.co/papers/2026.12345', facts: { title: 'A structured paper' } }),
    envelope({ radar: 'DEV', recordId: 'dev-record-0001', runId: 'dev-run-000001' }),
    envelope({ radar: 'APP', sourceName: 'Product Hunt', recordId: 'app-record-0001', runId: 'app-run-000001', url: 'https://www.producthunt.com/products/sample-app', facts: { title: 'Sample app', link: 'https://www.producthunt.com/products/sample-app' } }),
    envelope({ radar: 'SEC', sourceName: 'GitHub Security Advisories', recordId: 'sec-record-0001', runId: 'sec-run-000001', url: 'https://github.com/advisories/GHSA-1234-5678-9abc', facts: { ghsa_id: 'GHSA-1234-5678-9abc', summary: 'Synthetic advisory' } }),
  ];
  for (const item of cases) {
    const result = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch([item]), clock: fixedClock });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].candidateDisposition, 'CANDIDATE_READY', `${item.radar} candidate`);
    assert.equal(result.records[0].evidenceDisposition, 'READY', `${item.radar} evidence`);
    assert.equal(result.records[0].terminalOutcome, 'IDENTITY_UNRESOLVED', `${item.radar} identity`);
  }
  const skill = envelope({ radar: 'SKILL', sourceName: 'ClawHub', recordId: 'skill-record-001', runId: 'skill-run-00001' });
  // SKILL remains outside the handoff radar enum and is rejected at the batch boundary.
  assert.equal(validateHandoffBatchBytes(batch([skill], { radar: 'SKILL', runId: skill.runId })).valid, false);
}));

test('synthetic state transition matrix covers four cases per Radar plus SEC and SKILL boundaries', async () => withRoot(async (root) => {
  const fixtureSet = JSON.parse(await readFile(new URL('./fixtures-v1.json', import.meta.url), 'utf8'));
  assert.equal(fixtureSet.syntheticOnly, true);
  assert.equal(fixtureSet.cases.length, 19);
  const cases = [];
  for (const radar of ['AI', 'DEV', 'APP', 'SEC']) {
    const base = radar === 'AI'
      ? { radar, sourceName: 'HuggingFace Papers', url: 'https://huggingface.co/papers/2026.12345', facts: { title: 'A structured paper' } }
      : radar === 'DEV'
        ? { radar, sourceName: 'Claude Code Changelog', url: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.286', facts: { tag_name: 'v2.1.286', name: 'Claude Code v2.1.286' } }
        : radar === 'APP'
          ? { radar, sourceName: 'Product Hunt', url: 'https://www.producthunt.com/products/sample-app', facts: { title: 'Sample app', link: 'https://www.producthunt.com/products/sample-app' } }
          : { radar, sourceName: 'GitHub Security Advisories', url: 'https://github.com/advisories/GHSA-1234-5678-9abc', facts: { ghsa_id: 'GHSA-1234-5678-9abc', summary: 'Synthetic advisory' } };
    cases.push({ radar, kind: 'valid', record: envelope({ ...base, recordId: `${radar.toLowerCase()}-valid-0001`, runId: `${radar.toLowerCase()}-matrix-0001` }) });
    cases.push({ radar, kind: 'identity-unresolved', record: envelope({ ...base, recordId: `${radar.toLowerCase()}-identity-001`, runId: `${radar.toLowerCase()}-matrix-0002` }) });
    const incomplete = envelope({ ...base, recordId: `${radar.toLowerCase()}-score-00001`, runId: `${radar.toLowerCase()}-matrix-0003` });
    cases.push({ radar, kind: 'score-incomplete', record: incomplete, options: { identityResolver: syntheticIdentityResolver, ...(radar === 'SEC' ? { securityContextProvider: syntheticSecurityResolvedContext } : {}) } });
    const invalidFacts = { ...base.facts }; delete invalidFacts.link;
    const invalid = envelope({ ...base, recordId: `${radar.toLowerCase()}-invalid-0001`, runId: `${radar.toLowerCase()}-matrix-0004`, url: null, facts: invalidFacts });
    cases.push({ radar, kind: 'candidate-invalid', record: invalid });
  }
  cases.push({ radar: 'SEC', kind: 'security-unresolved', record: envelope({ radar: 'SEC', sourceName: 'GitHub Security Advisories', recordId: 'sec-gate-unresolved1', runId: 'sec-matrix-0005', url: 'https://github.com/advisories/GHSA-1234-5678-9abc', facts: { ghsa_id: 'GHSA-1234-5678-9abc', summary: 'Synthetic advisory' } }), options: { identityResolver: syntheticIdentityResolver, securityContextProvider: async () => ({ status: 'UNRESOLVED', reason: 'SECURITY_GATE_CONTEXT_UNAVAILABLE' }) } });
  cases.push({ radar: 'SEC', kind: 'security-context-resolved', record: envelope({ radar: 'SEC', sourceName: 'GitHub Security Advisories', recordId: 'sec-gate-resolved01', runId: 'sec-matrix-0006', url: 'https://github.com/advisories/GHSA-1234-5678-9abc', facts: { ghsa_id: 'GHSA-1234-5678-9abc', summary: 'Synthetic advisory' } }), options: { identityResolver: syntheticIdentityResolver, securityContextProvider: syntheticSecurityResolvedContext } });
  for (const item of cases) {
    const result = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch([item.record]), clock: fixedClock, ...item.options });
    const row = result.records[0] ?? result.errors[0];
    assert.ok(row, `${item.radar}/${item.kind} persisted one result`);
    if (item.kind === 'valid' || item.kind === 'identity-unresolved') assert.equal(row.terminalOutcome, 'IDENTITY_UNRESOLVED', `${item.radar}/${item.kind}`);
    if (item.kind === 'score-incomplete') assert.equal(row.terminalOutcome, 'SCORE_INPUT_INCOMPLETE', `${item.radar}/${item.kind}`);
    if (item.kind === 'candidate-invalid') {
      const fixture = fixtureSet.cases.find((entry) => entry.id === `${item.radar}-candidate-invalid`);
      assert.equal(row.terminalOutcome, fixture.expected, `${item.radar}/${item.kind}`);
    }
    if (item.kind === 'security-unresolved') assert.equal(row.terminalOutcome, 'SECURITY_GATE_UNRESOLVED');
    if (item.kind === 'security-context-resolved') assert.equal(row.terminalOutcome, 'SCORE_INPUT_INCOMPLETE');
  }
  const skill = envelope({ radar: 'DEV', sourceName: 'ClawHub', recordId: 'skill-unavailable1', runId: 'skill-matrix-0001' });
  skill.radar = 'SKILL';
  const result = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch([skill]), clock: fixedClock });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errors[0].errorCode, 'HANDOFF_MANIFEST_INVALID');
}));

const syntheticIdentityResolver = async ({ candidate }) => ({
  status: 'RESOLVED', entity: 'synthetic.entity', canonicalEventType: 'release', eventIdentifier: 'initial',
  provenance: { authority: 'SYNTHETIC_FIXTURE_ONLY', ruleId: 'SYNTHETIC_TEST_ONLY', policyVersion: '1.0', evidenceRefs: [candidate.itemUrl] },
});

const syntheticSecurityResolvedContext = async () => ({
  status: 'RESOLVED',
  evaluatorInput: { applicability: 'NOT_APPLICABLE', applicabilityProvenance: { ruleId: 'SYNTHETIC_TEST_ONLY', ruleVersion: '1.0.0', evidenceRefs: ['https://github.com/advisories/GHSA-1234-5678-9abc'], applicabilityBasis: 'Synthetic boundary fixture only.' } },
  securityAssessment: { gate: 'N/A', ruleId: 'SYNTHETIC_TEST_ONLY', evidenceRefs: ['https://github.com/advisories/GHSA-1234-5678-9abc'], policyVersion: '1.0', authority: 'SECURITY_GATE_POLICY' },
});


test('frozen Security Gate 1.0.0 accepts a resolved synthetic classification without production facts', () => {
  const evidenceRef = 'https://github.com/advisories/GHSA-1234-5678-9abc';
  const relation = { state: 'TRUE', provenance: { evidenceRefs: [evidenceRef], sourceAuthority: 'SYNTHETIC_FIXTURE', authorityMapVersion: '1.0' } };
  const result = evaluateSecurityGateV100({
    radar: 'SEC', applicability: 'APPLICABLE', incomingSignal: 'high',
    baseline: { baselineVersion: 'synthetic-v1', baselineSha256: 'a'.repeat(64), observedAt, trackedTechnologyCatalog: 'fixture', directDeploymentInventory: 'fixture', dependencyGraph: 'fixture', trackedEcosystemCatalog: 'fixture', scopeCompleteness: 'COMPLETE', coverageAttestation: { trackedTechnologyCatalog: true, directDeploymentInventory: true, completeDependencyGraph: true, trackedEcosystemCatalog: true }, sourceAuthorityMapVersion: 'fixture-v1', sourceAuthorityMapSha256: 'b'.repeat(64) },
    relationships: { directExposure: relation },
    candidateIdentity: { canonicalId: 'synthetic:cve', evidenceRef, component: { componentId: 'synthetic:component' } },
  });
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.classificationResolution, 'RESOLVED');
  assert.equal(result.gateClass, 'DIRECTLY_EXPOSED');
});

test('disabled runtime does not initialize or mutate state', async () => withRoot(async (root) => {
  const result = await runShadowRuntime({ enabled: false, root: stateRoot(root), inputBytes: Buffer.from('{bad') });
  assert.equal(result.status, 'DISABLED');
  await assert.rejects(readdir(stateRoot(root)));
}));

test('corrupt JSON and checksum mismatch fail closed without throwing', async () => withRoot(async (root) => {
  const malformed = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: Buffer.from('{'), clock: fixedClock });
  assert.equal(malformed.status, 'FAILED');
  assert.equal(malformed.errors[0].errorCode, 'HANDOFF_INVALID_JSON');
  const item = envelope();
  const bytes = batch([item]);
  const tampered = JSON.parse(bytes.toString()); tampered.records[0].record.facts.name = 'changed';
  const checksum = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: Buffer.from(JSON.stringify(tampered)), clock: fixedClock });
  assert.equal(checksum.errors[0].errorCode, 'HANDOFF_CHECKSUM_MISMATCH');
}));

test('unsupported Radar identifiers fail closed at the explicit manifest boundary', async () => withRoot(async (root) => {
  const input = batch([envelope()]);
  const parsed = JSON.parse(input.toString()); parsed.manifest.radar = 'UNKNOWN';
  const result = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: Buffer.from(JSON.stringify(parsed)), clock: fixedClock });
  assert.equal(result.errors[0].errorCode, 'HANDOFF_MANIFEST_INVALID');
  assert.equal(result.metrics.production_registry_write_count, 0);
}));

test('same delivery deduplicates and changed payload conflicts without overwriting prior result', async () => withRoot(async (root) => {
  const item = envelope();
  const first = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch([item]), clock: fixedClock });
  const replay = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch([item]), clock: fixedClock });
  assert.deepEqual(first.records.map((r) => r.terminalOutcome), replay.records.map((r) => r.terminalOutcome));
  assert.equal(replay.records[0].duplicate, true);
  const changed = structuredClone(item); changed.record.facts.name = 'changed payload';
  const conflict = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch([changed]), clock: fixedClock });
  assert.equal(conflict.errors[0].errorCode, 'RUN_ID_PAYLOAD_CONFLICT');
  assert.equal((await readFile(join(stateRoot(root), 'runs', item.runId, 'records.jsonl'), 'utf8')).includes('changed payload'), false);
}));

test('synthetic handoff semantics exact-match across ten isolated replay runs', async () => withRoot(async (root) => {
  const bytes = batch([envelope()]);
  const outputs = [];
  for (let i = 0; i < 10; i++) {
    const result = await runShadowRuntime({ enabled: true, root: join(stateRoot(root), `replay-${i}`), inputBytes: bytes, clock: fixedClock });
    outputs.push(semanticProjection(result));
  }
  for (const output of outputs.slice(1)) assert.deepEqual(output, outputs[0]);
}));

test('run id conflict and unmarked state root fail closed', async () => withRoot(async (parent) => {
  const root = join(parent, 'state');
  const item = envelope();
  await runShadowRuntime({ enabled: true, root, inputBytes: batch([item]), clock: fixedClock });
  const another = structuredClone(item); another.record.recordId = 'release-other01';
  assert.equal((await runShadowRuntime({ enabled: true, root, inputBytes: batch([another]), clock: fixedClock })).errors[0].errorCode, 'RUN_ID_PAYLOAD_CONFLICT');
  const unmarked = join(parent, 'unmarked'); await mkdir(unmarked); await writeFile(join(unmarked, 'user-data'), 'keep');
  const blocked = await runShadowRuntime({ enabled: true, root: unmarked, inputBytes: batch([item]), clock: fixedClock });
  assert.equal(blocked.code, 'SHADOW_ISOLATION_FAILURE');
  assert.equal(await readFile(join(unmarked, 'user-data'), 'utf8'), 'keep');
}));

test('atomic exclusive writes preserve the first complete file when a second attempt collides', async () => withRoot(async (root) => {
  const path = join(stateRoot(root), 'atomic.json');
  assert.equal(await writeExclusiveAtomic(path, Buffer.from('{"complete":true}\n')), true);
  assert.equal(await writeExclusiveAtomic(path, Buffer.from('{"partial":')), false);
  assert.equal(await readFile(path, 'utf8'), '{"complete":true}\n');
}));

test('a simulated final run write interruption fails closed and never publishes a partial official run', async () => {
  const store = {
    initialize: async () => '/isolated/test-store',
    readRun: async () => null,
    readDelivery: async () => null,
    claimDelivery: async (_key, row) => ({ created: true, row }),
    writeError: async () => true,
    publishRun: async () => { throw new Error('INJECTED_PARTIAL_WRITE'); },
  };
  const result = await runShadowRuntime({ enabled: true, root: '/isolated/test-store', store, inputBytes: batch([envelope()]), clock: fixedClock });
  assert.equal(result.status, 'STORAGE_FAILED', JSON.stringify(result));
  assert.equal(result.outputWritten, false);
  assert.equal(result.sideEffects.productionRegistryWrites, 0);
});

test('would-publish requests are forbidden; ADOPT remains a non-publication action', async () => withRoot(async (root) => {
  const item = envelope(); item.publicationDecision = 'WOULD_PUBLISH';
  const result = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch([item]), clock: fixedClock });
  assert.equal(result.records[0].errorCode, 'WOULD_PUBLISH_FORBIDDEN');
  assert.equal(result.publicationEvaluation, 'NOT_AVAILABLE');
  assert.equal(result.sideEffects.publisherCalls, 0);
  assert.notEqual('ADOPT', 'WOULD_PUBLISH');
}));

test('real adapter maps GitHub Releases API html_url and publication time without inventing event identity', () => {
  const url = 'https://github.com/anthropics/claude-code/releases/tag/v2.1.286';
  const adapted = adaptProductionCandidate({ radar: 'DEV', sourceName: 'Claude Code Changelog', record: { tag_name: 'v2.1.286', name: 'Claude Code v2.1.286', html_url: url, published_at: '2026-09-30T19:10:13Z' } }, { observedAt });
  assert.equal(adapted.status, 'CANDIDATE_READY');
  assert.equal(adapted.candidate.itemUrl, url);
  assert.equal(adapted.candidate.publishedAt, '2026-09-30T19:10:13Z');
  assert.equal(adapted.candidate.eventIdentity, undefined);

  const unsupportedAlias = adaptProductionCandidate({ radar: 'DEV', sourceName: 'Claude Code Changelog', record: { tag_name: 'v2.1.286', name: 'Claude Code v2.1.286', link: url } }, { observedAt });
  assert.equal(unsupportedAlias.status, 'RECEIPT_ONLY');
  assert.ok(unsupportedAlias.receiptReasons.includes('MISSING_ITEM_URL'));
  assert.equal(unsupportedAlias.candidate.itemUrl, undefined);
});

test('V1 normalized result is byte-identical around disabled and enabled Shadow calls', async () => withRoot(async (root) => {
  const fixture = JSON.parse(await readFile(new URL('../../vendor/horizon-contracts/radar/v2/fixtures/v1/v1-legacy-signals.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(normalizeRadarV1(structuredClone(fixture)));
  const disabled = await runShadowRuntime({ enabled: false, root: stateRoot(root), inputBytes: batch([envelope()]) });
  assert.equal(disabled.status, 'DISABLED');
  const enabled = await runShadowRuntime({ enabled: true, root: stateRoot(root), inputBytes: batch([envelope()]), clock: fixedClock });
  assert.equal(enabled.status, 'COMPLETED');
  const after = JSON.stringify(normalizeRadarV1(structuredClone(fixture)));
  assert.equal(after, before);
  assert.equal(enabled.metrics.V1_behavioral_delta_count, 0);
}));
