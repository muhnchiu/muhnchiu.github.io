import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const ROOT_MARKER = '.horizon-radar-v2-shadow-root-v1';
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Same-filesystem, no-overwrite write. A crash can leave only an ignored temp file. */
export async function writeExclusiveAtomic(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temp, path);
    await unlink(temp);
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    await unlink(temp).catch(() => {});
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/** Independent append-only Shadow state. This module imports no Registry code. */
export class ShadowStateStore {
  constructor(root) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('SHADOW_ROOT_REQUIRED');
    this.root = resolve(root);
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return this.root;
    await mkdir(dirname(this.root), { recursive: true, mode: 0o700 });
    let created = false;
    try { await mkdir(this.root, { mode: 0o700 }); created = true; }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SHADOW_ISOLATION_FAILURE');
    const canonical = await realpath(this.root);
    this.root = canonical;
    const marker = join(this.root, ROOT_MARKER);
    const markerBytes = Buffer.from('HORIZON_RADAR_V2_SHADOW_ROOT_V1\n', 'utf8');
    if (created) {
      const written = await writeExclusiveAtomic(marker, markerBytes);
      if (!written) throw new Error('SHADOW_ROOT_MARKER_CONFLICT');
    } else {
      const current = await readFile(marker).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (!current || !current.equals(markerBytes)) throw new Error('SHADOW_ROOT_NOT_MARKED');
    }
    this.initialized = true;
    return this.root;
  }

  async readDelivery(key) {
    await this.initialize();
    return readJson(join(this.root, 'deliveries', `${key}.json`));
  }

  async claimDelivery(key, row) {
    await this.initialize();
    const path = join(this.root, 'deliveries', `${key}.json`);
    const created = await writeExclusiveAtomic(path, jsonBytes(row));
    if (created) return { created: true, row };
    return { created: false, row: await readJson(path) };
  }

  async writeError(errorId, row) {
    await this.initialize();
    return writeExclusiveAtomic(join(this.root, 'errors', `${errorId}.json`), jsonBytes(row));
  }

  async publishRun(runId, batchDigest, files) {
    await this.initialize();
    const parent = join(this.root, 'runs');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const finalDir = join(parent, runId);
    const prior = await readJson(join(finalDir, 'metadata.json'));
    if (prior) {
      if (prior.inputDigest !== batchDigest) return { published: false, conflict: true, prior };
      const attemptId = randomUUID();
      const attemptDir = join(finalDir, 'attempts', attemptId);
      await mkdir(attemptDir, { recursive: true, mode: 0o700 });
      for (const [name, bytes] of Object.entries(files)) await writeExclusiveAtomic(join(attemptDir, name), bytes);
      await syncDirectory(attemptDir);
      return { published: false, replay: true, attemptId };
    }
    const stagingRoot = join(this.root, 'staging');
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const stage = join(stagingRoot, `${runId}.${randomUUID()}.tmp`);
    await mkdir(stage, { mode: 0o700 });
    try {
      for (const [name, bytes] of Object.entries(files)) await writeExclusiveAtomic(join(stage, name), bytes);
      await syncDirectory(stage);
      try {
        await rename(stage, finalDir);
        await syncDirectory(parent);
        return { published: true };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
        const raced = await readJson(join(finalDir, 'metadata.json'));
        if (raced?.inputDigest === batchDigest) return { published: false, replay: true };
        return { published: false, conflict: true, prior: raced };
      }
    } catch (error) {
      throw error;
    }
  }

  async readRun(runId) {
    await this.initialize();
    return readJson(join(this.root, 'runs', runId, 'metadata.json'));
  }
}

export const shadowRootMarkerName = ROOT_MARKER;
export const shadowStoreDigest = (value) => sha256(value);
