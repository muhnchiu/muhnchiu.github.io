import { buildObservationIdentity } from '../radar-observation-identity.mjs';
import type { ObservationInput, ObservationRegistryRecord, RegistryRadar } from './types.ts';

export interface ObservationUpsertResult { observation: ObservationRegistryRecord; inserted: boolean; changed: boolean; }

export function materializeObservation(
  input: ObservationInput,
  existing: ObservationRegistryRecord | undefined,
  createdAt: string,
): ObservationUpsertResult {
  const identity = buildObservationIdentity(input);
  if (existing && (existing.eventKey !== input.eventKey || existing.radar !== input.radar || existing.canonicalSourceUrl !== identity.canonicalSourceUrl)) {
    throw Object.assign(new Error('An observationId cannot be reassigned to a different identity tuple.'), { code: 'REGISTRY_OBSERVATION_IDENTITY_COLLISION' });
  }
  const observedAt = input.observedAt;
  const firstObservedAt = existing && Date.parse(existing.firstObservedAt) < Date.parse(observedAt) ? existing.firstObservedAt : observedAt;
  const lastObservedAt = existing && Date.parse(existing.lastObservedAt) > Date.parse(observedAt) ? existing.lastObservedAt : observedAt;
  const retrievedAt = typeof input.retrievedAt === 'string' ? input.retrievedAt : existing?.retrievedAt;
  const observation: ObservationRegistryRecord = {
    observationId: identity.observationId,
    eventKey: input.eventKey,
    radar: input.radar,
    canonicalSourceUrl: identity.canonicalSourceUrl,
    sourceUrl: input.sourceUrl,
    sourceName: input.sourceName,
    sourceLevel: input.sourceLevel,
    ...(input.sourceAuthority ? { sourceAuthority: input.sourceAuthority } : {}),
    ...(input.sourcePublishedAt ? { sourcePublishedAt: input.sourcePublishedAt } : {}),
    observedAt,
    firstObservedAt,
    lastObservedAt,
    ...(retrievedAt ? { retrievedAt } : {}),
    createdAt: existing?.createdAt ?? createdAt,
    ...(retrievedAt ? { lastRetrievedAt: retrievedAt } : existing?.lastRetrievedAt ? { lastRetrievedAt: existing.lastRetrievedAt } : {}),
  };
  const changed = !existing || JSON.stringify(existing) !== JSON.stringify(observation);
  return { observation, inserted: !existing, changed };
}

export function getObservationFrom(observations: ObservationRegistryRecord[], observationId: string): ObservationRegistryRecord | undefined {
  return observations.find((observation) => observation.observationId === observationId);
}

export function hasObservationIn(observations: ObservationRegistryRecord[], observationId: string): boolean {
  return getObservationFrom(observations, observationId) !== undefined;
}

export function listObservationRecords(observations: ObservationRegistryRecord[]): ObservationRegistryRecord[] {
  return [...observations].sort((a, b) => a.observationId.localeCompare(b.observationId));
}

export function observationRadar(input: ObservationInput): RegistryRadar { return input.radar; }
