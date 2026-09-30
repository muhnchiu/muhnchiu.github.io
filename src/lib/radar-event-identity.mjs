import { createHash } from 'node:crypto';

export const EVENT_FACT_FIELDS = Object.freeze([
  'version', 'cveId', 'activeExploitation', 'supplyChainImpact',
  'reachableDependency', 'officialEmergencyAdvisory',
]);
export const CANONICAL_EVENT_TYPES = Object.freeze([
  'release', 'model-release', 'skill-release', 'research-release', 'version-update',
  'pricing-change', 'capability-change', 'security-cve', 'security-cisa-kev',
  'security-advisory', 'funding', 'incident', 'documentation',
]);
const eventTypes = new Set(CANONICAL_EVENT_TYPES);
const eventKeyPattern = /^[a-z0-9][a-z0-9._-]*:[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9][a-z0-9._-]*$/;
const entityPattern = /^[a-z0-9][a-z0-9._-]*$/;
const identifierPattern = /^[a-z0-9][a-z0-9._-]*$/;

export function buildEventKey({ entity, canonicalEventType, eventIdentifier }) {
  if (typeof entity !== 'string' || !entityPattern.test(entity)) throw new TypeError('INVALID_ENTITY');
  if (!eventTypes.has(canonicalEventType)) throw new TypeError('INVALID_CANONICAL_EVENT_TYPE');
  if (typeof eventIdentifier !== 'string' || !identifierPattern.test(eventIdentifier)) throw new TypeError('INVALID_EVENT_IDENTIFIER');
  return `${entity}:${canonicalEventType}:${eventIdentifier}`;
}

/** Hash only the frozen fact allowlist. Unknown keys and null/undefined values are ignored. */
export function buildEventFingerprint(facts = {}) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new TypeError('EVENT_FACTS_MUST_BE_OBJECT');
  const canonicalFacts = Object.fromEntries(EVENT_FACT_FIELDS
    .filter((field) => Object.hasOwn(facts, field) && facts[field] !== null && facts[field] !== undefined)
    .sort()
    .map((field) => [field, facts[field]]));
  return createHash('sha256').update(JSON.stringify(canonicalFacts), 'utf8').digest('hex').slice(0, 16);
}

export function evaluateMaterialChange({ canonicalEventType, previousCanonicalEventType, previousFingerprint, fingerprint }) {
  if (previousCanonicalEventType !== undefined && previousCanonicalEventType !== canonicalEventType) return false;
  return previousFingerprint !== undefined && previousFingerprint !== fingerprint;
}

/** Identify requested material fields that have no frozen fingerprint semantics. */
export function inspectMaterialChange({ canonicalEventType, previousCanonicalEventType, previousFacts = {}, facts = {} }) {
  const frozenMaterialChange = evaluateMaterialChange({
    canonicalEventType,
    previousCanonicalEventType,
    previousFingerprint: buildEventFingerprint(previousFacts),
    fingerprint: buildEventFingerprint(facts),
  });
  const policyFieldNotFrozen = ['pricingTerms', 'apiAvailability', 'license'].some((field) => previousFacts[field] !== facts[field]);
  return { materialChange: frozenMaterialChange, policyFieldNotFrozen };
}

/** Resolve against caller-owned, in-memory prior events; no registry or clock access. */
export function resolveEventState({ entity, canonicalEventType, eventIdentifier, fingerprint, previousEvents = [] }) {
  const eventKey = buildEventKey({ entity, canonicalEventType, eventIdentifier });
  const previous = previousEvents.find((item) => item.eventKey === eventKey);
  const eventState = !previous ? 'NEW'
    : evaluateMaterialChange({
      canonicalEventType,
      previousCanonicalEventType: previous.canonicalEventType,
      previousFingerprint: previous.fingerprint,
      fingerprint,
    }) ? 'UPDATE' : 'DUPLICATE';
  return {
    eventKey,
    entity,
    canonicalEventType,
    fingerprint,
    eventState,
    duplicate: eventState === 'DUPLICATE',
    materialChange: eventState === 'UPDATE',
  };
}

export function isValidContractEventKey(value) {
  return typeof value === 'string' && eventKeyPattern.test(value);
}
