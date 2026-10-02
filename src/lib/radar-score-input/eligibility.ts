import { isDeepStrictEqual } from 'node:util';

/**
 * Pure conformance gate for the Score Policy 2.1 candidate.
 * It validates and classifies inputs only: it never scores, assigns EventState,
 * mutates Registry state, publishes, fills defaults, or reverse-maps V1 fields.
 */

export type EligibilityReason =
  | 'MISSING_PROVENANCE'
  | 'MISSING_AUTHORITY'
  | 'MISSING_VERSION'
  | 'MISSING_EVIDENCE'
  | 'MISSING_TIME_RELATION'
  | 'INVALID_VALUE';

export type EligibilityResult =
  | { status: 'SCORE_READY'; reasons: []; diagnostics: [] }
  | { status: 'RECEIPT_ONLY'; reasons: EligibilityReason[]; diagnostics: string[] };

export type InputRule = {
  domain: 'enum' | 'integer' | 'number' | 'boolean' | 'string' | 'object';
  values?: readonly unknown[];
  min?: number;
  max?: number;
  required?: boolean;
  properties?: Record<string, InputRule>;
  additionalProperties?: boolean;
};

export type Provenance = {
  field?: unknown;
  value?: unknown;
  generationMethod?: unknown;
  authority?: unknown;
  policyVersion?: unknown;
  rubricVersion?: unknown;
  observedAtRelationship?: unknown;
  generatedAt?: unknown;
  ruleId?: unknown;
  sourceEvidence?: unknown;
  derivedFrom?: unknown;
  humanValidationRecord?: unknown;
  [key: string]: unknown;
};

export type Candidate = {
  inputs?: Record<string, unknown>;
  provenance?: Record<string, Provenance | undefined>;
};

const FAILURE_ORDER: readonly EligibilityReason[] = [
  'MISSING_PROVENANCE',
  'MISSING_AUTHORITY',
  'MISSING_VERSION',
  'MISSING_EVIDENCE',
  'MISSING_TIME_RELATION',
  'INVALID_VALUE',
];

const AUTHORITIES: Record<string, readonly string[]> = {
  radar: ['SCORE_INPUT_GENERATION_POLICY_2.1.0'],
  relevanceLevel: ['SCORE_INPUT_GENERATION_POLICY_2.1.0'],
  relevanceScore: ['SCORE_POLICY_2.1.0'],
  impact: ['SCORE_INPUT_RUBRIC_1.0'],
  actionability: ['SCORE_INPUT_RUBRIC_1.0'],
  confidence: ['SCORE_INPUT_RUBRIC_1.0'],
  novelty: ['SCORE_INPUT_RUBRIC_1.0'],
  momentum: ['SCORE_INPUT_GENERATION_POLICY_2.1.0'],
  radarModifier: ['SCORE_POLICY_2.0.1_MODIFIER_RESOLVER'],
  securityGate: ['SECURITY_GATE_POLICY'],
  securityEscalation: ['SECURITY_GATE_POLICY'],
  risk: ['RISK_POLICY_1.0'],
  priorValidation: ['HUMAN_VALIDATION_REGISTRY'],
  eventType: ['EVENT_POLICY_1.0'],
  duplicate: ['REGISTRY_POLICY_1.0'],
  eventClass: ['ACTION_DECISION_POLICY_2.1.0'],
  entity: ['EVENT_POLICY_1.0'],
  title: ['RADAR_SOURCE_RECORD'],
  sourceAuthority: ['HORIZON_SOURCE_AUTHORITY_MAP'],
};

const POLICY_VERSION: Record<string, string> = {
  radar: '2.1.0', relevanceLevel: '2.1.0',
  relevanceScore: '2.1.0', impact: '1.0', actionability: '1.0', confidence: '1.0',
  novelty: '1.0', momentum: '2.1.0', radarModifier: '2.0.1',
  securityGate: '1.0', securityEscalation: '1.0', risk: '1.0',
  priorValidation: '1.0', eventType: '1.0', duplicate: '1.0',
  eventClass: '2.1.0', entity: '2.1.2', title: '1.0', sourceAuthority: '1.0',
};

/** Field domains are derived from Score Policy 2.1, its action input contract,
 * and the reconciled input authority map. EventState is intentionally excluded:
 * it is an upstream evaluation/Registry result, not a generated score input.
 */
export const SCORE_INPUT_RULES: Readonly<Record<string, InputRule>> = {
  radar: { domain: 'enum', values: ['AI', 'DEV', 'APP', 'SEC', 'SKILL'] },
  relevanceLevel: { domain: 'enum', values: ['DIRECT', 'ADJACENT', 'EXPLORATORY', 'UNRELATED'] },
  relevanceScore: { domain: 'enum', values: [9, 5, 3, 1] },
  impact: { domain: 'integer', min: 0, max: 10 },
  actionability: { domain: 'integer', min: 0, max: 10 },
  confidence: { domain: 'integer', min: 0, max: 10 },
  novelty: { domain: 'integer', min: 0, max: 10 },
  momentum: { domain: 'integer', min: 0, max: 10 },
  radarModifier: { domain: 'integer', min: -10, max: 10 },
  securityGate: { domain: 'enum', values: ['N/A', 'DIRECTLY_EXPOSED', 'DEPENDENCY_RELEVANT', 'ECOSYSTEM_RELEVANT', 'UNRELATED'] },
  securityEscalation: { domain: 'object', required: false, properties: { activeExploitation: { domain: 'boolean' }, supplyChainImpact: { domain: 'boolean' }, reachableDependency: { domain: 'boolean' }, officialEmergencyAdvisory: { domain: 'boolean' } }, additionalProperties: false },
  risk: { domain: 'enum', values: ['low', 'normal', 'high'] },
  priorValidation: { domain: 'boolean' },
  eventType: { domain: 'enum', values: ['release', 'model-release', 'skill-release', 'research-release', 'version-update', 'pricing-change', 'capability-change', 'security-cve', 'security-cisa-kev', 'security-advisory', 'funding', 'incident', 'documentation'] },
  duplicate: { domain: 'boolean' },
  eventClass: { domain: 'enum', values: ['FIRST_DISCOVERY', 'VERSION_RELEASE', 'OTHER'] },
  entity: { domain: 'string' },
  title: { domain: 'string' },
  sourceAuthority: { domain: 'enum', values: ['official', 'primary', 'secondary', 'community'] },
};

const REQUIRED_INPUTS = Object.keys(SCORE_INPUT_RULES).filter(
  (field) => SCORE_INPUT_RULES[field].required !== false,
);

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueValid(value: unknown, rule: InputRule): boolean {
  switch (rule.domain) {
    case 'enum': return rule.values?.some((entry) => entry === value) ?? false;
    case 'integer': return Number.isInteger(value) && (rule.min === undefined || (value as number) >= rule.min) && (rule.max === undefined || (value as number) <= rule.max);
    case 'number': return typeof value === 'number' && Number.isFinite(value) && (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max);
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string' && value.length > 0;
    case 'object': {
      if (!isRecord(value)) return false;
      const properties = rule.properties ?? {};
      if (rule.additionalProperties === false && Object.keys(value).some((key) => !hasOwn(properties, key))) return false;
      return Object.entries(value).every(([key, entry]) => properties[key] ? valueValid(entry, properties[key]) : rule.additionalProperties !== false);
    }
  }
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Collect all contract failures, in stable reason and field order. */
export function resolveScoreInputEligibility(candidate: Candidate): EligibilityResult {
  const failures = new Map<EligibilityReason, string[]>();
  const add = (reason: EligibilityReason, field: string, detail: string) => {
    const entries = failures.get(reason) ?? [];
    entries.push(`${field}: ${detail}`);
    failures.set(reason, entries);
  };
  const inputs = isRecord(candidate?.inputs) ? candidate.inputs : {};
  const provenance = isRecord(candidate?.provenance) ? candidate.provenance : {};

  for (const field of [...REQUIRED_INPUTS, ...Object.keys(inputs).filter((name) => SCORE_INPUT_RULES[name]?.required === false)]) {
    const rule = SCORE_INPUT_RULES[field];
    const hasValue = hasOwn(inputs, field);
    const record = provenance[field] as Provenance | undefined;
    if (!record || !isRecord(record)) add('MISSING_PROVENANCE', field, 'field provenance record is absent');
    if (record && (!record.authority || record.authority === 'UNKNOWN' || !(AUTHORITIES[field] ?? []).includes(String(record.authority)))) {
      add('MISSING_AUTHORITY', field, 'authority is absent, UNKNOWN, or not the primary field authority');
    }
    if (record) {
      const method = String(record.generationMethod ?? '');
      const version = method === 'MODEL_JUDGMENT' ? record.rubricVersion : record.policyVersion;
      if (typeof version !== 'string' || version.trim() === '' || version !== POLICY_VERSION[field]) {
        add('MISSING_VERSION', field, 'required exact policy/rubric version is absent or unexpected');
      }
      if (method === 'DETERMINISTIC' && (typeof record.ruleId !== 'string' || !record.ruleId.trim())) add('MISSING_EVIDENCE', field, 'deterministic ruleId is absent');
      if (method === 'MODEL_JUDGMENT' && (!isNonEmptyArray(record.sourceEvidence) || typeof record.modelId !== 'string' || typeof record.provider !== 'string' || typeof record.generationConfigRef !== 'string')) add('MISSING_EVIDENCE', field, 'model identity/config/source evidence is incomplete');
      if (method === 'HUMAN_AUTHORITY' && (!isRecord(record.humanValidationRecord) || !record.humanValidationRecord.registryVersion || !isNonEmptyArray(record.humanValidationRecord.evidenceRefs))) add('MISSING_EVIDENCE', field, 'explicit human validation authority record is incomplete');
      if (method === 'DERIVED' && !isNonEmptyArray(record.derivedFrom)) add('MISSING_EVIDENCE', field, 'derivedFrom is absent');
      if (record.field !== field || !['DETERMINISTIC', 'MODEL_JUDGMENT', 'HUMAN_AUTHORITY', 'DERIVED'].includes(method)) add('INVALID_VALUE', field, 'provenance field or generation method is invalid');
      if (!['SAME_OBSERVATION', 'SOURCE_EVIDENCE', 'PRIOR_STATE', 'HUMAN_RECORD', 'DERIVED_FROM_INPUTS'].includes(String(record.observedAtRelationship ?? ''))) add('MISSING_TIME_RELATION', field, 'observedAtRelationship is absent or unknown');
      if (typeof record.generatedAt !== 'string' || Number.isNaN(Date.parse(record.generatedAt))) add('MISSING_TIME_RELATION', field, 'generatedAt is absent or invalid');
      if (record.observedAtRelationship === 'SAME_OBSERVATION' && (typeof record.candidateObservationObservedAt !== 'string' || Number.isNaN(Date.parse(record.candidateObservationObservedAt)))) add('MISSING_TIME_RELATION', field, 'candidate Observation observedAt is absent or invalid');
      if (record.observedAtRelationship === 'SOURCE_EVIDENCE' && !isNonEmptyArray(record.sourceEvidence)) add('MISSING_TIME_RELATION', field, 'source evidence is absent');
      if (record.observedAtRelationship === 'PRIOR_STATE' && !isNonEmptyArray(record.decisionEvidenceRefs)) add('MISSING_TIME_RELATION', field, 'prior-state evidence is absent');
      if (record.observedAtRelationship === 'HUMAN_RECORD' && !isRecord(record.humanValidationRecord)) add('MISSING_TIME_RELATION', field, 'human record is absent');
      if (record.observedAtRelationship === 'DERIVED_FROM_INPUTS' && !isNonEmptyArray(record.derivedFrom)) add('MISSING_TIME_RELATION', field, 'derived input references are absent');
    }
    if (rule.required !== false && (!hasValue || !valueValid(inputs[field], rule))) add('INVALID_VALUE', field, hasValue ? `value does not match ${rule.domain} domain` : 'required value is absent');
    if (rule.required === false && hasValue && !valueValid(inputs[field], rule)) add('INVALID_VALUE', field, `value does not match ${rule.domain} domain`);
      if (record && hasValue && !isDeepStrictEqual(record.value, inputs[field])) add('INVALID_VALUE', field, 'provenance value differs from candidate input');
  }

  for (const field of Object.keys(inputs)) {
    if (!hasOwn(SCORE_INPUT_RULES, field)) add('INVALID_VALUE', field, 'unknown Score Input field');
  }
  for (const field of Object.keys(provenance)) {
    if (!hasOwn(SCORE_INPUT_RULES, field)) add('INVALID_VALUE', field, 'unknown provenance field');
  }

  const reasons = FAILURE_ORDER.filter((reason) => (failures.get(reason)?.length ?? 0) > 0);
  if (reasons.length === 0) return { status: 'SCORE_READY', reasons: [], diagnostics: [] };
  return {
    status: 'RECEIPT_ONLY',
    reasons,
    diagnostics: reasons.flatMap((reason) => failures.get(reason) ?? []),
  };
}

/** Guard example integration entry point: callback is never invoked for receipt-only. */
export function withScoreReady<T>(candidate: Candidate, score: (inputs: Record<string, unknown>) => T): T | EligibilityResult {
  const result = resolveScoreInputEligibility(candidate);
  if (result.status !== 'SCORE_READY') return result;
  return score(candidate.inputs!);
}

/** Guard every downstream score/action/registry-scoring/publication adapter. */
export function dispatchScoreReadyCandidate<T>(candidate: Candidate, downstream: (inputs: Record<string, unknown>) => T): T | EligibilityResult {
  const result = resolveScoreInputEligibility(candidate);
  if (result.status !== 'SCORE_READY') return result;
  return downstream(candidate.inputs!);
}

/** Export stable required fields for audits and fixture generation. */
export const REQUIRED_SCORE_INPUT_FIELDS = REQUIRED_INPUTS;
