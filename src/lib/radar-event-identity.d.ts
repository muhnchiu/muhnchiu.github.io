export type CanonicalEventType = 'release' | 'model-release' | 'skill-release' | 'research-release' | 'version-update' | 'pricing-change' | 'capability-change' | 'security-cve' | 'security-cisa-kev' | 'security-advisory' | 'funding' | 'incident' | 'documentation';
export type EventFacts = Partial<Record<'version' | 'cveId' | 'activeExploitation' | 'supplyChainImpact' | 'reachableDependency' | 'officialEmergencyAdvisory', string | boolean>> & Record<string, unknown>;
export interface EventIdentityInput { entity: string; canonicalEventType: CanonicalEventType; eventIdentifier: string; fingerprint: string; }
export interface ResolvedEventIdentity extends EventIdentityInput { eventState: 'NEW' | 'DUPLICATE' | 'UPDATE'; duplicate: boolean; materialChange: boolean; }
export const EVENT_FACT_FIELDS: readonly string[];
export const CANONICAL_EVENT_TYPES: readonly CanonicalEventType[];
export function buildEventKey(input: Pick<EventIdentityInput, 'entity' | 'canonicalEventType' | 'eventIdentifier'>): string;
export function buildEventFingerprint(facts?: EventFacts): string;
export function evaluateMaterialChange(input: { canonicalEventType: CanonicalEventType; previousCanonicalEventType?: CanonicalEventType; previousFingerprint?: string; fingerprint: string }): boolean;
export function inspectMaterialChange(input: { canonicalEventType: CanonicalEventType; previousCanonicalEventType?: CanonicalEventType; previousFacts?: EventFacts; facts?: EventFacts }): { materialChange: boolean; policyFieldNotFrozen: boolean };
export function resolveEventState(input: Pick<EventIdentityInput, 'entity' | 'canonicalEventType' | 'eventIdentifier' | 'fingerprint'> & { previousEvents?: Array<{ eventKey: string; canonicalEventType: CanonicalEventType; fingerprint: string }> }): ResolvedEventIdentity;
export function isValidContractEventKey(value: unknown): boolean;
