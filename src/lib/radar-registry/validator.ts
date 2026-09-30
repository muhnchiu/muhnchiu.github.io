import { buildObservationIdentity } from '../radar-observation-identity.mjs';
import type { EventRegistryRecord, ObservationRegistryRecord, RegistryPair } from './types.ts';

export interface RegistryIssue { code: string; path: string; message: string; }
export interface RegistryValidationResult { valid: boolean; errors: RegistryIssue[]; }

const eventFields = new Set([
  'eventKey', 'entity', 'canonicalEventType', 'firstObservedAt', 'lastObservedAt', 'occurrences',
  'latestFingerprint', 'fingerprintHistory', 'lastEventState', 'radars', 'observationIds', 'createdAt', 'updatedAt',
]);
const observationFields = new Set([
  'observationId', 'eventKey', 'radar', 'canonicalSourceUrl', 'sourceUrl', 'sourceName', 'sourceLevel',
  'sourceAuthority', 'sourcePublishedAt', 'observedAt', 'firstObservedAt', 'lastObservedAt', 'retrievedAt',
  'createdAt', 'lastRetrievedAt',
]);
const eventStringFields = [
  'eventKey', 'entity', 'canonicalEventType', 'firstObservedAt', 'lastObservedAt',
  'latestFingerprint', 'lastEventState', 'createdAt', 'updatedAt',
];
const observationStringFields = [
  'observationId', 'eventKey', 'radar', 'canonicalSourceUrl', 'sourceUrl', 'sourceName', 'sourceLevel',
  'observedAt', 'firstObservedAt', 'lastObservedAt', 'createdAt',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRowShape(
  value: unknown,
  kind: 'events' | 'observations',
  index: number,
  add: (code: string, path: string, message: string) => void,
): value is Record<string, unknown> {
  const path = `/${kind}/${index}`;
  if (!isRecord(value)) {
    add('REGISTRY_INVALID_ROW_SHAPE', path, 'Registry row must be a non-null JSON object.');
    return false;
  }

  const allowedFields = kind === 'events' ? eventFields : observationFields;
  const stringFields = kind === 'events' ? eventStringFields : observationStringFields;
  let valid = true;
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      add('REGISTRY_INVALID_ROW_SHAPE', `${path}/${field}`, `Registry row contains unsupported field ${field}.`);
      valid = false;
    }
  }
  for (const field of allowedFields) {
    if (!Object.hasOwn(value, field)) {
      // Optional Observation fields are omitted when unset.
      if (kind === 'observations' && ['sourceAuthority', 'sourcePublishedAt', 'retrievedAt', 'lastRetrievedAt'].includes(field)) continue;
      add('REGISTRY_INVALID_ROW_SHAPE', `${path}/${field}`, `Registry row is missing required field ${field}.`);
      valid = false;
    }
  }
  for (const field of stringFields) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      add('REGISTRY_INVALID_ROW_SHAPE', `${path}/${field}`, `Registry field ${field} must be a non-empty string.`);
      valid = false;
    }
  }
  if (kind === 'events') {
    if (!Array.isArray(value.fingerprintHistory)) {
      add('REGISTRY_INVALID_ROW_SHAPE', `${path}/fingerprintHistory`, 'fingerprintHistory must be an array.');
      valid = false;
    } else {
      value.fingerprintHistory.forEach((entry, historyIndex) => {
        const historyPath = `${path}/fingerprintHistory/${historyIndex}`;
        if (!isRecord(entry)) {
          add('REGISTRY_INVALID_ROW_SHAPE', historyPath, 'Fingerprint history entry must be a non-null JSON object.');
          valid = false;
          return;
        }
        for (const field of ['fingerprint', 'eventState', 'observedAt']) {
          if (typeof entry[field] !== 'string' || entry[field] === '') {
            add('REGISTRY_INVALID_ROW_SHAPE', `${historyPath}/${field}`, `Fingerprint history field ${field} must be a non-empty string.`);
            valid = false;
          }
        }
        for (const field of Object.keys(entry)) {
          if (!['fingerprint', 'eventState', 'observedAt'].includes(field)) {
            add('REGISTRY_INVALID_ROW_SHAPE', `${historyPath}/${field}`, `Fingerprint history contains unsupported field ${field}.`);
            valid = false;
          }
        }
      });
    }
    for (const field of ['radars', 'observationIds']) {
      if (!Array.isArray(value[field])) {
        add('REGISTRY_INVALID_ROW_SHAPE', `${path}/${field}`, `${field} must be an array.`);
        valid = false;
      }
    }
    if (typeof value.occurrences !== 'number' || !Number.isFinite(value.occurrences)) {
      add('REGISTRY_INVALID_ROW_SHAPE', `${path}/occurrences`, 'occurrences must be a finite number.');
      valid = false;
    }
  } else {
    for (const field of ['sourceAuthority', 'sourcePublishedAt', 'retrievedAt', 'lastRetrievedAt']) {
      if (value[field] !== undefined && typeof value[field] !== 'string') {
        add('REGISTRY_INVALID_ROW_SHAPE', `${path}/${field}`, `${field} must be a string when present.`);
        valid = false;
      }
    }
  }
  return valid;
}

const eventKeyPattern = /^[a-z0-9][a-z0-9._-]*:[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9][a-z0-9._-]*$/;
const fingerprintPattern = /^[a-f0-9]{16}$/;
const digestPattern = /^[a-f0-9]{16}$/;
const eventTypes = new Set([
  'release', 'model-release', 'skill-release', 'research-release', 'version-update',
  'pricing-change', 'capability-change', 'security-cve', 'security-cisa-kev',
  'security-advisory', 'funding', 'incident', 'documentation',
]);
const radars = new Set(['ai', 'dev', 'app', 'security', 'skill']);
const sourceLevels = new Set(['official', 'research', 'ecosystem', 'media', 'community']);
const sourceAuthorities = new Set(['official', 'primary', 'secondary', 'community']);

function isDateTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime());
}

function identityResult(observation: ObservationRegistryRecord) {
  try {
    const identity = buildObservationIdentity({
      eventKey: observation.eventKey,
      radar: observation.radar,
      sourceName: observation.sourceName,
      sourceUrl: observation.sourceUrl,
      sourceLevel: observation.sourceLevel,
      observedAt: observation.observedAt,
      sourceAuthority: observation.sourceAuthority,
    });
    return { identity, error: undefined };
  } catch (error) {
    return { identity: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Pure, deterministic, check-only validator. It never mutates or repairs input. */
export function validateRegistryPair(input: RegistryPair): RegistryValidationResult {
  const errors: RegistryIssue[] = [];
  const add = (code: string, path: string, message: string) => errors.push({ code, path, message });
  if (!isRecord(input)) {
    add('REGISTRY_INVALID_ROW_SHAPE', '/', 'Registry pair must be a non-null JSON object.');
    return { valid: false, errors };
  }
  if (!Array.isArray(input.events) || !Array.isArray(input.observations)) {
    if (!Array.isArray(input.events)) add('REGISTRY_INVALID_ROW_SHAPE', '/events', 'events must be an array.');
    if (!Array.isArray(input.observations)) add('REGISTRY_INVALID_ROW_SHAPE', '/observations', 'observations must be an array.');
    return { valid: false, errors };
  }
  let rowShapesValid = true;
  input.events.forEach((event, index) => { if (!validateRowShape(event, 'events', index, add)) rowShapesValid = false; });
  input.observations.forEach((observation, index) => { if (!validateRowShape(observation, 'observations', index, add)) rowShapesValid = false; });
  if (!rowShapesValid) return { valid: false, errors };
  const eventByKey = new Map<string, EventRegistryRecord>();
  const observationById = new Map<string, ObservationRegistryRecord>();

  input.events.forEach((event, index) => {
    const path = `/events/${index}`;
    if (eventByKey.has(event.eventKey)) add('REGISTRY_DUPLICATE_EVENT_KEY', `${path}/eventKey`, 'eventKey must be unique.');
    else eventByKey.set(event.eventKey, event);
    if (!eventKeyPattern.test(event.eventKey)) add('REGISTRY_EVENT_KEY_INVALID', `${path}/eventKey`, 'eventKey does not match Contract 2.1.2 grammar.');
    const [entity, eventType] = event.eventKey.split(':');
    if (event.entity !== entity) add('REGISTRY_ENTITY_MISMATCH', `${path}/entity`, 'entity must match the eventKey entity segment.');
    if (!eventTypes.has(event.canonicalEventType)) add('REGISTRY_EVENT_TYPE_INVALID', `${path}/canonicalEventType`, 'canonicalEventType is not in the frozen Event Policy enum.');
    if (event.canonicalEventType !== eventType) add('REGISTRY_EVENT_TYPE_MISMATCH', `${path}/canonicalEventType`, 'canonicalEventType must match the eventKey type segment.');
    if (!isDateTime(event.firstObservedAt) || !isDateTime(event.lastObservedAt) || Date.parse(event.firstObservedAt) > Date.parse(event.lastObservedAt)) {
      add('REGISTRY_EVENT_TIME_ORDER_INVALID', `${path}/firstObservedAt`, 'firstObservedAt must be a valid datetime not later than lastObservedAt.');
    }
    if (!Number.isInteger(event.occurrences) || event.occurrences < 0) add('REGISTRY_OCCURRENCES_INVALID', `${path}/occurrences`, 'occurrences must be a non-negative integer.');
    if (!fingerprintPattern.test(event.latestFingerprint)) add('REGISTRY_FINGERPRINT_INVALID', `${path}/latestFingerprint`, 'latestFingerprint must be 16 lowercase SHA-256 hex characters.');
    if (!Array.isArray(event.fingerprintHistory) || event.fingerprintHistory.length === 0) {
      add('REGISTRY_FINGERPRINT_HISTORY_INVALID', `${path}/fingerprintHistory`, 'fingerprintHistory must contain at least one entry.');
    } else {
      event.fingerprintHistory.forEach((entry, historyIndex) => {
        if (!fingerprintPattern.test(entry.fingerprint) || !['NEW', 'DUPLICATE', 'UPDATE'].includes(entry.eventState) || !isDateTime(entry.observedAt)) {
          add('REGISTRY_FINGERPRINT_HISTORY_INVALID', `${path}/fingerprintHistory/${historyIndex}`, 'Fingerprint history entry is invalid.');
        }
      });
      if (event.fingerprintHistory.at(-1)?.fingerprint !== event.latestFingerprint) {
        add('REGISTRY_FINGERPRINT_HISTORY_INVALID', `${path}/fingerprintHistory`, 'The final history fingerprint must equal latestFingerprint.');
      }
      if (event.fingerprintHistory[0]?.eventState !== 'NEW'
        || event.fingerprintHistory.slice(1).some(({ eventState }) => eventState !== 'UPDATE')
        || event.fingerprintHistory.some((entry, historyIndex) => historyIndex > 0
          && entry.fingerprint === event.fingerprintHistory[historyIndex - 1].fingerprint)) {
        add('REGISTRY_EVENT_STATE_FACTS_INVALID', `${path}/fingerprintHistory`, 'History must start with NEW and append only distinct-fingerprint UPDATE transitions.');
      }
    }
    if (!['NEW', 'DUPLICATE', 'UPDATE'].includes(event.lastEventState)) add('REGISTRY_EVENT_STATE_INVALID', `${path}/lastEventState`, 'Unknown Event state.');
    else if (Array.isArray(event.fingerprintHistory)
      && ((event.lastEventState === 'NEW' && event.fingerprintHistory.length !== 1)
        || (event.lastEventState === 'UPDATE' && event.fingerprintHistory.at(-1)?.eventState !== 'UPDATE'))) {
      add('REGISTRY_EVENT_STATE_FACTS_INVALID', `${path}/lastEventState`, 'lastEventState must agree with the latest frozen fingerprint transition.');
    }
    if (new Set(event.observationIds).size !== event.observationIds.length) add('REGISTRY_DUPLICATE_OBSERVATION_LINK', `${path}/observationIds`, 'observationIds must be unique.');
    if (new Set(event.radars).size !== event.radars.length || event.radars.some((radar) => !radars.has(radar))) add('REGISTRY_RADARS_INVALID', `${path}/radars`, 'radars must be unique supported radar IDs.');
    if (!isDateTime(event.createdAt) || !isDateTime(event.updatedAt)) add('REGISTRY_OPERATIONAL_TIME_INVALID', `${path}/createdAt`, 'createdAt and updatedAt must be valid datetimes.');
  });

  input.observations.forEach((observation, index) => {
    const path = `/observations/${index}`;
    if (observationById.has(observation.observationId)) add('REGISTRY_DUPLICATE_OBSERVATION_ID', `${path}/observationId`, 'observationId must be unique.');
    else observationById.set(observation.observationId, observation);
    if (!radars.has(observation.radar)) add('REGISTRY_RADAR_INVALID', `${path}/radar`, 'Unsupported radar ID.');
    if (!sourceLevels.has(observation.sourceLevel)) add('REGISTRY_SOURCE_LEVEL_INVALID', `${path}/sourceLevel`, 'Unsupported source level.');
    if (observation.sourceAuthority !== undefined && !sourceAuthorities.has(observation.sourceAuthority)) add('REGISTRY_SOURCE_AUTHORITY_INVALID', `${path}/sourceAuthority`, 'Unsupported source authority.');
    const { identity, error } = identityResult(observation);
    if (error || !identity) add('REGISTRY_OBSERVATION_INPUT_INVALID', path, error ?? 'Observation input is invalid.');
    else {
      if (identity.observationId !== observation.observationId) add('REGISTRY_OBSERVATION_ID_MISMATCH', `${path}/observationId`, 'Recomputed Observation identity differs from stored observationId.');
      if (identity.canonicalSourceUrl !== observation.canonicalSourceUrl) add('REGISTRY_CANONICAL_URL_MISMATCH', `${path}/canonicalSourceUrl`, 'Stored canonicalSourceUrl differs from frozen canonicalization.');
    }
    if (![observation.observedAt, observation.firstObservedAt, observation.lastObservedAt].every(isDateTime)
      || Date.parse(observation.firstObservedAt) > Date.parse(observation.lastObservedAt)) {
      add('REGISTRY_OBSERVATION_TIME_INVALID', `${path}/observedAt`, 'Observation timestamps are invalid or out of order.');
    }
    if (observation.sourcePublishedAt !== undefined && !isDateTime(observation.sourcePublishedAt)) add('REGISTRY_SOURCE_PUBLISHED_AT_INVALID', `${path}/sourcePublishedAt`, 'sourcePublishedAt must be a valid datetime.');
    if (observation.retrievedAt !== undefined && !isDateTime(observation.retrievedAt)) add('REGISTRY_RETRIEVED_AT_INVALID', `${path}/retrievedAt`, 'retrievedAt must be a valid datetime.');
    if (!isDateTime(observation.createdAt) || (observation.lastRetrievedAt !== undefined && !isDateTime(observation.lastRetrievedAt))) add('REGISTRY_OPERATIONAL_TIME_INVALID', `${path}/createdAt`, 'Operational timestamps are invalid.');
  });

  for (const observation of input.observations) {
    if (!eventByKey.has(observation.eventKey)) add('REGISTRY_OBSERVATION_EVENT_MISSING', `/observations/${observation.observationId}/eventKey`, 'Observation references a missing Event.');
  }
  for (const event of input.events) {
    const linked = input.observations.filter((observation) => observation.eventKey === event.eventKey);
    const derivedIds = [...new Set(linked.map(({ observationId }) => observationId))].sort();
    const derivedCount = derivedIds.length;
    if (derivedCount === 0) add('REGISTRY_EVENT_WITHOUT_OBSERVATION', `/events/${event.eventKey}/observationIds`, 'Every committed Event must link at least one Observation.');
    if (event.occurrences !== derivedCount) add('REGISTRY_OCCURRENCE_MISMATCH', `/events/${event.eventKey}/occurrences`, `storedOccurrences=${event.occurrences}; derivedUniqueObservationCount=${derivedCount}.`);
    if (JSON.stringify([...event.observationIds].sort()) !== JSON.stringify(derivedIds)) add('REGISTRY_OBSERVATION_LINK_MISMATCH', `/events/${event.eventKey}/observationIds`, 'Stored Observation links must match linked Observation records.');
    const derivedRadars = [...new Set(linked.map(({ radar }) => radar))].sort();
    if (JSON.stringify([...event.radars].sort()) !== JSON.stringify(derivedRadars)) add('REGISTRY_RADAR_AGGREGATE_MISMATCH', `/events/${event.eventKey}/radars`, 'Stored radar set must match linked observations.');
    if (linked.length > 0) {
      const first = linked.map(({ firstObservedAt }) => firstObservedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      const last = linked.map(({ lastObservedAt }) => lastObservedAt).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      if (Date.parse(event.firstObservedAt) !== Date.parse(first) || Date.parse(event.lastObservedAt) !== Date.parse(last)) add('REGISTRY_EVENT_TIME_AGGREGATE_MISMATCH', `/events/${event.eventKey}`, 'Event observation bounds must be derived from linked Observation records.');
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Deterministic canonical facts omit only operational metadata. */
const operationalFields = new Set(['createdAt', 'updatedAt', 'retrievedAt', 'lastRetrievedAt']);
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !operationalFields.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

export function canonicalRegistryBytes<T extends EventRegistryRecord | ObservationRegistryRecord>(rows: T[], key: 'eventKey' | 'observationId'): Buffer {
  const sorted = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  return Buffer.from(sorted.map((row) => JSON.stringify(canonicalValue(row))).join('\n') + (sorted.length ? '\n' : ''), 'utf8');
}

export function registryPairFromJsonl(eventBytes: Buffer, observationBytes: Buffer): RegistryPair {
  const parse = <T>(bytes: Buffer, label: string): T[] => {
    const text = bytes.toString('utf8');
    if (!text) return [];
    if (!text.endsWith('\n')) throw Object.assign(new Error(`${label} JSONL must end with newline`), { code: 'REGISTRY_JSONL_TRUNCATED' });
    return text.trimEnd().split('\n').map((line, index) => {
      try { return JSON.parse(line) as T; }
      catch { throw Object.assign(new Error(`${label} JSONL parse failure at line ${index + 1}`), { code: 'REGISTRY_JSONL_INVALID' }); }
    });
  };
  return { events: parse<EventRegistryRecord>(eventBytes, 'Event'), observations: parse<ObservationRegistryRecord>(observationBytes, 'Observation') };
}
