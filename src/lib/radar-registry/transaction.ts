import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { buildObservationIdentity } from '../radar-observation-identity.mjs';
import { buildEventKey } from '../radar-event-identity.mjs';
import { materializeEvent } from './event-registry.ts';
import { materializeObservation } from './observation-registry.ts';
import { acquireRegistryLock, type RegistryRuntime } from './lock.ts';
import { addQuarantinePath, preserveCorruptionEvidence, type CorruptionEvidenceFile } from './quarantine.ts';
import { createSnapshot, fsyncDirectory, fsyncFile, verifySnapshotPair } from './snapshot.ts';
import { registryPairFromJsonl, validateRegistryPair } from './validator.ts';
import type { AtomicObservationCommitInput, AtomicObservationCommitResult, EventEngineOutput, EventRegistryRecord, ObservationInput, ObservationRegistryRecord, RegistryEventState, RegistryPair } from './types.ts';

const EVENT_FILE = 'radar-event-registry.jsonl';
const OBSERVATION_FILE = 'radar-observation-registry.jsonl';
const JOURNAL_FILE = 'radar-registry-transaction.json';
const STAGING_DIR = 'radar-registry-staging';
const SNAPSHOT_DIR = 'radar-registry-snapshots';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const absentHash = sha256(Buffer.from('HORIZON_REGISTRY_FILE_ABSENT', 'utf8'));

export interface RegistryTransactionJournal {
  transactionId: string;
  state: 'PREPARED' | 'COMMITTED';
  eventTempPath: string;
  eventFinalPath: string;
  eventTempSha256: string;
  eventFinalSha256: string;
  eventOldSha256: string;
  observationTempPath: string;
  observationFinalPath: string;
  observationTempSha256: string;
  observationFinalSha256: string;
  observationOldSha256: string;
  createdAt: string;
  committedAt?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function registryBytes<T extends EventRegistryRecord | ObservationRegistryRecord>(rows: T[], key: 'eventKey' | 'observationId'): Buffer {
  const ordered = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  return Buffer.from(ordered.map((row) => `${canonicalJson(row)}\n`).join(''), 'utf8');
}

async function readBytesIfExists(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function currentHash(path: string): Promise<string> {
  const bytes = await readBytesIfExists(path);
  return bytes ? sha256(bytes) : absentHash;
}

async function writeSynced(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeSynced(temporary, bytes);
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

async function readJournal(stateDir: string): Promise<RegistryTransactionJournal | undefined> {
  const bytes = await readBytesIfExists(join(stateDir, JOURNAL_FILE));
  if (!bytes) return undefined;
  try { return JSON.parse(bytes.toString('utf8')) as RegistryTransactionJournal; }
  catch (cause) { throw Object.assign(new Error('Registry transaction journal is corrupt.', { cause }), { code: 'REGISTRY_JOURNAL_INVALID', journalBytes: bytes }); }
}

async function directoryEvidence(stateDir: string, directoryName: string, rolePrefix: string): Promise<{ present: boolean; paths: string[]; files: CorruptionEvidenceFile[] }> {
  const root = join(stateDir, directoryName);
  const paths: string[] = [];
  const files: CorruptionEvidenceFile[] = [];
  async function walk(path: string, relative: string): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      const childRelative = relative ? join(relative, entry.name) : entry.name;
      paths.push(child);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) files.push({ role: `${rolePrefix}:${childRelative}`, originalPath: child, present: true, bytes: await readFile(child) });
      else files.push({ role: `${rolePrefix}:${childRelative}`, originalPath: child, present: true });
    }
  }
  await walk(root, '');
  return { present: files.length > 0, paths, files };
}

async function loadPairUnlocked(stateDir: string, runtime: RegistryRuntime = {}): Promise<RegistryPair> {
  const eventPath = join(stateDir, EVENT_FILE);
  const observationPath = join(stateDir, OBSERVATION_FILE);
  const [eventBytes, observationBytes] = await Promise.all([readBytesIfExists(eventPath), readBytesIfExists(observationPath)]);
  const evidenceFiles: CorruptionEvidenceFile[] = [
    { role: 'event-registry', originalPath: eventPath, present: eventBytes !== undefined, ...(eventBytes ? { bytes: eventBytes } : {}) },
    { role: 'observation-registry', originalPath: observationPath, present: observationBytes !== undefined, ...(observationBytes ? { bytes: observationBytes } : {}) },
  ];
  if (!eventBytes && !observationBytes) {
    const [staging, snapshots] = await Promise.all([
      directoryEvidence(stateDir, STAGING_DIR, 'staging'),
      directoryEvidence(stateDir, SNAPSHOT_DIR, 'snapshot'),
    ]);
    if (!staging.present && !snapshots.present) return { events: [], observations: [] };
    const error = Object.assign(new Error('Both Registry files are absent although prior Registry state exists.'), { code: 'REGISTRY_PAIR_MISSING' });
    const quarantinePath = await preserveCorruptionEvidence(stateDir, {
      failureClass: staging.present ? 'PARTIAL_TRANSACTION_STATE' : 'REGISTRY_FILE_MISSING',
      errorCode: error.code,
      failureReason: error.message,
      evidenceFiles: [...evidenceFiles, ...staging.files],
      metadata: { priorStateMarkers: [...staging.paths, ...snapshots.paths] },
    }, runtime);
    throw addQuarantinePath(error, quarantinePath);
  }
  if (!eventBytes || !observationBytes) {
    const error = Object.assign(new Error('Only one Registry file exists; pair is incomplete.'), { code: 'REGISTRY_PAIR_INCOMPLETE' });
    const quarantinePath = await preserveCorruptionEvidence(stateDir, {
      failureClass: 'REGISTRY_FILE_MISSING', errorCode: error.code, failureReason: error.message, evidenceFiles,
    }, runtime);
    throw addQuarantinePath(error, quarantinePath);
  }
  let pair: RegistryPair;
  try { pair = registryPairFromJsonl(eventBytes, observationBytes); }
  catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    const errorCode = String((error as NodeJS.ErrnoException).code ?? 'REGISTRY_JSONL_INVALID');
    const failureClass = errorCode === 'REGISTRY_JSONL_TRUNCATED' ? 'TRUNCATED_JSONL' : 'MALFORMED_JSONL';
    const quarantinePath = await preserveCorruptionEvidence(stateDir, { failureClass, errorCode, failureReason: error.message, evidenceFiles }, runtime);
    throw addQuarantinePath(error, quarantinePath);
  }
  const result = validateRegistryPair(pair);
  if (!result.valid) {
    const error = Object.assign(new Error(`Registry validation failed: ${result.errors.map(({ code }) => code).join(',')}`), { code: 'REGISTRY_VALIDATION_FAILED', details: result.errors });
    const quarantinePath = await preserveCorruptionEvidence(stateDir, {
      failureClass: 'REGISTRY_VALIDATION_FAILED', errorCode: error.code, failureReason: error.message, evidenceFiles,
      metadata: { validationErrors: result.errors },
    }, runtime);
    throw addQuarantinePath(error, quarantinePath);
  }
  return pair;
}

function ensureSafeJournalPaths(stateDir: string, journal: RegistryTransactionJournal): void {
  const stagingRoot = resolve(stateDir, STAGING_DIR) + sep;
  for (const path of [journal.eventTempPath, journal.observationTempPath]) {
    if (!resolve(path).startsWith(stagingRoot)) throw Object.assign(new Error('Transaction journal staging path escapes state directory.'), { code: 'REGISTRY_JOURNAL_PATH_INVALID' });
  }
  if (resolve(journal.eventFinalPath) !== resolve(stateDir, EVENT_FILE) || resolve(journal.observationFinalPath) !== resolve(stateDir, OBSERVATION_FILE)) {
    throw Object.assign(new Error('Transaction journal destination is not a Registry path.'), { code: 'REGISTRY_JOURNAL_PATH_INVALID' });
  }
}

async function registryPairEvidence(stateDir: string): Promise<CorruptionEvidenceFile[]> {
  return Promise.all([
    EVENT_FILE,
    OBSERVATION_FILE,
  ].map(async (name): Promise<CorruptionEvidenceFile> => {
    const path = join(stateDir, name);
    const bytes = await readBytesIfExists(path);
    return { role: name === EVENT_FILE ? 'event-registry' : 'observation-registry', originalPath: path, present: bytes !== undefined, ...(bytes ? { bytes } : {}) };
  }));
}

async function journalAndPairEvidence(stateDir: string, journalBytes?: Buffer, journal?: RegistryTransactionJournal): Promise<CorruptionEvidenceFile[]> {
  const evidence = await registryPairEvidence(stateDir);
  const journalPath = join(stateDir, JOURNAL_FILE);
  const rawJournal = journalBytes ?? await readBytesIfExists(journalPath);
  evidence.push({ role: 'transaction-journal', originalPath: journalPath, present: rawJournal !== undefined, ...(rawJournal ? { bytes: rawJournal } : {}) });
  if (journal) {
    for (const [role, path] of [['event-staging', journal.eventTempPath], ['observation-staging', journal.observationTempPath]] as const) {
      const bytes = await readBytesIfExists(path);
      evidence.push({ role, originalPath: path, present: bytes !== undefined, ...(bytes ? { bytes } : {}) });
    }
  }
  return evidence;
}

async function quarantineRecoveryFailure(
  stateDir: string,
  runtime: RegistryRuntime,
  error: Error & { code?: string; journalBytes?: Buffer },
  failureClass: string,
  journal?: RegistryTransactionJournal,
  extraFiles: CorruptionEvidenceFile[] = [],
): Promise<never> {
  const evidenceFiles = await journalAndPairEvidence(stateDir, error.journalBytes, journal);
  const knownPaths = new Set(evidenceFiles.map(({ originalPath }) => originalPath));
  evidenceFiles.push(...extraFiles.filter(({ originalPath }) => !knownPaths.has(originalPath)));
  const quarantinePath = await preserveCorruptionEvidence(stateDir, {
    failureClass,
    errorCode: error.code ?? 'REGISTRY_RECOVERY_FAILED',
    failureReason: error.message,
    evidenceFiles,
    metadata: { transactionId: journal?.transactionId ?? null, journalState: journal?.state ?? null },
  }, runtime);
  throw addQuarantinePath(error, quarantinePath);
}

async function quarantineTransaction(
  stateDir: string,
  journalPath: string,
  journal: RegistryTransactionJournal,
  failureReason = `Registry transaction ${journal.transactionId} cannot be recovered safely; evidence preserved.`,
  failureMetadata: Record<string, unknown> = {},
): Promise<never> {
  const pathRoles: Array<[string, string]> = [
    ['transaction-journal', journalPath],
    ['event-staging', journal.eventTempPath],
    ['observation-staging', journal.observationTempPath],
    ['event-registry', journal.eventFinalPath],
    ['observation-registry', journal.observationFinalPath],
  ];
  const evidenceFiles = await Promise.all(pathRoles.map(async ([role, originalPath]): Promise<CorruptionEvidenceFile> => {
    const bytes = await readBytesIfExists(originalPath);
    return { role, originalPath, present: bytes !== undefined, ...(bytes ? { bytes } : {}) };
  }));
  const quarantine = await preserveCorruptionEvidence(stateDir, {
    failureClass: 'TRANSACTION_RECOVERY_CORRUPTION',
    errorCode: 'MANUAL_INTERVENTION',
    failureReason,
    evidenceFiles,
    metadata: {
      transactionId: journal.transactionId,
      journalState: journal.state,
      expectedHashes: {
        eventOldSha256: journal.eventOldSha256,
        eventNewSha256: journal.eventFinalSha256,
        observationOldSha256: journal.observationOldSha256,
        observationNewSha256: journal.observationFinalSha256,
      },
      ...failureMetadata,
    },
  });
  throw Object.assign(new Error(failureReason), { code: 'MANUAL_INTERVENTION', transactionId: journal.transactionId, quarantinePath: quarantine });
}

async function ensureSnapshotForJournal(stateDir: string, journal: RegistryTransactionJournal, runtime: RegistryRuntime): Promise<void> {
  const day = journal.committedAt?.slice(0, 10) ?? journal.createdAt.slice(0, 10);
  const snapshotPath = join(stateDir, SNAPSHOT_DIR, day);
  const existing = await verifySnapshotPair(snapshotPath);
  if (existing.valid && existing.manifest?.transactionId === journal.transactionId) return;
  if (existing.valid && existing.manifest && existing.manifest.transactionId !== journal.transactionId) {
    // A later committed transaction already produced today's latest daily snapshot.
    return;
  }
  const pair = await loadPairUnlocked(stateDir, runtime);
  const eventBytes = await readFile(join(stateDir, EVENT_FILE));
  const observationBytes = await readFile(join(stateDir, OBSERVATION_FILE));
  if (sha256(eventBytes) !== journal.eventFinalSha256 || sha256(observationBytes) !== journal.observationFinalSha256) {
    throw Object.assign(new Error('Committed Registry hashes do not match the journal.'), { code: 'MANUAL_INTERVENTION' });
  }
  const at = runtime.clock?.() ?? new Date(journal.committedAt ?? journal.createdAt);
  await createSnapshot(join(stateDir, SNAPSHOT_DIR), day, journal.transactionId, at.toISOString(), pair, eventBytes, observationBytes);
}

async function recoverUnlocked(stateDir: string, runtime: RegistryRuntime): Promise<'NONE' | 'COMMITTED' | 'RECOVERED' | 'MANUAL_INTERVENTION'> {
  const journalPath = join(stateDir, JOURNAL_FILE);
  let journal: RegistryTransactionJournal | undefined;
  try { journal = await readJournal(stateDir); }
  catch (caught) {
    const error = caught instanceof Error ? caught as Error & { code?: string; journalBytes?: Buffer } : Object.assign(new Error(String(caught)), { code: 'REGISTRY_JOURNAL_INVALID' });
    const extraFiles: CorruptionEvidenceFile[] = error.journalBytes
      ? [{ role: 'transaction-journal', originalPath: journalPath, present: true, bytes: error.journalBytes }]
      : [];
    return await quarantineRecoveryFailure(stateDir, runtime, error, 'INVALID_TRANSACTION_JOURNAL', undefined, extraFiles);
  }
  if (!journal) {
    const staging = await directoryEvidence(stateDir, STAGING_DIR, 'staging');
    if (!staging.present) return 'NONE';
    const error = Object.assign(new Error('Orphan Registry staging exists without a PREPARED transaction journal.'), { code: 'REGISTRY_PARTIAL_TRANSACTION_STATE' });
    return await quarantineRecoveryFailure(stateDir, runtime, error, 'PARTIAL_TRANSACTION_STATE', undefined, staging.files);
  }
  try { ensureSafeJournalPaths(stateDir, journal); }
  catch (caught) {
    const error = caught instanceof Error ? caught as Error & { code?: string; journalBytes?: Buffer } : Object.assign(new Error(String(caught)), { code: 'REGISTRY_JOURNAL_PATH_INVALID' });
    const rawJournal = await readBytesIfExists(journalPath);
    const extra: CorruptionEvidenceFile[] = rawJournal ? [{ role: 'transaction-journal', originalPath: journalPath, present: true, bytes: rawJournal }] : [];
    return await quarantineRecoveryFailure(stateDir, runtime, error, 'INVALID_TRANSACTION_JOURNAL', undefined, extra);
  }
  if (journal.state === 'COMMITTED') {
    const [eventHash, observationHash] = await Promise.all([currentHash(journal.eventFinalPath), currentHash(journal.observationFinalPath)]);
    if (eventHash !== journal.eventFinalSha256 || observationHash !== journal.observationFinalSha256) {
      return await quarantineTransaction(stateDir, journalPath, journal);
    }
    await loadPairUnlocked(stateDir, runtime);
    await ensureSnapshotForJournal(stateDir, journal, runtime);
    return 'COMMITTED';
  }
  if (journal.state !== 'PREPARED') {
    const error = Object.assign(new Error('Unknown registry transaction journal state.'), { code: 'REGISTRY_JOURNAL_INVALID' });
    return await quarantineRecoveryFailure(stateDir, runtime, error, 'INVALID_TRANSACTION_JOURNAL', journal);
  }

  const finalPaths = [journal.eventFinalPath, journal.observationFinalPath];
  const tempPaths = [journal.eventTempPath, journal.observationTempPath];
  const oldHashes = [journal.eventOldSha256, journal.observationOldSha256];
  const newHashes = [journal.eventFinalSha256, journal.observationFinalSha256];
  const tempHashes = [journal.eventTempSha256, journal.observationTempSha256];
  const finals = await Promise.all(finalPaths.map(currentHash));
  const temps = await Promise.all(tempPaths.map(currentHash));
  for (let index = 0; index < 2; index += 1) {
    if (finals[index] !== oldHashes[index] && finals[index] !== newHashes[index]) return await quarantineTransaction(stateDir, journalPath, journal);
    if (finals[index] !== newHashes[index] && temps[index] !== tempHashes[index]) return await quarantineTransaction(stateDir, journalPath, journal);
    if (tempHashes[index] !== newHashes[index]) return await quarantineTransaction(stateDir, journalPath, journal);
  }
  const proposedEventBytes = finals[0] === newHashes[0] ? await readFile(finalPaths[0]) : await readFile(tempPaths[0]);
  const proposedObservationBytes = finals[1] === newHashes[1] ? await readFile(finalPaths[1]) : await readFile(tempPaths[1]);
  let stagedValidationFailure: { reason: string; metadata: Record<string, unknown> } | undefined;
  try {
    const proposedPair = registryPairFromJsonl(proposedEventBytes, proposedObservationBytes);
    const proposedValidation = validateRegistryPair(proposedPair);
    if (!proposedValidation.valid) {
      stagedValidationFailure = { reason: 'Prepared Registry pair fails semantic validation.', metadata: { validationErrors: proposedValidation.errors } };
    }
  } catch (error) {
    stagedValidationFailure = { reason: error instanceof Error ? error.message : String(error), metadata: { validationCode: (error as NodeJS.ErrnoException).code ?? 'REGISTRY_JSONL_INVALID' } };
  }
  if (stagedValidationFailure) {
    return await quarantineTransaction(stateDir, journalPath, journal, stagedValidationFailure.reason, stagedValidationFailure.metadata);
  }
  for (let index = 0; index < 2; index += 1) {
    if (finals[index] !== newHashes[index]) {
      await rename(tempPaths[index], finalPaths[index]);
      await fsyncFile(finalPaths[index]);
      await fsyncDirectory(stateDir);
    }
  }
  const pair = await loadPairUnlocked(stateDir, runtime);
  const finalEventBytes = await readFile(journal.eventFinalPath);
  const finalObservationBytes = await readFile(journal.observationFinalPath);
  if (sha256(finalEventBytes) !== journal.eventFinalSha256 || sha256(finalObservationBytes) !== journal.observationFinalSha256) return await quarantineTransaction(stateDir, journalPath, journal);
  const committedAt = (runtime.clock?.() ?? new Date()).toISOString();
  await atomicWrite(journalPath, Buffer.from(`${JSON.stringify({ ...journal, state: 'COMMITTED', committedAt })}\n`));
  await ensureSnapshotForJournal(stateDir, { ...journal, state: 'COMMITTED', committedAt }, runtime);
  void pair;
  return 'RECOVERED';
}

export class RegistryTransactionManager {
  readonly stateDir: string;
  private readonly runtime: RegistryRuntime;

  constructor(runtime: RegistryRuntime) {
    if (!runtime.stateDir) throw new TypeError('stateDir must be explicit; production state is never selected implicitly.');
    this.stateDir = resolve(runtime.stateDir);
    this.runtime = runtime;
  }

  async recover(): Promise<string> {
    await mkdir(this.stateDir, { recursive: true });
    const transactionId = this.runtime.transactionIdFactory?.() ?? randomUUID();
    const lock = await acquireRegistryLock(this.stateDir, transactionId, this.runtime);
    try { return await recoverUnlocked(this.stateDir, this.runtime); }
    finally { await lock.release(); }
  }

  async readPair(): Promise<RegistryPair> {
    await mkdir(this.stateDir, { recursive: true });
    const transactionId = this.runtime.transactionIdFactory?.() ?? randomUUID();
    const lock = await acquireRegistryLock(this.stateDir, transactionId, this.runtime);
    try {
      await recoverUnlocked(this.stateDir, this.runtime);
      return await loadPairUnlocked(this.stateDir, this.runtime);
    } finally { await lock.release(); }
  }

  /**
   * Atomic stateful boundary. It resolves Event state only after taking the global lock,
   * recovering pending work, and loading the latest validated Event/Observation pair.
   */
  async commitObservation(input: AtomicObservationCommitInput): Promise<AtomicObservationCommitResult> {
    const transactionId = this.runtime.transactionIdFactory?.() ?? randomUUID();
    await mkdir(this.stateDir, { recursive: true });
    const lock = await acquireRegistryLock(this.stateDir, transactionId, this.runtime);
    try {
      this.failIf('after-lock');
      await recoverUnlocked(this.stateDir, this.runtime);
      const pair = await loadPairUnlocked(this.stateDir, this.runtime);
      this.validateAtomicInput(input);

      const eventKey = buildEventKey(input.eventFacts);
      const observationIdentity = buildObservationIdentity(input.observation);
      const priorEvent = pair.events.find(({ eventKey: currentKey }) => currentKey === eventKey);
      const priorObservation = pair.observations.find(({ observationId }) => observationId === observationIdentity.observationId);
      const eventState: RegistryEventState = !priorEvent ? 'NEW'
        : priorEvent.canonicalEventType === input.eventFacts.canonicalEventType
          && priorEvent.latestFingerprint === input.fingerprint ? 'DUPLICATE' : 'UPDATE';
      const duplicate = eventState === 'DUPLICATE';
      const materialChange = eventState === 'UPDATE';
      const now = (this.runtime.clock?.() ?? new Date()).toISOString();
      const observationResult = materializeObservation(input.observation, priorObservation, now);
      const observations = pair.observations.filter(({ observationId }) => observationId !== observationIdentity.observationId);
      observations.push(observationResult.observation);
      const engineOutput: EventEngineOutput = {
        eventKey,
        entity: input.eventFacts.entity,
        canonicalEventType: input.eventFacts.canonicalEventType,
        fingerprint: input.fingerprint,
        eventState,
        duplicate,
        materialChange,
      };
      const event = materializeEvent(engineOutput, observations, priorEvent, now, input.observation.observedAt);
      const events = pair.events.filter(({ eventKey: currentKey }) => currentKey !== eventKey);
      events.push(event);
      const nextPair = {
        events: events.sort((a, b) => a.eventKey.localeCompare(b.eventKey)),
        observations: observations.sort((a, b) => a.observationId.localeCompare(b.observationId)),
      };
      await this.persistPair(nextPair, transactionId, now);
      return {
        eventKey,
        observationId: observationIdentity.observationId,
        eventState,
        duplicate,
        materialChange,
        observationCreated: observationResult.inserted,
        eventCreated: priorEvent === undefined,
        eventUpdated: eventState === 'UPDATE',
        occurrences: event.occurrences,
        transactionId,
        registryWriteStatus: 'COMMITTED',
        event,
        observation: observationResult.observation,
      };
    } finally { await lock.release(); }
  }

  /** LEGACY / NON-PRODUCTION: caller-supplied Event state is persisted as provided. */
  async commitCandidate(engineOutput: EventEngineOutput, input: ObservationInput): Promise<{ event: EventRegistryRecord; observation: ObservationRegistryRecord; transactionId: string }> {
      const transactionId = this.runtime.transactionIdFactory?.() ?? randomUUID();
      await mkdir(this.stateDir, { recursive: true });
      const lock = await acquireRegistryLock(this.stateDir, transactionId, this.runtime);
      try {
      await recoverUnlocked(this.stateDir, this.runtime);
      const pair = await loadPairUnlocked(this.stateDir, this.runtime);
      if (engineOutput.eventKey !== input.eventKey) throw Object.assign(new Error('Event and Observation eventKey must match.'), { code: 'REGISTRY_CANDIDATE_EVENT_KEY_MISMATCH' });
      const identity = buildObservationIdentity(input);
      const now = (this.runtime.clock?.() ?? new Date()).toISOString();
      const priorObservation = pair.observations.find(({ observationId }) => observationId === identity.observationId);
      const observationResult = materializeObservation(input, priorObservation, now);
      const observations = pair.observations.filter(({ observationId }) => observationId !== identity.observationId);
      observations.push(observationResult.observation);
      const priorEvent = pair.events.find(({ eventKey }) => eventKey === engineOutput.eventKey);
      const event = materializeEvent(engineOutput, observations, priorEvent, now, input.observedAt);
      const events = pair.events.filter(({ eventKey }) => eventKey !== event.eventKey);
      events.push(event);
      const nextPair = { events: events.sort((a, b) => a.eventKey.localeCompare(b.eventKey)), observations: observations.sort((a, b) => a.observationId.localeCompare(b.observationId)) };
      await this.persistPair(nextPair, transactionId, now);
      return { event, observation: observationResult.observation, transactionId };
    } finally { await lock.release(); }
  }

  private validateAtomicInput(input: AtomicObservationCommitInput): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new TypeError('Atomic Registry input must be an object.'), { code: 'REGISTRY_ATOMIC_INPUT_INVALID' });
    const forbidden = ['eventState', 'duplicate', 'materialChange'];
    if (forbidden.some((field) => Object.hasOwn(input as object, field))
      || (input.eventFacts && forbidden.some((field) => Object.hasOwn(input.eventFacts as object, field)))) {
      throw Object.assign(new TypeError('Caller-provided Event state is forbidden on the atomic Registry API.'), { code: 'REGISTRY_CALLER_STATE_FORBIDDEN' });
    }
    const allowedInputFields = new Set(['eventKey', 'eventFacts', 'fingerprint', 'observation']);
    if (Object.keys(input).some((field) => !allowedInputFields.has(field))) {
      throw Object.assign(new TypeError('Atomic Registry input contains unsupported fields.'), { code: 'REGISTRY_ATOMIC_INPUT_INVALID' });
    }
    if (!input.eventFacts || typeof input.eventFacts !== 'object' || Array.isArray(input.eventFacts)) {
      throw Object.assign(new TypeError('Event identity facts are required.'), { code: 'REGISTRY_ATOMIC_INPUT_INVALID' });
    }
    const allowedEventFactFields = new Set(['entity', 'canonicalEventType', 'eventIdentifier']);
    if (Object.keys(input.eventFacts).some((field) => !allowedEventFactFields.has(field))) {
      throw Object.assign(new TypeError('Event identity facts contain unsupported fields.'), { code: 'REGISTRY_ATOMIC_INPUT_INVALID' });
    }
    let derivedKey: string;
    try { derivedKey = buildEventKey(input.eventFacts); }
    catch (error) { throw Object.assign(new TypeError(`Invalid Event identity facts: ${error instanceof Error ? error.message : String(error)}`), { code: 'REGISTRY_ATOMIC_EVENT_IDENTITY_INVALID' }); }
    if (input.eventKey !== derivedKey || input.observation?.eventKey !== derivedKey) {
      throw Object.assign(new Error('eventKey must match Event identity facts and Observation eventKey.'), { code: 'REGISTRY_ATOMIC_EVENT_KEY_MISMATCH' });
    }
    if (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(input.fingerprint)) {
      throw Object.assign(new TypeError('fingerprint must be a 16-character lowercase SHA-256 digest.'), { code: 'REGISTRY_ATOMIC_FINGERPRINT_INVALID' });
    }
    try { buildObservationIdentity(input.observation); }
    catch (error) { throw Object.assign(new TypeError(`Invalid Observation input: ${error instanceof Error ? error.message : String(error)}`), { code: 'REGISTRY_ATOMIC_OBSERVATION_INVALID' }); }
  }

  private async persistPair(nextPair: RegistryPair, transactionId: string, now: string): Promise<void> {
    const validation = validateRegistryPair(nextPair);
    if (!validation.valid) throw Object.assign(new Error(`Candidate would produce invalid Registry pair: ${validation.errors.map(({ code }) => code).join(',')}`), { code: 'REGISTRY_VALIDATION_FAILED', details: validation.errors });
    const eventBytes = registryBytes(nextPair.events, 'eventKey');
    const observationBytes = registryBytes(nextPair.observations, 'observationId');
    const staging = join(this.stateDir, STAGING_DIR, transactionId);
    await mkdir(staging, { recursive: true });
    const eventTempPath = join(staging, 'events.next.jsonl');
    const observationTempPath = join(staging, 'observations.next.jsonl');
    try {
      await writeSynced(eventTempPath, eventBytes);
      this.failIf('after-event-temp-write');
      await writeSynced(observationTempPath, observationBytes);
      await fsyncDirectory(staging);
      this.failIf('after-observation-temp-write');
      const eventFinalPath = join(this.stateDir, EVENT_FILE);
      const observationFinalPath = join(this.stateDir, OBSERVATION_FILE);
      const journal: RegistryTransactionJournal = {
        transactionId,
        state: 'PREPARED',
        eventTempPath,
        eventFinalPath,
        eventTempSha256: sha256(eventBytes),
        eventFinalSha256: sha256(eventBytes),
        eventOldSha256: await currentHash(eventFinalPath),
        observationTempPath,
        observationFinalPath,
        observationTempSha256: sha256(observationBytes),
        observationFinalSha256: sha256(observationBytes),
        observationOldSha256: await currentHash(observationFinalPath),
        createdAt: now,
      };
      const journalPath = join(this.stateDir, JOURNAL_FILE);
      await atomicWrite(journalPath, Buffer.from(`${JSON.stringify(journal)}\n`));
      this.failIf('after-prepare');
      await rename(eventTempPath, eventFinalPath);
      await fsyncFile(eventFinalPath); await fsyncDirectory(this.stateDir);
      this.failIf('after-event-rename');
      await rename(observationTempPath, observationFinalPath);
      await fsyncFile(observationFinalPath); await fsyncDirectory(this.stateDir);
      this.failIf('after-observation-rename');
      const committedPair = await loadPairUnlocked(this.stateDir, this.runtime);
      const [committedEventBytes, committedObservationBytes] = await Promise.all([readFile(eventFinalPath), readFile(observationFinalPath)]);
      if (sha256(committedEventBytes) !== journal.eventFinalSha256 || sha256(committedObservationBytes) !== journal.observationFinalSha256) {
        throw Object.assign(new Error('Registry pair hashes do not match the prepared transaction.'), { code: 'REGISTRY_TRANSACTION_HASH_MISMATCH' });
      }
      this.failIf('before-committed');
      const committedAt = (this.runtime.clock?.() ?? new Date()).toISOString();
      await atomicWrite(journalPath, Buffer.from(`${JSON.stringify({ ...journal, state: 'COMMITTED', committedAt })}\n`));
      this.failIf('after-committed-before-snapshot');
      await createSnapshot(join(this.stateDir, SNAPSHOT_DIR), committedAt.slice(0, 10), transactionId, committedAt, committedPair, committedEventBytes, committedObservationBytes);
    } catch (error) {
      const journal = await readJournal(this.stateDir);
      if (!journal || journal.transactionId !== transactionId) await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private failIf(point: RegistryRuntime['failurePoint']): void {
    if (point && this.runtime.failurePoint === point) {
      throw Object.assign(new Error(`Injected transaction failure at ${point}.`), { code: 'REGISTRY_FAILURE_INJECTED', point });
    }
  }
}

export async function canonicalRegistryHashes(stateDir: string): Promise<{ eventSha256: string; observationSha256: string }> {
  const manager = new RegistryTransactionManager({ stateDir });
  const pair = await manager.readPair();
  const { canonicalRegistryBytes } = await import('./validator.ts');
  return {
    eventSha256: sha256(canonicalRegistryBytes(pair.events, 'eventKey')),
    observationSha256: sha256(canonicalRegistryBytes(pair.observations, 'observationId')),
  };
}
