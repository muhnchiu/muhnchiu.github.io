import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RegistryLayer, recoverRegistry } from '../src/lib/radar-registry/index.ts';

const roots = new Set();
test.after(async () => Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true }))));

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'horizon-registry-quarantine-'));
  roots.add(root);
  return root;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validInput = (eventIdentifier = 'baseline') => {
  const eventFacts = { entity: 'quarantine-fixture', canonicalEventType: 'release', eventIdentifier };
  const eventKey = `${eventFacts.entity}:${eventFacts.canonicalEventType}:${eventFacts.eventIdentifier}`;
  return {
    eventKey,
    eventFacts,
    fingerprint: '0123456789abcdef',
    observation: {
      eventKey, radar: 'ai', sourceName: 'Fixture', sourceUrl: `https://example.test/${eventIdentifier}`,
      sourceLevel: 'official', observedAt: '2026-09-30T10:00:00.000Z',
    },
  };
};

async function seedValidPair(root) {
  const layer = new RegistryLayer({ stateDir: root, clock: () => new Date('2026-09-30T12:00:00.000Z') });
  await layer.commitObservation(validInput());
  return layer;
}

async function removeCommitMarkers(root) {
  await rm(join(root, 'radar-registry-transaction.json'), { force: true });
  await rm(join(root, 'radar-registry-staging'), { recursive: true, force: true });
}

async function files(root) {
  const result = {};
  for (const [role, name] of [['event', 'radar-event-registry.jsonl'], ['observation', 'radar-observation-registry.jsonl']]) {
    try { result[role] = await readFile(join(root, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

async function quarantineEntries(root) {
  try { return (await readdir(join(root, 'radar-registry-quarantine'), { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function readMetadata(root, dirname) {
  return JSON.parse(await readFile(join(root, 'radar-registry-quarantine', dirname, 'metadata.json'), 'utf8'));
}

async function assertEvidenceMatches(root, dirname, before, expectedRoles) {
  const metadata = await readMetadata(root, dirname);
  assert.equal(metadata.complete, true);
  assert.equal(typeof metadata.failureClass, 'string');
  assert.equal(typeof metadata.failureReason, 'string');
  assert.ok(metadata.failureReason.length > 0);
  for (const role of expectedRoles) {
    const item = metadata.evidenceFiles.find((file) => file.role === role);
    assert.ok(item, `metadata contains ${role}`);
    const beforeKey = role === 'event-registry' ? 'event' : role === 'observation-registry' ? 'observation' : role;
    if (before[beforeKey]) {
      const raw = await readFile(join(root, 'radar-registry-quarantine', dirname, item.quarantineFile));
      assert.equal(sha(raw), sha(before[beforeKey]), `${role} exact bytes preserved`);
      assert.equal(item.sha256, sha(before[beforeKey]));
    } else {
      assert.equal(item.present, false, `${role} recorded absent`);
    }
  }
  return metadata;
}

async function rejectedRead(root, runtime = {}) {
  const layer = new RegistryLayer({ stateDir: root, lockTimeoutMs: 100, ...runtime });
  await assert.rejects(layer.transactions.readPair());
  return layer;
}

async function assertStructuredShapeQuarantine(root, before, role, description) {
  const layer = new RegistryLayer({ stateDir: root, lockTimeoutMs: 100 });
  await assert.rejects(layer.transactions.readPair(), (error) => {
    assert.notEqual(error instanceof TypeError, true, `${description}: native TypeError must not leak`);
    assert.equal(error.code, 'REGISTRY_VALIDATION_FAILED');
    assert.ok(Array.isArray(error.details));
    assert.ok(error.details.some(({ code, path }) => code === 'REGISTRY_INVALID_ROW_SHAPE' && path.startsWith(`/${role}/0`)));
    return true;
  });
  const entries = await quarantineEntries(root);
  assert.equal(entries.length, 1, `${description}: one paired quarantine is created`);
  const metadata = await assertEvidenceMatches(root, entries[0], before, ['event-registry', 'observation-registry']);
  assert.equal(metadata.failureClass, 'REGISTRY_VALIDATION_FAILED');
  assert.ok(metadata.failureReason.includes('REGISTRY_INVALID_ROW_SHAPE'));
  assert.ok(metadata.validationErrors.some(({ code, path }) => code === 'REGISTRY_INVALID_ROW_SHAPE' && path.startsWith(`/${role}/0`)));
  assert.deepEqual(await files(root), before, `${description}: source Registry files are unchanged`);
  return metadata;
}

test('clean initial state with both Registry files absent remains a valid empty pair', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer({ stateDir: root });
  assert.deepEqual(await layer.transactions.readPair(), { events: [], observations: [] });
  assert.deepEqual(await quarantineEntries(root), []);
});

test('both files absent after prior snapshot state is corruption, not fresh initialization', async () => {
  const root = await newRoot();
  await seedValidPair(root);
  await rm(join(root, 'radar-event-registry.jsonl'));
  await rm(join(root, 'radar-observation-registry.jsonl'));
  await removeCommitMarkers(root);
  await rejectedRead(root);
  const [entry] = await quarantineEntries(root);
  const metadata = await assertEvidenceMatches(root, entry, {}, ['event-registry', 'observation-registry']);
  assert.equal(metadata.failureClass, 'REGISTRY_FILE_MISSING');
  assert.equal(metadata.evidenceFiles.every(({ present }) => !present), true);
});

test('COMMITTED journal proves missing Registry data was expected and preserves the remaining side', async () => {
  const root = await newRoot();
  await seedValidPair(root);
  await rm(join(root, 'radar-event-registry.jsonl'));
  const before = await files(root);
  await rejectedRead(root);
  const [entry] = await quarantineEntries(root);
  const metadata = await assertEvidenceMatches(root, entry, before, ['event-registry', 'observation-registry']);
  assert.equal(metadata.failureClass, 'TRANSACTION_RECOVERY_CORRUPTION');
  assert.equal(metadata.journalState, 'COMMITTED');
  assert.ok(metadata.evidenceFiles.some(({ role }) => role === 'transaction-journal'));
  assert.deepEqual(await files(root), before);
});

test('one expected Registry file missing preserves the present side and records the absent side', async () => {
  const root = await newRoot();
  await seedValidPair(root);
  await rm(join(root, 'radar-observation-registry.jsonl'));
  await removeCommitMarkers(root);
  const before = await files(root);
  await rejectedRead(root);
  const [entry] = await quarantineEntries(root);
  const metadata = await assertEvidenceMatches(root, entry, before, ['event-registry', 'observation-registry']);
  assert.equal(metadata.failureClass, 'REGISTRY_FILE_MISSING');
  assert.equal((await files(root)).event.equals(before.event), true);
});

test('missing Event Registry with Observation Registry present is quarantined as one pair', async () => {
  const root = await newRoot();
  await seedValidPair(root);
  await rm(join(root, 'radar-event-registry.jsonl'));
  await removeCommitMarkers(root);
  const before = await files(root);
  await rejectedRead(root);
  const [entry] = await quarantineEntries(root);
  const metadata = await assertEvidenceMatches(root, entry, before, ['event-registry', 'observation-registry']);
  assert.equal(metadata.failureClass, 'REGISTRY_FILE_MISSING');
  assert.equal(metadata.evidenceFiles.find(({ role }) => role === 'event-registry').present, false);
  assert.deepEqual(await files(root), before);
});

for (const [name, role, content, expectedClass] of [
  ['malformed Event JSONL', 'event', Buffer.from('{bad-json}\n'), 'MALFORMED_JSONL'],
  ['malformed Observation JSONL', 'observation', Buffer.from('{bad-json}\n'), 'MALFORMED_JSONL'],
  ['truncated final Event JSONL line', 'event', Buffer.from('{"partial":true}'), 'TRUNCATED_JSONL'],
  ['truncated final Observation JSONL line', 'observation', Buffer.from('{"partial":true}'), 'TRUNCATED_JSONL'],
]) {
  test(`${name} quarantines raw paired bytes without repair`, async () => {
    const root = await newRoot();
    await seedValidPair(root);
    await removeCommitMarkers(root);
    const targetPath = join(root, role === 'event' ? 'radar-event-registry.jsonl' : 'radar-observation-registry.jsonl');
    await writeFile(targetPath, content);
    const before = await files(root);
    await rejectedRead(root);
    const [entry] = await quarantineEntries(root);
    const metadata = await assertEvidenceMatches(root, entry, before, ['event-registry', 'observation-registry']);
    assert.equal(metadata.failureClass, expectedClass);
    assert.equal(metadata.errorCode, expectedClass === 'TRUNCATED_JSONL' ? 'REGISTRY_JSONL_TRUNCATED' : 'REGISTRY_JSONL_INVALID');
    assert.deepEqual(await files(root), before);
  });
}

for (const [name, value] of [
  ['null', null],
  ['array', []],
  ['string', 'string'],
  ['number', 123],
  ['boolean', true],
  ['empty object', {}],
  ['null eventKey', { eventKey: null }],
  ['empty eventKey', { eventKey: '' }],
  ['missing required fields', { eventKey: 'shape-fixture:release:missing' }],
]) {
  test(`Event JSONL ${name} row is structurally diagnosed and quarantined byte-for-byte`, async () => {
    const root = await newRoot();
    await seedValidPair(root);
    await removeCommitMarkers(root);
    await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from(`${JSON.stringify(value)}\n`));
    const before = await files(root);
    await assertStructuredShapeQuarantine(root, before, 'events', `Event ${name}`);
  });
}

for (const [name, value] of [
  ['null', null],
  ['array', []],
  ['string', 'string'],
  ['empty object', {}],
  ['missing observationId', { eventKey: 'shape-fixture:release:missing-id' }],
  ['missing eventKey', { observationId: '0123456789abcdef' }],
]) {
  test(`Observation JSONL ${name} row is structurally diagnosed and quarantined byte-for-byte`, async () => {
    const root = await newRoot();
    await seedValidPair(root);
    await removeCommitMarkers(root);
    await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.from(`${JSON.stringify(value)}\n`));
    const before = await files(root);
    await assertStructuredShapeQuarantine(root, before, 'observations', `Observation ${name}`);
  });
}

for (const [name, eventBytes, observationBytes, invalidRole] of [
  ['valid Event and invalid Observation', undefined, 'null\n', 'observations'],
  ['invalid Event and valid Observation', 'null\n', undefined, 'events'],
  ['both invalid', 'null\n', '[]\n', 'events'],
]) {
  test(`paired JSONL validation quarantines ${name} without replacing either side`, async () => {
    const root = await newRoot();
    await seedValidPair(root);
    await removeCommitMarkers(root);
    if (eventBytes !== undefined) await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from(eventBytes));
    if (observationBytes !== undefined) await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.from(observationBytes));
    const before = await files(root);
    const metadata = await assertStructuredShapeQuarantine(root, before, invalidRole, name);
    if (name === 'both invalid') assert.ok(metadata.validationErrors.some(({ code, path }) => code === 'REGISTRY_INVALID_ROW_SHAPE' && path.startsWith('/observations/0')));
  });
}

async function mutateValidPair(root, mutate) {
  const layer = await seedValidPair(root);
  await removeCommitMarkers(root);
  const pairFiles = await files(root);
  const events = pairFiles.event.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  const observations = pairFiles.observation.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  const changed = mutate({ events, observations });
  await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from(changed.events.map((row) => `${JSON.stringify(row)}\n`).join('')));
  await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.from(changed.observations.map((row) => `${JSON.stringify(row)}\n`).join('')));
  return { layer, before: await files(root) };
}

for (const [name, mutate, expectedCode] of [
  ['duplicate eventKey', ({ events, observations }) => ({ events: [...events, events[0]], observations }), 'REGISTRY_DUPLICATE_EVENT_KEY'],
  ['duplicate observationId', ({ events, observations }) => ({ events, observations: [...observations, observations[0]] }), 'REGISTRY_DUPLICATE_OBSERVATION_ID'],
  ['Observation references missing Event', ({ events, observations }) => ({ events, observations: observations.map((row) => ({ ...row, eventKey: 'missing-event:release:orphan' })) }), 'REGISTRY_OBSERVATION_EVENT_MISSING'],
  ['occurrences mismatch', ({ events, observations }) => ({ events: events.map((row) => ({ ...row, occurrences: row.occurrences + 1 })), observations }), 'REGISTRY_OCCURRENCE_MISMATCH'],
  ['fingerprint history inconsistency', ({ events, observations }) => ({ events: events.map((row) => ({ ...row, fingerprintHistory: [{ ...row.fingerprintHistory[0], fingerprint: 'ffffffffffffffff' }] })), observations }), 'REGISTRY_FINGERPRINT_HISTORY_INVALID'],
]) {
  test(`${name} validation failure is quarantined with issue metadata and no repair`, async () => {
    const root = await newRoot();
    const { before } = await mutateValidPair(root, mutate);
    await rejectedRead(root);
    const [entry] = await quarantineEntries(root);
    const metadata = await assertEvidenceMatches(root, entry, before, ['event-registry', 'observation-registry']);
    assert.equal(metadata.failureClass, 'REGISTRY_VALIDATION_FAILED');
    assert.ok(metadata.validationErrors.some(({ code }) => code === expectedCode));
    assert.deepEqual(await files(root), before);
  });
}

test('both corrupt sides are preserved together as one pair evidence record', async () => {
  const root = await newRoot();
  await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from('{bad-event}\n'));
  await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.from('{bad-observation}\n'));
  const before = await files(root);
  await rejectedRead(root);
  const entries = await quarantineEntries(root);
  assert.equal(entries.length, 1);
  const metadata = await assertEvidenceMatches(root, entries[0], before, ['event-registry', 'observation-registry']);
  assert.equal(metadata.failureClass, 'MALFORMED_JSONL');
  assert.deepEqual(await files(root), before);
});

test('invalid fingerprint-history row shape is diagnosed before field access and quarantined', async () => {
  const root = await newRoot();
  await seedValidPair(root);
  await removeCommitMarkers(root);
  const pair = await files(root);
  const event = JSON.parse(pair.event.toString('utf8').trim());
  event.fingerprintHistory = [null];
  await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from(`${JSON.stringify(event)}\n`));
  const before = await files(root);
  const layer = new RegistryLayer({ stateDir: root, lockTimeoutMs: 100 });
  await assert.rejects(layer.transactions.readPair(), (error) => {
    assert.notEqual(error instanceof TypeError, true);
    assert.equal(error.code, 'REGISTRY_VALIDATION_FAILED');
    assert.ok(error.details.some(({ code, path }) => code === 'REGISTRY_INVALID_ROW_SHAPE' && path === '/events/0/fingerprintHistory/0'));
    return true;
  });
  const [entry] = await quarantineEntries(root);
  const metadata = await assertEvidenceMatches(root, entry, before, ['event-registry', 'observation-registry']);
  assert.ok(metadata.validationErrors.some(({ code, path }) => code === 'REGISTRY_INVALID_ROW_SHAPE' && path === '/events/0/fingerprintHistory/0'));
  assert.deepEqual(await files(root), before);
});

test('repeated validation reuses complete matching evidence and never overwrites it', async () => {
  const root = await newRoot();
  await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from('{bad}\n'));
  await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.alloc(0));
  await rejectedRead(root, { clock: () => new Date('2026-09-30T12:00:00.000Z') });
  const [first] = await quarantineEntries(root);
  const firstMetadata = await readMetadata(root, first);
  const firstEvent = firstMetadata.evidenceFiles.find(({ role }) => role === 'event-registry');
  const saved = await readFile(join(root, 'radar-registry-quarantine', first, firstEvent.quarantineFile));
  await rejectedRead(root, { clock: () => new Date('2026-09-30T12:00:00.000Z') });
  assert.deepEqual(await quarantineEntries(root), [first]);
  assert.deepEqual(await readFile(join(root, 'radar-registry-quarantine', first, firstEvent.quarantineFile)), saved);
});

test('quarantine destination collision selects a new directory and preserves prior evidence', async () => {
  const root = await newRoot();
  const fixedName = 'fixed-collision-target';
  const occupied = join(root, 'radar-registry-quarantine', fixedName);
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, 'metadata.json'), '{"sentinel":"do-not-overwrite"}\n');
  await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from('{bad}\n'));
  await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.alloc(0));
  await rejectedRead(root, { quarantineNameFactory: () => fixedName });
  assert.equal(await readFile(join(occupied, 'metadata.json'), 'utf8'), '{"sentinel":"do-not-overwrite"}\n');
  const entries = await quarantineEntries(root);
  assert.ok(entries.some((name) => name.startsWith(`${fixedName}-`)));
});

for (const [name, setup, runtime] of [
  ['permission denied', async (root) => {
    await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from('{bad}\n'));
    await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.alloc(0));
  }, { quarantineFailurePoint: 'before-directory' }],
  ['destination unavailable', async (root) => {
    await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from('{bad}\n'));
    await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.alloc(0));
    await writeFile(join(root, 'radar-registry-quarantine'), 'blocks-directory');
  }, {}],
  ['write interruption', async (root) => {
    await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from('{bad}\n'));
    await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.from('{}\n'));
  }, { quarantineFailurePoint: 'after-first-evidence-file' }],
  ['metadata write failure', async (root) => {
    await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from('{bad}\n'));
    await writeFile(join(root, 'radar-observation-registry.jsonl'), Buffer.from('{}\n'));
  }, { quarantineFailurePoint: 'before-metadata' }],
]) {
  test(`quarantine failure (${name}) fails closed and leaves source bytes untouched`, async () => {
    const root = await newRoot();
    await setup(root);
    const before = await files(root);
    const layer = new RegistryLayer({ stateDir: root, lockTimeoutMs: 100, ...runtime });
    await assert.rejects(layer.commitObservation(validInput('must-not-commit')), (error) => error.code === 'REGISTRY_QUARANTINE_FAILED');
    assert.deepEqual(await files(root), before);
    await assert.rejects(readFile(join(root, 'radar-registry-transaction.json')), (error) => error.code === 'ENOENT');
  });
}

test('PREPARED recovery unexpected hash is quarantined by the shared primitive and idempotent', async () => {
  const root = await newRoot();
  const layer = new RegistryLayer({ stateDir: root, failurePoint: 'after-event-rename', clock: () => new Date('2026-09-30T12:00:00.000Z') });
  await assert.rejects(layer.commitObservation(validInput()), /Injected transaction failure/);
  await writeFile(join(root, 'radar-event-registry.jsonl'), Buffer.from('unexpected-registry-bytes\n'));
  const before = await files(root);
  await assert.rejects(recoverRegistry({ stateDir: root }), (error) => error.code === 'MANUAL_INTERVENTION');
  const first = await quarantineEntries(root);
  assert.equal(first.length, 1);
  const journal = JSON.parse(await readFile(join(root, 'radar-registry-transaction.json'), 'utf8'));
  const metadata = await readMetadata(root, first[0]);
  assert.equal(metadata.failureClass, 'TRANSACTION_RECOVERY_CORRUPTION');
  assert.ok(metadata.evidenceFiles.some(({ role }) => role === 'transaction-journal'));
  await assert.rejects(recoverRegistry({ stateDir: root }), (error) => error.code === 'MANUAL_INTERVENTION');
  assert.deepEqual(await quarantineEntries(root), first);
  assert.deepEqual(await files(root), before);
  assert.equal(journal.state, 'PREPARED');
});

test('orphan staging without a journal is preserved and prevents fresh initialization', async () => {
  const root = await newRoot();
  const staging = join(root, 'radar-registry-staging', 'orphan-tx');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'events.next.jsonl'), Buffer.from('raw-staged-evidence\n'));
  const before = await files(root);
  await assert.rejects(recoverRegistry({ stateDir: root }), (error) => error.code === 'REGISTRY_PARTIAL_TRANSACTION_STATE');
  const [entry] = await quarantineEntries(root);
  const metadata = await readMetadata(root, entry);
  assert.equal(metadata.failureClass, 'PARTIAL_TRANSACTION_STATE');
  const staged = metadata.evidenceFiles.find(({ role }) => role.startsWith('staging:'));
  assert.ok(staged);
  assert.equal(sha(await readFile(join(root, 'radar-registry-quarantine', entry, staged.quarantineFile))), sha(Buffer.from('raw-staged-evidence\n')));
  assert.deepEqual(await files(root), before);
});

test('malformed transaction journal is quarantined with raw journal and Registry pair evidence', async () => {
  const root = await newRoot();
  await seedValidPair(root);
  await writeFile(join(root, 'radar-registry-transaction.json'), Buffer.from('{broken-journal}\n'));
  const before = await files(root);
  const journalBytes = await readFile(join(root, 'radar-registry-transaction.json'));
  await assert.rejects(recoverRegistry({ stateDir: root }), (error) => error.code === 'REGISTRY_JOURNAL_INVALID');
  const [entry] = await quarantineEntries(root);
  const metadata = await readMetadata(root, entry);
  assert.equal(metadata.failureClass, 'INVALID_TRANSACTION_JOURNAL');
  const journal = metadata.evidenceFiles.find(({ role }) => role === 'transaction-journal');
  assert.equal(sha(await readFile(join(root, 'radar-registry-quarantine', entry, journal.quarantineFile))), sha(journalBytes));
  assert.deepEqual(await files(root), before);
});

test('valid Registry pair still loads unchanged and snapshot pair remains valid', async () => {
  const root = await newRoot();
  const layer = await seedValidPair(root);
  const before = await files(root);
  const pair = await layer.transactions.readPair();
  assert.equal(pair.events.length, 1);
  assert.equal(pair.observations.length, 1);
  assert.deepEqual(await files(root), before);
  assert.deepEqual(await quarantineEntries(root), []);
});
