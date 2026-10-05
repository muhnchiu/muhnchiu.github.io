import { buildEventKey } from '../radar-event-identity.mjs';

export const CLAUDE_CODE_IDENTITY_RESOLVER_VERSION = '1.0.0';
export const CLAUDE_CODE_SOURCE_IDENTIFIER = 'github.com/anthropics/claude-code';

const TAG = /^v?(\d+\.\d+\.\d+)$/;
const RELEASE_URL = /^\/anthropics\/claude-code\/releases\/tag\/(v?\d+\.\d+\.\d+)$/;

const unresolved = (reasonCode) => ({ status: 'IDENTITY_UNRESOLVED', reasonCode });

/**
 * Source-scoped resolver for official Claude Code GitHub releases.
 * It consumes an already validated Candidate Adapter result and never reads Registry state.
 */
export function resolveClaudeCodeChangelogIdentity(candidate) {
  if (!candidate || candidate.radar !== 'DEV' || candidate.sourceName !== 'Claude Code Changelog') return unresolved('SOURCE_NOT_ALLOWLISTED');
  if (candidate.sourceAuthority !== 'official' || candidate.sourceLevel !== 'official') return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');
  if (!candidate.observedAt || !Number.isFinite(Date.parse(candidate.observedAt))) return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');

  const record = candidate.rawSourceMetadata?.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');
  if (typeof record.tag_name !== 'string' || !TAG.test(record.tag_name)) return unresolved('STABLE_IDENTIFIER_MISSING');
  if (typeof candidate.itemUrl !== 'string') return unresolved('SOURCE_ITEM_URL_MISSING');

  let url;
  try { url = new URL(candidate.itemUrl); } catch { return unresolved('SOURCE_ITEM_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) {
    return unresolved('SOURCE_ITEM_URL_INVALID');
  }
  const urlMatch = url.pathname.match(RELEASE_URL);
  if (!urlMatch) return unresolved('SOURCE_NOT_ALLOWLISTED');
  if (urlMatch[1] !== record.tag_name) return unresolved('SOURCE_TAG_MISMATCH');
  if (candidate.itemIdentifier !== record.tag_name) return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');

  const version = record.tag_name.match(TAG)?.[1];
  if (!version) return unresolved('STABLE_IDENTIFIER_MISSING');
  const entity = 'claude-code';
  const canonicalEventType = 'version-update';
  let eventKey;
  try { eventKey = buildEventKey({ entity, canonicalEventType, eventIdentifier: version }); }
  catch { return unresolved('IDENTITY_RULE_REJECTED'); }

  const evidenceRef = candidate.itemUrl;
  const identityProvenance = {
    entity: {
      value: entity,
      authority: 'GITHUB_OFFICIAL_RELEASE_SOURCE',
      sourceField: 'html_url repository path /anthropics/claude-code',
      method: 'EXACT_REPOSITORY_ALLOWLIST',
      observedAtRelationship: 'OBSERVED_AT_EXCLUDED_FROM_IDENTITY',
      policyVersion: 'CLAUDE_CODE_IDENTITY_SOURCE_SLICE_1.0.0',
      evidenceRef,
    },
    canonicalEventType: {
      value: canonicalEventType,
      authority: 'EVENT_POLICY_1.0',
      sourceField: 'tag_name',
      method: 'FROZEN_CLAUDE_CODE_VERSIONED_RELEASE_RULE',
      observedAtRelationship: 'OBSERVED_AT_EXCLUDED_FROM_IDENTITY',
      policyVersion: '1.0',
      evidenceRef,
    },
    eventIdentifier: {
      value: version,
      authority: 'GITHUB_OFFICIAL_RELEASE_SOURCE',
      sourceField: 'tag_name validated against html_url release tag',
      method: 'STRIP_LEADING_V_FROM_VERSION_TAG',
      observedAtRelationship: 'OBSERVED_AT_EXCLUDED_FROM_IDENTITY',
      policyVersion: 'EVENT_POLICY_1.0',
      evidenceRef,
    },
  };

  return {
    status: 'IDENTITY_READY',
    sourceIdentifier: CLAUDE_CODE_SOURCE_IDENTIFIER,
    entity,
    canonicalEventType,
    eventIdentifier: version,
    eventKey,
    version,
    identityProvenance,
    resolverVersion: CLAUDE_CODE_IDENTITY_RESOLVER_VERSION,
  };
}
