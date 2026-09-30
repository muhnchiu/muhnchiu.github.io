import { getEventFrom, hasEventIn, listEventRecords } from './event-registry.ts';
import { getObservationFrom, hasObservationIn, listObservationRecords } from './observation-registry.ts';
import { RegistryTransactionManager, canonicalRegistryHashes } from './transaction.ts';
import type { AtomicObservationCommitInput, EventEngineOutput, EventRegistryRecord, ObservationInput, ObservationRegistryRecord, RegistryRuntime } from './types.ts';

/** Explicitly scoped Registry API. stateDir is mandatory to avoid accidental production writes. */
export class RegistryLayer {
  readonly transactions: RegistryTransactionManager;

  constructor(runtime: RegistryRuntime) {
    this.transactions = new RegistryTransactionManager(runtime);
  }

  async getEvent(eventKey: string): Promise<EventRegistryRecord | undefined> {
    return getEventFrom((await this.transactions.readPair()).events, eventKey);
  }
  async hasEvent(eventKey: string): Promise<boolean> {
    return hasEventIn((await this.transactions.readPair()).events, eventKey);
  }
  async listEvents(): Promise<EventRegistryRecord[]> {
    return listEventRecords((await this.transactions.readPair()).events);
  }
  async getObservation(observationId: string): Promise<ObservationRegistryRecord | undefined> {
    return getObservationFrom((await this.transactions.readPair()).observations, observationId);
  }
  async hasObservation(observationId: string): Promise<boolean> {
    return hasObservationIn((await this.transactions.readPair()).observations, observationId);
  }
  async listObservations(): Promise<ObservationRegistryRecord[]> {
    return listObservationRecords((await this.transactions.readPair()).observations);
  }
  async commitObservation(input: AtomicObservationCommitInput) {
    return this.transactions.commitObservation(input);
  }
  /** LEGACY / NON-PRODUCTION: use commitObservation() for authoritative state resolution. */
  async upsertEvent(engineOutput: EventEngineOutput, observation: ObservationInput) {
    return this.transactions.commitCandidate(engineOutput, observation);
  }
  /** LEGACY / NON-PRODUCTION: alias retained for Phase 5A.5 callers. */
  async upsertObservation(engineOutput: EventEngineOutput, observation: ObservationInput) {
    return this.transactions.commitCandidate(engineOutput, observation);
  }
  async hashes(): Promise<{ eventSha256: string; observationSha256: string }> {
    return canonicalRegistryHashes(this.transactions.stateDir);
  }
}

export { RegistryTransactionManager, canonicalRegistryHashes } from './transaction.ts';
export { validateRegistryPair, canonicalRegistryBytes, registryPairFromJsonl } from './validator.ts';
export { acquireRegistryLock, REGISTRY_LOCK_TIMEOUT_MS, REGISTRY_STALE_LOCK_MS } from './lock.ts';
export { createSnapshot, pruneSnapshots, readSnapshotPair, verifySnapshotPair } from './snapshot.ts';
export { appendCandidateReceipt, cleanupCandidateReceipts } from './receipts.ts';
export { recoverRegistry } from './recovery.ts';
export * from './types.ts';
