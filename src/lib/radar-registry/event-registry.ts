import type { EventEngineOutput, EventRegistryRecord, FingerprintHistoryEntry, ObservationRegistryRecord } from './types.ts';

function aggregateObservations(eventKey: string, observations: ObservationRegistryRecord[]) {
  const linked = observations.filter((observation) => observation.eventKey === eventKey);
  const uniqueById = new Map(linked.map((observation) => [observation.observationId, observation]));
  const rows = [...uniqueById.values()];
  if (rows.length === 0) throw Object.assign(new Error('A committed Event must have at least one linked Observation.'), { code: 'REGISTRY_EVENT_WITHOUT_OBSERVATION' });
  const byTime = (field: 'firstObservedAt' | 'lastObservedAt', direction: 1 | -1) => [...rows]
    .sort((a, b) => (Date.parse(a[field]) - Date.parse(b[field])) * direction)[0][field];
  return {
    firstObservedAt: byTime('firstObservedAt', 1),
    lastObservedAt: byTime('lastObservedAt', -1),
    occurrences: rows.length,
    observationIds: rows.map(({ observationId }) => observationId).sort(),
    radars: [...new Set(rows.map(({ radar }) => radar))].sort(),
  };
}

/** Persistence projection only. It consumes the Event Engine state; it never decides it. */
export function materializeEvent(
  output: EventEngineOutput,
  observations: ObservationRegistryRecord[],
  existing: EventRegistryRecord | undefined,
  now: string,
  candidateObservedAt: string,
): EventRegistryRecord {
  const aggregate = aggregateObservations(output.eventKey, observations);
  const fingerprintHistory: FingerprintHistoryEntry[] = existing ? [...existing.fingerprintHistory] : [];
  if (!existing) {
    fingerprintHistory.push({ fingerprint: output.fingerprint, eventState: output.eventState, observedAt: aggregate.firstObservedAt });
  } else if (output.eventState === 'UPDATE' && output.fingerprint !== existing.latestFingerprint) {
    fingerprintHistory.push({ fingerprint: output.fingerprint, eventState: output.eventState, observedAt: candidateObservedAt });
  }
  return {
    eventKey: output.eventKey,
    entity: output.entity,
    canonicalEventType: output.canonicalEventType,
    firstObservedAt: aggregate.firstObservedAt,
    lastObservedAt: aggregate.lastObservedAt,
    occurrences: aggregate.occurrences,
    latestFingerprint: output.fingerprint,
    fingerprintHistory,
    lastEventState: output.eventState,
    radars: aggregate.radars,
    observationIds: aggregate.observationIds,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function getEventFrom(events: EventRegistryRecord[], eventKey: string): EventRegistryRecord | undefined {
  return events.find((event) => event.eventKey === eventKey);
}
export function hasEventIn(events: EventRegistryRecord[], eventKey: string): boolean { return getEventFrom(events, eventKey) !== undefined; }
export function listEventRecords(events: EventRegistryRecord[]): EventRegistryRecord[] { return [...events].sort((a, b) => a.eventKey.localeCompare(b.eventKey)); }

/** Registry Policy permits cache verification but never repairs a mismatch. */
export function deriveOccurrenceCount(eventKey: string, observations: ObservationRegistryRecord[]): number {
  return new Set(observations.filter((item) => item.eventKey === eventKey).map((item) => item.observationId)).size;
}
