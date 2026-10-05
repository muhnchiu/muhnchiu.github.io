import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adaptProductionCandidate } from '../src/lib/radar-candidate-adapter/adapters.ts';
import { resolveClaudeCodeChangelogIdentity } from '../src/lib/radar-canary/claude-code-identity.mjs';
import { CANARY_NAMESPACE, CANARY_STORE_MARKER, createRegistryOnlyCanary } from '../src/lib/radar-canary/registry-only-canary.mjs';

const capture = JSON.parse(await readFile(new URL('../fixtures/radar-canary/claude-code-real-release-capture-v1.json', import.meta.url), 'utf8'));
const observedAt = '2026-10-03T03:00:00Z';
const roots = new Set();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function contentTreeHash(root) {
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const rows = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) rows.push(...await walk(path));
      else if (entry.isFile()) rows.push(`${path.slice(root.length + 1)}:${digest(await readFile(path))}`);
    }
    return rows;
  };
  return digest(Buffer.from((await walk(root)).sort().join('\n')));
}

test.after(async () => Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true }))));

async function newHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'horizon-canary-registry-'));
  roots.add(root);
  const canaryPath = join(root, CANARY_NAMESPACE);
  const productionPath = join(root, 'production');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(productionPath));
  return {
    root, canaryPath, productionPath,
    canary: createRegistryOnlyCanary({ enabled: true, stateDir: canaryPath, productionStateDir: productionPath, clock: () => new Date('2026-10-03T04:00:00Z'), ...options }),
  };
}

function candidateFor(item, overrides = {}, sourceName = 'Claude Code Changelog', radar = 'DEV') {
  const record = { tag_name: item.tagName, name: item.title, html_url: item.itemUrl, ...overrides };
  return adaptProductionCandidate({ radar, sourceName, record }, { observedAt });
}

function inputFor(item, ids = {}) {
  const adapted = candidateFor(item);
  assert.equal(adapted.status, 'CANDIDATE_READY');
  const identity = resolveClaudeCodeChangelogIdentity(adapted.candidate);
  assert.equal(identity.status, 'IDENTITY_READY');
  return { candidate: adapted.candidate, identity, runId: ids.runId ?? 'run-1', recordId: ids.recordId ?? item.tagName };
}

test('default is disabled and cannot create or mutate the selected Canary store implicitly', async () => {
  const h = await newHarness({ enabled: false });
  await assert.rejects(h.canary.commit(inputFor(capture.items[0])), (error) => error.code === 'CANARY_DISABLED');
  await assert.rejects(lstat(h.canaryPath), (error) => error.code === 'ENOENT');
});

test('default namespace is physically outside Production Registry storage and module has no Publisher or Deployment adapter', async () => {
  const { DEFAULT_CANARY_REGISTRY_DIR, DEFAULT_PRODUCTION_REGISTRY_DIR } = await import('../src/lib/radar-canary/registry-only-canary.mjs');
  assert.notEqual(DEFAULT_CANARY_REGISTRY_DIR, DEFAULT_PRODUCTION_REGISTRY_DIR);
  assert.equal(DEFAULT_CANARY_REGISTRY_DIR.startsWith(`${DEFAULT_PRODUCTION_REGISTRY_DIR}/`), false);
  const source = await readFile(new URL('../src/lib/radar-canary/registry-only-canary.mjs', import.meta.url), 'utf8');
  assert.equal(/from ['"][^'"]*(publisher|deployment)/i.test(source), false);
  assert.equal(/\.publish\s*\(/i.test(source), false);
});

test('store path equal to or beneath Production Registry is rejected before store creation', async () => {
  const h = await newHarness();
  const equalPath = createRegistryOnlyCanary({ enabled: true, stateDir: h.productionPath, productionStateDir: h.productionPath });
  await assert.rejects(equalPath.commit(inputFor(capture.items[0])), (error) => error.code === 'CANARY_REGISTRY_PATH_COLLISION');
  const collision = createRegistryOnlyCanary({ enabled: true, stateDir: join(h.productionPath, CANARY_NAMESPACE), productionStateDir: h.productionPath });
  await assert.rejects(collision.commit(inputFor(capture.items[0])), (error) => error.code === 'CANARY_REGISTRY_PATH_COLLISION');
  await assert.rejects(lstat(join(h.productionPath, CANARY_NAMESPACE)), (error) => error.code === 'ENOENT');
});

test('only DEV / Claude Code Changelog is allowlisted; all other Radars and DEV sources fail closed', async () => {
  const h = await newHarness();
  for (const [radar, sourceName] of [['AI', 'Claude Code Changelog'], ['APP', 'Claude Code Changelog'], ['SEC', 'Claude Code Changelog'], ['SKILL', 'Claude Code Changelog'], ['DEV', 'GitHub Trending']]) {
    const adapted = candidateFor(capture.items[0], {}, sourceName, radar);
    await assert.rejects(h.canary.commit({ candidate: adapted.candidate, identity: { status: 'IDENTITY_READY' }, runId: 'blocked', recordId: `${radar}-${sourceName}` }), (error) => error.code === 'CANARY_SOURCE_NOT_ALLOWED');
  }
  await assert.rejects(lstat(h.canaryPath), (error) => error.code === 'ENOENT', 'disallowed sources do not initialize the store');
});

test('five real releases commit to isolated Canary Registry and exact replay is idempotent', async () => {
  const h = await newHarness();
  const v1ContentRoot = new URL('../src/content/radar/', import.meta.url).pathname;
  const v1Before = await contentTreeHash(v1ContentRoot);
  const first = [];
  for (const item of capture.items) first.push(await h.canary.commit(inputFor(item)));
  assert.equal(first.length, 5);
  assert.ok(first.every(({ record }) => record.registryDisposition === 'NEW_EVENT'));
  assert.ok(first.every(({ record }) => record.scoreStatus === 'SCORE_NOT_EVALUATED' && record.scoreReason === 'SCORE_INPUT_INCOMPLETE'));
  assert.ok(first.every(({ record }) => !['score', 'signal', 'action', 'publicationDecision'].some((key) => Object.hasOwn(record, key))));
  assert.ok(first.every(({ productionRegistryReads, productionRegistryWrites, publisherCalls, deploymentCalls }) => productionRegistryReads === 0 && productionRegistryWrites === 0 && publisherCalls === 0 && deploymentCalls === 0));
  const afterFirst = await h.canary.readPair();
  assert.equal(afterFirst.events.length, 5);
  assert.equal(afterFirst.observations.length, 5);

  const restart = createRegistryOnlyCanary({ enabled: true, stateDir: h.canaryPath, productionStateDir: h.productionPath });
  for (const item of capture.items) {
    const replay = await restart.commit(inputFor(item));
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.record.registryDisposition, 'NEW_EVENT', 'same run/record retry returns the first immutable disposition');
  }
  const afterRestart = await restart.readPair();
  assert.deepEqual(afterRestart.events.map((row) => row.eventKey).sort(), afterFirst.events.map((row) => row.eventKey).sort());
  assert.deepEqual(afterRestart.observations.map((row) => row.observationId).sort(), afterFirst.observations.map((row) => row.observationId).sort());

  for (const item of capture.items) {
    const laterRun = await restart.commit(inputFor(item, { runId: 'run-2', recordId: `replay-${item.tagName}` }));
    assert.equal(laterRun.record.registryDisposition, 'DUPLICATE_OBSERVATION');
    assert.equal(laterRun.record.eventState, 'DUPLICATE');
  }
  const afterDuplicateRun = await restart.readPair();
  assert.equal(afterDuplicateRun.events.length, 5);
  assert.equal(afterDuplicateRun.observations.length, 5);
  assert.equal((await restart.listCanaryRecords()).length, 10);
  assert.equal(await contentTreeHash(v1ContentRoot), v1Before, 'V1 Radar content bytes are unchanged around Canary Registry evaluation');
});

test('identity, observation, provenance, evidence, score, and unexpected action fields are rejected before commit', async () => {
  const h = await newHarness();
  const input = inputFor(capture.items[0]);
  await assert.rejects(h.canary.commit({ ...input, identity: { ...input.identity, eventKey: 'claude-code:version-update:9.9.9' } }), (error) => error.code === 'CANARY_IDENTITY_INVALID');
  await assert.rejects(h.canary.commit({ ...input, observationId: 'bad-observation-id' }), (error) => error.code === 'CANARY_OBSERVATION_ID_INVALID');
  const noAuthority = structuredClone(input.candidate); noAuthority.sourceAuthority = undefined;
  await assert.rejects(h.canary.commit({ ...input, candidate: noAuthority }), (error) => error.code === 'CANARY_EVIDENCE_INVALID');
  const noUrl = structuredClone(input.candidate); noUrl.itemUrl = undefined;
  await assert.rejects(h.canary.commit({ ...input, candidate: noUrl }), (error) => error.code === 'CANARY_EVIDENCE_INVALID');
  await assert.rejects(h.canary.commit({ ...input, score: 0 }), (error) => error.code === 'CANARY_SCORE_BOUNDARY_VIOLATION');
  await assert.rejects(h.canary.commit({ ...input, candidate: { ...input.candidate, action: 'ADOPT' } }), (error) => error.code === 'CANARY_SCORE_BOUNDARY_VIOLATION');
  await assert.rejects(lstat(h.canaryPath), (error) => error.code === 'ENOENT', 'rejected fields do not initialize or partially write the Canary store');
});

test('injected store write failure fails closed with an empty Canary Registry pair', async () => {
  const h = await newHarness({ testFailurePoint: 'before-registry-commit' });
  await assert.rejects(h.canary.commit(inputFor(capture.items[0])), (error) => error.code === 'CANARY_STORE_WRITE_FAILED');
  assert.deepEqual(await h.canary.readPair(), { events: [], observations: [] });
  assert.equal((await h.canary.listCanaryRecords()).length, 0);
});

test('failure before final atomic state replacement leaves no partial Event, Observation, or Canary record', async () => {
  const h = await newHarness({ testFailurePoint: 'before-state-commit' });
  await assert.rejects(h.canary.commit(inputFor(capture.items[0])), (error) => error.code === 'CANARY_STORE_WRITE_FAILED');
  assert.deepEqual(await h.canary.readPair(), { events: [], observations: [] });
  assert.equal((await h.canary.listCanaryRecords()).length, 0);
});

test('actual Canary store write failure does not create a record or fall back to Production Registry', async () => {
  const h = await newHarness();
  await h.canary.initialize();
  await writeFile(join(h.canaryPath, '.work'), 'blocks-working-directory');
  await assert.rejects(h.canary.commit(inputFor(capture.items[0])));
  assert.deepEqual(await h.canary.readPair(), { events: [], observations: [] });
  assert.equal((await h.canary.listCanaryRecords()).length, 0);
  assert.equal(await readFile(join(h.canaryPath, '.work'), 'utf8'), 'blocks-working-directory');
  assert.equal((await readdir(h.productionPath)).length, 0);
});

test('corrupt existing Canary receipt is rejected and is never repaired or routed to Production', async () => {
  const h = await newHarness();
  const input = inputFor(capture.items[0]);
  await h.canary.commit(input);
  const recordFile = join(h.canaryPath, 'canary-state-v1.json');
  const corrupt = Buffer.from('{not-json\n');
  await writeFile(recordFile, corrupt);
  await assert.rejects(h.canary.commit(input));
  assert.deepEqual(await readFile(recordFile), corrupt);
  await assert.rejects(h.canary.readPair(), (error) => error.code === 'CANARY_STORE_CORRUPT');
});

test('kill switch blocks new writes and Canary-only reset leaves Production Registry sentinel unchanged', async () => {
  const h = await newHarness();
  const sentinelPath = join(h.productionPath, 'protected-sentinel');
  await writeFile(sentinelPath, 'production-registry-protected\n');
  const beforeHash = digest(await readFile(sentinelPath));
  await h.canary.commit(inputFor(capture.items[0]));
  h.canary.disable();
  await assert.rejects(h.canary.commit(inputFor(capture.items[1])), (error) => error.code === 'CANARY_DISABLED');
  const reset = await h.canary.reset();
  assert.equal(reset.reset, true);
  assert.equal(digest(await readFile(sentinelPath)), beforeHash);
  assert.equal(await h.canary.readPair().catch((error) => error.code === 'CANARY_DISABLED'), true);
  const auditor = createRegistryOnlyCanary({ enabled: true, stateDir: h.canaryPath, productionStateDir: h.productionPath });
  assert.deepEqual(await auditor.readPair(), { events: [], observations: [] });
  assert.equal((await auditor.listCanaryRecords()).length, 0);
});

test('runtime kill switch blocks new writes after enablement and retains prior Canary data for audit', async () => {
  const h = await newHarness();
  await h.canary.commit(inputFor(capture.items[0]));
  let killed = false;
  const guarded = createRegistryOnlyCanary({ enabled: true, stateDir: h.canaryPath, productionStateDir: h.productionPath, killSwitch: () => killed });
  killed = true;
  await assert.rejects(guarded.commit(inputFor(capture.items[1])), (error) => error.code === 'CANARY_DISABLED');
  const auditor = createRegistryOnlyCanary({ enabled: true, stateDir: h.canaryPath, productionStateDir: h.productionPath });
  assert.equal((await auditor.readPair()).events.length, 1);
});

test('symbolic links inside Canary state fail closed before following or changing their targets', async () => {
  const h = await newHarness();
  await h.canary.initialize();
  const target = join(h.productionPath, 'protected-data');
  await writeFile(target, 'must-not-read-through-link');
  await import('node:fs/promises').then(({ symlink }) => symlink(target, join(h.canaryPath, 'canary-records')));
  await assert.rejects(h.canary.listCanaryRecords(), (error) => error.code === 'CANARY_REGISTRY_PATH_COLLISION');
});
