import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveProcessIdentity, parseLinuxProcStatStartTicks } from '../src/lib/radar-registry/process-identity.mjs';
import {
  acquireRegistryLock, assessLockOwner, REGISTRY_LOCK_TIMEOUT_MS, REGISTRY_STALE_LOCK_MS,
} from '../src/lib/radar-registry/lock.ts';

const roots = new Set();
test.after(async () => Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true }))));

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'horizon-registry-lock-identity-'));
  roots.add(root);
  return root;
}

const now = Date.parse('2026-09-30T12:00:00.000Z');
const localHost = hostname();
const selfIdentity = resolveProcessIdentity(process.pid);
assert.equal(selfIdentity.status, 'RUNNING', 'the current platform must expose a reliable process start identity');
const startA = process.platform === 'darwin' ? 'darwin:100:1' : 'linux:100';
const startB = process.platform === 'darwin' ? 'darwin:100:2' : 'linux:101';

function owner(overrides = {}) {
  return {
    pid: 987654321,
    startedAt: new Date(now - REGISTRY_STALE_LOCK_MS - 1).toISOString(),
    transactionId: 'old-transaction',
    hostname: localHost,
    token: 'old-lock-token',
    processStartIdentity: startA,
    ...overrides,
  };
}

async function seedLock(root, record) {
  const lockDir = join(root, 'radar-registry.lock');
  await mkdir(lockDir);
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify(record));
  return lockDir;
}

function runtimeFor(root, resolver, extra = {}) {
  return {
    stateDir: root,
    clock: () => new Date(now),
    lockTimeoutMs: 0,
    staleThresholdMs: REGISTRY_STALE_LOCK_MS,
    processIdentityResolver: (pid) => pid === process.pid ? selfIdentity : resolver(pid),
    ...extra,
  };
}

async function assertRetained(root, record, resolver) {
  const lockDir = await seedLock(root, record);
  await assert.rejects(
    acquireRegistryLock(root, 'contender', runtimeFor(root, resolver)),
    (error) => error.code === 'REGISTRY_LOCK_TIMEOUT',
  );
  assert.deepEqual(await readdir(lockDir), ['owner.json']);
  assert.equal(await readFile(join(lockDir, 'owner.json'), 'utf8'), JSON.stringify(record));
  await assert.rejects(readdir(join(root, 'radar-registry-quarantine')));
}

test('Frozen timeout and stale thresholds stay fixed', () => {
  assert.equal(REGISTRY_LOCK_TIMEOUT_MS, 120_000);
  assert.equal(REGISTRY_STALE_LOCK_MS, 15 * 60_000);
});

test('current process start identity is OS-derived and deterministic', () => {
  const again = resolveProcessIdentity(process.pid);
  assert.equal(again.status, 'RUNNING');
  assert.equal(again.startIdentity, selfIdentity.startIdentity);
  assert.match(selfIdentity.startIdentity, /^(darwin|linux):/);
});

test('Linux /proc stat parser handles command names containing closing parentheses', () => {
  const remaining = Array.from({ length: 20 }, (_, index) => String(index + 3));
  remaining[0] = 'S';
  remaining[19] = '456789';
  assert.equal(parseLinuxProcStatStartTicks(`77 (worker ) with paren) ${remaining.join(' ')}`), '456789');
  assert.equal(parseLinuxProcStatStartTicks('malformed'), undefined);
});

test('same PID and same start identity is active and is never quarantined', async () => {
  const record = owner();
  assert.equal(assessLockOwner(record, {
    localHostname: localHost, now, staleThresholdMs: REGISTRY_STALE_LOCK_MS,
    resolveIdentity: () => ({ status: 'RUNNING', startIdentity: record.processStartIdentity }),
  }), 'ACTIVE_OWNER');
  const root = await newRoot();
  await assertRetained(root, record, () => ({ status: 'RUNNING', startIdentity: startA }));
});

test('PID absent is confirmed exited and a stale lock is quarantined before acquisition', async () => {
  const root = await newRoot();
  await seedLock(root, owner());
  const handle = await acquireRegistryLock(root, 'new-owner', runtimeFor(root, () => ({ status: 'EXITED' })));
  const quarantine = await readdir(join(root, 'radar-registry-quarantine'));
  assert.equal(quarantine.length, 1);
  assert.equal(JSON.parse(await readFile(join(root, 'radar-registry.lock', 'owner.json'), 'utf8')).transactionId, 'new-owner');
  await handle.release();
});

test('PID reuse regression: same PID with a different OS start identity confirms original owner exited', async () => {
  const record = owner();
  assert.equal(assessLockOwner(record, {
    localHostname: localHost, now, staleThresholdMs: REGISTRY_STALE_LOCK_MS,
    resolveIdentity: () => ({ status: 'RUNNING', startIdentity: startB }),
  }), 'PID_REUSED');
  const root = await newRoot();
  await seedLock(root, record);
  const handle = await acquireRegistryLock(root, 'after-pid-reuse', runtimeFor(root, () => ({ status: 'RUNNING', startIdentity: startB })));
  assert.equal((await readdir(join(root, 'radar-registry-quarantine'))).length, 1);
  await handle.release();
  console.log('PID_REUSE_REGRESSION = PASS');
});

test('identity lookup failure, unsupported lookup, and ambiguous states fail safe', async (t) => {
  const cases = [
    ['unknown', () => ({ status: 'UNKNOWN', reason: 'fixture' })],
    ['throw', () => { throw new Error('lookup failed'); }],
    ['malformed result', () => ({ status: 'RUNNING' })],
  ];
  for (const [name, resolver] of cases) await t.test(name, async () => {
    await assertRetained(await newRoot(), owner(), resolver);
  });
});

test('foreign host is never checked or quarantined locally', async () => {
  const record = owner({ hostname: 'another-host.invalid' });
  assert.equal(assessLockOwner(record, {
    localHostname: localHost, now, staleThresholdMs: REGISTRY_STALE_LOCK_MS,
    resolveIdentity: () => assert.fail('foreign PID must not be inspected locally'),
  }), 'FOREIGN_HOST');
  await assertRetained(await newRoot(), record, () => assert.fail('foreign PID must not be inspected locally'));
});

test('malformed and legacy owners without processStartIdentity are preserved', async () => {
  const missingIdentity = owner();
  delete missingIdentity.processStartIdentity;
  assert.equal(assessLockOwner(missingIdentity, {
    localHostname: localHost, now, staleThresholdMs: REGISTRY_STALE_LOCK_MS,
    resolveIdentity: () => assert.fail('legacy lock identity must not be fabricated'),
  }), 'INVALID_OWNER_METADATA');
  await assertRetained(await newRoot(), missingIdentity, () => assert.fail('legacy lock identity must not be fabricated'));
  await assertRetained(await newRoot(), { ...owner(), pid: 'not-a-pid' }, () => assert.fail('invalid owner must not be inspected'));
});

test('lock younger than 15 minutes is retained without process lookup', async () => {
  const record = owner({ startedAt: new Date(now - REGISTRY_STALE_LOCK_MS + 1).toISOString() });
  assert.equal(assessLockOwner(record, {
    localHostname: localHost, now, staleThresholdMs: REGISTRY_STALE_LOCK_MS,
    resolveIdentity: () => assert.fail('young lock does not need stale proof'),
  }), 'NOT_OLD_ENOUGH');
  await assertRetained(await newRoot(), record, () => assert.fail('young lock does not need stale proof'));
});

test('old active owner remains protected beyond the stale threshold', async () => {
  const record = owner();
  await assertRetained(await newRoot(), record, () => ({ status: 'RUNNING', startIdentity: record.processStartIdentity }));
});

test('stale recovery is idempotent after one quarantine', async () => {
  const root = await newRoot();
  const record = owner();
  await seedLock(root, record);
  const resolver = () => ({ status: 'EXITED' });
  const first = await acquireRegistryLock(root, 'recovery-one', runtimeFor(root, resolver));
  await first.release();
  const afterFirst = await readdir(join(root, 'radar-registry-quarantine'));
  const second = await acquireRegistryLock(root, 'recovery-two', runtimeFor(root, resolver));
  await second.release();
  assert.deepEqual(await readdir(join(root, 'radar-registry-quarantine')), afterFirst);
});

test('concurrent acquisition yields exactly one lock holder', async () => {
  const root = await newRoot();
  const runtime = runtimeFor(root, () => ({ status: 'UNKNOWN', reason: 'not needed for a young owner' }), { lockTimeoutMs: 100 });
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => acquireRegistryLock(root, `contender-${index}`, runtime)));
  const holders = attempts.filter((result) => result.status === 'fulfilled');
  const failures = attempts.filter((result) => result.status === 'rejected');
  assert.equal(holders.length, 1);
  assert.equal(failures.length, 5);
  assert.ok(failures.every(({ reason }) => reason.code === 'REGISTRY_LOCK_TIMEOUT'));
  await holders[0].value.release();
});

test('new lock records the current OS process start identity', async () => {
  const root = await newRoot();
  const handle = await acquireRegistryLock(root, 'identity-recording', runtimeFor(root, resolveProcessIdentity));
  const written = JSON.parse(await readFile(join(root, 'radar-registry.lock', 'owner.json'), 'utf8'));
  assert.equal(written.pid, process.pid);
  assert.equal(written.hostname, localHost);
  assert.equal(written.startedAt, new Date(now).toISOString());
  assert.equal(written.processStartIdentity, selfIdentity.startIdentity);
  await handle.release();
});
