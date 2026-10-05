import { buildEventKey } from '../radar-event-identity.mjs';

export const NVD_SOURCE_IDENTIFIER = 'services.nvd.nist.gov/rest/json/cves/2.0';
export const NVD_IDENTITY_RESOLVER_VERSION = '1.0.0';
const unresolved = (reasonCode) => ({ status: 'IDENTITY_UNRESOLVED', reasonCode });

/** Phase 6.3 adjudication: the frozen Event Policy explicitly permits a CVE entity.
 * Only the official cve.id supplies identity; CPE, prose, status and environment
 * relationships remain separate evidence. No Registry or Security Gate lookup.
 */
export function resolveNvdIdentity(candidate) {
  if (!candidate || candidate.radar !== 'SEC' || candidate.sourceName !== 'NVD') return unresolved('SOURCE_NOT_ALLOWLISTED');
  if (candidate.sourceAuthority !== 'primary' || candidate.sourceLevel !== 'official'
    || !candidate.observedAt || !Number.isFinite(Date.parse(candidate.observedAt))) return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');
  const record = candidate.rawSourceMetadata?.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');
  if (record.sourceIdentifier !== NVD_SOURCE_IDENTIFIER) return unresolved('SOURCE_NOT_ALLOWLISTED');
  if (typeof record.id !== 'string' || !/^CVE-\d{4}-\d{4,}$/i.test(record.id)) return unresolved('STABLE_IDENTIFIER_INVALID');
  if (candidate.itemIdentifier !== record.id) return unresolved('IDENTITY_PROVENANCE_INCOMPLETE');
  if (candidate.itemUrl !== `https://nvd.nist.gov/vuln/detail/${record.id}`) return unresolved('SOURCE_ITEM_URL_INVALID');
  const entity = record.id.toLowerCase();
  const canonicalEventType = 'security-cve';
  const eventIdentifier = entity;
  const evidenceRef = candidate.itemUrl;
  const fact = (value, sourceField, method) => ({ value, authority: 'EVENT_POLICY_1.0', sourceField, method,
    sourceAuthority: 'NVD_OFFICIAL_CVE_API', policyVersion: '1.0', evidenceRef,
    observedAtRelationship: 'OBSERVED_AT_EXCLUDED_FROM_IDENTITY' });
  return { status: 'IDENTITY_READY', sourceIdentifier: NVD_SOURCE_IDENTIFIER, entity, canonicalEventType,
    eventIdentifier, eventKey: buildEventKey({ entity, canonicalEventType, eventIdentifier }),
    eventFacts: { cveId: entity },
    identityProvenance: {
      entity: fact(entity, 'cve.id', 'FROZEN_CVE_ENTITY_LOWERCASE_CANONICALIZATION'),
      canonicalEventType: fact(canonicalEventType, 'NVD CVE record', 'FROZEN_CVE_VULNERABILITY_DISCLOSURE_TAXONOMY'),
      eventIdentifier: fact(eventIdentifier, 'cve.id', 'FROZEN_CVE_IDENTIFIER_PRECEDENCE'),
    }, resolverVersion: NVD_IDENTITY_RESOLVER_VERSION };
}
