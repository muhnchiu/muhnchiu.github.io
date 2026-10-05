import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { adaptProductionCandidate } from '../radar-candidate-adapter/adapters.ts';
import { prepareEvidenceCommit } from '../radar-evidence-pipeline.mjs';
import { resolveClaudeCodeChangelogIdentity, CLAUDE_CODE_SOURCE_IDENTIFIER } from '../radar-canary/claude-code-identity.mjs';
import { resolveArxivCsLgIdentity, ARXIV_SOURCE_IDENTIFIER } from '../radar-canary/arxiv-identity.mjs';
import { resolveNvdIdentity, NVD_SOURCE_IDENTIFIER } from '../radar-canary/nvd-identity.mjs';
import { RegistryLayer, canonicalRegistryBytes, registryPairFromJsonl, validateRegistryPair } from '../radar-registry/index.ts';
import { preserveCorruptionEvidence } from '../radar-registry/quarantine.ts';

export const PRODUCTION_IDENTITY_MODE = 'PRODUCTION_IDENTITY_REGISTRY';
export const PRODUCTION_REGISTRY_NAMESPACE = 'radar-v2-prod-identity-dev-claude-code';
export const ARXIV_PRODUCTION_REGISTRY_NAMESPACE = 'radar-v2-prod-identity-ai-arxiv-cs-lg';
export const NVD_PRODUCTION_REGISTRY_NAMESPACE = 'radar-v2-prod-identity-sec-nvd';
export const PRODUCTION_SOURCE_ALLOWLIST = Object.freeze([
  Object.freeze({ radar: 'DEV', sourceName: 'Claude Code Changelog', sourceIdentifier: CLAUDE_CODE_SOURCE_IDENTIFIER, registryNamespace: PRODUCTION_REGISTRY_NAMESPACE }),
  Object.freeze({ radar: 'AI', sourceName: 'arXiv cs.LG', sourceIdentifier: ARXIV_SOURCE_IDENTIFIER, registryNamespace: ARXIV_PRODUCTION_REGISTRY_NAMESPACE }),
  Object.freeze({ radar: 'SEC', sourceName: 'NVD', sourceIdentifier: NVD_SOURCE_IDENTIFIER, registryNamespace: NVD_PRODUCTION_REGISTRY_NAMESPACE }),
]);
export const DEFAULT_PRODUCTION_REGISTRY_DIR = join(homedir(), '.local', 'state', 'horizon-production', PRODUCTION_REGISTRY_NAMESPACE);
export const DEFAULT_ARXIV_PRODUCTION_REGISTRY_DIR = join(homedir(), '.local', 'state', 'horizon-production', ARXIV_PRODUCTION_REGISTRY_NAMESPACE);
export const DEFAULT_NVD_PRODUCTION_REGISTRY_DIR = join(homedir(), '.local', 'state', 'horizon-production', NVD_PRODUCTION_REGISTRY_NAMESPACE);
export const DEFAULT_CANARY_REGISTRY_DIR = join(homedir(), '.local', 'state', 'horizon-canary', 'radar-v2-canary-dev-claude-code');
export const DEFAULT_V1_CONTENT_DIR = fileURLToPath(new URL('../../content/radar', import.meta.url));
export const PRODUCTION_STORE_MARKER = '.horizon-production-registry-v1.json';
export const SCORE_DEBT_MODE = Object.freeze({ score: 'NOT_EVALUATED', scoreReason: 'SCORE_INPUT_INCOMPLETE', action: 'NOT_EVALUATED', publication: 'NOT_AUTHORIZED' });

const CONTRACT_PIN = '5ac615eda0de0b0fa1d2cc398309fc2657bacc49';
const POLICY_DISTRIBUTION_PIN = 'f01683ad960663267361f5a5519ddbc7095d6543';
function markerBytesFor(registryNamespace) {
  const authorization = PRODUCTION_SOURCE_ALLOWLIST.find((row) => row.registryNamespace === registryNamespace);
  if (!authorization) throw fail('PRODUCTION_REGISTRY_NAMESPACE_REQUIRED');
  const payload = {
  storeVersion: 1,
  registryMode: 'PRODUCTION_IDENTITY_REGISTRY',
  registryNamespace,
  allowedSource: { radar: authorization.radar, sourceName: authorization.sourceName, sourceIdentifier: authorization.sourceIdentifier },
  contractPin: CONTRACT_PIN,
  policyDistributionPin: POLICY_DISTRIBUTION_PIN,
  recordSchemas: ['EventRegistryRecord/1.0', 'ObservationRegistryRecord/1.0'],
  score: 'NOT_EVALUATED', action: 'NOT_EVALUATED', publication: 'NOT_AUTHORIZED',
  };
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
}
const AUDIT_RELATIVE_PATH = join('audit', 'registry-operations.jsonl');
const BACKUP_RELATIVE_PATH = 'radar-production-registry-backups';
const EFFECT_NAMES = Object.freeze([
      'productionRegistryReads', 'productionRegistryWrites', 'canaryRegistryReads', 'canaryRegistryWrites',
  'v1Mutations', 'publisherCalls', 'deploymentCalls', 'scoreExecutions', 'actionExecutions',
  'scheduleMutations', 'publicationEvaluations',
]);
const METRIC_NAMES = Object.freeze([
  'recordsReceived', 'candidateReady', 'evidenceReady', 'identityReady', 'registryWriteAttempted',
  'registryWriteSucceeded', 'duplicateObservation', 'receiptOnly', 'writeRejected', 'corruptionDetected',
  'killSwitchRejection', 'unexpectedSourceRejection', 'runtimeError', 'forbiddenCapabilityCalls',
  'backupsCreated', 'backupRestoreSucceeded', 'auditFailures',
]);
const FORBIDDEN_CAPABILITY_EFFECTS = Object.freeze({
  score: 'scoreExecutions',
  action: 'actionExecutions',
  publication: 'publicationEvaluations',
  publisher: 'publisherCalls',
  deployment: 'deploymentCalls',
  schedule: 'scheduleMutations',
  'canary-registry-read': 'canaryRegistryReads',
  'canary-registry-write': 'canaryRegistryWrites',
  'v1-mutation': 'v1Mutations',
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message = code, details = {}) => Object.assign(new Error(message), { code, ...details });
const emptyEffects = () => Object.fromEntries(EFFECT_NAMES.map((name) => [name, { calls: 0, returned: 0, effectUnits: 0, zeroEffectReturns: 0, nonzeroEffectReturns: 0, rejected: 0 }]));

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalPath(path) {
  const target = resolve(path);
  let cursor = target;
  const suffix = [];
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw fail('PRODUCTION_REGISTRY_PATH_COLLISION', `Production Registry path traverses a symlink: ${cursor}`);
      if (!info.isDirectory()) throw fail('PRODUCTION_REGISTRY_PATH_INVALID', `Production Registry path component is not a directory: ${cursor}`);
      const base = await realpath(cursor);
      return resolve(base, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw fail('PRODUCTION_REGISTRY_PATH_INVALID', 'Unable to resolve Registry path.');
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertNoSymlinks(root) {
  const visit = async (path) => {
    const info = await lstat(path).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!info) return;
    if (info.isSymbolicLink()) throw fail('PRODUCTION_REGISTRY_PATH_COLLISION', `Production Registry contains symlink: ${path}`);
    if (info.isDirectory()) for (const entry of await readdir(path)) await visit(join(path, entry));
  };
  await visit(root);
}

async function fsyncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeSynced(path, bytes, flags = 'wx') {
  const handle = await open(path, flags, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeSynced(temporary, bytes);
  try { await rename(temporary, path); await fsyncDirectory(dirname(path)); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

function validateSource(candidate, identity, registryNamespace) {
  if (!candidate || typeof candidate !== 'object' || !candidate.radar || !candidate.sourceName) {
    throw fail('PRODUCTION_SOURCE_REQUIRED', 'A source radar and source name are required.');
  }
  const allowed = PRODUCTION_SOURCE_ALLOWLIST.some((row) => row.registryNamespace === registryNamespace
    && row.radar === candidate.radar && row.sourceName === candidate.sourceName && row.sourceIdentifier === identity?.sourceIdentifier);
  if (!allowed) throw fail('PRODUCTION_SOURCE_NOT_ALLOWLISTED', 'Source is not in the explicit Tier-1 production allowlist.', { radar: candidate.radar, sourceName: candidate.sourceName });
}

function validateRegistryOutput(pair) {
  const result = validateRegistryPair(pair);
  if (!result.valid) throw fail('PRODUCTION_REGISTRY_SCHEMA_INVALID', result.errors.map((row) => row.code).join(','), { details: result.errors });
  for (const row of [...pair.events, ...pair.observations]) {
    if (['scoreStatus', 'actionStatus', 'publicationStatus', 'score', 'signal', 'action', 'publicationDecision'].some((key) => Object.hasOwn(row, key))) {
      throw fail('PRODUCTION_REGISTRY_SCHEMA_INVALID', 'Score, Action and publication fields are forbidden in Registry rows.');
    }
  }
}

function safePart(value) { return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'operation'; }

function storedRegistryBytes(rows, key) {
  const canonicalJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  return Buffer.from([...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])))
    .map((row) => `${canonicalJson(row)}\n`).join(''), 'utf8');
}

export class ProductionIdentityRegistry {
  constructor({
    stateDir = DEFAULT_PRODUCTION_REGISTRY_DIR,
    canaryStateDir = DEFAULT_CANARY_REGISTRY_DIR,
    v1StateDir = DEFAULT_V1_CONTENT_DIR,
    legacyHorizonStateDir = join(homedir(), '.local', 'state', 'horizon'),
    authorized = false,
    enabled = false,
    runtimeMode = PRODUCTION_IDENTITY_MODE,
    killSwitch = () => process.env.HORIZON_PRODUCTION_REGISTRY_KILL_SWITCH === '1',
    clock = () => new Date(),
    registryRuntime = {},
    auditFailurePoint,
    registryNamespace = PRODUCTION_REGISTRY_NAMESPACE,
  } = {}) {
    if (![stateDir, canaryStateDir, v1StateDir, legacyHorizonStateDir].every((value) => typeof value === 'string' && value.trim())) {
      throw fail('PRODUCTION_REGISTRY_PATH_REQUIRED');
    }
    if (basename(resolve(stateDir)) !== registryNamespace || !PRODUCTION_SOURCE_ALLOWLIST.some((row) => row.registryNamespace === registryNamespace)) throw fail('PRODUCTION_REGISTRY_NAMESPACE_REQUIRED');
    this.registryNamespace = registryNamespace;
    this.markerBytes = markerBytesFor(registryNamespace);
    this.stateDir = resolve(stateDir);
    this.canaryStateDir = resolve(canaryStateDir);
    this.v1StateDir = resolve(v1StateDir);
    this.legacyHorizonStateDir = resolve(legacyHorizonStateDir);
    this.authorized = authorized === true;
    this.enabled = enabled === true;
    this.runtimeMode = runtimeMode;
    this.killSwitch = killSwitch;
    this.clock = clock;
    this.auditFailurePoint = auditFailurePoint;
    this.initialized = false;
    this.metrics = Object.fromEntries(METRIC_NAMES.map((name) => [name, 0]));
    this.effects = emptyEffects();
    const externalBeforeCommit = registryRuntime.beforeCommit;
    const externalOnCommitted = registryRuntime.onCommitted;
    this.registryRuntime = {
      ...registryRuntime,
      beforeCommit: async (context) => {
        this.effects.productionRegistryReads.calls += 1;
        this.effects.productionRegistryReads.returned += 1;
        this.effects.productionRegistryReads.effectUnits += context.pair.events.length + context.pair.observations.length;
        await externalBeforeCommit?.(context);
        await this.writePreMutationBackup(context);
      },
      onCommitted: (context) => {
        externalOnCommitted?.(context);
        this.metrics.registryWriteSucceeded += 1;
        const effectUnits = Number(context.eventCreated) + Number(context.observationCreated);
        this.effects.productionRegistryWrites.effectUnits += effectUnits;
        if (effectUnits === 0) this.effects.productionRegistryWrites.zeroEffectReturns += 1;
        else this.effects.productionRegistryWrites.nonzeroEffectReturns += 1;
      },
    };
    this.layer = new RegistryLayer({ ...this.registryRuntime, stateDir: this.stateDir });
  }

  async initialize() {
    const [store, canary, v1, legacy] = await Promise.all([
      canonicalPath(this.stateDir), canonicalPath(this.canaryStateDir), canonicalPath(this.v1StateDir), canonicalPath(this.legacyHorizonStateDir),
    ]);
    if ([canary, v1, legacy].some((path) => isWithin(path, store) || isWithin(store, path))) {
      throw fail('PRODUCTION_REGISTRY_PATH_COLLISION', 'Production Registry must be physically disjoint from Canary, V1 and the legacy Horizon state tree.');
    }
    // macOS may expose /var and /private/var as the same physical path; retain the canonical target.
    this.stateDir = store;
    this.layer.transactions.stateDir = store;
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const info = await lstat(this.stateDir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw fail('PRODUCTION_REGISTRY_PERMISSIONS_UNSAFE');
    await assertNoSymlinks(this.stateDir);
    const markerPath = join(this.stateDir, PRODUCTION_STORE_MARKER);
    let marker = await readFile(markerPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (marker && !marker.equals(this.markerBytes)) {
      this.metrics.corruptionDetected += 1;
      let quarantinePath;
      try {
        quarantinePath = await preserveCorruptionEvidence(this.stateDir, {
          failureClass: 'PRODUCTION_REGISTRY_METADATA_CORRUPT',
          errorCode: 'PRODUCTION_REGISTRY_METADATA_CORRUPT',
          failureReason: 'Production Registry marker does not match the approved namespace and policy pins.',
          evidenceFiles: [{ role: 'production-registry-metadata', originalPath: markerPath, present: true, bytes: marker }],
          metadata: { registryNamespace: this.registryNamespace },
        });
      } catch (error) {
        throw fail('PRODUCTION_REGISTRY_METADATA_QUARANTINE_FAILED', 'Corrupt metadata could not be preserved; Registry remains unavailable.', { cause: error });
      }
      throw fail('PRODUCTION_REGISTRY_METADATA_CORRUPT', 'Production Registry marker does not match the approved namespace and policy pins.', { quarantinePath });
    }
    if (!marker) {
      const names = await readdir(this.stateDir);
      if (names.length > 0) {
        // Concurrent first use may observe the marker after its creator opens it but before bytes are fully synced.
        // Accept only this exact initialization race; every other unmarked entry remains a hard collision.
        if (names.length !== 1 || names[0] !== basename(markerPath)) throw fail('PRODUCTION_REGISTRY_PATH_COLLISION', 'Unmarked Production Registry directory is not empty; refusing to adopt unknown state.');
        for (let attempt = 0; attempt < 25; attempt += 1) {
          marker = await readFile(markerPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
          if (marker?.equals(this.markerBytes)) break;
          await new Promise((resolve) => setTimeout(resolve, 4));
        }
        if (!marker?.equals(this.markerBytes)) throw fail('PRODUCTION_REGISTRY_METADATA_CORRUPT', 'Concurrent Registry initialization did not produce the approved marker bytes.');
      }
      if (marker) {
        // Another initializer installed the exact approved marker while this process inspected the directory.
      } else {
      await writeSynced(markerPath, this.markerBytes).catch(async (error) => {
        if (error?.code !== 'EEXIST') throw error;
        const raced = await readFile(markerPath);
        if (!raced.equals(this.markerBytes)) throw fail('PRODUCTION_REGISTRY_METADATA_CORRUPT');
      });
      await fsyncDirectory(this.stateDir);
      }
    }
    this.initialized = true;
    return this.stateDir;
  }

  enable() {
    if (!this.authorized) throw fail('PRODUCTION_REGISTRY_NOT_AUTHORIZED');
    this.enabled = true;
  }

  disable() { this.enabled = false; }

  assertWritable(input) {
    if (this.runtimeMode !== PRODUCTION_IDENTITY_MODE || input?.runtimeMode !== PRODUCTION_IDENTITY_MODE) throw fail('PRODUCTION_REGISTRY_MODE_REQUIRED');
    if (!this.authorized) throw fail('PRODUCTION_REGISTRY_NOT_AUTHORIZED');
    if (this.killSwitch()) throw fail('PRODUCTION_REGISTRY_KILL_SWITCH');
    if (input?.productionRegistryEnabled !== true || !this.enabled) throw fail('PRODUCTION_REGISTRY_DISABLED');
  }

  async appendAudit(row) {
    try {
      if (this.auditFailurePoint === 'before-intent' && row.operation === 'WRITE_INTENT') {
        throw fail('PRODUCTION_REGISTRY_AUDIT_UNAVAILABLE', 'Audit persistence failed before mutation.');
      }
      if (this.auditFailurePoint === 'after-commit' && row.operation === 'WRITE_RESULT' && row.success === true) {
        throw fail('PRODUCTION_REGISTRY_AUDIT_RESULT_MISSING', 'Registry commit is durable but its final audit outcome could not be recorded.');
      }
      const auditDir = join(this.stateDir, 'audit');
      await mkdir(auditDir, { recursive: true, mode: 0o700 });
      await assertNoSymlinks(this.stateDir);
      const path = join(this.stateDir, AUDIT_RELATIVE_PATH);
      const handle = await open(path, 'a', 0o600);
      try { await handle.writeFile(`${JSON.stringify(row)}\n`); await handle.sync(); } finally { await handle.close(); }
      await fsyncDirectory(auditDir);
    } catch (error) {
      this.metrics.auditFailures += 1;
      throw error;
    }
  }

  auditRow({ operation, candidate, identity, request, observationId = request?.observation?.observationId ?? null, disposition = null, success, reasonCode = null, transactionId = null, committed = null, runId = null }) {
    return {
      when: this.clock().toISOString(),
      ...(runId ? { runId } : {}),
      runtimeMode: this.runtimeMode,
      modeDisposition: SCORE_DEBT_MODE,
      source: candidate ? {
        radar: candidate.radar ?? null,
        sourceName: candidate.sourceName ?? null,
        sourceIdentifier: candidate.sourceIdentifier ?? PRODUCTION_SOURCE_ALLOWLIST.find((row) => row.radar === candidate.radar && row.sourceName === candidate.sourceName)?.sourceIdentifier ?? null,
      } : null,
      operation,
      eventKey: request?.eventKey ?? null,
      observationId,
      eventIdentity: identity ? {
        entity: identity.entity,
        canonicalEventType: identity.canonicalEventType,
        eventIdentifier: identity.eventIdentifier,
        resolverVersion: identity.resolverVersion,
        provenance: identity.identityProvenance,
      } : null,
      evidenceReference: candidate?.itemUrl ?? null,
      transactionId,
      disposition,
      success,
      reasonCode,
      committed,
    };
  }

  async prepareInput(input) {
    const candidateResult = input?.candidateResult;
    const candidate = candidateResult?.candidate ?? input?.candidate;
    if (!candidate) throw fail('PRODUCTION_SOURCE_REQUIRED', 'A structured candidate with a source is required.');
    validateSource(candidate, input?.identity, this.registryNamespace);
    if (candidateResult?.status !== 'CANDIDATE_READY' || !candidate) {
      this.metrics.receiptOnly += 1;
      throw fail('PRODUCTION_CANDIDATE_NOT_READY');
    }
    const recomputed = adaptProductionCandidate({
      radar: candidate.radar,
      sourceName: candidate.sourceName,
      record: candidate.rawSourceMetadata?.record,
    }, { observedAt: candidate.observedAt });
    if (recomputed.status !== 'CANDIDATE_READY' || !isDeepStrictEqual(recomputed.candidate, candidate)
      || !isDeepStrictEqual(recomputed.provenance, candidateResult.provenance)) {
      this.metrics.receiptOnly += 1;
      throw fail('PRODUCTION_CANDIDATE_NOT_READY', 'Candidate does not match a fresh deterministic adapter result.');
    }
    this.metrics.candidateReady += 1;
    const forbiddenFields = ['score', 'signal', 'action', 'publicationDecision', 'scoreStatus', 'actionStatus', 'publicationStatus'];
    const suppliedObjects = [input, candidate, candidate.rawSourceMetadata, candidate.rawSourceMetadata?.record];
    if (suppliedObjects.some((object) => object && typeof object === 'object' && forbiddenFields.some((field) => Object.hasOwn(object, field)))) {
      throw fail('PRODUCTION_FORBIDDEN_OUTPUT', 'Score, Action and publication fields are not accepted by the identity Registry path.');
    }
    const identity = candidate.radar === 'AI' && candidate.sourceName === 'arXiv cs.LG'
      ? resolveArxivCsLgIdentity(candidate)
      : candidate.radar === 'SEC' && candidate.sourceName === 'NVD'
      ? resolveNvdIdentity(candidate)
      : resolveClaudeCodeChangelogIdentity(candidate);
    if (identity.status !== 'IDENTITY_READY' || !isDeepStrictEqual(identity, input.identity)) {
      this.metrics.receiptOnly += 1;
      throw fail('PRODUCTION_EVENT_IDENTITY_NOT_READY', identity.reasonCode ?? 'IDENTITY_MISMATCH');
    }
    this.metrics.identityReady += 1;
    const raw = {
      sourceName: candidate.sourceName,
      title: candidate.title,
      sourceUrl: candidate.itemUrl,
      ...(candidate.publishedAt ? { sourcePublishedAt: candidate.publishedAt } : {}),
      sourceAuthority: candidate.sourceAuthority,
      sourceLevel: candidate.sourceLevel,
      entity: identity.entity,
      canonicalEventType: identity.canonicalEventType,
      eventIdentifier: identity.eventIdentifier,
      eventFacts: identity.eventFacts ?? {},
    };
    const evidenceRadar = candidate.radar === 'SEC' ? 'security' : candidate.radar.toLowerCase();
    const prepared = prepareEvidenceCommit(raw, { radar: evidenceRadar, observedAt: candidate.observedAt });
    if (!prepared.registryEligible || !prepared.commitRequest || prepared.eventKey !== identity.eventKey || prepared.observationId === undefined) {
      this.metrics.receiptOnly += 1;
      throw fail('PRODUCTION_EVIDENCE_NOT_READY', (prepared.errors ?? []).map(({ code }) => code).join(',') || 'EVIDENCE_INVALID');
    }
    this.metrics.evidenceReady += 1;
    const provenance = identity.identityProvenance;
    for (const key of ['entity', 'canonicalEventType', 'eventIdentifier']) {
      const fact = provenance?.[key];
      if (!fact || !fact.value || !fact.authority || !fact.method || fact.evidenceRef !== candidate.itemUrl) {
        this.metrics.receiptOnly += 1;
        throw fail('PRODUCTION_PROVENANCE_INVALID', key);
      }
    }
    return { candidate, identity, observationId: prepared.observationId, request: prepared.commitRequest };
  }

  async commit(input = {}) {
    this.metrics.recordsReceived += 1;
    this.metrics.registryWriteAttempted += 1;
    let prepared;
    let intentWritten = false;
    let writeWasCalled = false;
    const writeEffectUnitsBefore = this.effects.productionRegistryWrites.effectUnits;
    try {
      if (this.authorized) await this.initialize();
      this.assertWritable(input);
      prepared = await this.prepareInput(input);
      await this.appendAudit(this.auditRow({ operation: 'WRITE_INTENT', candidate: prepared.candidate, identity: prepared.identity, request: prepared.request, observationId: prepared.observationId, success: false, reasonCode: 'IN_PROGRESS', runId: input.runId }));
      intentWritten = true;
      writeWasCalled = true;
      this.effects.productionRegistryWrites.calls += 1;
      const committed = await this.layer.commitObservation(prepared.request);
      this.effects.productionRegistryWrites.returned += 1;
      const disposition = committed.eventCreated ? 'NEW_EVENT' : committed.observationCreated ? 'NEW_OBSERVATION' : 'DUPLICATE_OBSERVATION';
      if (disposition === 'DUPLICATE_OBSERVATION') this.metrics.duplicateObservation += 1;
      await this.appendAudit(this.auditRow({ operation: 'WRITE_RESULT', candidate: prepared.candidate, identity: prepared.identity, request: prepared.request, observationId: committed.observationId, disposition, success: true, transactionId: committed.transactionId, runId: input.runId }));
      return {
        ...committed,
        registryDisposition: disposition,
        modeDisposition: SCORE_DEBT_MODE,
        productionIngestionRemainsEnabled: this.enabled === true,
      };
    } catch (error) {
      const code = String(error?.code ?? 'PRODUCTION_REGISTRY_RUNTIME_ERROR');
      if (writeWasCalled && this.effects.productionRegistryWrites.returned < this.effects.productionRegistryWrites.calls) {
        if (this.effects.productionRegistryWrites.effectUnits > writeEffectUnitsBefore) {
          error.committed = true;
        } else {
          this.effects.productionRegistryWrites.rejected += 1;
        }
      }
      if (code === 'PRODUCTION_REGISTRY_AUDIT_RESULT_MISSING') {
        this.disable();
        error.committed = writeWasCalled;
      }
      if (code === 'PRODUCTION_REGISTRY_KILL_SWITCH') this.metrics.killSwitchRejection += 1;
      if (code === 'PRODUCTION_SOURCE_NOT_ALLOWLISTED' || code === 'PRODUCTION_SOURCE_REQUIRED') this.metrics.unexpectedSourceRejection += 1;
      if (/CORRUPT|INVALID|HASH_MISMATCH|PAIR_|JSONL_|VALIDATION_FAILED|SNAPSHOT_/i.test(code)) this.metrics.corruptionDetected += 1;
      if (code.endsWith('_RUNTIME_ERROR') || code === 'PRODUCTION_BACKUP_FAILED') this.metrics.runtimeError += 1;
      this.metrics.writeRejected += 1;
      if (intentWritten && prepared) {
        try {
          await this.appendAudit(this.auditRow({ operation: 'WRITE_RESULT', candidate: prepared.candidate, identity: prepared.identity, request: prepared.request, observationId: prepared.observationId, success: false, reasonCode: code, committed: error.committed === true, runId: input.runId }));
        } catch (auditError) {
          this.disable();
          throw fail(auditError?.code ?? 'PRODUCTION_REGISTRY_AUDIT_RESULT_MISSING', 'Write result audit failed; runtime disabled. Inspect transaction journal before resuming.', { cause: error, committed: writeWasCalled && code === 'PRODUCTION_REGISTRY_AUDIT_RESULT_MISSING' });
        }
      } else if (this.initialized) {
        try { await this.appendAudit(this.auditRow({ operation: 'WRITE_REJECTED', candidate: input?.candidateResult?.candidate, success: false, reasonCode: code })); }
        catch { /* A denied operation remains denied when the audit store is unavailable. */ }
      }
      throw error;
    }
  }

  async readPair() {
    if (!this.authorized) throw fail('PRODUCTION_REGISTRY_NOT_AUTHORIZED');
    await this.initialize();
    this.effects.productionRegistryReads.calls += 1;
    try {
      const pair = await this.layer.transactions.readPair();
      validateRegistryOutput(pair);
      this.effects.productionRegistryReads.returned += 1;
      this.effects.productionRegistryReads.effectUnits += pair.events.length + pair.observations.length;
      return pair;
    } catch (error) {
      this.metrics.corruptionDetected += 1;
      this.effects.productionRegistryReads.rejected += 1;
      throw error;
    }
  }

  async writePreMutationBackup({ pair, transactionId, at, backupId }) {
    try {
      validateRegistryOutput(pair);
      const metadataBytes = await readFile(join(this.stateDir, PRODUCTION_STORE_MARKER));
      if (!metadataBytes.equals(this.markerBytes)) throw fail('PRODUCTION_REGISTRY_METADATA_CORRUPT');
      const eventBytes = storedRegistryBytes(pair.events, 'eventKey');
      const observationBytes = storedRegistryBytes(pair.observations, 'observationId');
      const backupRoot = join(this.stateDir, BACKUP_RELATIVE_PATH);
      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      const id = backupId ?? `${at.replace(/[:.]/g, '-')}-${safePart(transactionId)}-${randomUUID().slice(0, 8)}`;
      const staging = join(backupRoot, `.staging-${id}`);
      const destination = join(backupRoot, id);
      await mkdir(staging, { mode: 0o700 });
      const manifest = {
        backupVersion: 1,
        backupKind: 'PRE_MUTATION_OPERATIONAL_RECOVERY_COPY',
        createdAt: at,
        transactionId,
        registryNamespace: this.registryNamespace,
        eventCount: pair.events.length,
        observationCount: pair.observations.length,
        eventSha256: sha256(eventBytes),
        observationSha256: sha256(observationBytes),
        metadataSha256: sha256(metadataBytes),
      };
      await writeSynced(join(staging, 'events.jsonl'), eventBytes);
      await writeSynced(join(staging, 'observations.jsonl'), observationBytes);
      await writeSynced(join(staging, 'registry-metadata.json'), metadataBytes);
      await writeSynced(join(staging, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
      await fsyncDirectory(staging);
      await rename(staging, destination);
      await fsyncDirectory(backupRoot);
      const verified = await this.verifyBackup(id);
      if (!verified.valid) throw fail('PRODUCTION_REGISTRY_BACKUP_INVALID', verified.errors.join(','));
      this.metrics.backupsCreated += 1;
      await this.appendAudit(this.auditRow({ operation: 'BACKUP_RESULT', disposition: 'VERIFIED', success: true, transactionId }));
    } catch (error) {
      throw fail('PRODUCTION_BACKUP_FAILED', 'A verified pre-mutation recovery copy is required before Registry mutation.', { cause: error });
    }
  }

  async verifyBackup(id) {
    if (typeof id !== 'string' || !id.trim() || basename(id) !== id) return { valid: false, errors: ['invalid backup id'] };
    const root = join(this.stateDir, BACKUP_RELATIVE_PATH, basename(id));
    const errors = [];
    try {
      const [eventBytes, observationBytes, metadataBytes, manifestBytes] = await Promise.all([
        readFile(join(root, 'events.jsonl')), readFile(join(root, 'observations.jsonl')),
        readFile(join(root, 'registry-metadata.json')), readFile(join(root, 'manifest.json')),
      ]);
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (manifest.backupVersion !== 1 || manifest.backupKind !== 'PRE_MUTATION_OPERATIONAL_RECOVERY_COPY' || manifest.registryNamespace !== this.registryNamespace) errors.push('manifest identity mismatch');
      if (manifest.eventSha256 !== sha256(eventBytes)) errors.push('event checksum mismatch');
      if (manifest.observationSha256 !== sha256(observationBytes)) errors.push('observation checksum mismatch');
      if (manifest.metadataSha256 !== sha256(metadataBytes) || !metadataBytes.equals(this.markerBytes)) errors.push('metadata checksum mismatch');
      const pair = registryPairFromJsonl(eventBytes, observationBytes);
      if (pair.events.length !== manifest.eventCount || pair.observations.length !== manifest.observationCount) errors.push('record count mismatch');
      const validation = validateRegistryPair(pair);
      if (!validation.valid) errors.push(...validation.errors.map(({ code }) => code));
      return { valid: errors.length === 0, errors, manifest, pair, eventBytes, observationBytes, metadataBytes };
    } catch (error) {
      return { valid: false, errors: [...errors, error instanceof Error ? error.message : String(error)] };
    }
  }

  async createBackup() {
    if (!this.authorized) throw fail('PRODUCTION_REGISTRY_NOT_AUTHORIZED');
    await this.initialize();
    this.effects.productionRegistryReads.calls += 1;
    const pair = await this.layer.transactions.readPair();
    this.effects.productionRegistryReads.returned += 1;
    this.effects.productionRegistryReads.effectUnits += pair.events.length + pair.observations.length;
    const at = this.clock().toISOString();
    const id = `manual-${at.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const context = { pair, transactionId: id, at, backupId: id };
    await this.writePreMutationBackup(context);
    return { backupId: id, eventCount: pair.events.length, observationCount: pair.observations.length };
  }

  async restoreBackup(id) {
    if (!this.authorized) throw fail('PRODUCTION_REGISTRY_NOT_AUTHORIZED');
    await this.initialize();
    const backup = await this.verifyBackup(id);
    if (!backup.valid) {
      this.metrics.corruptionDetected += 1;
      throw fail('PRODUCTION_REGISTRY_BACKUP_INVALID', backup.errors.join(','));
    }
    const restoreId = `restore-${safePart(id)}-${randomUUID()}`;
    const candidate = { radar: 'DEV', sourceName: 'Claude Code Changelog' };
    await this.appendAudit(this.auditRow({ operation: 'RESTORE_INTENT', candidate, success: false, reasonCode: 'IN_PROGRESS', transactionId: restoreId }));
    this.effects.productionRegistryWrites.calls += 1;
    try {
      const result = await this.layer.transactions.replacePair(backup.pair, restoreId);
      this.effects.productionRegistryWrites.returned += 1;
      this.effects.productionRegistryWrites.effectUnits += result.eventCount + result.observationCount;
      this.metrics.backupRestoreSucceeded += 1;
      await this.appendAudit(this.auditRow({ operation: 'RESTORE_RESULT', candidate, disposition: 'RESTORED', success: true, transactionId: result.transactionId }));
      return result;
    } catch (error) {
      this.effects.productionRegistryWrites.rejected += 1;
      await this.appendAudit(this.auditRow({ operation: 'RESTORE_RESULT', candidate, success: false, reasonCode: error?.code ?? 'RESTORE_FAILED', transactionId: restoreId })).catch(() => {});
      throw error;
    }
  }

  async invokeForbiddenCapability(capability) {
    const key = String(capability).trim().toLowerCase().replaceAll('_', '-');
    const effect = FORBIDDEN_CAPABILITY_EFFECTS[key];
    if (!effect) throw fail('PRODUCTION_CAPABILITY_UNKNOWN');
    this.metrics.forbiddenCapabilityCalls += 1;
    this.effects[effect].calls += 1;
    this.effects[effect].rejected += 1;
    if (this.authorized) {
      try {
        await this.initialize();
        await this.appendAudit(this.auditRow({ operation: 'FORBIDDEN_CAPABILITY', disposition: key.toUpperCase(), success: false, reasonCode: `PRODUCTION_${key.toUpperCase()}_FORBIDDEN` }));
      } catch { /* The capability stays rejected even if its diagnostic audit cannot be persisted. */ }
    }
    throw fail(`PRODUCTION_${key.toUpperCase().replaceAll('-', '_')}_FORBIDDEN`, `${key} is outside GENERAL_PRODUCTION_IDENTITY_REGISTRY.`);
  }

  getMetrics() { return structuredClone(this.metrics); }

  getSideEffectAccounting() {
    return Object.fromEntries(Object.entries(this.effects).map(([name, value]) => [name, {
      ...value,
      status: value.calls === 0 ? 'NOT_CALLED' : value.rejected > 0 && value.effectUnits > 0 ? 'COMMITTED_WITH_RESPONSE_ERROR' : value.rejected > 0 && value.returned === 0 ? 'CALLED_AND_REJECTED' : value.effectUnits === 0 ? 'CALLED_AND_RETURNED_ZERO' : 'CALLED_AND_RETURNED_NONZERO',
    }]));
  }
}

export function createProductionIdentityRegistry(options = {}) { return new ProductionIdentityRegistry(options); }
