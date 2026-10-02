import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schema = JSON.parse(readFileSync(new URL('./handoff-schema-v1.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateEnvelope = ajv.compile(schema);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const duplicateKeyToken = Symbol('duplicate-json-key');

/** Strict JSON reader that rejects duplicate object keys before they can be collapsed by JSON.parse. */
export function parseJsonNoDuplicateKeys(text) {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const fail = () => { throw new SyntaxError(`INVALID_JSON_AT_${i}`); };
  const string = () => {
    if (text[i] !== '"') fail();
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return JSON.parse(text.slice(start, i));
      if (c === '\\') { if (i >= text.length) fail(); i++; }
      else if (c.charCodeAt(0) < 0x20) fail();
    }
    fail();
  };
  const value = () => {
    ws();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; ws(); const obj = Object.create(null); const seen = new Set();
      if (text[i] === '}') { i++; return obj; }
      while (i < text.length) {
        ws(); const key = string();
        if (seen.has(key)) throw Object.assign(new SyntaxError('DUPLICATE_JSON_KEY'), { code: duplicateKeyToken });
        seen.add(key); ws(); if (text[i++] !== ':') fail();
        obj[key] = value(); ws();
        if (text[i] === '}') { i++; return obj; }
        if (text[i++] !== ',') fail();
      }
      fail();
    }
    if (text[i] === '[') {
      i++; ws(); const arr = [];
      if (text[i] === ']') { i++; return arr; }
      while (i < text.length) { arr.push(value()); ws(); if (text[i] === ']') { i++; return arr; } if (text[i++] !== ',') fail(); }
      fail();
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, i)) { i += literal.length; return parsed; }
    }
    const match = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail();
    i += match[0].length; const number = Number(match[0]); if (!Number.isFinite(number)) fail(); return number;
  };
  const out = value(); ws(); if (i !== text.length) fail(); return out;
}

function assertUnicode(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('JCS_INVALID_UNICODE');
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError('JCS_INVALID_UNICODE');
  }
}

/** RFC 8785 JCS serialization for JSON data (ECMAScript number/string serialization and UTF-16 key order). */
export function canonicalizeJcs(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { assertUnicode(value); return JSON.stringify(value); }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS_NONFINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJcs).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    for (const key of keys) assertUnicode(key);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJcs(value[key])}`).join(',')}}`;
  }
  throw new TypeError('JCS_NON_JSON_VALUE');
}

const secretPatterns = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /(?:authorization|cookie|set-cookie)\s*:/i,
  /\/(?:Users|home)\/[^\s"']+/,
  /file:\/\//i,
];

function scanValue(value, path = '$', findings = []) {
  if (typeof value === 'string') {
    if (value.length > 8192) findings.push(`${path}:FIELD_SIZE_LIMIT`);
    for (const pattern of secretPatterns) if (pattern.test(value)) findings.push(`${path}:PRIVACY_OR_SECRET_PATTERN`);
  } else if (Array.isArray(value)) value.forEach((item, i) => scanValue(item, `${path}[${i}]`, findings));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) scanValue(item, `${path}.${key}`, findings);
  return findings;
}

function validateBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) || Object.keys(batch).sort().join(',') !== 'manifest,records') return { valid: false, code: 'HANDOFF_BATCH_SCHEMA_INVALID' };
  const { manifest, records } = batch;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(records)) return { valid: false, code: 'HANDOFF_BATCH_SCHEMA_INVALID' };
  const required = ['handoffVersion', 'radar', 'runId', 'collectorVersion', 'recordCount', 'recordsSha256', 'createdAt'];
  if (Object.keys(manifest).sort().join(',') !== [...required].sort().join(',') || manifest.handoffVersion !== '1.0'
    || !['AI', 'DEV', 'APP', 'SEC'].includes(manifest.radar) || !Number.isInteger(manifest.recordCount)
    || manifest.recordCount !== records.length || typeof manifest.recordsSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.recordsSha256)
    || typeof manifest.collectorVersion !== 'string' || !manifest.collectorVersion || !Number.isFinite(Date.parse(manifest.createdAt))) return { valid: false, code: 'HANDOFF_MANIFEST_INVALID' };
  if (records.length > 1000) return { valid: false, code: 'HANDOFF_RECORD_LIMIT' };
  for (const record of records) {
    if (!validateEnvelope(record)) return { valid: false, code: 'HANDOFF_RECORD_SCHEMA_INVALID', diagnostics: validateEnvelope.errors.map((e) => e.keyword) };
    if (!record.observedAt.endsWith('Z') || record.radar !== manifest.radar || record.runId !== manifest.runId
      || record.versions.collectorVersion !== manifest.collectorVersion) return { valid: false, code: 'HANDOFF_RECORD_MANIFEST_MISMATCH' };
    const findings = scanValue(record);
    if (findings.length) return { valid: false, code: findings.some((x) => x.endsWith('FIELD_SIZE_LIMIT')) ? 'HANDOFF_FIELD_SIZE_LIMIT' : 'HANDOFF_PRIVACY_SCAN_REJECTED', diagnostics: findings.slice(0, 8) };
  }
  const actual = hash(Buffer.from(canonicalizeJcs(records), 'utf8'));
  if (actual !== manifest.recordsSha256) return { valid: false, code: 'HANDOFF_CHECKSUM_MISMATCH', expected: manifest.recordsSha256, actual };
  return { valid: true, manifest, records, recordsSha256: actual };
}

export function validateHandoffBatchBytes(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!raw.length) return { valid: false, code: 'HANDOFF_EMPTY' };
  if (raw.length > 10 * 1024 * 1024) return { valid: false, code: 'HANDOFF_SIZE_LIMIT', digest: hash(raw), byteLength: raw.length };
  let parsed;
  try { parsed = parseJsonNoDuplicateKeys(raw.toString('utf8')); }
  catch (error) { return { valid: false, code: error.code === duplicateKeyToken ? 'HANDOFF_DUPLICATE_JSON_KEY' : 'HANDOFF_INVALID_JSON', digest: hash(raw), byteLength: raw.length }; }
  return { ...validateBatch(parsed), digest: hash(raw), byteLength: raw.length };
}

/**
 * Runtime variant: validate the batch envelope/checksum once, then isolate each
 * row's schema/provenance result so one malformed candidate cannot discard its
 * valid siblings. The handoff schema and its field semantics remain unchanged.
 */
export function validateHandoffBatchForRuntime(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!raw.length) return { valid: false, code: 'HANDOFF_EMPTY' };
  if (raw.length > 10 * 1024 * 1024) return { valid: false, code: 'HANDOFF_SIZE_LIMIT', digest: hash(raw), byteLength: raw.length };
  let batch;
  try { batch = parseJsonNoDuplicateKeys(raw.toString('utf8')); }
  catch (error) { return { valid: false, code: error.code === duplicateKeyToken ? 'HANDOFF_DUPLICATE_JSON_KEY' : 'HANDOFF_INVALID_JSON', digest: hash(raw), byteLength: raw.length }; }
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) || Object.keys(batch).sort().join(',') !== 'manifest,records') return { valid: false, code: 'HANDOFF_BATCH_SCHEMA_INVALID', digest: hash(raw), byteLength: raw.length };
  const { manifest, records } = batch;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(records)) return { valid: false, code: 'HANDOFF_BATCH_SCHEMA_INVALID', digest: hash(raw), byteLength: raw.length };
  const required = ['handoffVersion', 'radar', 'runId', 'collectorVersion', 'recordCount', 'recordsSha256', 'createdAt'];
  if (Object.keys(manifest).sort().join(',') !== [...required].sort().join(',') || manifest.handoffVersion !== '1.0'
    || !['AI', 'DEV', 'APP', 'SEC'].includes(manifest.radar) || typeof manifest.runId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(manifest.runId)
    || typeof manifest.collectorVersion !== 'string' || !manifest.collectorVersion
    || !Number.isInteger(manifest.recordCount) || manifest.recordCount !== records.length || records.length > 1000
    || typeof manifest.recordsSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.recordsSha256)
    || !Number.isFinite(Date.parse(manifest.createdAt))) return { valid: false, code: 'HANDOFF_MANIFEST_INVALID', digest: hash(raw), byteLength: raw.length };
  const actual = hash(Buffer.from(canonicalizeJcs(records), 'utf8'));
  if (actual !== manifest.recordsSha256) return { valid: false, code: 'HANDOFF_CHECKSUM_MISMATCH', digest: hash(raw), byteLength: raw.length, expected: manifest.recordsSha256, actual };
  const rowResults = records.map((record) => {
    if (!validateEnvelope(record)) return { valid: false, code: record?.radar === 'SKILL' ? 'SKILL_STRUCTURED_INPUT_UNAVAILABLE' : 'HANDOFF_RECORD_SCHEMA_INVALID', diagnostics: (validateEnvelope.errors ?? []).map((e) => e.keyword) };
    if (!record.observedAt.endsWith('Z') || record.radar !== manifest.radar || record.runId !== manifest.runId || record.versions.collectorVersion !== manifest.collectorVersion) return { valid: false, code: 'HANDOFF_RECORD_MANIFEST_MISMATCH' };
    const findings = scanValue(record);
    if (findings.length) return { valid: false, code: findings.some((x) => x.endsWith('FIELD_SIZE_LIMIT')) ? 'HANDOFF_FIELD_SIZE_LIMIT' : 'HANDOFF_PRIVACY_SCAN_REJECTED', diagnostics: findings.slice(0, 8) };
    return { valid: true };
  });
  return { valid: true, manifest, records, rowResults, recordsSha256: actual, digest: hash(raw), byteLength: raw.length };
}

export const handoffSchemaSha256 = hash(readFileSync(new URL('./handoff-schema-v1.json', import.meta.url)));
