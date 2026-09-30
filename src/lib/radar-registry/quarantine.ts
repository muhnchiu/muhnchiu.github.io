import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RegistryRuntime } from './types.ts';

export interface CorruptionEvidenceFile {
  role: string;
  originalPath: string;
  present: boolean;
  bytes?: Buffer;
}

export interface CorruptionEvidenceInput {
  failureClass: string;
  errorCode: string;
  failureReason: string;
  evidenceFiles: CorruptionEvidenceFile[];
  metadata?: Record<string, unknown>;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const absentHash = 'ABSENT';
const safe = (value: string) => {
  const part = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return !part || part === '.' || part === '..' ? 'evidence' : part;
};

function evidenceKey(input: CorruptionEvidenceInput): string {
  const rows = input.evidenceFiles.map(({ role, originalPath, present, bytes }) => ({
    role, originalPath, present, sha256: present && bytes ? sha256(bytes) : absentHash,
  })).sort((a, b) => `${a.role}\0${a.originalPath}`.localeCompare(`${b.role}\0${b.originalPath}`));
  return sha256(JSON.stringify({ failureClass: input.failureClass, errorCode: input.errorCode, failureReason: input.failureReason, evidenceFiles: rows }));
}

async function completeExistingEvidence(root: string, key: string): Promise<string | undefined> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const metadata = JSON.parse(await readFile(join(root, entry.name, 'metadata.json'), 'utf8')) as { complete?: boolean; evidenceKey?: string };
      if (metadata.complete === true && metadata.evidenceKey === key) return join(root, entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return undefined;
}

async function writeSyncedExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/** Persist exact bytes and a reason manifest before callers can replace or initialize Registry state. */
export async function preserveCorruptionEvidence(
  stateDir: string,
  input: CorruptionEvidenceInput,
  runtime: Pick<RegistryRuntime, 'clock' | 'quarantineFailurePoint' | 'quarantineNameFactory'> = {},
): Promise<string> {
  const key = evidenceKey(input);
  const root = join(stateDir, 'radar-registry-quarantine');
  try {
    const existing = await completeExistingEvidence(root, key);
    if (existing) return existing;
    if (runtime.quarantineFailurePoint === 'before-directory') {
      throw Object.assign(new Error('Injected permission denied before quarantine creation.'), { code: 'EACCES' });
    }
    await mkdir(root, { recursive: true });
    const detectedAt = (runtime.clock?.() ?? new Date()).toISOString();
    const supplied = runtime.quarantineNameFactory?.(detectedAt, key, input.failureClass);
    const base = safe(supplied ?? `${detectedAt.replace(/[:.]/g, '-')}-${safe(input.failureClass)}-${key.slice(0, 12)}`);
    let destination = '';
    for (let collision = 0; collision < 10_000; collision += 1) {
      const name = collision === 0 ? base : `${base}-${collision}`;
      const candidate = join(root, name);
      try { await mkdir(candidate); destination = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!destination) throw Object.assign(new Error('Could not allocate a collision-free quarantine directory.'), { code: 'EEXIST' });

    const evidenceFiles: Array<Record<string, unknown>> = [];
    let writtenEvidence = 0;
    for (const [index, file] of input.evidenceFiles.entries()) {
      const hasBytes = file.present && file.bytes !== undefined;
      const row: Record<string, unknown> = {
        role: file.role,
        originalPath: file.originalPath,
        present: file.present,
        bytes: hasBytes ? file.bytes!.length : 0,
        sha256: hasBytes ? sha256(file.bytes!) : null,
        quarantineFile: hasBytes ? `${String(index + 1).padStart(2, '0')}-${safe(file.role)}.raw` : null,
      };
      if (hasBytes) {
        await writeSyncedExclusive(join(destination, row.quarantineFile as string), file.bytes!);
        writtenEvidence += 1;
        if (writtenEvidence === 1 && runtime.quarantineFailurePoint === 'after-first-evidence-file') {
          throw Object.assign(new Error('Injected interruption while writing raw quarantine evidence.'), { code: 'EIO' });
        }
      }
      evidenceFiles.push(row);
    }
    if (runtime.quarantineFailurePoint === 'before-metadata') {
      throw Object.assign(new Error('Injected metadata write failure.'), { code: 'EIO' });
    }
    const metadata = {
      ...(input.metadata ?? {}),
      quarantineVersion: '1.0',
      complete: true,
      evidenceKey: key,
      detectionTimestamp: detectedAt,
      failureClass: input.failureClass,
      errorCode: input.errorCode,
      failureReason: input.failureReason,
      evidenceFiles,
    };
    await writeSyncedExclusive(join(destination, 'metadata.json'), Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
    const directory = await open(destination, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    const quarantineRoot = await open(root, 'r');
    try { await quarantineRoot.sync(); } finally { await quarantineRoot.close(); }
    return destination;
  } catch (error) {
    throw Object.assign(new Error(`Registry corruption evidence could not be preserved: ${error instanceof Error ? error.message : String(error)}`, { cause: error }), {
      code: 'REGISTRY_QUARANTINE_FAILED',
      failureClass: input.failureClass,
      originalErrorCode: input.errorCode,
      evidenceKey: key,
    });
  }
}

export function addQuarantinePath(error: unknown, path: string): Error {
  const result = error instanceof Error ? error : new Error(String(error));
  Object.assign(result, { quarantinePath: path });
  return result;
}
