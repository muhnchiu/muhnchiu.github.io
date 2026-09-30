import { createHash } from 'node:crypto';
import { isValidContractEventKey } from './radar-event-identity.mjs';

export const RADARS = Object.freeze(['ai', 'dev', 'app', 'security', 'skill']);
export const SOURCE_LEVELS = Object.freeze(['official', 'research', 'ecosystem', 'media', 'community']);
const sourceAuthorities = new Set(['official', 'primary', 'secondary', 'community']);
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function canonicalizeSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('INVALID_URL:sourceUrl'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('UNSUPPORTED_URL_SCHEME:sourceUrl (https/http required)');
  const scheme = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const port = (scheme === 'https:' && url.port === '443') || (scheme === 'http:' && url.port === '80') ? '' : url.port;
  const pathname = url.pathname === '/' ? '/' : (url.pathname.replace(/\/+$/, '') || '/');
  return `${scheme}//${hostname}${port ? `:${port}` : ''}${pathname}${url.search}`;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !timestampPattern.test(value)) return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return false;
  const [, y, m, d, h, min, s] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    && h <= 23 && min <= 59 && s <= 59 && Number.isFinite(Date.parse(value));
}

export function buildObservationIdentity(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) throw new TypeError('INVALID_OBSERVATION');
  for (const field of ['eventKey', 'radar', 'sourceName', 'sourceUrl', 'sourceLevel', 'observedAt']) {
    if (observation[field] === undefined || observation[field] === null || observation[field] === '') throw new TypeError(`MISSING_REQUIRED_FIELD:${field}`);
  }
  if (!RADARS.includes(observation.radar)) throw new TypeError('INVALID_RADAR:radar');
  if (typeof observation.sourceName !== 'string' || !observation.sourceName.trim()) throw new TypeError('INVALID_SOURCE_NAME:sourceName');
  if (!SOURCE_LEVELS.includes(observation.sourceLevel)) throw new TypeError('INVALID_SOURCE_LEVEL:sourceLevel');
  if (observation.sourceAuthority !== undefined && !sourceAuthorities.has(observation.sourceAuthority)) throw new TypeError('INVALID_SOURCE_AUTHORITY:sourceAuthority');
  if (!validTimestamp(observation.observedAt)) throw new TypeError('INVALID_ISO_DATE_TIME:observedAt');
  if (!isValidContractEventKey(observation.eventKey)) throw new TypeError('INVALID_EVENT_KEY:must match Contract 2.1.1 eventKey grammar');
  const canonicalSourceUrl = canonicalizeSourceUrl(observation.sourceUrl);
  const identityInput = `${observation.eventKey}\n${canonicalSourceUrl}\n${observation.radar}`;
  const observationId = createHash('sha256').update(identityInput, 'utf8').digest('hex').slice(0, 16);
  return { observationId, canonicalSourceUrl, identityInput };
}

export function resolveObservationTimes(observations) {
  if (!Array.isArray(observations) || observations.length === 0) throw new TypeError('OBSERVATIONS_REQUIRED');
  const ordered = observations.map(({ observedAt }) => {
    if (!validTimestamp(observedAt)) throw new TypeError('INVALID_ISO_DATE_TIME:observedAt');
    return { value: observedAt, instant: Date.parse(observedAt) };
  }).sort((a, b) => a.instant - b.instant);
  return { firstSeen: ordered[0].value, lastSeen: ordered.at(-1).value };
}
