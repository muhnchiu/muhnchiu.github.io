import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContinuousProductionIngestion, INGESTION_LIMITS, parseClaudeCodeAtomFeed } from '../src/lib/radar-production-registry/continuous-ingestion.mjs';
import { createProductionIdentityRegistry } from '../src/lib/radar-production-registry/production-identity-registry.mjs';

const feed = (tags = ['v9.8.7']) => `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">${tags.map((tag, i) => `<entry><id>https://github.com/anthropics/claude-code/releases/tag/${tag}</id><title>Claude Code ${tag} &amp; release</title><updated>2026-10-03T10:0${i}:00Z</updated><link href="https://github.com/anthropics/claude-code/releases/tag/${tag}" /></entry>`).join('')}</feed>`;
const fakeFetch = (xml) => async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => xml });
async function sandbox(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'horizon-prod-ingestion-test-'));
  const stateDir = join(root, 'radar-v2-prod-identity-dev-claude-code');
  const runtime = createContinuousProductionIngestion({ stateDir, fetchImpl: fakeFetch(feed()), sleep: async () => {}, ...options });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir, runtime };
}

test('Atom parser admits official release shape and rejects declarations / broken roots', () => {
  const rows = parseClaudeCodeAtomFeed(feed(['v9.8.7']));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Claude Code v9.8.7 & release');
  assert.throws(() => parseClaudeCodeAtomFeed('<!DOCTYPE feed [<!ENTITY x "bad">]><feed/>'), { code: 'TEMPORARY_PARSE_FAILURE' });
  assert.throws(() => parseClaudeCodeAtomFeed('<feed><entry></feed>'), { code: 'TEMPORARY_PARSE_FAILURE' });
});

test('control state defaults disabled and disabled writes reject before mutation', async (t) => {
  const { runtime } = await sandbox(t);
  assert.equal((await runtime.control()).ingestion, 'DISABLED');
  const records = parseClaudeCodeAtomFeed(feed());
  const { createClaudeCodeFeedCandidate } = await import('../src/lib/radar-production-registry/claude-code-feed-capture.mjs');
  const input = createClaudeCodeFeedCandidate(records[0], { observedAt: '2026-10-03T10:00:00Z' });
  await assert.rejects(runtime.registry.commit({ ...input, runtimeMode: 'PRODUCTION_IDENTITY_REGISTRY', productionRegistryEnabled: true }), { code: 'PRODUCTION_REGISTRY_DISABLED' });
  assert.equal((await runtime.verifyRegistry()).events, 0);
});

test('controlled run writes deterministic identities, replays idempotently and persists audit IDs', async (t) => {
  const { runtime, stateDir } = await sandbox(t, { fetchImpl: fakeFetch(feed(['v9.8.7', 'v9.8.6'])) });
  await runtime.enable();
  const result = await runtime.runOnce({ replayCount: 5 });
  assert.equal(result.finalStatus, 'RUN_SUCCESS', JSON.stringify(result.failures));
  assert.equal(result.replayPasses, 5);
  assert.equal(result.eventCount, 2);
  assert.equal(result.observationCount, 2);
  assert.equal(result.newEvents, 2);
  assert.equal(result.newObservations, 2);
  const rows = (await readFile(join(stateDir, 'audit', 'registry-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const writes = rows.filter((row) => ['WRITE_INTENT', 'WRITE_RESULT'].includes(row.operation));
  assert.ok(writes.length >= 4);
  assert.ok(writes.every((row) => typeof row.observationId === 'string' && row.observationId.length > 0));
  assert.equal((await runtime.verifyRegistry()).observations, 2);
});

test('same-process parallel run is rejected and stale dead-owner lock is recovered', async (t) => {
  const { runtime } = await sandbox(t);
  const release = await runtime.acquireLock('first-run');
  await assert.rejects(runtime.acquireLock('second-run'), { code: 'RUN_ALREADY_ACTIVE' });
  await release();
  const lock = join(runtime.ingestionDir, 'run.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, host: (await import('node:os')).hostname(), startedAt: new Date(Date.now() - INGESTION_LIMITS.staleRunMs - 1000).toISOString(), runId: 'dead-run' }));
  const unlock = await runtime.acquireLock('recovered-run');
  await unlock();
});

test('fetch transient retries are bounded', async (t) => {
  let calls = 0;
  const { runtime } = await sandbox(t, { fetchImpl: async () => { calls += 1; if (calls < 3) throw new TypeError('temporary network'); return { ok: true, status: 200, headers: { get: () => null }, text: async () => feed() }; } });
  const result = await runtime.fetchFeed();
  assert.equal(result.records.length, 1);
  assert.equal(calls, 3);
  calls = 0;
  const failing = createContinuousProductionIngestion({ stateDir: runtime.stateDir, fetchImpl: async () => { calls += 1; throw new TypeError('offline'); }, sleep: async () => {} });
  await assert.rejects(failing.fetchFeed(), { code: 'NETWORK_TRANSIENT' });
  assert.equal(calls, INGESTION_LIMITS.maxFetchAttempts);
  calls = 0;
  const readonlyCode = createContinuousProductionIngestion({ stateDir: runtime.stateDir, fetchImpl: async () => {
    calls += 1; const error = new TypeError('network transient with readonly code');
    Object.defineProperty(error, 'code', { get: () => 'ERR_NETWORK_TRANSIENT' });
    throw error;
  }, sleep: async () => {} });
  await assert.rejects(readonlyCode.fetchFeed(), { code: 'NETWORK_TRANSIENT' });
  assert.equal(calls, INGESTION_LIMITS.maxFetchAttempts);
  calls = 0;
  const timeout = createContinuousProductionIngestion({ stateDir: runtime.stateDir, fetchImpl: async () => {
    calls += 1; const error = new Error('The operation was aborted due to timeout'); error.code = 23; throw error;
  }, sleep: async () => {} });
  await assert.rejects(timeout.fetchFeed(), { code: 'SOURCE_TIMEOUT' });
  assert.equal(calls, INGESTION_LIMITS.maxFetchAttempts);
});

test('complete retrieval with parser EOF is nonretryable', async (t) => {
  let calls = 0; const delays = [];
  const { runtime } = await sandbox(t, { fetchImpl: async () => { calls += 1; return { ok: true, status: 200, headers: { get: () => null }, text: async () => '<feed><entry>' }; }, sleep: async ms => delays.push(ms) });
  await assert.rejects(runtime.fetchFeed(), { code: 'MALFORMED_PAYLOAD' });
  assert.equal(calls, 1); assert.deepEqual(delays, []);
});

test('duplicate feed entries do not grow Event or Observation registries', async (t) => {
  const duplicate = feed(['v9.8.7', 'v9.8.7']);
  const { runtime } = await sandbox(t, { fetchImpl: fakeFetch(duplicate) });
  await runtime.enable();
  const result = await runtime.runOnce({ replayCount: 0 });
  assert.equal(result.finalStatus, 'RUN_SUCCESS');
  assert.equal(result.eventCount, 1);
  assert.equal(result.observationCount, 1);
  assert.equal(result.duplicateCount, 1);
});

test('disable during a run prevents the next Registry commit', async (t) => {
  const { runtime } = await sandbox(t, { fetchImpl: fakeFetch(feed(['v9.8.7', 'v9.8.6'])) });
  await runtime.enable();
  const result = await runtime.runOnce({ replayCount: 0, beforeCommit: () => runtime.disable('TEST_DISABLE_DURING_RUN') });
  assert.equal(result.writeSuccessCount, 0);
  assert.equal((await runtime.verifyRegistry()).observations, 0);
  assert.ok(result.failures.some(({ reasonCode }) => reasonCode === 'INGESTION_DISABLED_DURING_RUN'));
});

test('invalid source item is isolated while valid items continue', async (t) => {
  const twoEntries = feed(['v9.8.7', 'v9.8.6']).replace('Claude Code v9.8.7 &amp; release', '');
  const { runtime } = await sandbox(t, { fetchImpl: fakeFetch(twoEntries) });
  await runtime.enable();
  const result = await runtime.runOnce({ replayCount: 0 });
  assert.equal(result.finalStatus, 'RUN_PARTIAL');
  assert.equal(result.writeSuccessCount, 1);
  assert.equal(result.eventCount, 1);
  assert.equal(result.observationCount, 1);
  assert.equal(result.failureCount, 1);
});

test('source item cap stops the batch at the configured backpressure limit', async (t) => {
  const { runtime } = await sandbox(t, { fetchImpl: fakeFetch(feed(['v9.8.7', 'v9.8.6'])), limits: { ...INGESTION_LIMITS, maxSourceItems: 1 } });
  await runtime.enable();
  const result = await runtime.runOnce({ replayCount: 0 });
  assert.equal(result.finalStatus, 'RUN_PARTIAL');
  assert.ok(result.failures.some(({ reasonCode }) => reasonCode === 'BACKPRESSURE_LIMIT_REACHED'));
  assert.equal(result.eventCount, 1);
  assert.equal(result.observationCount, 1);
});

test('a restarted runtime retries the same capture without registry growth', async (t) => {
  const { stateDir, runtime } = await sandbox(t, { fetchImpl: fakeFetch(feed()) });
  await runtime.enable();
  const first = await runtime.runOnce({ replayCount: 0 });
  const restarted = createContinuousProductionIngestion({ stateDir, fetchImpl: fakeFetch(feed()), sleep: async () => {} });
  const second = await restarted.runOnce({ replayCount: 0 });
  assert.equal(first.eventCount, 1);
  assert.equal(second.eventCount, 1);
  assert.equal(second.observationCount, 1);
  assert.equal(second.duplicateCount, 1);
});

test('scheduler dispatch requires its independent enable bit and produces one run', async (t) => {
  const { runtime } = await sandbox(t, { fetchImpl: fakeFetch(feed()) });
  await runtime.enable();
  await assert.rejects(runtime.schedulerDispatch(), { code: 'SCHEDULER_DISABLED' });
  await runtime.enableScheduler();
  const result = await runtime.schedulerDispatch({ scheduledAt: '2026-10-03T12:00:00.000Z' });
  assert.equal(result.finalStatus, 'RUN_SUCCESS');
  assert.equal(result.schedulerId, 'horizon-radar-v2-production');
  assert.equal(result.scheduledAt, '2026-10-03T12:00:00.000Z');
  await runtime.disable();
});

test('scheduler dry run fetches, captures and resolves candidates while never accessing Registry', async (t) => {
  const { runtime, stateDir } = await sandbox(t, { fetchImpl: fakeFetch(feed(['v9.8.7', 'v9.8.6'])), registryFactory: () => new Proxy({}, { get(_target, key) { if (key === 'disable') return () => {}; throw new Error(`Registry access forbidden in dry run: ${String(key)}`); } }) });
  await assert.rejects(runtime.schedulerDryRun(), { code: 'SCHEDULER_DISABLED' });
  await runtime.enableScheduler();
  const result = await runtime.schedulerDryRun({ scheduledAt: '2026-10-03T12:00:00.000Z' });
  assert.equal(result.finalStatus, 'DRY_RUN_SUCCESS', JSON.stringify(result.failures));
  assert.equal(result.registryAccess, 'NONE');
  assert.equal(result.captureHash.length, 64);
  assert.equal(result.itemCount, 2);
  assert.equal(result.candidateReadyCount, 2);
  assert.equal(result.evidenceReadyCount, 2);
  assert.equal(result.identityReadyCount, 2);
  assert.equal((await runtime.control()).ingestion, 'DISABLED');
  await assert.rejects(readFile(join(stateDir, 'radar-event-registry.jsonl')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(stateDir, 'radar-observation-registry.jsonl')), { code: 'ENOENT' });
  assert.equal((await readFile(result.capturePath, 'utf8')).includes('CONTENT_RETURNED'), true);
  assert.equal((await readFile(join(runtime.ingestionDir, 'last-scheduler-dry-run.json'), 'utf8')).includes('DRY_RUN_SUCCESS'), true);
});

test('terminal source timeout is bounded and cannot create partial success or Registry writes', async (t) => {
  let attempts = 0;
  const { runtime, stateDir } = await sandbox(t, { fetchImpl: async () => { attempts += 1; throw Object.assign(new Error('official source timeout'), { code: 'SOURCE_TIMEOUT' }); } });
  await runtime.enable();
  const before = await runtime.verifyRegistry();
  const result = await runtime.runOnce({ replayCount: 0 });
  const after = await runtime.verifyRegistry();
  assert.equal(attempts, INGESTION_LIMITS.maxFetchAttempts);
  assert.equal(result.finalStatus, 'RUN_FAILED');
  assert.equal(result.lastFailureReason, 'SOURCE_TIMEOUT');
  assert.equal(result.writeIntentCount, 0);
  assert.equal(result.writeSuccessCount, 0);
  assert.equal(result.captureHash, null);
  assert.deepEqual(after, before);
  const audit = await readFile(join(stateDir, 'audit', 'registry-operations.jsonl'), 'utf8');
  assert.equal(audit.includes('WRITE_INTENT'), false);
  assert.equal(audit.includes('WRITE_RESULT'), false);
});

test('temporary Registry write failure retries once and then commits', async (t) => {
  let attempts = 0;
  const registryFactory = (options) => {
    const registry = createProductionIdentityRegistry(options);
    const commit = registry.commit.bind(registry);
    registry.commit = async (...args) => { attempts += 1; if (attempts === 1) throw Object.assign(new Error('temporary write'), { code: 'REGISTRY_TEMPORARY_WRITE_FAILURE' }); return commit(...args); };
    return registry;
  };
  const { runtime } = await sandbox(t, { registryFactory });
  await runtime.enable();
  const result = await runtime.runOnce({ replayCount: 0 });
  assert.equal(result.finalStatus, 'RUN_SUCCESS');
  assert.equal(attempts, 2);
  assert.equal(result.observationCount, 1);
});

test('audit failure disables ingestion and prevents additional commits', async (t) => {
  const registryFactory = (options) => createProductionIdentityRegistry({ ...options, auditFailurePoint: 'before-intent' });
  const { runtime } = await sandbox(t, { registryFactory, fetchImpl: fakeFetch(feed(['v9.8.7', 'v9.8.6'])) });
  await runtime.enable();
  const result = await runtime.runOnce({ replayCount: 0 });
  assert.equal(result.finalStatus, 'RUN_FAILED');
  assert.equal((await runtime.control()).ingestion, 'DISABLED');
  assert.equal(result.writeSuccessCount, 0);
  assert.equal((await runtime.verifyRegistry()).observations, 0);
});

test('health retains last success across consecutive failures and normalizes timeout reason', async (t) => {
  const { runtime } = await sandbox(t);
  const log = join(runtime.ingestionDir, 'runs', '2026-10-03', 'runs.jsonl');
  await mkdir(join(runtime.ingestionDir, 'runs', '2026-10-03'), { recursive: true });
  const history = [
    { runId:'ok', startedAt:'2026-10-03T08:00:00Z', completedAt:'2026-10-03T08:00:01Z', finalStatus:'RUN_SUCCESS' },
    { runId:'bad1', startedAt:'2026-10-03T09:00:00Z', completedAt:'2026-10-03T09:00:01Z', finalStatus:'RUN_FAILED', failures:[{reasonCode:'NETWORK_TRANSIENT'}] },
    { runId:'bad2', startedAt:'2026-10-03T09:10:00Z', completedAt:'2026-10-03T09:10:01Z', finalStatus:'RUN_FAILED', failures:[{reasonCode:23,errorMessage:'The operation was aborted due to timeout'}] },
  ];
  await writeFile(log, history.map(JSON.stringify).join('\n')+'\n');
  const health = await runtime.health();
  assert.equal(health.state, 'DISABLED');
  assert.equal(health.lastSuccessfulRun, '2026-10-03T08:00:01Z');
  assert.equal(health.consecutiveFailures, 2);
  assert.equal(health.lastFailureReason, 'SOURCE_TIMEOUT');
});
