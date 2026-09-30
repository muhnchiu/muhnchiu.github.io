export interface ObservationInput { eventKey: string; radar: 'ai' | 'dev' | 'app' | 'security' | 'skill'; sourceName: string; sourceUrl: string; sourceLevel: 'official' | 'research' | 'ecosystem' | 'media' | 'community'; observedAt: string; sourceAuthority?: 'official' | 'primary' | 'secondary' | 'community'; sourcePublishedAt?: string; retrievedAt?: string; [metadata: string]: unknown; }
export function canonicalizeSourceUrl(value: string): string;
export function buildObservationIdentity(observation: ObservationInput): { observationId: string; canonicalSourceUrl: string; identityInput: string };
export function resolveObservationTimes(observations: Array<Pick<ObservationInput, 'observedAt'>>): { firstSeen: string; lastSeen: string };
