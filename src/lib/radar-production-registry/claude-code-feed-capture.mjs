import { createHash } from 'node:crypto';
import { adaptProductionCandidate } from '../radar-candidate-adapter/adapters.ts';
import { resolveClaudeCodeChangelogIdentity, CLAUDE_CODE_SOURCE_IDENTIFIER } from '../radar-canary/claude-code-identity.mjs';

export const CLAUDE_CODE_OFFICIAL_FEED_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/feed.xml';
const TAG = /^v?\d+\.\d+\.\d+$/;
const RELEASE_URL = /^https:\/\/github\.com\/anthropics\/claude-code\/releases\/tag\/(v?\d+\.\d+\.\d+)$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message = code) => Object.assign(new Error(message), { code });

function captureHashPayload(capture) {
  return JSON.stringify({
    captureTimestamp: capture.captureTimestamp,
    source: capture.source,
    sourceRecords: capture.sourceRecords,
    secondCapture: capture.secondCapture,
  });
}

/** Validate the immutable materialized source capture before any Registry access. */
export function verifyClaudeCodeFeedCapture(capture) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) throw fail('PRODUCTION_CAPTURE_INVALID');
  if (capture.source?.sourceIdentifier !== CLAUDE_CODE_SOURCE_IDENTIFIER
    || capture.source?.feedUrl !== CLAUDE_CODE_OFFICIAL_FEED_URL
    || capture.source?.retrievalResult !== 'CONTENT_RETURNED'
    || !Array.isArray(capture.sourceRecords) || capture.sourceRecords.length === 0) {
    throw fail('PRODUCTION_CAPTURE_SOURCE_INVALID');
  }
  if (!capture.secondCapture || capture.secondCapture.retrievalResult !== 'CONTENT_RETURNED'
    || !Array.isArray(capture.secondCapture.sourceRecords)) throw fail('PRODUCTION_CAPTURE_SECOND_READ_INVALID');
  const expected = sha256(captureHashPayload(capture));
  if (capture.contentIntegrity?.algorithm !== 'SHA-256' || capture.contentIntegrity.sha256 !== expected) {
    throw fail('PRODUCTION_CAPTURE_HASH_MISMATCH');
  }
  for (const row of [...capture.sourceRecords, ...capture.secondCapture.sourceRecords]) projectClaudeCodeAtomEntry(row);
  return { valid: true, sha256: expected, firstCount: capture.sourceRecords.length, secondCount: capture.secondCapture.sourceRecords.length };
}

/** Project one exact official Atom release entry into the existing source-owned Candidate Adapter shape. */
export function projectClaudeCodeAtomEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.id !== 'string' || typeof entry.link !== 'string'
    || typeof entry.title !== 'string' || typeof entry.updated !== 'string') {
    throw fail('PRODUCTION_CAPTURE_ENTRY_INVALID');
  }
  if (entry.id !== entry.link) throw fail('PRODUCTION_CAPTURE_ENTRY_LINK_MISMATCH');
  const match = entry.link.match(RELEASE_URL);
  if (!match || !TAG.test(match[1])) throw fail('PRODUCTION_CAPTURE_ENTRY_URL_INVALID');
  if (!Number.isFinite(Date.parse(entry.updated)) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(entry.updated)) {
    throw fail('PRODUCTION_CAPTURE_ENTRY_TIME_INVALID');
  }
  return {
    tag_name: match[1],
    name: entry.title,
    html_url: entry.link,
    atom: { id: entry.id, updated: entry.updated },
  };
}

export function createClaudeCodeFeedCandidate(entry, { observedAt } = {}) {
  const record = projectClaudeCodeAtomEntry(entry);
  const candidateResult = adaptProductionCandidate({ radar: 'DEV', sourceName: 'Claude Code Changelog', record }, { observedAt });
  const identity = candidateResult.candidate ? resolveClaudeCodeChangelogIdentity(candidateResult.candidate) : null;
  return { candidateResult, identity };
}
