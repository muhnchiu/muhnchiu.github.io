import { buildEventKey } from '../radar-event-identity.mjs';

export const ARXIV_IDENTITY_RESOLVER_VERSION = '1.0.0';
export const ARXIV_SOURCE_IDENTIFIER = 'export.arxiv.org/api/query:cat:cs.LG';
const VERSIONED_ID = /^(\d{4}\.\d{4,5})(?:v([1-9]\d*))?$/;
const unresolved = (reasonCode) => ({ status: 'IDENTITY_UNRESOLVED', reasonCode });

/** Resolve only official arXiv cs.LG Atom API candidates, without Registry reads. */
export function resolveArxivCsLgIdentity(candidate) {
  if (!candidate || candidate.radar !== 'AI' || candidate.sourceName !== 'arXiv cs.LG') return unresolved('SOURCE_NOT_ALLOWLISTED');
  if (candidate.sourceAuthority !== 'primary' || candidate.sourceLevel !== 'research') return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');
  if (!candidate.observedAt || !Number.isFinite(Date.parse(candidate.observedAt))) return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');
  const record = candidate.rawSourceMetadata?.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');
  const match = typeof record.id === 'string' ? record.id.match(VERSIONED_ID) : null;
  if (!match) return unresolved('STABLE_IDENTIFIER_MISSING');
  if (record.sourceIdentifier !== ARXIV_SOURCE_IDENTIFIER) return unresolved('SOURCE_NOT_ALLOWLISTED');
  if (candidate.itemIdentifier !== record.id || typeof candidate.itemUrl !== 'string') return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');
  let url;
  try { url = new URL(candidate.itemUrl); } catch { return unresolved('SOURCE_ITEM_URL_INVALID'); }
  const expectedPath = `/abs/${record.id}`;
  if (url.protocol !== 'https:' || url.hostname !== 'arxiv.org' || url.pathname !== expectedPath || url.search || url.hash || url.username || url.password) return unresolved('SOURCE_ITEM_URL_INVALID');

  const baseId = match[1];
  const entity = `arxiv-${baseId}`;
  const canonicalEventType = 'research-release';
  const eventIdentifier = 'initial';
  let eventKey;
  try { eventKey = buildEventKey({ entity, canonicalEventType, eventIdentifier }); }
  catch { return unresolved('IDENTITY_RULE_REJECTED'); }
  const evidenceRef = candidate.itemUrl;
  const identityProvenance = {
    entity: { value: entity, authority: 'ARXIV_OFFICIAL_API', sourceField: 'Atom id base identifier', method: 'REMOVE_ONLY_VERSION_SUFFIX_FROM_OFFICIAL_STABLE_WORK_ID', observedAtRelationship: 'OBSERVED_AT_EXCLUDED_FROM_IDENTITY', policyVersion: 'ARXIV_IDENTITY_SOURCE_SLICE_1.0.0', evidenceRef },
    canonicalEventType: { value: canonicalEventType, authority: 'EVENT_POLICY_1.0', sourceField: 'arXiv paper record', method: 'FROZEN_RESEARCH_PAPER_PUBLICATION_TAXONOMY', observedAtRelationship: 'OBSERVED_AT_EXCLUDED_FROM_IDENTITY', policyVersion: '1.0', evidenceRef },
    eventIdentifier: { value: eventIdentifier, authority: 'EVENT_POLICY_1.0', sourceField: 'arXiv official version history', method: 'FIRST_PUBLICATION_OF_STABLE_WORK_IS_INITIAL_EVENT', observedAtRelationship: 'OBSERVED_AT_EXCLUDED_FROM_IDENTITY', policyVersion: '1.0', evidenceRef },
  };
  return { status: 'IDENTITY_READY', sourceIdentifier: ARXIV_SOURCE_IDENTIFIER, entity, canonicalEventType, eventIdentifier, eventKey, arxivBaseId: baseId, arxivVersion: Number(match[2] ?? 1), identityProvenance, resolverVersion: ARXIV_IDENTITY_RESOLVER_VERSION };
}
