// Trusted Head — independent monotonic persistence for Domain Snapshot stores.
//
// Selected mechanism (minimal, uses existing local infrastructure): the macOS
// Keychain holds one generic-password item per store id whose secret is the
// trusted head record (JSON). The Keychain is OS-managed storage outside the
// store's ordinary writable files; its creation timestamp ("cdat") is readable
// and makes delete+recreate of the item detectable. The store verifies its own
// anchor against this record at every cut() and advances it atomically inside
// its exclusive lock; any mismatch — state rollback, old snapshot replay,
// divergent anchor — fails closed.
//
// Threat-model boundary (honest): a same-user process can still rewrite the
// Keychain item; such rewrites are DETECTABLE (creation-timestamp vs init
// receipt cross-check + monotonic chaining), not prevented. This module never
// grants production authorization and never creates production anchors.
import {execFileSync} from 'node:child_process';
import {canonical, sha256} from '../radar-judgment/provider.mjs';

const fail = (code) => { throw Object.assign(new Error(code), {code}); };
const RECORD_VERSION = '1.0';

export const TRUSTED_HEAD_SERVICE = 'horizon.trusted-head.v1';
export const TRUSTED_HEAD_SERVICE_TEST = 'horizon.trusted-head.v1.test';

function parseCdatHex(hex) {
  const ascii = Buffer.from(hex, 'hex').toString('utf8').replace(/\0+$/, '');
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(ascii);
  if (!m) fail('TRUSTED_HEAD_CDAT_UNPARSEABLE');
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/** macOS Keychain backend via /usr/bin/security (non-interactive; item ACL bound to the CLI). */
export class KeychainBackend {
  constructor({service = TRUSTED_HEAD_SERVICE} = {}) { this.service = service; }
  account(storeId) { return `trusted-head:${storeId}`; }
  async read(storeId) {
    try {
      const secret = execFileSync('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', this.account(storeId), '-w'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
      return {exists: true, record: JSON.parse(secret)};
    } catch (e) {
      if (e.status === 44 || String(e.stderr ?? '').includes('could not be found')) return {exists: false};
      throw e;
    }
  }
  async creationTimestamp(storeId) {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', this.account(storeId)], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    const m = /"cdat"<timedate>=[^"]*"?(\d{14})Z/.exec(out);
    if (!m) fail('TRUSTED_HEAD_CDAT_UNAVAILABLE');
    const d = m[1];
    return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${d.slice(8,10)}:${d.slice(10,12)}:${d.slice(12,14)}Z`;
  }
  async write(storeId, record) {
    execFileSync('/usr/bin/security', ['add-generic-password', '-s', this.service, '-a', this.account(storeId), '-w', JSON.stringify(record), '-U'], {stdio: ['ignore', 'pipe', 'pipe']});
  }
  async delete(storeId) {
    try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', this.service, '-a', this.account(storeId)], {stdio: ['ignore', 'pipe', 'pipe']}); } catch {}
  }
}

/** In-memory backend for isolated tests: same interface; delete+recreate bumps creationStamp. */
export class InMemoryBackend {
  constructor({clock} = {}) { this.items = new Map(); this.clock = clock ?? (() => new Date().toISOString()); }
  account(storeId) { return `trusted-head:${storeId}`; }
  async read(storeId) {
    const it = this.items.get(storeId);
    return it ? {exists: true, record: JSON.parse(JSON.stringify(it.record))} : {exists: false};
  }
  async creationTimestamp(storeId) { return this.items.get(storeId)?.creationStamp ?? null; }
  async write(storeId, record) {
    const prior = this.items.get(storeId);
    this.items.set(storeId, {record: JSON.parse(JSON.stringify(record)), creationStamp: prior?.creationStamp ?? this.clock()});
  }
  async delete(storeId) { this.items.delete(storeId); }
}

/**
 * Monotonic trusted head over a backend.
 * initialize() refuses overwrite; advance() requires the exact expected
 * (generation, headHash) — stale expectations are rejected, so rolled-back
 * store state and replayed old snapshots fail closed. verifyStoreHead() is
 * the Store-side enforcement boundary called from every cut().
 */
export class TrustedHead {
  constructor({backend, storeId, environment, recordVersion = RECORD_VERSION} = {}) {
    if (!backend || !storeId || !environment) fail('TRUSTED_HEAD_CONFIGURATION_INVALID');
    this.backend = backend; this.storeId = storeId; this.environment = environment; this.recordVersion = recordVersion;
  }
  record(headHash, generation, previousHeadHash, reason) {
    return {recordVersion: this.recordVersion, storeId: this.storeId, environment: this.environment, generation, headHash, previousHeadHash, updatedAt: new Date().toISOString(), lastReason: reason ?? null};
  }
  async initialize({generation = 0, headHash = null} = {}) {
    const prior = await this.backend.read(this.storeId);
    if (prior.exists) fail('TRUSTED_HEAD_ALREADY_INITIALIZED');
    const record = this.record(headHash, generation, null, 'INITIALIZE');
    await this.backend.write(this.storeId, record);
    const creationTimestamp = await this.backend.creationTimestamp?.(this.storeId) ?? null;
    return {receipt: {initRecordHash: sha256(canonical(record)), creationTimestamp, generation, headHash}};
  }
  async read() {
    const item = await this.backend.read(this.storeId);
    if (!item.exists) fail('TRUSTED_HEAD_UNINITIALIZED');
    return item.record;
  }
  async creationTimestamp() { return await this.backend.creationTimestamp?.(this.storeId) ?? null; }
  async advance({expectedGeneration, expectedHeadHash, nextHeadHash, reason} = {}) {
    const cur = await this.read();
    if (cur.generation !== expectedGeneration || (expectedHeadHash !== undefined && cur.headHash !== expectedHeadHash)) fail('TRUSTED_HEAD_STATE_MISMATCH');
    if (nextHeadHash !== null && typeof nextHeadHash !== 'string') fail('TRUSTED_HEAD_HASH_INVALID');
    const next = this.record(nextHeadHash, cur.generation + 1, cur.headHash, reason ?? 'ADVANCE');
    await this.backend.write(this.storeId, next);
    return next;
  }
  async verifyStoreHead({generation, headHash}) {
    const cur = await this.read();
    if (cur.generation === generation && cur.headHash === headHash) return {ok: true};
    if (cur.generation + 1 === generation) return {ok: false, code: 'TRUSTED_HEAD_RECOVERY_CANDIDATE', keychain: cur};
    return {ok: false, code: 'TRUSTED_HEAD_STATE_MISMATCH', keychain: cur};
  }
}
