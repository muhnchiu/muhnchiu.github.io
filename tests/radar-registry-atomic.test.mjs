import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { policyArtifactPath } from '../scripts/policy-artifact-path.mjs';
import { buildEventFingerprint } from '../src/lib/radar-event-identity.mjs';
import { RegistryLayer, validateRegistryPair } from '../src/lib/radar-registry/index.ts';

const fixture = JSON.parse(await readFile(policyArtifactPath('radar-observation-fixtures-v1.json'), 'utf8'));
const replay = JSON.parse(await readFile(policyArtifactPath('radar-event-replay-v1.json'), 'utf8'));
const roots = new Set();

test.after(async () => Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true }))));

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'horizon-radar-atomic-test-'));
  roots.add(root);
  return root;
}

function runtime(root, options = {}) {
  let sequence = 0;
  return {
    stateDir: root,
    clock: () => new Date('2026-09-30T12:00:00.000Z'),
    transactionIdFactory: () => `atomic-${String(++sequence).padStart(4, '0')}`,
    lockTimeoutMs: 5_000,
    ...options,
  };
}

function request(observation, fingerprint = buildEventFingerprint({}), extra = {}) {
  const [entity, canonicalEventType, eventIdentifier] = observation.eventKey.split(':');
  return {
    eventKey: observation.eventKey,
    eventFacts: { entity, canonicalEventType, eventIdentifier },
    fingerprint,
    observation,
    ...extra,
  };
}

function distinctObservation(base, { radar, sourceUrl, observedAt = base.observedAt }) {
  return { ...base, radar, sourceUrl, sourceName: `${radar} source`, observedAt };
}

async function commitPair(layer, requests) {
  const results = await Promise.all(requests.map((item) => layer.commitObservation(item)));
  const pair = await layer.transactions.readPair();
  assert.equal(validateRegistryPair(pair).valid, true);
  return { results, pair };
}

test('atomic API resolves concurrent NEW candidates under one global lock', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const source = fixture.cases.valid[0];
  const ai = distinctObservation(source, { radar: 'ai', sourceUrl: 'https://atomic.example/ai' });
  const dev = distinctObservation(source, { radar: 'dev', sourceUrl: 'https://atomic.example/dev' });
  const { results, pair } = await commitPair(layer, [request(ai), request(dev)]);
  assert.deepEqual(results.map(({ eventState }) => eventState).sort(), ['DUPLICATE', 'NEW']);
  assert.equal(results.filter(({ eventCreated }) => eventCreated).length, 1);
  assert.equal(pair.events.length, 1);
  assert.equal(pair.observations.length, 2);
  assert.equal(pair.events[0].occurrences, 2);
  assert.deepEqual(pair.events[0].radars, ['ai', 'dev']);
  for (const result of results) {
    assert.equal(result.registryWriteStatus, 'COMMITTED');
    assert.equal(result.eventKey, ai.eventKey);
    assert.ok(result.observationId);
    assert.equal(typeof result.duplicate, 'boolean');
    assert.equal(typeof result.materialChange, 'boolean');
    assert.ok(result.transactionId);
  }
});

test('same Observation concurrency creates one Observation and one occurrence', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const observation = fixture.cases.valid[0];
  const { results, pair } = await commitPair(layer, [request(observation), request(observation)]);
  assert.deepEqual(results.map(({ eventState }) => eventState).sort(), ['DUPLICATE', 'NEW']);
  assert.deepEqual(results.map(({ observationCreated }) => observationCreated).sort(), [false, true]);
  assert.equal(pair.events.length, 1);
  assert.equal(pair.observations.length, 1);
  assert.equal(pair.events[0].occurrences, 1);
});

test('concurrent same-fingerprint UPDATE candidates produce one UPDATE then one DUPLICATE', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const source = fixture.cases.valid[0];
  const initialFingerprint = buildEventFingerprint({ activeExploitation: false });
  const changedFingerprint = buildEventFingerprint({ activeExploitation: true });
  assert.equal((await layer.commitObservation(request(source, initialFingerprint))).eventState, 'NEW');
  const ai = distinctObservation(source, { radar: 'ai', sourceUrl: 'https://atomic.example/update-ai' });
  const dev = distinctObservation(source, { radar: 'dev', sourceUrl: 'https://atomic.example/update-dev' });
  const { results, pair } = await commitPair(layer, [request(ai, changedFingerprint), request(dev, changedFingerprint)]);
  assert.deepEqual(results.map(({ eventState }) => eventState).sort(), ['DUPLICATE', 'UPDATE']);
  assert.equal(results.filter(({ eventUpdated }) => eventUpdated).length, 1);
  assert.equal(pair.events.length, 1);
  assert.equal(pair.events[0].latestFingerprint, changedFingerprint);
  assert.equal(pair.events[0].fingerprintHistory.length, 2);
  assert.equal(pair.events[0].occurrences, 3);
  assert.equal(pair.observations.length, 3);
});

test('sequential A to B to C updates follow latest fingerprint and frozen history', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const observation = fixture.cases.valid[0];
  const fpA = buildEventFingerprint({ version: '1.0.0' });
  const fpB = buildEventFingerprint({ version: '1.1.0' });
  const fpC = buildEventFingerprint({ version: '1.2.0' });
  assert.equal((await layer.commitObservation(request(observation, fpA))).eventState, 'NEW');
  assert.equal((await layer.commitObservation(request(observation, fpB))).eventState, 'UPDATE');
  const final = await layer.commitObservation(request(observation, fpC));
  assert.equal(final.eventState, 'UPDATE');
  assert.equal(final.event.latestFingerprint, fpC);
  assert.deepEqual(final.event.fingerprintHistory.map(({ fingerprint, eventState }) => ({ fingerprint, eventState })), [
    { fingerprint: fpA, eventState: 'NEW' },
    { fingerprint: fpB, eventState: 'UPDATE' },
    { fingerprint: fpC, eventState: 'UPDATE' },
  ]);
  assert.equal(final.event.occurrences, 1, 'same observation identity does not increment occurrences during UPDATE');
  assert.equal(final.observationCreated, false);
});

test('retries are idempotent and a new Observation on a duplicate Event increments occurrences once', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const ai = fixture.cases.valid[0];
  const first = await layer.commitObservation(request(ai));
  const retry = await layer.commitObservation(request(ai));
  const retryAgain = await layer.commitObservation(request(ai));
  assert.equal(first.eventState, 'NEW');
  assert.equal(retry.eventState, 'DUPLICATE');
  assert.equal(retry.observationCreated, false);
  assert.equal(retryAgain.observationCreated, false);
  assert.equal(retryAgain.occurrences, 1);
  const secondSource = distinctObservation(ai, { radar: 'dev', sourceUrl: 'https://atomic.example/retry-source' });
  const duplicateEventNewObservation = await layer.commitObservation(request(secondSource));
  assert.equal(duplicateEventNewObservation.eventState, 'DUPLICATE');
  assert.equal(duplicateEventNewObservation.observationCreated, true);
  assert.equal(duplicateEventNewObservation.occurrences, 2);
  const pair = await layer.transactions.readPair();
  assert.equal(pair.events[0].occurrences, 2);
  assert.equal(pair.observations.length, 2);
});

test('cross-Radar identity remains one Event with Radar-specific Observations', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const members = fixture.identityExpectations.find(({ case: name }) => name === 'H_cross_radar').members;
  const [ai, dev] = members.map((name) => fixture.cases.valid.find((row) => row.case === name));
  assert.equal((await layer.commitObservation(request(ai))).eventState, 'NEW');
  const second = await layer.commitObservation(request(dev));
  assert.equal(second.eventState, 'DUPLICATE');
  assert.equal(second.observationCreated, true);
  const pair = await layer.transactions.readPair();
  assert.equal(pair.events.length, 1);
  assert.equal(pair.observations.length, 2);
  assert.equal(pair.events[0].occurrences, 2);
  assert.deepEqual(pair.events[0].radars, ['ai', 'dev']);
});

test('different canonical Event Types are separate NEW identities, never cross-type UPDATE', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const original = fixture.cases.valid[0];
  const [entity, , eventIdentifier] = original.eventKey.split(':');
  const otherType = 'capability-change';
  const otherKey = `${entity}:${otherType}:${eventIdentifier}`;
  const otherObservation = { ...original, eventKey: otherKey, sourceUrl: 'https://atomic.example/other-type' };
  const first = await layer.commitObservation(request(original, buildEventFingerprint({ version: '1.0.0' })));
  const second = await layer.commitObservation(request(otherObservation, buildEventFingerprint({ version: '2.0.0' })));
  assert.equal(first.eventState, 'NEW');
  assert.equal(second.eventState, 'NEW');
  const pair = await layer.transactions.readPair();
  assert.equal(pair.events.length, 2);
  assert.deepEqual(pair.events.map(({ canonicalEventType }) => canonicalEventType).sort(), ['capability-change', original.eventKey.split(':')[1]].sort());
});

test('atomic API refuses caller-owned state; legacy API remains explicitly compatible', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const observation = fixture.cases.valid[0];
  await assert.rejects(
    layer.commitObservation({ ...request(observation), eventState: 'UPDATE' }),
    (error) => error.code === 'REGISTRY_CALLER_STATE_FORBIDDEN',
  );
  await assert.rejects(
    layer.commitObservation({ ...request(observation), candidateMetadata: { source: 'caller' } }),
    (error) => error.code === 'REGISTRY_ATOMIC_INPUT_INVALID',
  );
  const legacyOutput = {
    eventKey: observation.eventKey,
    entity: observation.eventKey.split(':')[0],
    canonicalEventType: observation.eventKey.split(':')[1],
    fingerprint: buildEventFingerprint({}),
    eventState: 'NEW', duplicate: false, materialChange: false,
  };
  const legacy = await layer.upsertEvent(legacyOutput, observation);
  assert.equal(legacy.event.lastEventState, 'NEW');
  assert.equal((await layer.listEvents()).length, 1);
});

test('validator rejects impossible Event state and fingerprint-history facts without mutation', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const observation = fixture.cases.valid[0];
  const fpA = buildEventFingerprint({ version: '1.0.0' });
  const fpB = buildEventFingerprint({ version: '1.1.0' });
  await layer.commitObservation(request(observation, fpA));
  await layer.commitObservation(request(observation, fpB));
  const pair = await layer.transactions.readPair();
  const invalidLatestState = structuredClone(pair);
  invalidLatestState.events[0].lastEventState = 'NEW';
  assert.ok(validateRegistryPair(invalidLatestState).errors.some(({ code }) => code === 'REGISTRY_EVENT_STATE_FACTS_INVALID'));
  const invalidHistory = structuredClone(pair);
  invalidHistory.events[0].fingerprintHistory[1].eventState = 'DUPLICATE';
  assert.ok(validateRegistryPair(invalidHistory).errors.some(({ code }) => code === 'REGISTRY_EVENT_STATE_FACTS_INVALID'));
  assert.equal(validateRegistryPair(pair).valid, true, 'validator is check-only and preserves the source pair');
});

test('atomic mutation fault points recover deterministically without partial pairs', async (t) => {
  const cases = [
    ['after-lock', false],
    ['after-event-temp-write', false],
    ['after-observation-temp-write', false],
    ['after-prepare', true],
    ['after-event-rename', true],
    ['after-observation-rename', true],
    ['before-committed', true],
    ['after-committed-before-snapshot', true],
  ];
  for (const [point, shouldRecover] of cases) {
    await t.test(point, async () => {
      const root = await newRoot();
      const row = fixture.cases.valid[0];
      const broken = new RegistryLayer(runtime(root, { failurePoint: point }));
      await assert.rejects(broken.commitObservation(request(row)), (error) => error.code === 'REGISTRY_FAILURE_INJECTED');
      const recovered = new RegistryLayer(runtime(root));
      let pair = await recovered.transactions.readPair();
      assert.equal(validateRegistryPair(pair).valid, true);
      if (shouldRecover) {
        assert.equal(pair.events.length, 1);
        assert.equal(pair.observations.length, 1);
        assert.equal(pair.events[0].occurrences, 1);
      } else {
        assert.equal(pair.events.length, 0);
        assert.equal(pair.observations.length, 0);
        const retried = await recovered.commitObservation(request(row));
        assert.equal(retried.eventState, 'NEW');
        pair = await recovered.transactions.readPair();
        assert.equal(pair.events.length, 1);
        assert.equal(pair.observations.length, 1);
      }
      const journal = JSON.parse(await readFile(join(root, 'radar-registry-transaction.json'), 'utf8'));
      if (shouldRecover) assert.equal(journal.state, 'COMMITTED');
      assert.equal(validateRegistryPair(pair).valid, true);
      assert.equal(pair.events.reduce((count, event) => count + event.occurrences, 0), pair.observations.length);
    });
  }
});

test('atomic Observation Fixture stays independent from Event Replay and reconstructs occurrences', async () => {
  assert.deepEqual(replay.summary, { candidates: 50, uniqueEvents: 39, NEW: 39, DUPLICATE: 11, UPDATE: 0 });
  const root = await newRoot();
  const layer = new RegistryLayer(runtime(root));
  const valid = fixture.cases.valid;
  const invalid = fixture.cases.invalid;
  assert.equal(valid.length, 19);
  assert.equal(invalid.length, 10);
  for (const row of valid) await layer.commitObservation(request(row));
  const beforeSecondRun = await layer.transactions.readPair();
  assert.equal(beforeSecondRun.observations.length, 13);
  assert.equal(beforeSecondRun.events.length, 9);
  for (const row of valid) await layer.commitObservation(request(row));
  const finalPair = await layer.transactions.readPair();
  assert.equal(finalPair.observations.length, 13);
  assert.equal(finalPair.events.length, 9);
  assert.equal(validateRegistryPair(finalPair).valid, true);
  assert.equal(finalPair.events.reduce((total, event) => total + event.occurrences, 0), 13);
  for (const row of invalid) {
    const observation = row.observation;
    const entity = observation.eventKey?.split(':')[0] ?? 'fixture';
    const canonicalEventType = observation.eventKey?.split(':')[1] ?? 'release';
    const eventIdentifier = observation.eventKey?.split(':')[2] ?? 'invalid';
    await assert.rejects(layer.commitObservation({
      eventKey: observation.eventKey ?? `${entity}:${canonicalEventType}:${eventIdentifier}`,
      eventFacts: { entity, canonicalEventType, eventIdentifier },
      fingerprint: buildEventFingerprint({}),
      observation,
    }));
  }
  const afterInvalid = await layer.transactions.readPair();
  assert.equal(afterInvalid.observations.length, 13);
  assert.equal(afterInvalid.events.length, 9);
});
