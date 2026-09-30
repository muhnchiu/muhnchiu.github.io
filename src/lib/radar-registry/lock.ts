import { mkdir, readFile, rename, rm, writeFile, open } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isValidProcessStartIdentity, resolveProcessIdentity, type ProcessIdentityResolution } from './process-identity.mjs';
import type { RegistryRuntime } from './types.ts';

export const REGISTRY_LOCK_TIMEOUT_MS = 120_000;
export const REGISTRY_STALE_LOCK_MS = 15 * 60_000;
export interface RegistryLockOwner { pid: number; startedAt: string; transactionId: string; hostname: string; token: string; processStartIdentity: string; }
export interface LockHandle { owner: RegistryLockOwner; release(): Promise<void>; }

export type LockOwnerAssessment =
  | 'ACTIVE_OWNER'
  | 'STALE_OWNER_CONFIRMED_EXITED'
  | 'PID_REUSED'
  | 'OWNER_IDENTITY_UNKNOWN'
  | 'FOREIGN_HOST'
  | 'INVALID_OWNER_METADATA'
  | 'NOT_OLD_ENOUGH';

function validOwner(owner: Partial<RegistryLockOwner>): owner is RegistryLockOwner {
  const isoTimestamp = typeof owner.startedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(owner.startedAt)
    && Number.isFinite(Date.parse(owner.startedAt));
  return Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0
    && isoTimestamp
    && typeof owner.transactionId === 'string' && owner.transactionId.length > 0
    && typeof owner.hostname === 'string' && owner.hostname.length > 0
    && typeof owner.token === 'string' && owner.token.length > 0
    && isValidProcessStartIdentity(owner.processStartIdentity);
}

export function assessLockOwner(
  owner: Partial<RegistryLockOwner>,
  { localHostname, now, staleThresholdMs, resolveIdentity }: {
    localHostname: string;
    now: number;
    staleThresholdMs: number;
    resolveIdentity: (pid: number) => ProcessIdentityResolution;
  },
): LockOwnerAssessment {
  if (!validOwner(owner)) return 'INVALID_OWNER_METADATA';
  if (owner.hostname !== localHostname) return 'FOREIGN_HOST';
  const ageMs = now - Date.parse(owner.startedAt);
  if (!Number.isFinite(ageMs) || ageMs <= staleThresholdMs) return 'NOT_OLD_ENOUGH';

  let current: ProcessIdentityResolution;
  try { current = resolveIdentity(owner.pid); }
  catch { return 'OWNER_IDENTITY_UNKNOWN'; }
  if (!current || current.status === 'UNKNOWN') return 'OWNER_IDENTITY_UNKNOWN';
  if (current.status === 'EXITED') return 'STALE_OWNER_CONFIRMED_EXITED';
  if (current.status !== 'RUNNING' || !isValidProcessStartIdentity(current.startIdentity)) {
    return 'OWNER_IDENTITY_UNKNOWN';
  }
  return current.startIdentity === owner.processStartIdentity ? 'ACTIVE_OWNER' : 'PID_REUSED';
}

async function writeOwner(path: string, owner: RegistryLockOwner): Promise<void> {
  const temporary = join(path, `.owner-${owner.token}.tmp`);
  await writeFile(temporary, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
  const file = await open(temporary, 'r');
  try { await file.sync(); } finally { await file.close(); }
  await rename(temporary, join(path, 'owner.json'));
}

export async function acquireRegistryLock(
  stateDir: string,
  transactionId: string,
  runtime: RegistryRuntime = {},
): Promise<LockHandle> {
  const clock = runtime.clock ?? (() => new Date());
  const timeoutMs = runtime.lockTimeoutMs ?? REGISTRY_LOCK_TIMEOUT_MS;
  const staleMs = runtime.staleThresholdMs ?? REGISTRY_STALE_LOCK_MS;
  const resolveIdentity = runtime.processIdentityResolver ?? resolveProcessIdentity;
  const ownIdentity = resolveIdentity(process.pid);
  if (ownIdentity.status !== 'RUNNING' || !isValidProcessStartIdentity(ownIdentity.startIdentity)) {
    throw Object.assign(new Error('Cannot acquire Registry lock without a verified process-start identity.'), {
      code: 'REGISTRY_PROCESS_IDENTITY_UNKNOWN', reason: ownIdentity.status === 'UNKNOWN' ? ownIdentity.reason : 'CURRENT_PROCESS_NOT_RUNNING',
    });
  }
  const lockPath = join(stateDir, 'radar-registry.lock');
  const quarantineDir = join(stateDir, 'radar-registry-quarantine');
  const startedWait = Date.now();
  await mkdir(stateDir, { recursive: true });

  while (true) {
    const owner: RegistryLockOwner = {
      pid: process.pid,
      startedAt: clock().toISOString(),
      transactionId,
      hostname: hostname(),
      token: `${process.pid}-${clock().getTime()}-${Math.random().toString(16).slice(2)}`,
      processStartIdentity: ownIdentity.startIdentity,
    };
    try {
      await mkdir(lockPath);
      try { await writeOwner(lockPath, owner); }
      catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error; }
      let released = false;
      return {
        owner,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as RegistryLockOwner;
            if (current.token === owner.token) await rm(lockPath, { recursive: true, force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    let staleQuarantined = false;
    try {
      const current = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as RegistryLockOwner;
      const assessment = assessLockOwner(current, {
        localHostname: hostname(), now: clock().getTime(), staleThresholdMs: staleMs, resolveIdentity,
      });
      if (assessment === 'STALE_OWNER_CONFIRMED_EXITED' || assessment === 'PID_REUSED') {
        await mkdir(quarantineDir, { recursive: true });
        const currentAgain = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as RegistryLockOwner;
        if (validOwner(currentAgain) && currentAgain.token === current.token) {
          const target = join(quarantineDir, `stale-lock-${current.token}`);
          await rename(lockPath, target);
          staleQuarantined = true;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Malformed or inaccessible owner data is deliberately not treated as stale.
      }
    }
    if (staleQuarantined) continue;
    if (Date.now() - startedWait >= timeoutMs) {
      throw Object.assign(new Error('Registry lock acquisition timed out; lock retained fail-safe.'), { code: 'REGISTRY_LOCK_TIMEOUT' });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, timeoutMs))));
  }
}
