import { buildEventFingerprint, buildEventKey } from './radar-event-identity.mjs';
import { buildObservationIdentity } from './radar-observation-identity.mjs';

export const SOURCE_EVIDENCE_MAP = Object.freeze({
  'NVD': ['official', 'primary'], 'GitHub Security Advisories': ['official', 'primary'],
  'CISA KEV': ['official', 'primary'], 'FIRST EPSS': ['research', 'primary'],
  'Hacker News Security': ['community', 'community'], 'Hacker News 首页': ['community', 'community'],
  'Hacker News Show HN': ['community', 'community'], 'Hacker News': ['community', 'community'],
  'Product Hunt': ['ecosystem', 'community'], 'GitHub Trending': ['ecosystem', 'community'],
  'AlternativeTo': ['ecosystem', 'secondary'], '少数派': ['media', 'secondary'],
  '小众软件': ['media', 'secondary'], '小众软件发现频道': ['community', 'community'],
  'HuggingFace Papers': ['research', 'primary'], 'HuggingFace 热门模型': ['ecosystem', 'primary'],
  'GitHub AI Trending': ['ecosystem', 'community'], 'OpenRouter 免费模型': ['ecosystem', 'primary'],
  'arXiv cs.LG': ['research', 'primary'], 'TechCrunch AI': ['media', 'secondary'],
  'OpenAI News': ['official', 'official'], 'Anthropic News': ['official', 'official'],
  'Google DeepMind': ['official', 'official'], 'npm Downloads': ['ecosystem', 'primary'],
  'VS Code Marketplace': ['ecosystem', 'primary'], 'Claude Code Changelog': ['official', 'official'],
  'VS Code Releases': ['official', 'official'], 'Node.js Releases': ['official', 'official'],
  'GitHub Changelog': ['official', 'official'], 'Skills.sh': ['ecosystem', 'secondary'],
  'Linkly': ['ecosystem', 'secondary'], 'OfficialSkills': ['ecosystem', 'secondary'],
  'ClawHub': ['ecosystem', 'primary'], 'SkillsMP': ['ecosystem', 'secondary'],
  'LobeHub': ['ecosystem', 'secondary'], 'GitHub': ['ecosystem', 'primary'],
});

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isTimestamp(value) {
  if (typeof value !== 'string' || !timestamp.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  const [, y, m, d, h, min, sec] = match.map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d
    && h <= 23 && min <= 59 && sec <= 59;
}

function issue(code, field, message) { return { code, field, message }; }

/** Static source classification; unknown sources intentionally remain unmapped. */
export function mapSourceEvidence(sourceName) {
  const mapped = SOURCE_EVIDENCE_MAP[sourceName];
  if (!mapped) return { sourceName, sourceLevel: undefined, sourceAuthority: undefined, errors: [issue('SOURCE_AUTHORITY_UNDEFINED', 'sourceName', `No frozen static mapping for ${String(sourceName)}.`)] };
  return { sourceName, sourceLevel: mapped[0], sourceAuthority: mapped[1], errors: [] };
}

/** Minimal source adapters preserve upstream item permalinks/publication fields verbatim. */
export function rssItemToCandidate(sourceName, item) {
  return { sourceName, title: item?.title, sourceUrl: item?.link, ...(item?.published ? { sourcePublishedAt: item.published } : {}) };
}

export function nvdCveToCandidate(cve) {
  // NVD references point to third-party advisories, not the NVD item itself.
  // Only accept an upstream item permalink if the source payload explicitly provides one.
  return { sourceName: 'NVD', title: cve?.descriptions?.find((row) => row.lang === 'en')?.value, sourceUrl: cve?.url, sourcePublishedAt: cve?.published };
}

export function githubAdvisoryToCandidate(advisory) {
  return { sourceName: 'GitHub Security Advisories', title: advisory?.summary, sourceUrl: advisory?.html_url, sourcePublishedAt: advisory?.published_at };
}

/** Pure evidence validation. observedAt is an explicit caller argument and is copied unchanged. */
export function normalizeEvidence(raw, { observedAt, retrievedAt } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { normalized: null, errors: [issue('CANDIDATE_INVALID', '', 'Candidate must be an object.')], receiptEligible: true, registryEligible: false };
  const mapping = mapSourceEvidence(raw.sourceName);
  errors.push(...mapping.errors);
  for (const field of ['sourceName']) if (typeof raw[field] !== 'string' || !raw[field].trim()) errors.push(issue('SOURCE_NAME_REQUIRED', field, `${field} is required.`));
  if (typeof raw.sourceUrl !== 'string' || !raw.sourceUrl.trim()) errors.push(issue('SOURCE_URL_REQUIRED', 'sourceUrl', 'Original item URL is required; do not synthesize one.'));
  else {
    try { const url = new URL(raw.sourceUrl); if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) errors.push(issue('SOURCE_URL_HTTPS_REQUIRED', 'sourceUrl', 'Evidence source URL must be a public HTTPS URL.')); }
    catch { errors.push(issue('SOURCE_URL_INVALID', 'sourceUrl', 'sourceUrl must be an absolute HTTPS URL.')); }
  }
  if (!isTimestamp(observedAt)) errors.push(issue('OBSERVED_AT_REQUIRED', 'observedAt', 'Pass a valid explicit observedAt timestamp.'));
  if (raw.sourcePublishedAt != null && !isTimestamp(raw.sourcePublishedAt)) errors.push(issue('SOURCE_PUBLISHED_AT_INVALID', 'sourcePublishedAt', 'sourcePublishedAt must be a valid source timestamp or null.'));
  if (raw.sourcePublishedAt && isTimestamp(observedAt) && Date.parse(raw.sourcePublishedAt) > Date.parse(observedAt)) {
    errors.push(issue('TIME_ORDER_POLICY_UNDEFINED', 'sourcePublishedAt', 'Frozen policy does not define source publication later than observation.'));
  }
  const normalized = {
    ...raw,
    sourceName: raw.sourceName,
    sourceUrl: raw.sourceUrl,
    sourceLevel: mapping.sourceLevel,
    sourceAuthority: mapping.sourceAuthority,
    observedAt,
    ...(raw.sourcePublishedAt == null ? {} : { sourcePublishedAt: raw.sourcePublishedAt }),
    ...(retrievedAt === undefined ? {} : { retrievedAt }),
  };
  const blocking = errors.filter((entry) => entry.code !== 'TIME_ORDER_POLICY_UNDEFINED');
  return { normalized, errors, receiptEligible: true, registryEligible: blocking.length === 0 };
}

/** Dry integration stops at the atomic Registry request; it never calls commitObservation. */
export function prepareEvidenceCommit(candidate, { radar, observedAt, retrievedAt } = {}) {
  const evidence = normalizeEvidence(candidate, { observedAt, retrievedAt });
  if (!evidence.registryEligible) return { ...evidence, observationInput: null, commitRequest: null };
  const raw = evidence.normalized;
  let eventKey; let fingerprint; let identity;
  try {
    eventKey = buildEventKey({ entity: raw.entity, canonicalEventType: raw.canonicalEventType, eventIdentifier: raw.eventIdentifier });
    fingerprint = buildEventFingerprint(raw.eventFacts ?? {});
    identity = buildObservationIdentity({ eventKey, radar, ...raw });
  } catch (error) {
    const code = String(error?.message || 'IDENTITY_PREPARATION_FAILED');
    const invalid = issue(code, 'identity', 'Frozen identity engine rejected candidate identity fields.');
    return { ...evidence, errors: [...evidence.errors, invalid], registryEligible: false, observationInput: null, commitRequest: null };
  }
  const observationInput = { eventKey, radar, sourceName: raw.sourceName, sourceUrl: raw.sourceUrl, sourceLevel: raw.sourceLevel, sourceAuthority: raw.sourceAuthority, observedAt: raw.observedAt, ...(raw.sourcePublishedAt ? { sourcePublishedAt: raw.sourcePublishedAt } : {}), ...(retrievedAt ? { retrievedAt } : {}) };
  return { ...evidence, eventKey, fingerprint, observationId: identity.observationId, observationInput, commitRequest: { eventKey, eventFacts: { entity: raw.entity, canonicalEventType: raw.canonicalEventType, eventIdentifier: raw.eventIdentifier }, fingerprint, observation: observationInput } };
}
