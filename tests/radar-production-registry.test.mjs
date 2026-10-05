import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { adaptProductionCandidate } from '../src/lib/radar-candidate-adapter/adapters.ts';
import { resolveClaudeCodeChangelogIdentity } from '../src/lib/radar-canary/claude-code-identity.mjs';
import {
  DEFAULT_CANARY_REGISTRY_DIR,
  DEFAULT_PRODUCTION_REGISTRY_DIR,
  DEFAULT_V1_CONTENT_DIR,
  PRODUCTION_IDENTITY_MODE,
  PRODUCTION_REGISTRY_NAMESPACE,
  PRODUCTION_STORE_MARKER,
  ProductionIdentityRegistry,
} from '../src/lib/radar-production-registry/production-identity-registry.mjs';
import { canonicalRegistryBytes, registryPairFromJsonl } from '../src/lib/radar-registry/index.ts';
import { createClaudeCodeFeedCandidate, projectClaudeCodeAtomEntry, verifyClaudeCodeFeedCapture } from '../src/lib/radar-production-registry/claude-code-feed-capture.mjs';
import { prepareEvidenceCommit } from '../src/lib/radar-evidence-pipeline.mjs';

const capture = JSON.parse(await readFile(new URL('../fixtures/radar-canary/claude-code-real-release-capture-v1.json', import.meta.url), 'utf8'));
const observedAt = '2026-10-03T03:00:00Z';
const roots = new Set();
let sequence = 0;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('official Claude Code Atom capture maps deterministically into Candidate and identity without treating updated as publishedAt', () => {
  const item = capture.items[0];
  const entry = {
    id: item.itemUrl,
    title: item.title,
    link: item.itemUrl,
    updated: item.sourceUpdatedAt,
  };
  const { candidateResult, identity } = createClaudeCodeFeedCandidate(entry, { observedAt });
  assert.equal(candidateResult.status, 'CANDIDATE_READY');
  assert.equal(candidateResult.candidate.rawSourceMetadata.record.atom.updated, item.sourceUpdatedAt);
  assert.equal(candidateResult.candidate.publishedAt, undefined);
  assert.equal(identity.status, 'IDENTITY_READY');
  assert.equal(identity.eventKey, `claude-code:version-update:${item.tagName.slice(1)}`);
  assert.throws(() => projectClaudeCodeAtomEntry({ ...entry, id: 'https://github.com/other/repo/releases/tag/v2.1.288' }), (error) => error.code === 'PRODUCTION_CAPTURE_ENTRY_LINK_MISMATCH');
  assert.throws(() => projectClaudeCodeAtomEntry({ ...entry, link: entry.link.replace('/anthropics/claude-code/', '/other/repo/') }), (error) => error.code === 'PRODUCTION_CAPTURE_ENTRY_LINK_MISMATCH');

  const content = {
    captureTimestamp: observedAt,
    source: {
      sourceIdentifier: 'github.com/anthropics/claude-code',
      feedUrl: 'https://raw.githubusercontent.com/anthropics/claude-code/main/feed.xml',
      retrievalResult: 'CONTENT_RETURNED',
    },
    sourceRecords: [entry],
    secondCapture: { retrievalResult: 'CONTENT_RETURNED', sourceRecords: [entry] },
  };
  const captureHash = digest(Buffer.from(JSON.stringify(content)));
  assert.equal(verifyClaudeCodeFeedCapture({ ...content, contentIntegrity: { algorithm: 'SHA-256', sha256: captureHash } }).valid, true);
  assert.throws(() => verifyClaudeCodeFeedCapture({ ...content, sourceRecords: [{ ...entry, title: 'tampered' }], contentIntegrity: { algorithm: 'SHA-256', sha256: captureHash } }), (error) => error.code === 'PRODUCTION_CAPTURE_HASH_MISMATCH');
});
const hashTree = async (root) => {
  const rows = [];
  const walk = async (directory) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) rows.push(`${path.slice(root.length + 1)}:${digest(await readFile(path))}`);
    }
  };
  await walk(root);
  return { exists: rows.length > 0 || await lstat(root).then(() => true).catch(() => false), fileCount: rows.length, sha256: digest(Buffer.from(rows.sort().join('\n'))) };
};
const v1Before = await hashTree(DEFAULT_V1_CONTENT_DIR);
const canaryBefore = await hashTree(DEFAULT_CANARY_REGISTRY_DIR);
const protectedProductionBefore = await hashTree(DEFAULT_PRODUCTION_REGISTRY_DIR);
const evidence = {
  phase: '5D.3',
  source: 'DEV / Claude Code Changelog',
  testSuites: {},
  mainReplayMetrics: null,
  mainReplaySideEffects: null,
  externalState: { v1Before, canaryBefore, productionBefore: protectedProductionBefore },
};

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  evidence.externalState.v1After = await hashTree(DEFAULT_V1_CONTENT_DIR);
  evidence.externalState.canaryAfter = await hashTree(DEFAULT_CANARY_REGISTRY_DIR);
  evidence.externalState.productionAfter = await hashTree(DEFAULT_PRODUCTION_REGISTRY_DIR);
  evidence.externalState.v1Delta = JSON.stringify(evidence.externalState.v1Before) === JSON.stringify(evidence.externalState.v1After) ? 0 : 1;
  evidence.externalState.canaryDelta = JSON.stringify(evidence.externalState.canaryBefore) === JSON.stringify(evidence.externalState.canaryAfter) ? 0 : 1;
  const output = process.env.PHASE5D3_EVIDENCE_OUT;
  if (output) await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
});

async function newHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'horizon-production-registry-'));
  roots.add(root);
  const stateDir = join(root, PRODUCTION_REGISTRY_NAMESPACE);
  const canaryStateDir = join(root, 'canary', 'radar-v2-canary-dev-claude-code');
  const registryRuntime = {
    lockTimeoutMs: 5_000,
    transactionIdFactory: () => `prod-test-${String(++sequence).padStart(6, '0')}`,
    ...options.registryRuntime,
  };
  const registry = new ProductionIdentityRegistry({
    stateDir,
    canaryStateDir,
    v1StateDir: DEFAULT_V1_CONTENT_DIR,
    authorized: true,
    enabled: true,
    runtimeMode: PRODUCTION_IDENTITY_MODE,
    registryRuntime,
    ...options,
  });
  return { root, stateDir, canaryStateDir, registry };
}

function inputFor(item, { radar = 'DEV', sourceName = 'Claude Code Changelog', record = undefined } = {}) {
  const upstream = record ?? {
    tag_name: item.tagName,
    name: item.title,
    html_url: item.itemUrl,
    ...(item.apiPublishedAtFromCapturedProbe ? { published_at: item.apiPublishedAtFromCapturedProbe } : {}),
  };
  const candidateResult = adaptProductionCandidate({ radar, sourceName, record: upstream }, { observedAt });
  const candidate = candidateResult.candidate;
  const identity = candidate ? resolveClaudeCodeChangelogIdentity(candidate) : undefined;
  return { runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true, candidateResult, ...(identity ? { identity } : {}) };
}

function expectedObservationId(input) {
  const candidate = input.candidateResult.candidate;
  const prepared = prepareEvidenceCommit({
    sourceName: candidate.sourceName,
    title: candidate.title,
    sourceUrl: candidate.itemUrl,
    ...(candidate.publishedAt ? { sourcePublishedAt: candidate.publishedAt } : {}),
    sourceAuthority: candidate.sourceAuthority,
    sourceLevel: candidate.sourceLevel,
    entity: input.identity.entity,
    canonicalEventType: input.identity.canonicalEventType,
    eventIdentifier: input.identity.eventIdentifier,
    eventFacts: {},
  }, { radar: 'dev', observedAt: candidate.observedAt });
  return prepared.observationId;
}

async function counts(registry) {
  const pair = await registry.readPair();
  return { events: pair.events.length, observations: pair.observations.length, pair };
}

test('production mode is default-off, namespace is dedicated, and the published Event/Observation row schema remains strict', async () => {
  assert.notEqual(DEFAULT_PRODUCTION_REGISTRY_DIR, DEFAULT_CANARY_REGISTRY_DIR);
  assert.equal(DEFAULT_PRODUCTION_REGISTRY_DIR.startsWith(`${DEFAULT_CANARY_REGISTRY_DIR}/`), false);
  assert.equal(DEFAULT_PRODUCTION_REGISTRY_DIR.startsWith(`${DEFAULT_V1_CONTENT_DIR}/`), false);
  const h = await newHarness({ enabled: false });
  await assert.rejects(h.registry.commit(inputFor(capture.items[0])), (error) => error.code === 'PRODUCTION_REGISTRY_DISABLED');
  const empty = await counts(h.registry);
  assert.deepEqual([empty.events, empty.observations], [0, 0]);
  const emptyRead = h.registry.getSideEffectAccounting().productionRegistryReads;
  assert.equal(emptyRead.calls, 1);
  assert.equal(emptyRead.status, 'CALLED_AND_RETURNED_ZERO');
  assert.equal(empty.pair.events.some((row) => ['scoreStatus', 'actionStatus', 'publicationStatus'].some((field) => field in row)), false);
  assert.equal(empty.pair.observations.some((row) => ['scoreStatus', 'actionStatus', 'publicationStatus'].some((field) => field in row)), false);
  evidence.testSuites.namespaceAndDefaultOff = 'PASS';
});

test('authorization, mode, enablement, Candidate and Evidence gates all fail closed before Registry commit', async () => {
  const base = inputFor(capture.items[0]);
  const gates = [
    [{ authorized: false }, base, 'PRODUCTION_REGISTRY_NOT_AUTHORIZED'],
    [{ runtimeMode: 'CANARY' }, base, 'PRODUCTION_REGISTRY_MODE_REQUIRED'],
    [{ enabled: false }, base, 'PRODUCTION_REGISTRY_DISABLED'],
    [{ killSwitch: () => true }, base, 'PRODUCTION_REGISTRY_KILL_SWITCH'],
    [{}, { ...base, productionRegistryEnabled: false }, 'PRODUCTION_REGISTRY_DISABLED'],
    [{}, { ...base, runtimeMode: 'CANARY' }, 'PRODUCTION_REGISTRY_MODE_REQUIRED'],
  ];
  for (const [options, input, code] of gates) {
    const h = await newHarness(options);
    await assert.rejects(h.registry.commit(input), (error) => error.code === code);
    await assert.rejects(lstat(join(h.stateDir, 'radar-event-registry.jsonl')), (error) => error.code === 'ENOENT');
  }

  const h = await newHarness();
  const receiptOnly = structuredClone(base);
  receiptOnly.candidateResult.status = 'RECEIPT_ONLY';
  await assert.rejects(h.registry.commit(receiptOnly), (error) => error.code === 'PRODUCTION_CANDIDATE_NOT_READY');
  const noTitle = structuredClone(base);
  noTitle.candidateResult.candidate.title = undefined;
  await assert.rejects(h.registry.commit(noTitle), (error) => error.code === 'PRODUCTION_CANDIDATE_NOT_READY');
  const wrongIdentity = structuredClone(base);
  wrongIdentity.identity.eventKey = 'claude-code:version-update:9.9.9';
  await assert.rejects(h.registry.commit(wrongIdentity), (error) => error.code === 'PRODUCTION_EVENT_IDENTITY_NOT_READY');
  assert.equal(h.registry.getSideEffectAccounting().productionRegistryWrites.calls, 0);
  const pair = await counts(h.registry);
  assert.deepEqual([pair.events, pair.observations], [0, 0]);
  evidence.testSuites.writeAuthorization = 'PASS; all six authorization gates plus stale Candidate and identity failures reject before Registry mutation';
});

test('explicit Tier-1 allowlist allows only DEV / Claude Code Changelog and fails closed for all other sources', async () => {
  const h = await newHarness();
  const denied = [
    inputFor(capture.items[0], { radar: 'DEV', sourceName: 'GitHub Trending', record: { full_name: 'other/repo', html_url: 'https://github.com/other/repo', name: 'other/repo' } }),
    inputFor(capture.items[0], { radar: 'AI' }),
    inputFor(capture.items[0], { radar: 'APP' }),
    inputFor(capture.items[0], { radar: 'SEC' }),
    inputFor(capture.items[0], { radar: 'SKILL' }),
    inputFor(capture.items[0], { radar: 'UNKNOWN' }),
    { runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true, candidate: { radar: 'DEV', sourceName: 'Unknown source' } },
    { runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true },
  ];
  for (const input of denied) await assert.rejects(h.registry.commit(input));
  await assert.rejects(lstat(join(h.stateDir, 'radar-event-registry.jsonl')), (error) => error.code === 'ENOENT');
  assert.equal(h.registry.getMetrics().unexpectedSourceRejection, 8);
  evidence.testSuites.sourceAllowlist = 'PASS; one allowlisted source, seven wrong/unknown-source denials plus explicit missing-source denial';
});

test('five immutable Claude Code releases commit once, replay as DUPLICATE_OBSERVATION, and restore to empty', async () => {
  const h = await newHarness();
  await h.registry.initialize();
  const initialBackup = await h.registry.createBackup();
  const first = [];
  for (const item of capture.items) first.push(await h.registry.commit(inputFor(item)));
  assert.deepEqual(first.map((row) => row.registryDisposition), Array(5).fill('NEW_EVENT'));
  const afterFirstCount = await counts(h.registry);
  assert.deepEqual([afterFirstCount.events, afterFirstCount.observations], [5, 5]);
  const firstPair = (await counts(h.registry)).pair;
  const firstKeys = firstPair.events.map((row) => row.eventKey).sort();
  const firstObservationIds = firstPair.observations.map((row) => row.observationId).sort();

  const replay = [];
  for (const item of capture.items) replay.push(await h.registry.commit(inputFor(item)));
  assert.deepEqual(replay.map((row) => row.registryDisposition), Array(5).fill('DUPLICATE_OBSERVATION'));
  const replayPair = (await counts(h.registry)).pair;
  assert.deepEqual(replayPair.events.map((row) => row.eventKey).sort(), firstKeys);
  assert.deepEqual(replayPair.observations.map((row) => row.observationId).sort(), firstObservationIds);
  assert.deepEqual([replayPair.events.length, replayPair.observations.length], [5, 5]);
  assert.ok(first.every((row) => row.modeDisposition.score === 'NOT_EVALUATED' && row.modeDisposition.action === 'NOT_EVALUATED'));
  const files = await readdir(h.stateDir);
  assert.ok(files.includes(PRODUCTION_STORE_MARKER));
  const audit = (await readFile(join(h.stateDir, 'audit', 'registry-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter((row) => row.operation === 'WRITE_INTENT').length, 10);
  assert.equal(audit.filter((row) => row.operation === 'WRITE_RESULT' && row.success).length, 10);
  assert.ok(audit.every((row) => ['when', 'runtimeMode', 'source', 'operation', 'eventKey', 'observationId', 'disposition', 'success', 'reasonCode'].every((key) => key in row)));
  assert.ok(audit.filter((row) => row.operation === 'WRITE_RESULT' && row.success).every((row) => row.eventIdentity?.provenance && row.evidenceReference && row.modeDisposition.score === 'NOT_EVALUATED' && row.modeDisposition.action === 'NOT_EVALUATED'));
  const writeRows = audit.filter((row) => ['WRITE_INTENT', 'WRITE_RESULT'].includes(row.operation));
  assert.ok(writeRows.every((row) => typeof row.observationId === 'string' && row.observationId.length > 0));
  for (const item of capture.items) {
    const input = inputFor(item);
    const expectedId = expectedObservationId(input);
    const eventRows = writeRows.filter((row) => row.eventKey === input.identity.eventKey);
    assert.equal(eventRows.length, 4);
    for (let index = 0; index < eventRows.length; index += 2) {
      assert.equal(eventRows[index].operation, 'WRITE_INTENT');
      assert.equal(eventRows[index + 1].operation, 'WRITE_RESULT');
      assert.equal(eventRows[index].observationId, eventRows[index + 1].observationId);
      assert.equal(eventRows[index].observationId, expectedId);
    }
    assert.equal(firstPair.observations.find((row) => row.eventKey === input.identity.eventKey).observationId, expectedId);
  }

  const metrics = h.registry.getMetrics();
  const sideEffects = h.registry.getSideEffectAccounting();
  assert.equal(metrics.recordsReceived, 10);
  assert.equal(metrics.candidateReady, 10);
  assert.equal(metrics.evidenceReady, 10);
  assert.equal(metrics.identityReady, 10);
  assert.equal(metrics.registryWriteSucceeded, 10);
  assert.equal(metrics.duplicateObservation, 5);
  assert.equal(metrics.scoreExecutions ?? 0, 0);
  assert.equal(sideEffects.productionRegistryWrites.calls, 10);
  assert.equal(sideEffects.productionRegistryWrites.effectUnits, 10);
  assert.equal(sideEffects.productionRegistryWrites.zeroEffectReturns, 5);
  assert.equal(sideEffects.productionRegistryWrites.nonzeroEffectReturns, 5);
  assert.equal(sideEffects.canaryRegistryReads.status, 'NOT_CALLED');
  assert.equal(sideEffects.canaryRegistryWrites.status, 'NOT_CALLED');
  assert.equal(sideEffects.publisherCalls.status, 'NOT_CALLED');
  assert.equal(sideEffects.deploymentCalls.status, 'NOT_CALLED');
  assert.equal(sideEffects.scoreExecutions.status, 'NOT_CALLED');
  assert.equal(sideEffects.actionExecutions.status, 'NOT_CALLED');
  evidence.mainReplayMetrics = metrics;
  evidence.mainReplaySideEffects = sideEffects;
  evidence.mainReplay = { firstPass: '5 Events / 5 Observations', replay: '0 new Events / 0 new Observations', disposition: 'DUPLICATE_OBSERVATION', exactEventKeys: true, exactObservationIds: true, backupsBeforeMutation: metrics.backupsCreated };

  await h.registry.restoreBackup(initialBackup.backupId);
  const restored = await counts(h.registry);
  assert.deepEqual([restored.events, restored.observations], [0, 0]);
  evidence.testSuites.fiveReleaseIdempotency = 'PASS';
});

test('backup manifest verifies Event, Observation and metadata bytes; populated restore is exact', async () => {
  const h = await newHarness();
  for (const item of capture.items.slice(0, 2)) await h.registry.commit(inputFor(item));
  const populatedBackup = await h.registry.createBackup();
  const verified = await h.registry.verifyBackup(populatedBackup.backupId);
  assert.equal(verified.valid, true);
  const priorBytes = {
    events: canonicalRegistryBytes(verified.pair.events, 'eventKey'),
    observations: canonicalRegistryBytes(verified.pair.observations, 'observationId'),
  };
  await h.registry.commit(inputFor(capture.items[2]));
  await h.registry.restoreBackup(populatedBackup.backupId);
  const restored = await h.registry.readPair();
  assert.deepEqual(restored, verified.pair, 'all Registry metadata and operational fields are restored exactly');
  assert.deepEqual(canonicalRegistryBytes(restored.events, 'eventKey'), priorBytes.events);
  assert.deepEqual(canonicalRegistryBytes(restored.observations, 'observationId'), priorBytes.observations);
  assert.deepEqual(await readFile(join(h.stateDir, 'radar-event-registry.jsonl')), verified.eventBytes);
  assert.deepEqual(await readFile(join(h.stateDir, 'radar-observation-registry.jsonl')), verified.observationBytes);
  assert.deepEqual([restored.events.length, restored.observations.length], [2, 2]);
  evidence.testSuites.backupRestore = 'PASS; empty and populated pairs restore byte-identically';
});

test('atomic transaction failure points recover deterministically and retries converge without orphan rows', async (t) => {
  const cases = [
    ['before-event-write', 0],
    ['during-event-write', 0],
    ['between-event-observation', 0],
    ['during-observation-write', 0],
    ['after-event-rename', 1],
    ['after-observation-rename', 1],
    ['after-durable-before-response', 1],
  ];
  for (const [failurePoint, recoveredCount] of cases) {
    await t.test(failurePoint, async () => {
      const h = await newHarness({ registryRuntime: { failurePoint } });
      await assert.rejects(h.registry.commit(inputFor(capture.items[0])));
      const normal = new ProductionIdentityRegistry({
        stateDir: h.stateDir, canaryStateDir: h.canaryStateDir, v1StateDir: DEFAULT_V1_CONTENT_DIR,
        authorized: true, enabled: true, runtimeMode: PRODUCTION_IDENTITY_MODE,
        registryRuntime: { lockTimeoutMs: 5_000, transactionIdFactory: () => `recovery-${++sequence}` },
      });
      const afterRecovery = await counts(normal);
      assert.deepEqual([afterRecovery.events, afterRecovery.observations], [recoveredCount, recoveredCount]);
      await normal.commit(inputFor(capture.items[0]));
      const final = await counts(normal);
      assert.deepEqual([final.events, final.observations], [1, 1]);
      assert.equal(final.pair.events[0].observationIds.length, 1);
    });
  }
  evidence.testSuites.atomicity = 'PASS; seven staged/rename/durable fault points with deterministic recovery and retry';
});

test('same and distinct concurrent identities serialize through one Registry lock', async () => {
  const h = await newHarness();
  const second = new ProductionIdentityRegistry({
    stateDir: h.stateDir, canaryStateDir: h.canaryStateDir, v1StateDir: DEFAULT_V1_CONTENT_DIR,
    authorized: true, enabled: true, runtimeMode: PRODUCTION_IDENTITY_MODE,
    registryRuntime: { lockTimeoutMs: 5_000, transactionIdFactory: () => `concurrent-${++sequence}` },
  });
  await Promise.all([h.registry.commit(inputFor(capture.items[0])), second.commit(inputFor(capture.items[0]))]);
  let pair = await counts(h.registry);
  assert.deepEqual([pair.events, pair.observations], [1, 1]);
  await Promise.all([h.registry.commit(inputFor(capture.items[1])), second.commit(inputFor(capture.items[2]))]);
  pair = await counts(h.registry);
  assert.deepEqual([pair.events, pair.observations], [3, 3]);
  evidence.testSuites.concurrency = 'PASS; same observation converges to 1/1, distinct concurrent identities to 3/3';
});

test('kill switch rejects ingestion, permits explicit authorized recovery, and ends disabled', async () => {
  let externalKill = false;
  const h = await newHarness({ killSwitch: () => externalKill });
  h.registry.disable();
  await assert.rejects(h.registry.commit(inputFor(capture.items[0])), (error) => error.code === 'PRODUCTION_REGISTRY_DISABLED');
  h.registry.enable();
  await h.registry.commit(inputFor(capture.items[0]));
  externalKill = true;
  await assert.rejects(h.registry.commit(inputFor(capture.items[1])), (error) => error.code === 'PRODUCTION_REGISTRY_KILL_SWITCH');
  const rejectedRows = (await readFile(join(h.stateDir, 'audit', 'registry-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter((row) => row.operation === 'WRITE_REJECTED');
  assert.equal(rejectedRows.at(-1).reasonCode, 'PRODUCTION_REGISTRY_KILL_SWITCH');
  assert.equal(rejectedRows.at(-1).observationId, null, 'kill-switch rejection occurs before Observation Identity is established');
  externalKill = false;
  const backup = await h.registry.createBackup();
  h.registry.disable();
  await h.registry.restoreBackup(backup.backupId);
  await assert.rejects(h.registry.commit(inputFor(capture.items[1])), (error) => error.code === 'PRODUCTION_REGISTRY_DISABLED');
  assert.equal(h.registry.enabled, false);
  externalKill = true;
  await assert.rejects(h.registry.commit(inputFor(capture.items[1])), (error) => error.code === 'PRODUCTION_REGISTRY_KILL_SWITCH');
  externalKill = false;
  const finalCount = await counts(h.registry);
  assert.deepEqual([finalCount.events, finalCount.observations], [1, 1]);
  evidence.testSuites.killSwitchAndRecovery = 'PASS; writes fail closed; explicit restore works while ingestion is disabled; final disabled';
});

test('audit failure blocks pre-commit mutation; missing post-commit audit outcome disables ingestion', async () => {
  const before = await newHarness({ auditFailurePoint: 'before-intent' });
  await assert.rejects(before.registry.commit(inputFor(capture.items[0])), (error) => error.code === 'PRODUCTION_REGISTRY_AUDIT_UNAVAILABLE');
  const beforeAuditCount = await counts(before.registry);
  assert.deepEqual([beforeAuditCount.events, beforeAuditCount.observations], [0, 0]);

  const after = await newHarness({ auditFailurePoint: 'after-commit' });
  await assert.rejects(after.registry.commit(inputFor(capture.items[0])), (error) => error.code === 'PRODUCTION_REGISTRY_AUDIT_RESULT_MISSING');
  assert.equal(after.registry.enabled, false);
  const afterAuditCount = await counts(after.registry);
  assert.deepEqual([afterAuditCount.events, afterAuditCount.observations], [1, 1]);
  const rows = (await readFile(join(after.stateDir, 'audit', 'registry-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).committed, true);
  assert.equal(rows.at(-1).observationId, expectedObservationId(inputFor(capture.items[0])));
  evidence.testSuites.auditFailClosed = 'PASS; pre-write failure blocks mutation, post-commit outcome gap disables runtime and records committed=true';
});

test('prepared Observation ID survives a Registry write failure and malformed candidates are explicitly pre-identity rejections', async () => {
  let failWrites = false;
  const h = await newHarness({ registryRuntime: { beforeCommit: () => { if (failWrites) throw Object.assign(new Error('injected write failure'), { code: 'INJECTED_WRITE_FAILURE' }); } } });
  const input = inputFor(capture.items[0]);
  const expectedId = expectedObservationId(input);
  await h.registry.commit(input);
  failWrites = true;
  await assert.rejects(h.registry.commit(input), (error) => error.code === 'INJECTED_WRITE_FAILURE');
  failWrites = false;
  const audit = (await readFile(join(h.stateDir, 'audit', 'registry-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const intent = audit.filter((row) => row.operation === 'WRITE_INTENT').at(-1);
  const failedResult = audit.filter((row) => row.operation === 'WRITE_RESULT' && row.success === false).at(-1);
  assert.equal(intent.observationId, expectedId);
  assert.equal(failedResult.observationId, expectedId);
  assert.equal(failedResult.reasonCode, 'INJECTED_WRITE_FAILURE');
  assert.equal(failedResult.committed, false);

  const malformed = structuredClone(input);
  malformed.candidateResult.status = 'RECEIPT_ONLY';
  await assert.rejects(h.registry.commit(malformed), (error) => error.code === 'PRODUCTION_CANDIDATE_NOT_READY');
  const rejected = (await readFile(join(h.stateDir, 'audit', 'registry-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter((row) => row.operation === 'WRITE_REJECTED').at(-1);
  assert.equal(rejected.reasonCode, 'PRODUCTION_CANDIDATE_NOT_READY');
  assert.equal(rejected.observationId, null, 'malformed Candidate is rejected before Evidence and Observation Identity preparation');
  const final = await counts(h.registry);
  assert.deepEqual([final.events, final.observations], [1, 1]);
  evidence.testSuites.auditIdentityPropagation = 'PASS; new and duplicate writes, matching intent/result/Registry IDs, Registry failure after identity, malformed pre-identity rejection, kill switch, and audit failure';
});

test('corrupt metadata, Registry rows, pair relationships and backup hashes fail closed without reset', async (t) => {
  const cases = ['metadata', 'truncated_state', 'invalid_event_row', 'invalid_observation_row', 'orphan_observation', 'duplicate_event', 'invalid_backup_checksum'];
  for (const kind of cases) {
    await t.test(kind, async () => {
      const h = await newHarness();
      if (kind !== 'metadata') await h.registry.commit(inputFor(capture.items[0]));
      if (kind === 'metadata') {
        await h.registry.initialize();
        const markerPath = join(h.stateDir, PRODUCTION_STORE_MARKER);
        await writeFile(markerPath, '{bad metadata\n');
        const before = await readFile(markerPath);
        await assert.rejects(h.registry.readPair(), (error) => error.code === 'PRODUCTION_REGISTRY_METADATA_CORRUPT');
        assert.deepEqual(await readFile(markerPath), before);
        const quarantineRoot = join(h.stateDir, 'radar-registry-quarantine');
        const quarantines = await readdir(quarantineRoot);
        assert.equal(quarantines.length, 1);
        const quarantinePath = join(quarantineRoot, quarantines[0]);
        const manifest = JSON.parse(await readFile(join(quarantinePath, 'metadata.json'), 'utf8'));
        assert.equal(manifest.failureClass, 'PRODUCTION_REGISTRY_METADATA_CORRUPT');
        assert.equal(manifest.evidenceFiles[0].sha256, digest(before));
        assert.deepEqual(await readFile(join(quarantinePath, manifest.evidenceFiles[0].quarantineFile)), before);
        return;
      }
      if (kind === 'invalid_backup_checksum') {
        const backup = await h.registry.createBackup();
        const manifestPath = join(h.stateDir, 'radar-production-registry-backups', backup.backupId, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.eventSha256 = '0'.repeat(64);
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
        const before = await h.registry.readPair();
        await assert.rejects(h.registry.restoreBackup(backup.backupId), (error) => error.code === 'PRODUCTION_REGISTRY_BACKUP_INVALID');
        const after = await h.registry.readPair();
        assert.deepEqual(after, before);
        return;
      }
      const eventPath = join(h.stateDir, 'radar-event-registry.jsonl');
      const observationPath = join(h.stateDir, 'radar-observation-registry.jsonl');
      if (kind === 'truncated_state') await writeFile(eventPath, '{truncated\n');
      if (kind === 'invalid_event_row') {
        const rows = (await readFile(eventPath, 'utf8')).trim().split('\n').map(JSON.parse);
        rows[0].scoreStatus = 'SCORE_NOT_EVALUATED';
        await writeFile(eventPath, `${rows.map(JSON.stringify).join('\n')}\n`);
      }
      if (kind === 'invalid_observation_row') {
        const rows = (await readFile(observationPath, 'utf8')).trim().split('\n').map(JSON.parse);
        rows[0].actionStatus = 'NOT_EVALUATED';
        await writeFile(observationPath, `${rows.map(JSON.stringify).join('\n')}\n`);
      }
      if (kind === 'orphan_observation') {
        const rows = (await readFile(observationPath, 'utf8')).trim().split('\n').map(JSON.parse);
        rows[0].eventKey = 'missing-entity:version-update:9.9.9';
        await writeFile(observationPath, `${rows.map(JSON.stringify).join('\n')}\n`);
      }
      if (kind === 'duplicate_event') {
        const bytes = await readFile(eventPath, 'utf8');
        await writeFile(eventPath, bytes + bytes);
      }
      const corruptedFiles = [];
      for (const path of [eventPath, observationPath]) if (await lstat(path).then(() => true).catch(() => false)) corruptedFiles.push([path, await readFile(path)]);
      await assert.rejects(h.registry.readPair());
      for (const [path, bytes] of corruptedFiles) assert.deepEqual(await readFile(path), bytes, 'corrupt evidence remains untouched');
      assert.equal(await lstat(join(h.stateDir, 'radar-registry-quarantine')).then(() => true).catch(() => false), true);
    });
  }
  evidence.testSuites.corruption = 'PASS; seven corruption classes rejected, original state preserved or quarantined, no empty fallback';
});

test('Score, Action and publication capability attempts are observable and rejected before execution', async () => {
  const h = await newHarness();
  const blockedCapabilities = ['score', 'action', 'publication', 'canary-registry-read', 'canary-registry-write', 'v1-mutation'];
  for (const name of blockedCapabilities) {
    await assert.rejects(h.registry.invokeForbiddenCapability(name), (error) => error.code === `PRODUCTION_${name.toUpperCase().replaceAll('-', '_')}_FORBIDDEN`);
  }
  const counters = h.registry.getSideEffectAccounting();
  assert.equal(counters.scoreExecutions.effectUnits, 0);
  assert.equal(counters.scoreExecutions.status, 'CALLED_AND_REJECTED');
  assert.equal(counters.actionExecutions.effectUnits, 0);
  assert.equal(counters.actionExecutions.status, 'CALLED_AND_REJECTED');
  assert.equal(counters.publicationEvaluations.status, 'CALLED_AND_REJECTED');
  assert.equal(counters.publisherCalls.status, 'NOT_CALLED');
  assert.equal(counters.canaryRegistryReads.status, 'CALLED_AND_REJECTED');
  assert.equal(counters.canaryRegistryReads.effectUnits, 0);
  assert.equal(counters.canaryRegistryWrites.status, 'CALLED_AND_REJECTED');
  assert.equal(counters.canaryRegistryWrites.effectUnits, 0);
  assert.equal(counters.v1Mutations.status, 'CALLED_AND_REJECTED');
  assert.equal(counters.v1Mutations.effectUnits, 0);
  assert.equal(h.registry.getMetrics().forbiddenCapabilityCalls, 6);
  const audit = (await readFile(join(h.stateDir, 'audit', 'registry-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter((row) => row.operation === 'FORBIDDEN_CAPABILITY').length, 6);
  evidence.testSuites.forbiddenCapabilities = 'PASS; Score/Action/Publication attempted guards are measured and rejected; no evaluator invoked';
});

test('path collision and unauthorized writes never route into Canary or V1 state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'horizon-production-collision-'));
  roots.add(root);
  const colliding = new ProductionIdentityRegistry({ stateDir: join(root, 'nest', PRODUCTION_REGISTRY_NAMESPACE), canaryStateDir: root, v1StateDir: DEFAULT_V1_CONTENT_DIR, authorized: true, enabled: true });
  await assert.rejects(colliding.initialize(), (error) => error.code === 'PRODUCTION_REGISTRY_PATH_COLLISION');

  const symlinkRoot = await mkdtemp(join(tmpdir(), 'horizon-production-symlink-'));
  roots.add(symlinkRoot);
  const actualNamespace = join(symlinkRoot, 'actual', PRODUCTION_REGISTRY_NAMESPACE);
  const linkedNamespace = join(symlinkRoot, 'linked', PRODUCTION_REGISTRY_NAMESPACE);
  await mkdir(actualNamespace, { recursive: true });
  await mkdir(join(symlinkRoot, 'linked'), { recursive: true });
  await symlink(actualNamespace, linkedNamespace, 'dir');
  const linked = new ProductionIdentityRegistry({ stateDir: linkedNamespace, canaryStateDir: root, v1StateDir: DEFAULT_V1_CONTENT_DIR, authorized: true, enabled: true });
  await assert.rejects(linked.initialize(), (error) => error.code === 'PRODUCTION_REGISTRY_PATH_COLLISION');
  const unauthorized = new ProductionIdentityRegistry({ stateDir: join(root, 'other', PRODUCTION_REGISTRY_NAMESPACE), canaryStateDir: join(root, 'canary'), v1StateDir: DEFAULT_V1_CONTENT_DIR });
  await assert.rejects(unauthorized.commit(inputFor(capture.items[0])), (error) => error.code === 'PRODUCTION_REGISTRY_NOT_AUTHORIZED');
  evidence.testSuites.isolationAndAuthorization = 'PASS';
});
