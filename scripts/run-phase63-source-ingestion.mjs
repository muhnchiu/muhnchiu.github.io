import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createArxivCandidate, verifyArxivFeedCapture } from '../src/lib/radar-production-registry/arxiv-feed-capture.mjs';
import { createNvdCandidate, verifyNvdCveCapture } from '../src/lib/radar-production-registry/nvd-cve-capture.mjs';
import {
  ARXIV_PRODUCTION_REGISTRY_NAMESPACE, DEFAULT_ARXIV_PRODUCTION_REGISTRY_DIR,
  NVD_PRODUCTION_REGISTRY_NAMESPACE, DEFAULT_NVD_PRODUCTION_REGISTRY_DIR,
  PRODUCTION_IDENTITY_MODE, createProductionIdentityRegistry,
} from '../src/lib/radar-production-registry/production-identity-registry.mjs';

const fail = (code) => Object.assign(new Error(code), { code });
const sourceArgs = new Map([
  ['arxiv', { verify: verifyArxivFeedCapture, candidate: createArxivCandidate, namespace: ARXIV_PRODUCTION_REGISTRY_NAMESPACE, stateDir: DEFAULT_ARXIV_PRODUCTION_REGISTRY_DIR }],
  ['nvd', { verify: verifyNvdCveCapture, candidate: createNvdCandidate, namespace: NVD_PRODUCTION_REGISTRY_NAMESPACE, stateDir: DEFAULT_NVD_PRODUCTION_REGISTRY_DIR }],
]);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const syncWrite = async (path, text, exclusive = true) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, exclusive ? 'wx' : 'w', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
};

const [source, capturePath] = process.argv.slice(2);
const selected = sourceArgs.get(source);
if (!selected || !capturePath) throw fail('SOURCE_AND_CAPTURE_REQUIRED');
const captureText = await readFile(capturePath, 'utf8');
const capture = JSON.parse(captureText);
const captureCheck = selected.verify(capture);
let nvdDecision;
// NVD admission requires the completed authority adjudication and exact reviewed
// immutable identities; this gate precedes namespace creation or control changes.
if (source === 'nvd') {
  const evidenceRoot = join(homedir(), '.local', 'state', 'horizon');
  const decision = JSON.parse(await readFile(join(evidenceRoot, 'radar-phase6.3-nvd-entity-authority-decision-v1.json'), 'utf8'));
  nvdDecision = decision;
  const audit = JSON.parse(await readFile(join(evidenceRoot, 'radar-phase6.3-nvd-identity-invariant-audit-v1.json'), 'utf8'));
  if (decision.decision !== 'NVD_ENTITY_AUTHORITY_APPROVED' || decision.sections1Through11 !== 'COMPLETE'
    || decision.realRecordsReady !== '5/5' || decision.sourceAuthorization?.namespace !== selected.namespace
    || audit.result !== 'PASS' || audit.realRecords?.length !== 5 || captureCheck.recordCount !== 5
    || captureCheck.sha256 !== '810043f9b51c4f7bb7750bf5aa2aecba2389b0b8516b968515f95ca507a72a6c') throw fail('NVD_AUTHORITY_GATE_NOT_ESTABLISHED');
  const reviewed = capture.sourceRecords.map((record) => selected.candidate(record, { observedAt: capture.observedAt }));
  const { prepareEvidenceCommit } = await import('../src/lib/radar-evidence-pipeline.mjs');
  for (const [index, row] of reviewed.entries()) {
    if (row.candidateResult.status !== 'CANDIDATE_READY' || row.identity?.status !== 'IDENTITY_READY'
      || row.identity.eventKey !== audit.realRecords[index].eventKey) throw fail('OFFLINE_IDENTITY_READINESS_DRIFT');
    const c = row.candidateResult.candidate;
    const evidence = prepareEvidenceCommit({ sourceName: c.sourceName, title: c.title, sourceUrl: c.itemUrl,
      sourceLevel: c.sourceLevel, sourceAuthority: c.sourceAuthority, ...row.identity }, { radar: 'security', observedAt: c.observedAt });
    if (!evidence.registryEligible || evidence.observationId !== audit.realRecords[index].observationId) throw fail('OFFLINE_IDENTITY_READINESS_DRIFT');
  }
  // Recheck both accepted stores without mutating their audits/metadata.
  const { registryPairFromJsonl, validateRegistryPair } = await import('../src/lib/radar-registry/index.ts');
  for (const baseline of decision.baseline.stores) {
    const dir = join(homedir(), '.local', 'state', 'horizon-production', baseline.namespace);
    const e = await readFile(join(dir, 'radar-event-registry.jsonl'), 'utf8');
    const o = await readFile(join(dir, 'radar-observation-registry.jsonl'), 'utf8');
    const pair = registryPairFromJsonl(e, o);
    const controls = JSON.parse(await readFile(`${dir}-ingestion-runtime/control.json`, 'utf8'));
    if (sha256(e) !== baseline.eventSha256 || sha256(o) !== baseline.observationSha256
      || !validateRegistryPair(pair).valid || pair.events.length !== baseline.eventCount
      || pair.observations.length !== baseline.observationCount || controls.ingestion !== 'DISABLED'
      || controls.scheduler !== 'DISABLED') throw fail('PHASE_6_3_BASELINE_DRIFT');
  }
}
if (basename(selected.stateDir) !== selected.namespace) throw fail('SOURCE_NAMESPACE_INVALID');
const root = join(homedir(), '.local', 'state', 'horizon-production');
const lockPath = join(root, 'radar-phase6.3-source-expansion.lock');
const lockRunId = randomUUID();
await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(lockPath, { mode: 0o700 }).catch((error) => { if (error.code === 'EEXIST') throw fail('SOURCE_EXPANSION_RUN_LOCKED'); throw error; });
await syncWrite(join(lockPath, 'owner.json'), `${JSON.stringify({ runId: lockRunId, pid: process.pid, startedAt: new Date().toISOString(), source }, null, 2)}\n`);

const runtimeDir = join(root, `${selected.namespace}-ingestion-runtime`);
const controlPath = join(runtimeDir, 'control.json');
let control;
let registry;
let finalStatus = 'RUN_FAILED';
const runId = `phase6.3-${source}-${lockRunId}`;
const result = { runId, source, captureSha256: captureCheck.sha256, capturePath, capturedRecordCount: captureCheck.recordCount, initialWriteCount: 0, replayCount: 0, eventGrowth: 0, observationGrowth: 0, scheduler: 'DISABLED', ingestionFinal: 'DISABLED', finalStatus, rows: [], failures: [] };
try {
  control = await readFile(controlPath, 'utf8').then(JSON.parse).catch((error) => error.code === 'ENOENT' ? { version: 1, ingestion: 'DISABLED', scheduler: 'DISABLED' } : Promise.reject(error));
  if (control.scheduler !== 'DISABLED' || control.ingestion !== 'DISABLED') throw fail('SOURCE_RUNTIME_CONTROL_NOT_DISABLED');
  registry = createProductionIdentityRegistry({ stateDir: selected.stateDir, registryNamespace: selected.namespace, authorized: true, enabled: false, runtimeMode: PRODUCTION_IDENTITY_MODE });
  const before = await registry.readPair();
  if (before.events.length || before.observations.length) throw fail('SOURCE_REGISTRY_NOT_EMPTY');
  result.initialBackup = await registry.createBackup();
  if (nvdDecision) {
    const backupDir = join(root, 'phase6.3', 'backups', runId);
    const backupFiles = [];
    for (const baseline of nvdDecision.baseline.stores) {
      for (const [name, expectedHash] of [['radar-event-registry.jsonl', baseline.eventSha256], ['radar-observation-registry.jsonl', baseline.observationSha256], [ '.horizon-production-registry-v1.json', baseline.markerSha256]]) {
        const bytes = await readFile(join(root, baseline.namespace, name));
        if (sha256(bytes) !== expectedHash) throw fail('PHASE_6_3_BASELINE_DRIFT');
        const target = join(backupDir, baseline.namespace, name);
        await syncWrite(target, bytes);
        if (sha256(await readFile(target)) !== expectedHash) throw fail('BASELINE_BACKUP_HASH_MISMATCH');
        backupFiles.push({ namespace: baseline.namespace, name, sha256: expectedHash });
      }
    }
    await syncWrite(join(backupDir, 'manifest.json'), `${JSON.stringify({ runId, createdAt: new Date().toISOString(), baseline: '25/25', verified: true, files: backupFiles }, null, 2)}\n`);
    result.acceptedBaselineBackup = { path: backupDir, verified: true, files: backupFiles };
  }
  const beforeAudit = await readFile(controlPath, 'utf8').then(JSON.parse).catch(() => ({ version: 1 }));
  await syncWrite(controlPath, `${JSON.stringify({ ...beforeAudit, version: 1, ingestion: 'ENABLED', scheduler: 'DISABLED', changedAt: new Date().toISOString(), reason: 'PHASE_6_3_BOUNDED_OPERATOR_RUN', runId }, null, 2)}\n`, false);
  registry.enable();
  const prepared = capture.sourceRecords.map((record) => selected.candidate(record, { observedAt: capture.observedAt }));
  if (prepared.some(({ candidateResult, identity }) => candidateResult.status !== 'CANDIDATE_READY' || identity?.status !== 'IDENTITY_READY')) throw fail('OFFLINE_IDENTITY_READINESS_DRIFT');
  for (const [index, item] of prepared.entries()) {
    const committed = await registry.commit({ candidateResult: item.candidateResult, identity: item.identity, runId, runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true });
    result.initialWriteCount += 1;
    result.rows.push({ index, eventKey: committed.eventKey, observationId: committed.observationId, disposition: committed.registryDisposition, runId });
  }
  const afterInitial = await registry.readPair();
  result.replayRows = [];
  for (const [index, item] of prepared.entries()) {
    const replayed = await registry.commit({ candidateResult: item.candidateResult, identity: item.identity, runId, runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true });
    if (replayed.registryDisposition !== 'DUPLICATE_OBSERVATION') throw fail('CAPTURE_REPLAY_DISPOSITION_MISMATCH');
    if (replayed.eventKey !== result.rows[index].eventKey || replayed.observationId !== result.rows[index].observationId) throw fail('CAPTURE_REPLAY_IDENTITY_MISMATCH');
    result.replayRows.push({ index, eventKey: replayed.eventKey, observationId: replayed.observationId, disposition: replayed.registryDisposition, runId });
    result.replayCount += 1;
  }
  const after = await registry.readPair();
  result.eventGrowth = after.events.length - before.events.length;
  result.observationGrowth = after.observations.length - before.observations.length;
  if (after.events.length !== afterInitial.events.length || after.observations.length !== afterInitial.observations.length) throw fail('UNEXPECTED_REPLAY_GROWTH');
  result.registryCounts = { events: after.events.length, observations: after.observations.length };
  result.effects = registry.effects;
  result.registryHashes = await Promise.all(['radar-event-registry.jsonl', 'radar-observation-registry.jsonl'].map(async (name) => ({ name, sha256: sha256(await readFile(join(selected.stateDir, name))) })));
  registry.disable();
  let disabledProbe;
  try {
    await registry.commit({ ...prepared[0], runId, runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true });
    throw fail('DISABLED_WRITE_PROBE_ACCEPTED');
  } catch (error) {
    if (error.code !== 'PRODUCTION_REGISTRY_DISABLED') throw error;
    disabledProbe = error.code;
  }
  for (const entry of result.registryHashes) if (sha256(await readFile(join(selected.stateDir, entry.name))) !== entry.sha256) throw fail('DISABLED_WRITE_PROBE_MUTATED_REGISTRY');
  result.disabledWriteProbe = { result: disabledProbe, eventAndObservationHashesUnchanged: true };
  result.finalStatus = 'RUN_SUCCESS'; finalStatus = 'RUN_SUCCESS';
} catch (error) {
  result.failures.push({ code: error.code ?? 'RUN_FAILED', message: String(error.message ?? error).slice(0, 240) });
  result.finalStatus = 'RUN_FAILED';
} finally {
  registry?.disable();
  const current = control ?? { version: 1 };
  const disabled = { ...current, version: 1, ingestion: 'DISABLED', scheduler: 'DISABLED', changedAt: new Date().toISOString(), reason: 'PHASE_6_3_RUN_COMPLETE', runId };
  await syncWrite(controlPath, `${JSON.stringify(disabled, null, 2)}\n`, false).catch((error) => result.failures.push({ code: 'FINAL_DISABLE_WRITE_FAILED', message: error.message }));
  result.ingestionFinal = 'DISABLED'; result.scheduler = 'DISABLED';
  const outDir = join(root, 'phase6.3', 'runs');
  const runFile = join(outDir, `${runId}.json`);
  await syncWrite(runFile, `${JSON.stringify(result, null, 2)}\n`, false).catch((error) => result.failures.push({ code: 'RUN_EVIDENCE_WRITE_FAILED', message: error.message }));
  await rm(lockPath, { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify({ ...result, finalStatus }, null, 2));
if (finalStatus !== 'RUN_SUCCESS' || result.failures.length) process.exitCode = 1;
