import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RegistryRadar } from './types.ts';

export interface CandidateReceipt {
  recordedAt: string;
  radar: RegistryRadar;
  candidate: unknown;
  outcome: string;
  reason?: string;
}

export async function appendCandidateReceipt(runRoot: string, receipt: CandidateReceipt): Promise<string> {
  const day = receipt.recordedAt.slice(0, 10);
  const directory = join(runRoot, day);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${receipt.radar}.jsonl`);
  const handle = await open(path, 'a', 0o600);
  try { await handle.write(`${JSON.stringify(receipt)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  return path;
}

/** Explicit cleanup only. Registry files are never read or modified. */
export async function cleanupCandidateReceipts(runRoot: string, now = new Date(), retentionDays = 14): Promise<string[]> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new TypeError('retentionDays must be a positive integer');
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted: string[] = [];
  const entries = await readdir(runRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const day = new Date(`${entry.name}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day >= cutoff) continue;
    const path = join(runRoot, entry.name);
    // Only remove a complete per-day receipt directory, never registry state.
    for (const file of await readdir(path)) {
      if (!/^(ai|dev|app|security|skill)\.jsonl$/.test(file)) throw Object.assign(new Error(`Unexpected receipt file: ${file}`), { code: 'REGISTRY_RECEIPT_CLEANUP_UNSAFE' });
    }
    await rm(path, { recursive: true, force: false });
    deleted.push(path);
  }
  return deleted;
}
