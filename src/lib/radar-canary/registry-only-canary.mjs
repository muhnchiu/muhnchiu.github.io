import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RegistryLayer, acquireRegistryLock, validateRegistryPair } from '../radar-registry/index.ts';
import { prepareEvidenceCommit } from '../radar-evidence-pipeline.mjs';
import { resolveClaudeCodeChangelogIdentity } from './claude-code-identity.mjs';

export const CANARY_MODE = 'REGISTRY_ONLY_IDENTITY_CANARY';
export const CANARY_REGISTRY_MODE = 'CANARY';
export const CANARY_NAMESPACE = 'radar-v2-canary-dev-claude-code';
export const CANARY_SOURCE_ID = 'github.com/anthropics/claude-code';
export const CANARY_SOURCE_NAME = 'Claude Code Changelog';
export const CANARY_STORE_MARKER = '.horizon-registry-only-canary-v1.json';
export const DEFAULT_CANARY_REGISTRY_DIR = join(homedir(), '.local', 'state', 'horizon-canary', CANARY_NAMESPACE);
export const DEFAULT_PRODUCTION_REGISTRY_DIR = join(homedir(), '.local', 'state', 'horizon');
const REGISTRY_DIR = 'registry';
const STATE_FILE = 'canary-state-v1.json';
const STORE_MARKER = `${JSON.stringify({ canaryMode: CANARY_MODE, registryMode: CANARY_REGISTRY_MODE, registryNamespace: CANARY_NAMESPACE, sourceId: CANARY_SOURCE_ID, storeVersion: 1 }, null, 2)}\n`;
const FORBIDDEN_EVALUATED_FIELDS = ['score', 'signal', 'action', 'publicationDecision'];
const VALID_DISPOSITIONS = new Set(['NEW_EVENT', 'NEW_OBSERVATION', 'DUPLICATE_OBSERVATION']);
const CANARY_RECORD_FIELDS = new Set(['canaryMode', 'registryMode', 'registryNamespace', 'sourceId', 'radar', 'runId', 'recordId', 'eventKey', 'observationId', 'canonicalEntity', 'canonicalEventType', 'stableEventIdentifier', 'sourceUrl', 'observedAt', 'identityProvenanceReference', 'evidenceReference', 'identityProvenance', 'registryDisposition', 'eventState', 'scoreStatus', 'scoreReason', 'createdAt', 'requestDigest']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const registryJsonlBytes = (rows, key) => Buffer.from([...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key]))).map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
const sealState = (payload) => ({ ...payload, payloadSha256: sha256(JSON.stringify(payload)) });

async function clearUncommittedWork(root) {
  const workRoot = join(root, '.work');
  const entries = await readdir(workRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries) {
    const path = join(workRoot, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw fail('CANARY_REGISTRY_PATH_COLLISION');
    await rm(path, { recursive: true, force: false });
  }
}

async function fsyncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicReplace(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalPath(path, { rejectSymlinks = false } = {}) {
  const target = resolve(path);
  let cursor = target;
  const suffix = [];
  while (true) {
    try {
      const info = await lstat(cursor);
      if (rejectSymlinks && info.isSymbolicLink()) throw fail('CANARY_REGISTRY_PATH_COLLISION', 'Canary store path may not traverse a symbolic link.');
      if (!info.isDirectory()) throw fail('CANARY_REGISTRY_PATH_INVALID', 'Canary store path and ancestors must be directories.');
      const canonicalBase = await realpath(cursor);
      return resolve(canonicalBase, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw fail('CANARY_REGISTRY_PATH_INVALID', 'Unable to resolve registry store path.');
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertPhysicalIsolation(canaryPath, productionPath) {
  const canary = await canonicalPath(canaryPath, { rejectSymlinks: true });
  const production = await canonicalPath(productionPath);
  if (isWithin(production, canary) || isWithin(canary, production)) {
    throw fail('CANARY_REGISTRY_PATH_COLLISION', 'Canary Registry store must not equal, contain, or be inside Production Registry storage.');
  }
  return { canary, production };
}

async function assertNoSymlinks(root) {
  const visit = async (path) => {
    const info = await lstat(path).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!info) return;
    if (info.isSymbolicLink()) throw fail('CANARY_REGISTRY_PATH_COLLISION', 'Canary store must not contain symbolic links.');
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(root);
}

function containsForbiddenFields(input) {
  const sources = [input, input?.candidate, input?.candidate?.rawSourceMetadata?.record];
  return sources.some((value) => value && typeof value === 'object' && FORBIDDEN_EVALUATED_FIELDS.some((field) => Object.hasOwn(value, field)));
}

function validateCanaryRecord(record) {
  const required = [
    'canaryMode', 'registryMode', 'registryNamespace', 'sourceId', 'radar', 'runId', 'recordId', 'eventKey', 'observationId',
    'canonicalEntity', 'canonicalEventType', 'stableEventIdentifier', 'sourceUrl', 'observedAt',
    'identityProvenanceReference', 'evidenceReference', 'registryDisposition', 'eventState',
    'scoreStatus', 'scoreReason', 'createdAt', 'requestDigest',
  ];
  if (!record || typeof record !== 'object' || Array.isArray(record) || required.some((key) => !Object.hasOwn(record, key))) {
    throw fail('CANARY_RECORD_INVALID', 'Canary Registry record is missing required fields.');
  }
  if (Object.keys(record).some((key) => !CANARY_RECORD_FIELDS.has(key))) throw fail('CANARY_RECORD_INVALID', 'Canary Registry record contains an unsupported field.');
  if (record.canaryMode !== CANARY_MODE || record.registryMode !== CANARY_REGISTRY_MODE || record.registryNamespace !== CANARY_NAMESPACE || record.sourceId !== CANARY_SOURCE_ID || record.radar !== 'DEV') throw fail('CANARY_RECORD_INVALID');
  if (!VALID_DISPOSITIONS.has(record.registryDisposition)) throw fail('CANARY_REGISTRY_SEMANTIC_GAP');
  if (!['NEW', 'DUPLICATE', 'UPDATE'].includes(record.eventState)) throw fail('CANARY_REGISTRY_SEMANTIC_GAP');
  if (record.scoreStatus !== 'SCORE_NOT_EVALUATED' || record.scoreReason !== 'SCORE_INPUT_INCOMPLETE') throw fail('CANARY_SCORE_BOUNDARY_VIOLATION');
  if (FORBIDDEN_EVALUATED_FIELDS.some((field) => Object.hasOwn(record, field))) throw fail('CANARY_SCORE_BOUNDARY_VIOLATION');
  for (const key of required) if (typeof record[key] !== 'string' || !record[key]) throw fail('CANARY_RECORD_INVALID', `Canary Registry record field ${key} must be a non-empty string.`);
  if (!/^https:\/\//.test(record.sourceUrl) || !Number.isFinite(Date.parse(record.observedAt)) || !Number.isFinite(Date.parse(record.createdAt))) throw fail('CANARY_RECORD_INVALID');
  if (!record.identityProvenance || !['entity', 'canonicalEventType', 'eventIdentifier'].every((key) => record.identityProvenance[key]?.value && record.identityProvenance[key]?.authority && record.identityProvenance[key]?.evidenceRef === record.evidenceReference)) throw fail('CANARY_RECORD_INVALID');
  return record;
}

function identityEvidence(candidate) {
  if (!candidate || candidate.radar !== 'DEV' || candidate.sourceName !== CANARY_SOURCE_NAME) {
    throw fail('CANARY_SOURCE_NOT_ALLOWED');
  }
  if (candidate.sourceAuthority !== 'official' || candidate.sourceLevel !== 'official' || !candidate.itemUrl || !candidate.title || !candidate.observedAt) {
    throw fail('CANARY_EVIDENCE_INVALID');
  }
  const record = candidate.rawSourceMetadata?.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw fail('CANARY_EVIDENCE_INVALID');
  const resolved = resolveClaudeCodeChangelogIdentity(candidate);
  if (resolved.status !== 'IDENTITY_READY') throw fail('CANARY_IDENTITY_INVALID', resolved.reasonCode);
  return { eventKey: resolved.eventKey, eventIdentifier: resolved.eventIdentifier, identityProvenance: resolved.identityProvenance, resolved };
}

function evidenceCommitRequest(candidate, identity) {
  const raw = {
    sourceName: candidate.sourceName,
    title: candidate.title,
    sourceUrl: candidate.itemUrl,
    ...(candidate.publishedAt ? { sourcePublishedAt: candidate.publishedAt } : {}),
    entity: 'claude-code', canonicalEventType: 'version-update', eventIdentifier: identity.eventIdentifier,
    eventFacts: {},
  };
  const prepared = prepareEvidenceCommit(raw, { radar: 'dev', observedAt: candidate.observedAt });
  if (!prepared.registryEligible || !prepared.commitRequest) throw fail('CANARY_EVIDENCE_INVALID', (prepared.errors ?? []).map((row) => row.code).join(','));
  if (prepared.eventKey !== identity.eventKey) throw fail('CANARY_IDENTITY_INVALID');
  return prepared.commitRequest;
}

function recordPathKey(runId, recordId) { return sha256(`${runId}\0${recordId}`); }

export class RegistryOnlyCanary {
  constructor({ enabled = false, stateDir = DEFAULT_CANARY_REGISTRY_DIR, productionStateDir = DEFAULT_PRODUCTION_REGISTRY_DIR, killSwitch = () => process.env.HORIZON_CANARY_KILL_SWITCH === '1', clock = () => new Date(), registryRuntime = {}, testFailurePoint } = {}) {
    if (typeof stateDir !== 'string' || !stateDir.trim() || typeof productionStateDir !== 'string' || !productionStateDir.trim()) throw fail('CANARY_REGISTRY_PATH_REQUIRED');
    this.enabled = enabled === true;
    this.stateDir = resolve(stateDir);
    this.productionStateDir = resolve(productionStateDir);
    this.killSwitch = killSwitch;
    this.clock = clock;
    this.registryRuntime = registryRuntime;
    this.testFailurePoint = testFailurePoint;
    this.initialized = false;
  }

  async initialize() {
    const paths = await assertPhysicalIsolation(this.stateDir, this.productionStateDir);
    this.stateDir = paths.canary;
    if (!this.initialized) {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const storeStat = await lstat(this.stateDir);
      if (!storeStat.isDirectory() || storeStat.isSymbolicLink() || (storeStat.mode & 0o077) !== 0) throw fail('CANARY_STORE_PERMISSIONS_UNSAFE');
      const checked = await assertPhysicalIsolation(this.stateDir, this.productionStateDir);
      if (checked.canary !== this.stateDir) throw fail('CANARY_REGISTRY_PATH_COLLISION');
      await assertNoSymlinks(this.stateDir);
      const markerPath = join(this.stateDir, CANARY_STORE_MARKER);
      const marker = await readFile(markerPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (marker && !marker.equals(Buffer.from(STORE_MARKER))) throw fail('CANARY_STORE_MARKER_INVALID');
      if (!marker) {
        await writeFile(markerPath, STORE_MARKER, { flag: 'wx', mode: 0o600 }).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
        const written = await readFile(markerPath);
        if (!written.equals(Buffer.from(STORE_MARKER))) throw fail('CANARY_STORE_MARKER_INVALID');
      }
      this.initialized = true;
    }
    return this.stateDir;
  }

  assertEnabled() {
    if (!this.enabled || this.killSwitch()) throw fail('CANARY_DISABLED');
  }

  disable() { this.enabled = false; }

  async commit(input = {}) {
    const { candidate, identity, runId, recordId, observationId } = input;
    this.assertEnabled();
    if (containsForbiddenFields(input)) throw fail('CANARY_SCORE_BOUNDARY_VIOLATION', 'Score, signal, action, and publication outputs are forbidden on this path.');
    if (typeof runId !== 'string' || !runId.trim() || typeof recordId !== 'string' || !recordId.trim()) throw fail('CANARY_RECORD_ID_REQUIRED');
    const resolved = identityEvidence(candidate);
    if (!identity || identity.status !== 'IDENTITY_READY' || !isDeepStrictEqual(identity, resolved.resolved)) throw fail('CANARY_IDENTITY_INVALID');
    const request = evidenceCommitRequest(candidate, resolved);
    if (observationId !== undefined && observationId !== request.observation.observationId) throw fail('CANARY_OBSERVATION_ID_INVALID');
    await this.initialize();
    await assertNoSymlinks(this.stateDir);
    const requestDigest = sha256(JSON.stringify({ eventKey: request.eventKey, observationId: request.observation.observationId, sourceUrl: request.observation.sourceUrl, observedAt: request.observation.observedAt, identity: resolved.identityProvenance }));
    const transactionId = `canary-${recordPathKey(runId, recordId).slice(0, 32)}`;
    const lock = await acquireRegistryLock(this.stateDir, transactionId, this.registryRuntime);
    const workRoot = join(this.stateDir, '.work', randomUUID());
    try {
      await clearUncommittedWork(this.stateDir);
      const state = await this.loadState();
      const prior = state.records.find((row) => row.runId === runId && row.recordId === recordId);
      if (prior) {
        validateCanaryRecord(prior);
        if (prior.requestDigest !== requestDigest) throw fail('CANARY_RECORD_ID_CONFLICT');
        return { record: prior, idempotentReplay: true, productionRegistryReads: 0, productionRegistryWrites: 0, publisherCalls: 0, deploymentCalls: 0 };
      }
      if (this.testFailurePoint === 'before-registry-commit') throw fail('CANARY_STORE_WRITE_FAILED');
      const registryDir = join(workRoot, REGISTRY_DIR);
      await mkdir(registryDir, { recursive: true, mode: 0o700 });
      await writeFile(join(registryDir, 'radar-event-registry.jsonl'), registryJsonlBytes(state.events, 'eventKey'), { flag: 'wx', mode: 0o600 });
      await writeFile(join(registryDir, 'radar-observation-registry.jsonl'), registryJsonlBytes(state.observations, 'observationId'), { flag: 'wx', mode: 0o600 });
      const layer = new RegistryLayer({ ...this.registryRuntime, stateDir: registryDir });
      const committed = await layer.commitObservation(request);
      const pair = await layer.transactions.readPair();
      const registryDisposition = committed.eventCreated ? 'NEW_EVENT' : committed.observationCreated ? 'NEW_OBSERVATION' : 'DUPLICATE_OBSERVATION';
      if (!VALID_DISPOSITIONS.has(registryDisposition)) throw fail('CANARY_REGISTRY_SEMANTIC_GAP');
      const record = validateCanaryRecord({
        canaryMode: CANARY_MODE,
        registryMode: CANARY_REGISTRY_MODE,
        registryNamespace: CANARY_NAMESPACE,
        sourceId: CANARY_SOURCE_ID,
        radar: 'DEV',
        runId,
        recordId,
        eventKey: committed.eventKey,
        observationId: committed.observationId,
        canonicalEntity: resolved.identityProvenance.entity.value,
        canonicalEventType: resolved.identityProvenance.canonicalEventType.value,
        stableEventIdentifier: resolved.eventIdentifier,
        sourceUrl: candidate.itemUrl,
        observedAt: candidate.observedAt,
        identityProvenanceReference: `${STATE_FILE}#records/${recordPathKey(runId, recordId)}/identityProvenance`,
        evidenceReference: candidate.itemUrl,
        identityProvenance: resolved.identityProvenance,
        registryDisposition,
        eventState: committed.eventState,
        scoreStatus: 'SCORE_NOT_EVALUATED',
        scoreReason: 'SCORE_INPUT_INCOMPLETE',
        createdAt: this.clock().toISOString(),
        requestDigest,
      });
      if (this.testFailurePoint === 'before-state-commit') throw fail('CANARY_STORE_WRITE_FAILED');
      const nextState = sealState({ storeVersion: 1, canaryMode: CANARY_MODE, registryMode: CANARY_REGISTRY_MODE, registryNamespace: CANARY_NAMESPACE, sourceId: CANARY_SOURCE_ID, events: pair.events, observations: pair.observations, records: [...state.records, record] });
      const validation = validateRegistryPair({ events: nextState.events, observations: nextState.observations });
      if (!validation.valid) throw fail('CANARY_REGISTRY_SEMANTIC_GAP');
      await atomicReplace(join(this.stateDir, STATE_FILE), Buffer.from(`${JSON.stringify(nextState, null, 2)}\n`));
      return { record, idempotentReplay: false, productionRegistryReads: 0, productionRegistryWrites: 0, publisherCalls: 0, deploymentCalls: 0 };
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
      await lock.release();
    }
  }

  async loadState() {
    const bytes = await readFile(join(this.stateDir, STATE_FILE)).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!bytes) return sealState({ storeVersion: 1, canaryMode: CANARY_MODE, registryMode: CANARY_REGISTRY_MODE, registryNamespace: CANARY_NAMESPACE, sourceId: CANARY_SOURCE_ID, events: [], observations: [], records: [] });
    let state;
    try { state = JSON.parse(bytes.toString('utf8')); } catch { throw fail('CANARY_STORE_CORRUPT'); }
    if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).sort().join(',') !== ['canaryMode', 'events', 'observations', 'payloadSha256', 'records', 'registryMode', 'registryNamespace', 'sourceId', 'storeVersion'].sort().join(',') || state.storeVersion !== 1 || state.canaryMode !== CANARY_MODE || state.registryMode !== CANARY_REGISTRY_MODE || state.registryNamespace !== CANARY_NAMESPACE || state.sourceId !== CANARY_SOURCE_ID || !Array.isArray(state.records)) throw fail('CANARY_STORE_CORRUPT');
    const { payloadSha256, ...payload } = state;
    if (payloadSha256 !== sha256(JSON.stringify(payload))) throw fail('CANARY_STORE_CORRUPT', 'Canary state checksum mismatch.');
    const result = validateRegistryPair({ events: state.events, observations: state.observations });
    if (!result.valid) throw fail('CANARY_STORE_CORRUPT', result.errors.map(({ code }) => code).join(','));
    state.records.forEach(validateCanaryRecord);
    if (new Set(state.records.map((row) => `${row.runId}\0${row.recordId}`)).size !== state.records.length) throw fail('CANARY_STORE_CORRUPT');
    return state;
  }

  async readPair() {
    this.assertEnabled();
    await this.initialize();
    await assertNoSymlinks(this.stateDir);
    const state = await this.loadState();
    return { events: state.events, observations: state.observations };
  }

  async listCanaryRecords() {
    this.assertEnabled();
    await this.initialize();
    await assertNoSymlinks(this.stateDir);
    return (await this.loadState()).records;
  }

  async reset() {
    if (basename(this.stateDir) !== CANARY_NAMESPACE) throw fail('CANARY_RESET_REFUSED_UNSAFE_PATH');
    const paths = await assertPhysicalIsolation(this.stateDir, this.productionStateDir);
    const markerPath = join(paths.canary, CANARY_STORE_MARKER);
    const marker = await readFile(markerPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!marker || !marker.equals(Buffer.from(STORE_MARKER))) throw fail('CANARY_RESET_REFUSED_UNOWNED_STORE');
    await assertNoSymlinks(paths.canary);
    this.enabled = false;
    const transactionId = `canary-reset-${randomUUID()}`;
    const lock = await acquireRegistryLock(paths.canary, transactionId, this.registryRuntime);
    try {
      await assertNoSymlinks(paths.canary);
      const currentMarker = await readFile(markerPath);
      if (!currentMarker.equals(Buffer.from(STORE_MARKER))) throw fail('CANARY_STORE_MARKER_INVALID');
      await clearUncommittedWork(paths.canary);
      const emptyState = sealState({ storeVersion: 1, canaryMode: CANARY_MODE, registryMode: CANARY_REGISTRY_MODE, registryNamespace: CANARY_NAMESPACE, sourceId: CANARY_SOURCE_ID, events: [], observations: [], records: [] });
      await atomicReplace(join(paths.canary, STATE_FILE), Buffer.from(`${JSON.stringify(emptyState, null, 2)}\n`));
    } finally { await lock.release(); }
    return { reset: true, productionRegistryReads: 0, productionRegistryWrites: 0, v1Mutations: 0 };
  }
}

export function createRegistryOnlyCanary(options = {}) { return new RegistryOnlyCanary(options); }

export const canaryStoreContract = Object.freeze({
  canaryMode: CANARY_MODE,
  registryMode: CANARY_REGISTRY_MODE,
  registryNamespace: CANARY_NAMESPACE,
  sourceId: CANARY_SOURCE_ID,
  defaultRegistryDir: DEFAULT_CANARY_REGISTRY_DIR,
  productionRegistryDir: DEFAULT_PRODUCTION_REGISTRY_DIR,
  allowedDispositions: [...VALID_DISPOSITIONS],
  scoreStatus: 'SCORE_NOT_EVALUATED',
  scoreReason: 'SCORE_INPUT_INCOMPLETE',
});
