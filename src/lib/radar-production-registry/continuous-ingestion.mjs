import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProductionIdentityRegistry, DEFAULT_PRODUCTION_REGISTRY_DIR, PRODUCTION_IDENTITY_MODE } from './production-identity-registry.mjs';
import { CLAUDE_CODE_OFFICIAL_FEED_URL, createClaudeCodeFeedCandidate, verifyClaudeCodeFeedCapture } from './claude-code-feed-capture.mjs';
import { CLAUDE_CODE_SOURCE_IDENTIFIER } from '../radar-canary/claude-code-identity.mjs';

export const INGESTION_SOURCE = Object.freeze({ radar: 'DEV', sourceName: 'Claude Code Changelog', sourceIdentifier: CLAUDE_CODE_SOURCE_IDENTIFIER });
export const INGESTION_SCHEDULER = Object.freeze({ schedulerId: 'horizon-radar-v2-production', scheduleVersion: '1', timezone: 'Asia/Shanghai' });
export const INGESTION_LIMITS = Object.freeze({ maxSourceItems: 50, maxPendingWrites: 1, maxRetryQueue: 10, maxFetchAttempts: 3, maxWriteAttempts: 2, retryBaseMs: 1000, retryMaxMs: 2000, runTimeoutMs: 10 * 60_000, staleRunMs: 15 * 60_000, lockWaitMs: 3000, replayCount: 5 });
const XML_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const nowIso = () => new Date().toISOString();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Consume source-layer classification; never infer transfer completeness from syntax. */
export function decideIngestionRetry(failure, attemptNumber, { remainingMs = Infinity } = {}) {
  const attemptLimit = failure.retryable ? 3 : 1;
  const retryAfterRaw = failure.retryAfterRaw ?? null;
  const retryAfterParsedMs = typeof retryAfterRaw === 'string' && /^\d+$/.test(retryAfterRaw.trim())
    ? Number(retryAfterRaw.trim()) * 1000 : null;
  let retryDecision = failure.retryable && attemptNumber < attemptLimit ? 'RETRY' : 'DO_NOT_RETRY';
  let delaySource = 'NONE'; let scheduledDelayMs = 0;
  if (retryDecision === 'RETRY') {
    if (failure.failureClass === 'RATE_LIMIT') {
      // Phase 8.1: honor the header within 30s/run deadline; otherwise exhausted.
      if (!Number.isSafeInteger(retryAfterParsedMs) || retryAfterParsedMs < 0 || retryAfterParsedMs > 30_000) retryDecision = 'DO_NOT_RETRY';
      else { delaySource = 'RETRY_AFTER'; scheduledDelayMs = retryAfterParsedMs; }
    } else { delaySource = 'DEFAULT_BACKOFF'; scheduledDelayMs = attemptNumber === 1 ? 1000 : 2000; }
    if (scheduledDelayMs >= remainingMs) { retryDecision = 'DO_NOT_RETRY'; delaySource = 'NONE'; scheduledDelayMs = 0; }
  }
  return { ...failure, attemptLimit, retryDecision, delaySource, scheduledDelayMs, retryAfterRaw, retryAfterParsedMs };
}

function classifyFetchFailure(error, stage) {
  const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 23
    || ['SOURCE_TIMEOUT', 'ETIMEDOUT'].includes(error?.code) || /aborted due to timeout|timed? out/i.test(error?.message ?? '');
  if (timeout) return { failureClass: 'SOURCE_TIMEOUT', reasonCode: 'SOURCE_TIMEOUT', retryable: true };
  const evidenceCode = error?.code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' ? error.code
    : error?.cause?.code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' ? error.cause.code : null;
  if (stage === 'BODY_READ' && evidenceCode) return { failureClass: 'PARTIAL_FETCH', reasonCode: 'PARTIAL_FETCH', retryable: true,
    transportEvidenceType: 'HTTP_CLIENT_RESPONSE_LENGTH_MISMATCH', transportEvidenceCode: evidenceCode };
  if (error?.fetchFailure) return error.fetchFailure;
  if (stage === 'PARSE') return { failureClass: 'MALFORMED_PAYLOAD', reasonCode: 'MALFORMED_PAYLOAD', retryable: false };
  const networkCodes = ['EAGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'];
  if (error?.name === 'TypeError' || networkCodes.includes(error?.code) || networkCodes.includes(error?.cause?.code))
    return { failureClass: 'NETWORK_TRANSIENT', reasonCode: 'NETWORK_TRANSIENT', retryable: true };
  return { failureClass: 'SOURCE_HTTP_REJECTED', reasonCode: error?.code ?? 'SOURCE_HTTP_REJECTED', retryable: false };
}

function decodeXml(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code) => {
    if (code[0] !== '#') return XML_ENTITIES[code.toLowerCase()] ?? whole;
    const n = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw fail('TEMPORARY_PARSE_FAILURE', 'Invalid XML character reference.');
    return String.fromCodePoint(n);
  });
}

/** Narrow, fail-closed parser for the official Atom feed shape. DTD/entity declarations are rejected. */
export function parseClaudeCodeAtomFeed(xml) {
  if (typeof xml !== 'string' || !xml.trim() || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw fail('TEMPORARY_PARSE_FAILURE', 'Feed is empty or contains a forbidden declaration.');
  const source = xml.replace(/^\uFEFF/, '').trim();
  const root = source.match(/^<\?xml\s+[^?]*\?>\s*<feed\b[^>]*>([\s\S]*)<\/feed>\s*$/i);
  if (!root) throw fail('TEMPORARY_PARSE_FAILURE', 'Expected one complete Atom feed root.');
  const body = root[1];
  const entries = [];
  let cursor = 0;
  const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  for (const match of body.matchAll(re)) {
    if (body.slice(cursor, match.index).replace(/<!--[\s\S]*?-->|\s|<updated\b[^>]*>[\s\S]*?<\/updated>/gi, '').includes('<entry')) throw fail('TEMPORARY_PARSE_FAILURE', 'Malformed nested Atom entry.');
    const block = match[1];
    const tag = (name) => {
      const found = [...block.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi'))];
      if (found.length !== 1) throw fail('TEMPORARY_PARSE_FAILURE', `Atom entry must have one ${name}.`);
      return decodeXml(found[0][1].replace(/<[^>]*>/g, '').trim());
    };
    const links = [...block.matchAll(/<link\b([^>]*)\/?\s*>/gi)];
    const alternate = links.find((row) => !/\brel\s*=\s*["'](?:self|enclosure|edit)["']/i.test(row[1]));
    const href = alternate?.[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) throw fail('TEMPORARY_PARSE_FAILURE', 'Atom entry has no link href.');
    entries.push({ id: tag('id'), title: tag('title'), updated: tag('updated'), link: decodeXml(href) });
    cursor = match.index + match[0].length;
  }
  const tail = body.slice(cursor).replace(/<!--[\s\S]*?-->|\s|<(?:id|title|updated)\b[^>]*>[\s\S]*?<\/(?:id|title|updated)>/gi, '');
  if (/<\/?entry\b/i.test(tail) || entries.length === 0) throw fail('TEMPORARY_PARSE_FAILURE', 'Feed entries are malformed or absent.');
  return entries;
}

async function syncedWrite(path, value, exclusive = true) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, exclusive ? 'wx' : 'w', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
async function appendSynced(path, record) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
}
const day = (iso) => iso.slice(0, 10);

export class ContinuousProductionIngestion {
  constructor({ stateDir = DEFAULT_PRODUCTION_REGISTRY_DIR, registryFactory = (options) => createProductionIdentityRegistry(options), fetchImpl = globalThis.fetch, clock = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), scheduler = INGESTION_SCHEDULER, hooks = {}, limits = INGESTION_LIMITS } = {}) {
    this.stateDir = stateDir; this.ingestionDir = join(dirname(stateDir), `${basename(stateDir)}-ingestion-runtime`); this.fetchImpl = fetchImpl; this.clock = clock; this.sleep = sleep; this.scheduler = scheduler; this.hooks = hooks; this.limits = limits;
    this.registry = registryFactory({ stateDir, authorized: true, enabled: false, runtimeMode: PRODUCTION_IDENTITY_MODE });
  }

  async control() {
    const path = join(this.ingestionDir, 'control.json');
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.version !== 1 || !['ENABLED', 'DISABLED'].includes(value.ingestion) || !['ENABLED', 'DISABLED'].includes(value.scheduler)) throw fail('CONTROL_STATE_INVALID');
      return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, ingestion: 'DISABLED', scheduler: 'DISABLED', changedAt: this.clock().toISOString(), reason: 'SAFE_DEFAULT' };
    }
  }
  async setControl(patch) {
    const current = await this.control();
    const next = { ...current, ...patch, changedAt: this.clock().toISOString() };
    await syncedWrite(join(this.ingestionDir, 'control.json'), json(next), false);
    if (next.ingestion === 'DISABLED') this.registry.disable();
    return next;
  }
  async enable() { return this.setControl({ ingestion: 'ENABLED', reason: 'OPERATOR_ENABLED' }); }
  async disable(reason = 'OPERATOR_DISABLED') { return this.setControl({ ingestion: 'DISABLED', scheduler: 'DISABLED', reason }); }
  async enableScheduler() { return this.setControl({ scheduler: 'ENABLED', schedulerEnabledAt: this.clock().toISOString(), reason: 'OPERATOR_SCHEDULER_ENABLED' }); }
  async disableScheduler() { return this.setControl({ scheduler: 'DISABLED', reason: 'OPERATOR_SCHEDULER_DISABLED' }); }

  async status() {
    const control = await this.control();
    return { source: INGESTION_SOURCE, scheduler: this.scheduler, ...control, runtime: await this.health() };
  }
  async verifyRegistry() {
    const pair = await this.registry.readPair();
    const [events, observations] = await Promise.all(['radar-event-registry.jsonl', 'radar-observation-registry.jsonl'].map(async (name) => readFile(join(this.stateDir, name)).catch((error) => error.code === 'ENOENT' ? Buffer.alloc(0) : Promise.reject(error))));
    return { valid: true, events: pair.events.length, observations: pair.observations.length, eventSha256: sha256(events), observationSha256: sha256(observations) };
  }
  async runHistory() {
    const root = join(this.ingestionDir, 'runs');
    const days = await readdir(root, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const byId = new Map();
    for (const entry of days.filter(row => row.isDirectory())) {
      const content = await readFile(join(root, entry.name, 'runs.jsonl'), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const row = JSON.parse(line);
          if (row.runId && row.completedAt) byId.set(row.runId, row);
        } catch { /* Run diagnostics do not override independent Registry validation. */ }
      }
    }
    return [...byId.values()].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  }
  async health() {
    const control = await this.control();
    let lockState = 'FREE';
    let owner;
    try { owner = JSON.parse(await readFile(join(this.ingestionDir, 'run.lock', 'owner.json'), 'utf8')); lockState = 'ACTIVE'; } catch {}
    let integrity = 'PASS'; let registry;
    try { registry = await this.verifyRegistry(); } catch (error) { integrity = 'FAIL'; registry = { code: error.code ?? 'REGISTRY_INVALID' }; }
    const last = await this.lastRun();
    const history = await this.runHistory();
    const latestRun = history.at(-1) ?? last;
    const latestSuccess = history.filter(row => row.finalStatus === 'RUN_SUCCESS').at(-1);
    let failureStreak = 0;
    for (const row of [...history].reverse()) { if (row.finalStatus === 'RUN_SUCCESS') break; failureStreak += 1; }
    const lastFailure = latestRun?.failures?.at(-1);
    const lastFailureReason = lastFailure?.reasonCode === 23 || /aborted due to timeout|timed? out/i.test(lastFailure?.errorMessage ?? '')
      ? 'SOURCE_TIMEOUT' : lastFailure?.reasonCode ?? latestRun?.lastFailureReason ?? last?.lastFailureReason ?? null;
    const stale = owner && this.clock().getTime() - Date.parse(owner.startedAt) > this.limits.staleRunMs;
    if (stale) await appendSynced(join(this.ingestionDir, 'runs', day(this.clock().toISOString()), 'runtime-audit.jsonl'), { at: this.clock().toISOString(), event: 'STALE_RUN', runId: owner.runId, startedAt: owner.startedAt }).catch(() => {});
    return { state: control.ingestion === 'DISABLED' ? 'DISABLED' : integrity !== 'PASS' || stale ? 'FAILED' : latestRun?.finalStatus === 'RUN_PARTIAL' ? 'DEGRADED' : 'HEALTHY', lastSuccessfulRun: latestSuccess?.completedAt ?? last?.lastSuccessfulRun ?? null, lastAttempt: latestRun?.startedAt ?? last?.startedAt ?? null, consecutiveFailures: failureStreak || latestRun?.consecutiveFailures || 0, lastFailureReason, lockState, registryIntegrity: integrity, registry, schedulerState: control.scheduler, staleRun: Boolean(stale) };
  }
  async lastRun() {
    const marker = join(this.ingestionDir, 'last-run.json');
    try { return JSON.parse(await readFile(marker, 'utf8')); } catch { return null; }
  }

  async fetchFeed({ runId = randomUUID(), failureId = null, fixtureId = null, testRunId = null, requireEnabled = false } = {}) {
    let lastError; let lastFailure;
    const started = this.clock().getTime();
    const guard = async () => {
      if (requireEnabled && (await this.control()).ingestion !== 'ENABLED') throw fail('INGESTION_DISABLED');
    };
    const auditPath = join(this.ingestionDir, 'runs', day(this.clock().toISOString()), 'fetch-attempts.jsonl');
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      await guard();
      const startedAt = this.clock().toISOString(); let stage = 'FETCH';
      try {
        const response = await this.fetchImpl(CLAUDE_CODE_OFFICIAL_FEED_URL, { headers: { accept: 'application/atom+xml, application/xml;q=0.9' }, signal: AbortSignal.timeout(20_000) });
        if (response.status === 429) throw Object.assign(fail('RATE_LIMIT'), { fetchFailure: { failureClass: 'RATE_LIMIT', reasonCode: 'RATE_LIMIT', retryable: true, retryAfterRaw: response.headers?.get?.('retry-after') ?? null } });
        if (response.status >= 500) throw Object.assign(fail('HTTP_SERVER_FAILURE'), { fetchFailure: { failureClass: 'HTTP_SERVER_FAILURE', reasonCode: 'HTTP_SERVER_FAILURE', retryable: true } });
        if (!response.ok) throw Object.assign(fail('SOURCE_HTTP_REJECTED'), { fetchFailure: { failureClass: 'HTTP_NON_SUCCESS', reasonCode: 'SOURCE_HTTP_REJECTED', retryable: false } });
        stage = 'BODY_READ';
        const text = await response.text();
        if (typeof text !== 'string' || !text.trim()) throw Object.assign(fail('EMPTY_RESPONSE'), { fetchFailure: { failureClass: 'EMPTY_RESPONSE', reasonCode: 'EMPTY_RESPONSE', retryable: false } });
        stage = 'PARSE';
        const rootName = text.replace(/^\uFEFF/, '').match(/^\s*(?:<\?xml[^?]*\?>\s*)?<([A-Za-z][\w:.-]*)\b/)?.[1];
        if (rootName && rootName.toLowerCase() !== 'feed') throw Object.assign(fail('SCHEMA_MISMATCH'), { fetchFailure: { failureClass: 'SCHEMA_MISMATCH', reasonCode: 'SCHEMA_MISMATCH', retryable: false } });
        const records = parseClaudeCodeAtomFeed(text);
        await guard();
        return { text, records, fetchedAt: this.clock().toISOString(), httpStatus: response.status };
      } catch (error) {
        if (error.code === 'INGESTION_DISABLED') throw error;
        lastError = error;
        const failure = classifyFetchFailure(error, stage);
        const remainingMs = this.limits.runTimeoutMs - (this.clock().getTime() - started);
        const decision = decideIngestionRetry(failure, attemptNumber, { remainingMs });
        lastFailure = decision;
        const row = { failureId, fixtureId, testRunId, runId, attemptNumber, startedAt, finishedAt: this.clock().toISOString(),
          ...decision, actualDelayMs: 0, writeIntentCount: 0, writeSuccessCount: 0,
          finalDisposition: decision.retryDecision === 'RETRY' ? 'ATTEMPT_FAILED_RETRY_SCHEDULED' : 'SOURCE_FETCH_FAILURE' };
        // Persist the decision before a timer; failure audit must never be reconstructed.
        await appendSynced(auditPath, { event: 'FETCH_ATTEMPT_DECISION', ...row });
        if (decision.retryDecision === 'DO_NOT_RETRY') break;
        const sleepStarted = Date.now();
        await this.sleep(decision.scheduledDelayMs);
        row.actualDelayMs = Date.now() - sleepStarted;
        try { await guard(); }
        catch (disabled) {
          await appendSynced(auditPath, { event: 'FETCH_RETRY_RESULT', ...row, finishedAt: this.clock().toISOString(), finalDisposition: 'INGESTION_DISABLED', actualDelayMs: row.actualDelayMs });
          throw disabled;
        }
        await appendSynced(auditPath, { event: 'FETCH_RETRY_RESULT', ...row, finishedAt: this.clock().toISOString() });
      }
    }
    const terminal = fail(lastFailure.reasonCode, String(lastError?.message ?? lastFailure.reasonCode));
    terminal.cause = lastError; terminal.errorName = lastError?.name ?? 'Error'; terminal.failureClass = lastFailure.failureClass;
    throw terminal;
  }

  async acquireLock(runId) {
    const lock = join(this.ingestionDir, 'run.lock');
    const deadline = this.clock().getTime() + this.limits.lockWaitMs;
    await mkdir(this.ingestionDir, { recursive: true, mode: 0o700 });
    do {
      try {
        await mkdir(lock, { mode: 0o700 });
        await syncedWrite(join(lock, 'owner.json'), json({ pid: process.pid, host: hostname(), startedAt: this.clock().toISOString(), runId }));
        return async () => {
          try { const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); if (owner.runId === runId && owner.pid === process.pid) await rm(lock, { recursive: true }); } catch {}
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw fail('LOCK_ACQUISITION_FAILED', error.message);
        let owner;
        try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); } catch { throw fail('RUN_ALREADY_ACTIVE', 'Existing lock owner is unreadable; fail closed.'); }
        if (owner.host !== hostname()) throw fail('RUN_ALREADY_ACTIVE', 'Lock is owned by a different host.');
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (!alive && this.clock().getTime() - Date.parse(owner.startedAt) > this.limits.staleRunMs) {
          const quarantine = `${lock}.stale-${owner.runId}-${randomUUID()}`;
          await rename(lock, quarantine).catch(() => {});
          await rm(quarantine, { recursive: true, force: true }).catch(() => {});
          await appendSynced(join(this.ingestionDir, 'runs', `${day(this.clock().toISOString())}`, 'runtime-audit.jsonl'), { at: this.clock().toISOString(), event: 'STALE_LOCK_RECOVERED', staleRunId: owner.runId, newRunId: runId });
          continue;
        }
        if (this.clock().getTime() >= deadline) throw fail('RUN_ALREADY_ACTIVE');
        await this.sleep(100);
      }
    } while (true);
  }

  captureObject(first, second) {
    const capture = {
      captureTimestamp: first.fetchedAt,
      source: { ...INGESTION_SOURCE, feedUrl: CLAUDE_CODE_OFFICIAL_FEED_URL, retrievalResult: 'CONTENT_RETURNED', httpStatus: first.httpStatus, rawSha256: sha256(first.text) },
      sourceRecords: first.records,
      secondCapture: { retrievalResult: 'CONTENT_RETURNED', fetchedAt: second.fetchedAt, httpStatus: second.httpStatus, rawSha256: sha256(second.text), sourceRecords: second.records },
      contentIntegrity: { algorithm: 'SHA-256', sha256: '' },
    };
    const payload = JSON.stringify({ captureTimestamp: capture.captureTimestamp, source: capture.source, sourceRecords: capture.sourceRecords, secondCapture: capture.secondCapture });
    capture.contentIntegrity.sha256 = sha256(payload);
    return capture;
  }

  async runOnce({ trigger = 'OPERATOR', schedulerContext = null, replayCount = 0, beforeCommit } = {}) {
    const initial = await this.control();
    if (initial.ingestion !== 'ENABLED') throw fail('INGESTION_DISABLED');
    if (trigger === 'SCHEDULER' && (initial.scheduler !== 'ENABLED' || !schedulerContext || schedulerContext.schedulerId !== this.scheduler.schedulerId || schedulerContext.scheduleVersion !== this.scheduler.scheduleVersion || schedulerContext.timezone !== this.scheduler.timezone)) throw fail('SCHEDULER_NOT_AUTHORIZED');
    const runId = randomUUID(); const startedAt = this.clock().toISOString(); const release = await this.acquireLock(runId);
    const summary = { runId, source: INGESTION_SOURCE, schedulerId: this.scheduler.schedulerId, scheduleVersion: this.scheduler.scheduleVersion, timezone: this.scheduler.timezone, scheduledAt: schedulerContext?.scheduledAt ?? null, startedAt, completedAt: null, captureHash: null, itemCount: 0, candidateReadyCount: 0, identityReadyCount: 0, writeIntentCount: 0, writeSuccessCount: 0, duplicateCount: 0, failureCount: 0, finalStatus: 'RUNNING', failures: [], replayPasses: 0 };
    let previous = await this.lastRun();
    try {
      await appendSynced(this.runAuditPath(startedAt), summary);
      const before = await this.registry.readPair();
      const backup = await this.registry.createBackup();
      const verifiedBackup = await this.registry.verifyBackup(backup.backupId);
      if (!verifiedBackup.valid) throw fail('BACKUP_VERIFICATION_FAILED');
      await this.restoreToIsolated(verifiedBackup);
      const first = await this.fetchFeed({ runId, requireEnabled: true });
      const second = await this.fetchFeed({ runId, requireEnabled: true });
      const capture = this.captureObject(first, second);
      const captureCheck = verifyClaudeCodeFeedCapture(capture);
      summary.captureHash = captureCheck.sha256; summary.itemCount = first.records.length;
      const capturePath = join(this.ingestionDir, 'captures', day(startedAt), `${runId}.json`);
      await syncedWrite(capturePath, json(capture));
      const immutableCapture = JSON.parse(await readFile(capturePath, 'utf8'));
      const persistedCheck = verifyClaudeCodeFeedCapture(immutableCapture);
      if (persistedCheck.sha256 !== summary.captureHash) throw fail('IMMUTABLE_CAPTURE_VERIFY_FAILED');
      if (first.records.length > this.limits.maxSourceItems) {
        summary.finalStatus = 'RUN_PARTIAL'; summary.failureCount = first.records.length - this.limits.maxSourceItems;
        summary.failures.push({ reasonCode: 'BACKPRESSURE_LIMIT_REACHED', remaining: summary.failureCount });
      }
      const count = Math.min(first.records.length, this.limits.maxSourceItems);
      const inputs = [];
      for (const row of immutableCapture.sourceRecords.slice(0, count)) {
        try {
          const out = createClaudeCodeFeedCandidate(row, { observedAt: capture.captureTimestamp });
          summary.candidateReadyCount += 1;
          if (out.identity?.status !== 'IDENTITY_READY') throw fail(out.identity?.reasonCode ?? 'IDENTITY_UNRESOLVED');
          summary.identityReadyCount += 1;
          const prepared = await this.registry.prepareInput({ candidateResult: out.candidateResult, identity: out.identity });
          inputs.push({ candidateResult: out.candidateResult, identity: out.identity, expectedObservationId: prepared.observationId });
        } catch (error) { summary.failureCount += 1; summary.failures.push({ item: row.id ?? null, reasonCode: error.code ?? 'ITEM_FAILED' }); }
      }
      for (const input of inputs) {
        if (summary.failureCount >= this.limits.maxRetryQueue) { summary.failures.push({ reasonCode: 'BACKPRESSURE_LIMIT_REACHED' }); break; }
        if ((await this.control()).ingestion !== 'ENABLED') { summary.failureCount += 1; summary.failures.push({ reasonCode: 'INGESTION_DISABLED_DURING_RUN' }); break; }
        await beforeCommit?.(summary);
        if ((await this.control()).ingestion !== 'ENABLED') { summary.failureCount += 1; summary.failures.push({ reasonCode: 'INGESTION_DISABLED_DURING_RUN' }); break; }
        if (this.clock().getTime() - Date.parse(startedAt) > this.limits.runTimeoutMs) { await this.disable('STALE_RUN'); throw fail('STALE_RUN'); }
        summary.writeIntentCount += 1;
        let result;
        for (let attempt = 1; attempt <= this.limits.maxWriteAttempts; attempt += 1) {
          this.registry.enabled = (await this.control()).ingestion === 'ENABLED';
          try { result = await this.registry.commit({ ...input, runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true }); break; }
          catch (error) {
            if (['REGISTRY_TEMPORARY_WRITE_FAILURE', 'EAGAIN', 'EBUSY'].includes(error.code) && attempt < this.limits.maxWriteAttempts) { await this.sleep(this.limits.retryBaseMs); continue; }
            summary.failureCount += 1; summary.failures.push({ eventKey: input.identity.eventKey, observationId: input.identity.observationId, reasonCode: error.code ?? 'ITEM_FAILED' }); break;
          }
        }
        if (result) { summary.writeSuccessCount += 1; if (result.registryDisposition === 'DUPLICATE_OBSERVATION') summary.duplicateCount += 1; }
        const writeFailure = summary.failures.at(-1)?.reasonCode;
        if (['PRODUCTION_REGISTRY_AUDIT_RESULT_MISSING', 'PRODUCTION_REGISTRY_AUDIT_UNAVAILABLE'].includes(writeFailure)) {
          await this.disable('AUDIT_FAILURE');
          break;
        }
        if (/REGISTRY_(?:CORRUPT|PAIR_|JSONL_|VALIDATION|JOURNAL|SNAPSHOT)/.test(writeFailure ?? '')) {
          await this.disable('REGISTRY_CORRUPTION');
          break;
        }
      }
      if (summary.failureCount > 0 && summary.finalStatus !== 'RUN_PARTIAL') summary.finalStatus = summary.writeSuccessCount > 0 ? 'RUN_PARTIAL' : 'RUN_FAILED';
      const afterInitial = await this.registry.readPair();
      const expectedGrowth = summary.writeSuccessCount > 0 ? null : { events: 0, observations: 0 };
      if (expectedGrowth && (afterInitial.events.length !== before.events.length || afterInitial.observations.length !== before.observations.length)) throw fail('UNEXPECTED_REGISTRY_GROWTH');
      for (let pass = 0; pass < replayCount; pass += 1) {
        for (const input of inputs) {
          if ((await this.control()).ingestion !== 'ENABLED') throw fail('INGESTION_DISABLED_DURING_REPLAY');
          this.registry.enabled = true;
          const replay = await this.registry.commit({ ...input, runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true });
          if (replay.observationId !== input.expectedObservationId || replay.eventKey !== input.identity.eventKey) throw fail('REPLAY_IDENTITY_MISMATCH');
          if (replay.registryDisposition !== 'DUPLICATE_OBSERVATION') throw fail('REPLAY_DISPOSITION_MISMATCH');
        }
        summary.replayPasses += 1;
      }
      const secondFetch = await this.fetchFeed({ runId, requireEnabled: true });
      const after = await this.registry.readPair();
      if (after.events.length !== afterInitial.events.length || after.observations.length !== afterInitial.observations.length) throw fail('UNEXPECTED_REGISTRY_GROWTH');
      summary.finalStatus = summary.failureCount ? (summary.writeSuccessCount ? 'RUN_PARTIAL' : 'RUN_FAILED') : 'RUN_SUCCESS';
      summary.eventCount = after.events.length; summary.observationCount = after.observations.length;
      summary.newEvents = after.events.length - before.events.length; summary.newObservations = after.observations.length - before.observations.length;
      summary.secondFetchSha256 = sha256(secondFetch.text);
      if (summary.finalStatus === 'RUN_SUCCESS' && summary.replayPasses < replayCount) throw fail('REPLAY_INCOMPLETE');
    } catch (error) {
      const reasonCode = error.code ?? 'RUN_FAILED';
      summary.failureCount += 1;
      summary.failures.push({ reasonCode, errorName: error.name ?? 'Error', errorMessage: String(error.message ?? reasonCode).slice(0, 300) });
      summary.finalStatus = summary.writeSuccessCount ? 'RUN_PARTIAL' : 'RUN_FAILED';
    } finally {
      summary.completedAt = this.clock().toISOString();
      summary.consecutiveFailures = summary.finalStatus === 'RUN_SUCCESS' ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
      summary.lastFailureReason = summary.failures.at(-1)?.reasonCode ?? null;
      const priorSuccess = (await this.runHistory().catch(() => [])).filter(row => row.finalStatus === 'RUN_SUCCESS').at(-1);
      summary.lastSuccessfulRun = summary.finalStatus === 'RUN_SUCCESS' ? summary.completedAt : priorSuccess?.completedAt ?? previous?.lastSuccessfulRun ?? null;
      try { await appendSynced(this.runAuditPath(startedAt), summary); }
      catch { summary.finalStatus = 'RUN_FAILED'; summary.failureCount += 1; summary.lastFailureReason = 'RUN_AUDIT_WRITE_FAILED'; await this.disable('AUDIT_FAILURE').catch(() => {}); }
      await syncedWrite(join(this.ingestionDir, 'last-run.json'), json(summary), false).catch(() => {});
      await release();
    }
    return summary;
  }

  runAuditPath(iso) { return join(this.ingestionDir, 'runs', day(iso), 'runs.jsonl'); }

  async restoreToIsolated(backup) {
    const tempRoot = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(tmpdir(), 'horizon-ingest-restore-')));
    const isolatedPath = join(tempRoot, 'radar-v2-prod-identity-dev-claude-code');
    try {
      await mkdir(join(isolatedPath, 'audit'), { recursive: true, mode: 0o700 });
      await writeFile(join(isolatedPath, '.horizon-production-registry-v1.json'), backup.metadataBytes, { mode: 0o600 });
      await writeFile(join(isolatedPath, 'radar-event-registry.jsonl'), backup.eventBytes, { mode: 0o600 });
      await writeFile(join(isolatedPath, 'radar-observation-registry.jsonl'), backup.observationBytes, { mode: 0o600 });
      const isolated = createProductionIdentityRegistry({ stateDir: isolatedPath, authorized: true, enabled: false });
      const pair = await isolated.readPair();
      if (pair.events.length !== backup.pair.events.length || pair.observations.length !== backup.pair.observations.length) throw fail('BACKUP_RESTORE_VALIDATION_FAILED');
      return { valid: true, events: pair.events.length, observations: pair.observations.length };
    } finally { await rm(tempRoot, { recursive: true, force: true }); }
  }

  async schedulerTrigger({ scheduledAt = this.clock().toISOString() } = {}) {
    await this.setControl({ scheduler: 'ENABLED', schedulerEnabledAt: this.clock().toISOString() });
    try {
      return await this.runOnce({ trigger: 'SCHEDULER', schedulerContext: { ...this.scheduler, scheduledAt }, replayCount: 0 });
    } finally { await this.disable('SCHEDULER_VALIDATION_COMPLETE'); }
  }

  async schedulerDispatch({ scheduledAt = this.clock().toISOString() } = {}) {
    const control = await this.control();
    if (control.scheduler !== 'ENABLED') throw fail('SCHEDULER_DISABLED');
    return this.runOnce({ trigger: 'SCHEDULER', schedulerContext: { ...this.scheduler, scheduledAt }, replayCount: 0 });
  }

  /** Scheduler acceptance probe: fetch and validate real source data without opening or mutating the Registry. */
  async schedulerDryRun({ scheduledAt = this.clock().toISOString() } = {}) {
    const initial = await this.control();
    if (initial.scheduler !== 'ENABLED') throw fail('SCHEDULER_DISABLED');
    if (initial.ingestion !== 'DISABLED') throw fail('DRY_RUN_REQUIRES_INGESTION_DISABLED');
    const runId = randomUUID(); const startedAt = this.clock().toISOString(); const release = await this.acquireLock(runId);
    const result = { runId, trigger: 'SCHEDULER_DRY_RUN', schedulerId: this.scheduler.schedulerId, scheduleVersion: this.scheduler.scheduleVersion, timezone: this.scheduler.timezone, scheduledAt, startedAt, completedAt: null, source: INGESTION_SOURCE, sourceUrl: CLAUDE_CODE_OFFICIAL_FEED_URL, readOnly: true, registryAccess: 'NONE', captureHash: null, capturePath: null, itemCount: 0, candidateReadyCount: 0, evidenceReadyCount: 0, identityReadyCount: 0, finalStatus: 'RUNNING', failures: [] };
    try {
      await appendSynced(join(this.ingestionDir, 'scheduler-dry-runs', day(startedAt), 'runs.jsonl'), result);
      const first = await this.fetchFeed({ runId });
      const second = await this.fetchFeed({ runId });
      const capture = this.captureObject(first, second);
      const check = verifyClaudeCodeFeedCapture(capture);
      result.captureHash = check.sha256; result.itemCount = first.records.length;
      const capturePath = join(this.ingestionDir, 'captures', day(startedAt), `${runId}.json`);
      await syncedWrite(capturePath, json(capture));
      const persisted = JSON.parse(await readFile(capturePath, 'utf8'));
      if (verifyClaudeCodeFeedCapture(persisted).sha256 !== result.captureHash) throw fail('IMMUTABLE_CAPTURE_VERIFY_FAILED');
      result.capturePath = capturePath;
      for (const row of persisted.sourceRecords.slice(0, this.limits.maxSourceItems)) {
        const prepared = createClaudeCodeFeedCandidate(row, { observedAt: capture.captureTimestamp });
        if (prepared.candidateResult.status !== 'CANDIDATE_READY') {
          result.failures.push({ item: row.id, reasonCode: prepared.candidateResult.receiptReasons[0] ?? 'CANDIDATE_NOT_READY' });
          continue;
        }
        result.candidateReadyCount += 1;
        result.evidenceReadyCount += 1;
        if (prepared.identity?.status === 'IDENTITY_READY') result.identityReadyCount += 1;
        else result.failures.push({ item: row.id, reasonCode: prepared.identity?.reasonCode ?? 'IDENTITY_UNRESOLVED' });
      }
      if (first.records.length > this.limits.maxSourceItems) result.failures.push({ reasonCode: 'BACKPRESSURE_LIMIT_REACHED', remaining: first.records.length - this.limits.maxSourceItems });
      if ((await this.control()).ingestion !== 'DISABLED') throw fail('DRY_RUN_INGESTION_STATE_CHANGED');
      result.finalStatus = result.failures.length === 0 && result.itemCount > 0 && result.identityReadyCount === result.itemCount ? 'DRY_RUN_SUCCESS' : 'DRY_RUN_FAILED';
    } catch (error) {
      result.finalStatus = 'DRY_RUN_FAILED';
      result.failures.push({ reasonCode: error.code ?? 'DRY_RUN_FAILED', errorName: error.name ?? 'Error', errorMessage: String(error.message ?? error.code ?? 'DRY_RUN_FAILED').slice(0, 300) });
    } finally {
      result.completedAt = this.clock().toISOString();
      await appendSynced(join(this.ingestionDir, 'scheduler-dry-runs', day(startedAt), 'runs.jsonl'), result).catch(() => {});
      await syncedWrite(join(this.ingestionDir, 'last-scheduler-dry-run.json'), json(result), false).catch(() => {});
      await release();
    }
    return result;
  }
}

export function createContinuousProductionIngestion(options = {}) { return new ContinuousProductionIngestion(options); }
