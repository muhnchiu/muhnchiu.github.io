import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registryPairFromJsonl, validateRegistryPair } from './validator.ts';
import type { RegistryPair } from './types.ts';

export interface SnapshotManifest {
  snapshotVersion: string;
  createdAt: string;
  transactionId: string;
  eventCount: number;
  observationCount: number;
  eventSha256: string;
  observationSha256: string;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeSynced(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function readSnapshotPair(path: string): Promise<{ pair: RegistryPair; manifest: SnapshotManifest }> {
  const eventBytes = await readFile(join(path, 'events.jsonl'));
  const observationBytes = await readFile(join(path, 'observations.jsonl'));
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as SnapshotManifest;
  if (sha256(eventBytes) !== manifest.eventSha256 || sha256(observationBytes) !== manifest.observationSha256) {
    throw Object.assign(new Error('Snapshot pair hash mismatch.'), { code: 'REGISTRY_SNAPSHOT_HASH_MISMATCH' });
  }
  const pair = registryPairFromJsonl(eventBytes, observationBytes);
  if (pair.events.length !== manifest.eventCount || pair.observations.length !== manifest.observationCount) {
    throw Object.assign(new Error('Snapshot pair record count mismatch.'), { code: 'REGISTRY_SNAPSHOT_COUNT_MISMATCH' });
  }
  const validation = validateRegistryPair(pair);
  if (!validation.valid) {
    throw Object.assign(new Error('Snapshot Registry pair failed validation.'), { code: 'REGISTRY_SNAPSHOT_INVALID', details: validation.errors });
  }
  return { pair, manifest };
}

export async function createSnapshot(
  snapshotsDir: string,
  date: string,
  transactionId: string,
  createdAt: string,
  pair: RegistryPair,
  eventBytes: Buffer,
  observationBytes: Buffer,
): Promise<SnapshotManifest> {
  const dayDir = join(snapshotsDir, date);
  const stagingDir = join(snapshotsDir, `.staging-${date}-${transactionId}`);
  const previousDir = join(snapshotsDir, `.previous-${date}-${transactionId}`);
  await mkdir(snapshotsDir, { recursive: true });
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  const manifest: SnapshotManifest = {
    snapshotVersion: '1.0', createdAt, transactionId,
    eventCount: pair.events.length, observationCount: pair.observations.length,
    eventSha256: sha256(eventBytes), observationSha256: sha256(observationBytes),
  };
  await writeSynced(join(stagingDir, 'events.jsonl'), eventBytes);
  await writeSynced(join(stagingDir, 'observations.jsonl'), observationBytes);
  await writeSynced(join(stagingDir, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  await fsyncDirectory(stagingDir);

  let movedPrevious = false;
  try {
    try { await rename(dayDir, previousDir); movedPrevious = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(stagingDir, dayDir);
    await fsyncDirectory(snapshotsDir);
    const verify = await verifySnapshotPair(dayDir);
    if (!verify.valid) throw Object.assign(new Error('New snapshot pair failed validation.'), { code: 'REGISTRY_SNAPSHOT_INVALID' });
    if (movedPrevious) await rm(previousDir, { recursive: true, force: true });
  } catch (error) {
    try {
      const targetStat = await stat(dayDir);
      if (targetStat.isDirectory() && movedPrevious) {
        // Preserve the previous complete pair; the transaction remains committed and retryable.
        await rm(dayDir, { recursive: true, force: true });
        await rename(previousDir, dayDir);
      }
    } catch { /* leave evidence for the recovery manager */ }
    throw error;
  }

  await pruneSnapshots(snapshotsDir, 30);
  return manifest;
}

export async function verifySnapshotPair(path: string): Promise<{ valid: boolean; errors: string[]; manifest?: SnapshotManifest }> {
  const errors: string[] = [];
  try {
    const eventBytes = await readFile(join(path, 'events.jsonl'));
    const observationBytes = await readFile(join(path, 'observations.jsonl'));
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as SnapshotManifest;
    if (sha256(eventBytes) !== manifest.eventSha256) errors.push('eventSha256 mismatch');
    if (sha256(observationBytes) !== manifest.observationSha256) errors.push('observationSha256 mismatch');
    if (eventBytes.toString('utf8').split('\n').filter(Boolean).length !== manifest.eventCount) errors.push('eventCount mismatch');
    if (observationBytes.toString('utf8').split('\n').filter(Boolean).length !== manifest.observationCount) errors.push('observationCount mismatch');
    return { valid: errors.length === 0, errors, manifest };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { valid: false, errors };
  }
}

export async function pruneSnapshots(snapshotsDir: string, retainDaily = 30): Promise<void> {
  const entries = await readdir(snapshotsDir, { withFileTypes: true }).catch(() => []);
  const validPairs: Array<{ path: string; day: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const path = join(snapshotsDir, entry.name);
    if ((await verifySnapshotPair(path)).valid) validPairs.push({ path, day: entry.name });
  }
  validPairs.sort((a, b) => a.day.localeCompare(b.day));
  for (const old of validPairs.slice(0, Math.max(0, validPairs.length - retainDaily))) {
    await rm(old.path, { recursive: true, force: false });
  }
}
