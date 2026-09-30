import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { policyArtifactPath } from '../scripts/policy-artifact-path.mjs';
import {
  buildEventFingerprint, resolveEventState,
} from '../src/lib/radar-event-identity.mjs';
import { RegistryLayer, acquireRegistryLock, appendCandidateReceipt, cleanupCandidateReceipts, validateRegistryPair, registryPairFromJsonl, readSnapshotPair, verifySnapshotPair } from '../src/lib/radar-registry/index.ts';

const replay = JSON.parse(await readFile(policyArtifactPath('radar-event-replay-v1.json'), 'utf8'));
const fixture = JSON.parse(await readFile(policyArtifactPath('radar-observation-fixtures-v1.json'), 'utf8'));
const policyDir = dirname(policyArtifactPath('radar-registry-policy-v1.json'));
const emptyFingerprint = buildEventFingerprint({});
const openedRoots = new Set();

test.after(async () => {
  await Promise.all([...openedRoots].map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot() {
  const path = await mkdtemp(join(tmpdir(), 'horizon-radar-registry-test-'));
  openedRoots.add(path);
  return path;
}

function makeRuntime(root, { clock = () => new Date('2026-09-29T12:00:00.000Z'), transactionIdFactory, ...rest } = {}) {
  let transactionCount = 0;
  return {
    stateDir: root,
    clock,
    transactionIdFactory: transactionIdFactory ?? (() => `test-tx-${String(++transactionCount).padStart(4, '0')}`),
    lockTimeoutMs: 20,
    ...rest,
  };
}

function eventFromObservation(row, eventState, fingerprint = emptyFingerprint) {
  const [entity, canonicalEventType] = row.eventKey.split(':');
  return {
    eventKey: row.eventKey, entity, canonicalEventType, fingerprint, eventState,
    duplicate: eventState === 'DUPLICATE', materialChange: eventState === 'UPDATE',
  };
}

async function seedObservationFixture(layer, rows = fixture.cases.valid) {
  const current = new Map();
  for (const row of rows) {
    const observation = { ...row };
    const previousFingerprint = current.get(row.eventKey);
    const engineOutput = resolveEventState({
      entity: row.eventKey.split(':')[0],
      canonicalEventType: row.eventKey.split(':')[1],
      eventIdentifier: row.eventKey.split(':')[2],
      fingerprint: emptyFingerprint,
      previousEvents: previousFingerprint === undefined ? [] : [{ eventKey: row.eventKey, canonicalEventType: row.eventKey.split(':')[1], fingerprint: previousFingerprint }],
    });
    const result = await layer.upsertEvent(engineOutput, observation);
    current.set(row.eventKey, result.event.latestFingerprint);
  }
  return current;
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

test('Registry API persists and retrieves Events and Observations using explicit temporary state', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(makeRuntime(root));
  const row = fixture.cases.valid[0];
  const engineOutput = eventFromObservation(row, 'NEW');
  const result = await layer.upsertEvent(engineOutput, row);
  assert.equal(result.event.eventKey, row.eventKey);
  assert.equal(result.observation.observationId, row.expectedObservationId);
  assert.equal(await layer.hasEvent(row.eventKey), true);
  assert.equal((await layer.getEvent(row.eventKey)).occurrences, 1);
  assert.equal(await layer.hasObservation(row.expectedObservationId), true);
  assert.equal((await layer.getObservation(row.expectedObservationId)).canonicalSourceUrl, row.canonicalSourceUrl);
  assert.equal((await layer.listEvents()).length, 1);
  assert.equal((await layer.listObservations()).length, 1);
});

test('Frozen Event Replay produces exactly 39 unique Event identities and is fixed point on rerun', () => {
  const firstRegistryProjection = new Map();
  const seen = new Map();
  const counts = { NEW: 0, DUPLICATE: 0, UPDATE: 0 };
  for (const row of replay.fixtures) {
    const [, canonicalEventType, eventIdentifier] = row.eventKey.split(':');
    const previous = seen.get(row.eventKey);
    const output = resolveEventState({
      entity: row.entity, canonicalEventType, eventIdentifier,
      fingerprint: row.fingerprint,
      previousEvents: previous ? [{ eventKey: row.eventKey, canonicalEventType, fingerprint: previous }] : [],
    });
    assert.equal(output.eventState, row.eventState, `F${row.id}`);
    firstRegistryProjection.set(output.eventKey, output);
    counts[output.eventState] += 1;
    if (output.eventState === 'NEW') seen.set(output.eventKey, output.fingerprint);
  }
  assert.deepEqual(counts, { NEW: 39, DUPLICATE: 11, UPDATE: 0 });
  assert.equal(firstRegistryProjection.size, 39);
  const beforeKeys = [...firstRegistryProjection.keys()].sort();
  const rerunCounts = { NEW: 0, DUPLICATE: 0, UPDATE: 0 };
  for (const row of replay.fixtures) {
    const existing = firstRegistryProjection.get(row.eventKey);
    assert.ok(existing, `F${row.id} remains represented`);
    const [, canonicalEventType, eventIdentifier] = row.eventKey.split(':');
    const output = resolveEventState({
      entity: row.entity, canonicalEventType, eventIdentifier,
      fingerprint: row.fingerprint,
      previousEvents: [{ eventKey: row.eventKey, canonicalEventType, fingerprint: existing.fingerprint }],
    });
    assert.equal(output.eventState, 'DUPLICATE', `rerun F${row.id}`);
    rerunCounts[output.eventState] += 1;
  }
  assert.deepEqual(rerunCounts, { NEW: 0, DUPLICATE: 50, UPDATE: 0 });
  assert.deepEqual([...firstRegistryProjection.keys()].sort(), beforeKeys);
  assert.deepEqual(replay.summary, { candidates: 50, uniqueEvents: 39, NEW: 39, DUPLICATE: 11, UPDATE: 0 });
});

test('Observation Fixture 29/29 upserts to 13 observations and 9 events; second run does not grow either', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(makeRuntime(root));
  const validIds = new Set();
  const keyCounts = new Map();
  for (const row of fixture.cases.valid) {
    validIds.add(row.expectedObservationId);
    keyCounts.set(row.eventKey, (keyCounts.get(row.eventKey) ?? 0) + 1);
  }
  assert.equal(fixture.cases.valid.length, 19);
  assert.equal(fixture.cases.invalid.length, 10);
  assert.equal(validIds.size, 13);
  assert.equal(keyCounts.size, 9);
  await seedObservationFixture(layer);
  assert.equal((await layer.listObservations()).length, 13);
  assert.equal((await layer.listEvents()).length, 9);
  await seedObservationFixture(layer);
  const pair = await layer.transactions.readPair();
  assert.equal(pair.observations.length, 13);
  assert.equal(pair.events.length, 9);
  assert.equal(pair.events.reduce((sum, event) => sum + event.occurrences, 0), 13);
  assert.equal(validateRegistryPair(pair).valid, true);
  for (const invalid of fixture.cases.invalid) {
    const row = invalid.observation;
    const engineOutput = eventFromObservation({ eventKey: row.eventKey ?? 'fixture:release:initial' }, 'NEW');
    await assert.rejects(layer.upsertEvent(engineOutput, row), (error) => error instanceof Error);
  }
  // Invalid candidates never commit or alter the registry pair.
  assert.equal((await layer.listObservations()).length, 13);
  assert.equal((await layer.listEvents()).length, 9);
});

test('Cross-Radar source identity is two Observations, one Event, occurrences two', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(makeRuntime(root));
  const [ai, dev] = fixture.identityExpectations.find(({ case: name }) => name === 'H_cross_radar').members
    .map((name) => fixture.cases.valid.find((row) => row.case === name));
  assert.equal(ai.canonicalSourceUrl, dev.canonicalSourceUrl);
  assert.equal(ai.eventKey, dev.eventKey);
  assert.notEqual(ai.radar, dev.radar);
  await layer.upsertEvent(eventFromObservation(ai, 'NEW'), ai);
  await layer.upsertEvent(eventFromObservation(dev, 'DUPLICATE'), dev);
  const pair = await layer.transactions.readPair();
  assert.equal(pair.events.length, 1);
  assert.equal(pair.observations.length, 2);
  assert.equal(pair.events[0].occurrences, 2);
  assert.deepEqual(pair.events[0].radars, ['ai', 'dev']);
});

test('DUPLICATE refetch and UPDATE from existing/new Observation obey frozen occurrences', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(makeRuntime(root));
  const original = fixture.cases.valid[0];
  const initialFp = buildEventFingerprint({ activeExploitation: false });
  const updateFp = buildEventFingerprint({ activeExploitation: true });
  const first = await layer.upsertEvent(eventFromObservation(original, 'NEW', initialFp), original);
  const firstObservedAt = first.event.firstObservedAt;
  const sameObservation = { ...original, observedAt: '2026-08-04T09:00:00Z', retrievedAt: '2026-08-04T09:00:01Z', sourceName: 'Renamed fixture source' };
  const updated = await layer.upsertEvent(eventFromObservation(sameObservation, 'UPDATE', updateFp), sameObservation);
  assert.equal(updated.event.eventKey, first.event.eventKey);
  assert.equal(updated.event.firstObservedAt, firstObservedAt);
  assert.equal(updated.event.lastObservedAt, sameObservation.observedAt);
  assert.equal(updated.event.latestFingerprint, updateFp);
  assert.equal(updated.event.fingerprintHistory.length, 2);
  assert.equal(updated.event.occurrences, 1);
  const extraSource = { ...original, sourceUrl: 'https://example.com/release/1/secondary', canonicalSourceUrl: undefined, sourceName: 'Second source', observedAt: '2026-08-05T09:00:00Z' };
  delete extraSource.canonicalSourceUrl;
  const secondObservationUpdate = await layer.upsertEvent(eventFromObservation(extraSource, 'UPDATE', initialFp), extraSource);
  assert.equal(secondObservationUpdate.event.occurrences, 2);
  assert.equal(secondObservationUpdate.event.fingerprintHistory.length, 3);
});

test('Validator is pure and detects required registry corruption classes', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(makeRuntime(root));
  await seedObservationFixture(layer, fixture.cases.valid.slice(0, 1));
  const pair = await layer.transactions.readPair();
  const before = structuredClone(pair);
  assert.equal(validateRegistryPair(pair).valid, true);
  assert.deepEqual(pair, before);
  const duplicateEvent = structuredClone(pair); duplicateEvent.events.push(structuredClone(pair.events[0]));
  assert.ok(validateRegistryPair(duplicateEvent).errors.some(({ code }) => code === 'REGISTRY_DUPLICATE_EVENT_KEY'));
  const duplicateObs = structuredClone(pair); duplicateObs.observations.push(structuredClone(pair.observations[0]));
  assert.ok(validateRegistryPair(duplicateObs).errors.some(({ code }) => code === 'REGISTRY_DUPLICATE_OBSERVATION_ID'));
  const missingEvent = structuredClone(pair); missingEvent.observations[0].eventKey = 'missing:release:initial';
  assert.ok(validateRegistryPair(missingEvent).errors.some(({ code }) => code === 'REGISTRY_OBSERVATION_EVENT_MISSING'));
  const wrongId = structuredClone(pair); wrongId.observations[0].observationId = '0000000000000000';
  assert.ok(validateRegistryPair(wrongId).errors.some(({ code }) => code === 'REGISTRY_OBSERVATION_ID_MISMATCH'));
  const badCount = structuredClone(pair); badCount.events[0].occurrences = 0;
  assert.ok(validateRegistryPair(badCount).errors.some(({ code }) => code === 'REGISTRY_OCCURRENCE_MISMATCH'));
  const badHistory = structuredClone(pair); badHistory.events[0].fingerprintHistory[0].fingerprint = 'not-a-digest';
  assert.ok(validateRegistryPair(badHistory).errors.some(({ code }) => code === 'REGISTRY_FINGERPRINT_HISTORY_INVALID'));
  const invalidUrl = structuredClone(pair); invalidUrl.observations[0].sourceUrl = 'ftp://example.com/file';
  assert.ok(validateRegistryPair(invalidUrl).errors.some(({ code }) => code === 'REGISTRY_OBSERVATION_INPUT_INVALID'));
});

test('JSONL corruption and snapshot hash mismatch fail closed', async () => {
  assert.throws(() => registryPairFromJsonl(Buffer.from('{'), Buffer.alloc(0)), (error) => error.code === 'REGISTRY_JSONL_TRUNCATED');
  assert.throws(() => registryPairFromJsonl(Buffer.from('{}\n{bad}\n'), Buffer.alloc(0)), (error) => error.code === 'REGISTRY_JSONL_INVALID');
  const root = await newRoot();
  const layer = new RegistryLayer(makeRuntime(root));
  await seedObservationFixture(layer, fixture.cases.valid.slice(0, 1));
  const snapshot = join(root, 'radar-registry-snapshots', '2026-09-29');
  const readBack = await readSnapshotPair(snapshot);
  assert.equal(readBack.pair.events.length, 1);
  assert.equal(readBack.pair.observations.length, 1);
  const eventFile = join(snapshot, 'events.jsonl');
  await writeFile(eventFile, `${await readFile(eventFile, 'utf8')} `);
  const result = await verifySnapshotPair(snapshot);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('eventSha256 mismatch')));
});

test('All injected crash boundaries recover to one valid pair; committed recovery is idempotent', async (t) => {
  for (const point of ['after-prepare', 'after-event-rename', 'after-observation-rename', 'before-committed', 'after-committed-before-snapshot']) {
    await t.test(point, async () => {
      const root = await newRoot();
      const firstRuntime = makeRuntime(root, { failurePoint: point });
      const layer = new RegistryLayer(firstRuntime);
      const row = fixture.cases.valid[0];
      await assert.rejects(layer.upsertEvent(eventFromObservation(row, 'NEW'), row), (error) => error.code === 'REGISTRY_FAILURE_INJECTED');
      const pair = await layer.transactions.readPair();
      assert.equal(validateRegistryPair(pair).valid, true);
      assert.equal(pair.events.length, 1);
      assert.equal(pair.observations.length, 1);
      const journal = JSON.parse(await readFile(join(root, 'radar-registry-transaction.json'), 'utf8'));
      assert.equal(journal.state, 'COMMITTED');
      const recovered = await layer.transactions.recover();
      assert.equal(recovered, 'COMMITTED');
      const snapshot = await verifySnapshotPair(join(root, 'radar-registry-snapshots', journal.committedAt.slice(0, 10)));
      assert.equal(snapshot.valid, true);
    });
  }
});

test('Receipt retention and deletion have zero Registry hash or occurrences impact', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(makeRuntime(root));
  await seedObservationFixture(layer);
  const beforeHashes = await layer.hashes();
  const beforePair = await layer.transactions.readPair();
  const beforeOccurrences = beforePair.events.reduce((sum, event) => sum + event.occurrences, 0);
  const runRoot = join(root, 'radar-runs');
  await appendCandidateReceipt(runRoot, { recordedAt: '2026-09-01T00:00:00Z', radar: 'ai', candidate: { id: 1 }, outcome: 'FILTERED', reason: 'test' });
  await cleanupCandidateReceipts(runRoot, new Date('2026-10-01T00:00:00Z'), 14);
  const afterHashes = await layer.hashes();
  const afterPair = await layer.transactions.readPair();
  const afterOccurrences = afterPair.events.reduce((sum, event) => sum + event.occurrences, 0);
  assert.deepEqual(afterHashes, beforeHashes);
  assert.equal(afterOccurrences, beforeOccurrences);
  assert.equal((await readdir(runRoot)).length, 0);
});

test('Independent deterministic simulations share canonical Registry hashes', async () => {
  async function simulate(clock) {
    const root = await newRoot();
    const layer = new RegistryLayer(makeRuntime(root, { clock }));
    await seedObservationFixture(layer);
    return { hashes: await layer.hashes(), pair: await layer.transactions.readPair() };
  }
  const a = await simulate(() => new Date('2026-09-29T12:00:00Z'));
  const b = await simulate(() => new Date('2026-10-01T18:00:00Z'));
  assert.deepEqual(a.hashes, b.hashes);
  assert.equal(a.pair.events.length, b.pair.events.length);
  assert.equal(a.pair.observations.length, b.pair.observations.length);
  assert.notEqual(a.pair.events[0].createdAt, b.pair.events[0].createdAt);
});

test('Frozen Registry Policy distribution manifest verifies canonical Registry artifacts', async () => {
  const manifestPath = policyArtifactPath('radar-registry-policy-v1-canonical-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.policyVersion, '1.0');
  assert.equal(manifest.status, 'FROZEN');
  for (const [name, expected] of Object.entries(manifest.canonicalArtifacts)) {
    assert.equal(hash(await readFile(join(policyDir, name))), expected.sha256, name);
  }
});
