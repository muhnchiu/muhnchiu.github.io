export type RegistryRadar = 'ai' | 'dev' | 'app' | 'security' | 'skill';
export type RegistryEventState = 'NEW' | 'DUPLICATE' | 'UPDATE';
export type RegistrySourceLevel = 'official' | 'research' | 'ecosystem' | 'media' | 'community';
export type RegistrySourceAuthority = 'official' | 'primary' | 'secondary' | 'community';

export interface FingerprintHistoryEntry {
  fingerprint: string;
  eventState: RegistryEventState;
  observedAt: string;
}

export interface EventRegistryRecord {
  eventKey: string;
  entity: string;
  canonicalEventType: string;
  firstObservedAt: string;
  lastObservedAt: string;
  occurrences: number;
  latestFingerprint: string;
  fingerprintHistory: FingerprintHistoryEntry[];
  lastEventState: RegistryEventState;
  radars: RegistryRadar[];
  observationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ObservationRegistryRecord {
  observationId: string;
  eventKey: string;
  radar: RegistryRadar;
  canonicalSourceUrl: string;
  sourceUrl: string;
  sourceName: string;
  sourceLevel: RegistrySourceLevel;
  sourceAuthority?: RegistrySourceAuthority;
  sourcePublishedAt?: string;
  observedAt: string;
  firstObservedAt: string;
  lastObservedAt: string;
  retrievedAt?: string;
  createdAt: string;
  lastRetrievedAt?: string;
}

export interface EventEngineOutput {
  eventKey: string;
  entity: string;
  canonicalEventType: string;
  fingerprint: string;
  eventState: RegistryEventState;
  duplicate: boolean;
  materialChange: boolean;
}

/** Event Engine facts accepted by the lock-internal Registry state resolver. */
export interface AtomicEventIdentityFacts {
  entity: string;
  canonicalEventType: string;
  eventIdentifier: string;
}

/** Caller input for the atomic production-ready Registry boundary; state outputs are deliberately absent. */
export interface AtomicObservationCommitInput {
  eventKey: string;
  eventFacts: AtomicEventIdentityFacts;
  fingerprint: string;
  observation: ObservationInput;
}

export interface AtomicObservationCommitResult {
  eventKey: string;
  observationId: string;
  eventState: RegistryEventState;
  duplicate: boolean;
  materialChange: boolean;
  observationCreated: boolean;
  eventCreated: boolean;
  eventUpdated: boolean;
  occurrences: number;
  transactionId: string;
  registryWriteStatus: 'COMMITTED';
  event: EventRegistryRecord;
  observation: ObservationRegistryRecord;
}

export interface ObservationInput {
  eventKey: string;
  radar: RegistryRadar;
  sourceName: string;
  sourceUrl: string;
  sourceLevel: RegistrySourceLevel;
  observedAt: string;
  sourceAuthority?: RegistrySourceAuthority;
  sourcePublishedAt?: string;
  retrievedAt?: string;
  [metadata: string]: unknown;
}

export interface RegistryPair {
  events: EventRegistryRecord[];
  observations: ObservationRegistryRecord[];
}

export interface RegistryRuntime {
  stateDir: string;
  clock?: () => Date;
  transactionIdFactory?: () => string;
  processIdentityResolver?: (pid: number) => import('./process-identity.mjs').ProcessIdentityResolution;
  lockTimeoutMs?: number;
  staleThresholdMs?: number;
  failurePoint?: 'after-lock' | 'after-event-temp-write' | 'after-observation-temp-write' | 'after-prepare' | 'after-event-rename' | 'after-observation-rename' | 'before-committed' | 'after-committed-before-snapshot';
  /** Test-only failures for proving corruption evidence writes fail closed. */
  quarantineFailurePoint?: 'before-directory' | 'after-first-evidence-file' | 'before-metadata';
  /** Test-only collision seam; production uses timestamp + evidence digest names. */
  quarantineNameFactory?: (timestamp: string, evidenceKey: string, failureClass: string) => string;
}
