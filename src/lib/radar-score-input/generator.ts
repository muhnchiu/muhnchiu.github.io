import { mapSourceEvidence } from '../radar-evidence-pipeline.mjs';
import { resolveRadarModifierV201 } from '../radar-intelligence/radar-modifier-resolver-v2.0.1.mjs';
import { resolveScoreInputEligibility, type Candidate, type Provenance } from './eligibility.ts';
import { actionPolicy, assertFrozenInputContract, CONSUMED_INPUTS, INPUT_AUTHORITY, REQUIRED_INPUTS, scoreInputPolicy, scorePolicy, riskPolicy, priorValidationPolicy } from './policy.ts';
import { validateProvenanceRecord } from './provenance.ts';

export type SourceEvidence = {
  evidenceRef: string;
  sourceName: string;
  sourceAuthority?: string;
  sourceUrl?: string;
  sourcePublishedAt?: string;
  observedAt?: string;
  description?: string;
};
export type JudgmentRequest = { field: string; authority: string; rubricVersion: string; candidate: StructuredCandidate; evidence: SourceEvidence[]; context: GenerationContext };
export type Judgment = { value: unknown; rubricVersion: string; modelId: string; provider: string; generationConfigRef: string; generationConfidence: number; evidenceRefs: string[]; authority?: string };
export type JudgmentProvider = (request: JudgmentRequest) => Promise<Judgment | undefined> | Judgment | undefined;
export type StructuredCandidate = {
  radar: string;
  sourceName: string;
  title: string;
  sourceUrl?: string;
  sourcePublishedAt?: string;
  observedAt: string;
  evidence: SourceEvidence[];
  eventIdentity?: { entity: string; canonicalEventType: string; eventKey: string; eventIdentifier: string; evidenceRefs: string[]; identityEngineVersion: string };
  version?: string;
  capabilityScope?: string[];
  intendedUsage?: string;
};
export type GenerationContext = {
  generatedAt: string;
  candidateObservationObservedAt?: string;
  trackedEnvironmentRef?: string;
  relevanceResolution?: { value: string; ruleId: string; evidenceRefs: string[]; policyVersion: string; authority: string };
  momentumResolution?: { value: number; ruleId: string; evidenceRefs: string[]; policyVersion: string; authority: string };
  securityAssessment?: { gate: string; ruleId: string; evidenceRefs: string[]; policyVersion: string; authority: string; escalation?: Record<string, boolean>; escalationRuleId?: string; escalationEvidenceRefs?: string[] };
  deterministicRiskResolution?: { status: 'DECISIVE' | 'CONFLICT' | 'INSUFFICIENT'; value?: string; ruleId?: string; evidenceRefs?: string[]; policyVersion?: string; authority?: string };
  priorValidationLookup?: {
    complete: boolean;
    healthy: boolean;
    authority: string;
    resolution: 'ACTIVE_MATCH' | 'NO_ACTIVE_RECORD' | 'LATEST_STALE' | 'LATEST_REVOKED' | 'CONFLICT';
    registryVersion: string;
    evidenceRefs: string[];
    completeLookupReceipt: string;
    record?: { validationId: string; recordVersion: string; validatedBy: string; validatedAt: string; status: 'ACTIVE' | 'STALE' | 'REVOKED'; entity: string; validatedVersion: string; validatedCapabilities: string[]; validatedUsage: string; validatedEnvironment: string; evidenceRefs: string[]; createdByAuthority: string };
  };
  registryResult?: { committed: boolean; registryWriteStatus: 'COMMITTED'; eventKey: string; eventState: 'NEW' | 'DUPLICATE' | 'UPDATE'; duplicate: boolean; transactionId: string; observationId: string; policyVersion: string };
};
export type GenerationResult = {
  status: 'SCORE_READY' | 'RECEIPT_ONLY';
  inputs: Record<string, unknown> | null;
  provenance: Record<string, Provenance> | null;
  generationFailures: Array<{ code: string; field?: string; detail: string }>;
  missingRequiredInputs: string[];
  receiptOnlyReasons: string[];
  policyVersions: Record<string, string>;
  evidenceReferences: string[];
  observedAtRelationships: Record<string, string>;
  attemptedFieldCount: number;
  eligibility: ReturnType<typeof resolveScoreInputEligibility> | null;
};

const SCORE_RUBRIC_VERSION = '1.0';
const RISK_RUBRIC_VERSION = '1.0';
const ALLOWED_RADARS = new Set(['AI', 'DEV', 'APP', 'SEC', 'SKILL']);
const RELEVANCE_TO_SCORE: Record<string, number> = scorePolicy.scoreCalculation.relevanceMap;
const VALID_EVENT_TYPES = new Set((INPUT_AUTHORITY.get('eventType')?.valueDomain?.enum ?? []) as string[]);
const KNOWN_EVENT_TYPES = actionPolicy.eventClassMapping.futureContract21Adapter;

function timestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function refsExist(refs: unknown, evidence: SourceEvidence[]): refs is string[] { return Array.isArray(refs) && refs.length > 0 && refs.every((ref) => typeof ref === 'string' && evidence.some((item) => item.evidenceRef === ref)); }
function evidenceRows(refs: string[], evidence: SourceEvidence[]): Array<Record<string, unknown>> {
  return evidence.filter((row) => refs.includes(row.evidenceRef)).map((row) => ({
    evidenceRef: row.evidenceRef,
    sourceAuthority: row.sourceAuthority,
    ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
    ...(row.sourcePublishedAt ? { sourcePublishedAt: row.sourcePublishedAt } : {}),
    ...(row.observedAt ? { observedAt: row.observedAt } : {}),
    ...(row.description ? { description: row.description } : {}),
  }));
}
function policyVersion(authority: string, provided?: string): string {
  if (provided) return provided;
  const match = authority.match(/_(\d+(?:\.\d+)+)(?:_|$)/);
  if (match) return match[1];
  if (authority === 'SECURITY_GATE_POLICY') return '1.0';
  if (authority === 'HORIZON_SOURCE_AUTHORITY_MAP') return '1.0';
  if (authority === 'RADAR_SOURCE_RECORD') return '1.0';
  throw new Error(`POLICY_VERSION_UNRESOLVED:${authority}`);
}
function eventClassFor(eventType: string): string | undefined {
  for (const eventClass of ['FIRST_DISCOVERY', 'VERSION_RELEASE', 'OTHER']) {
    const values = KNOWN_EVENT_TYPES[eventClass];
    if (Array.isArray(values) && values.includes(eventType)) return eventClass;
  }
  return undefined;
}

export async function generateScoreInputs(candidate: StructuredCandidate, context: GenerationContext, judgmentProvider?: JudgmentProvider): Promise<GenerationResult> {
  const inputs: Record<string, unknown> = {};
  const provenance: Record<string, Provenance> = {};
  const failures: GenerationResult['generationFailures'] = [];
  const policyVersions: Record<string, string> = {};
  const observedAtRelationships: Record<string, string> = {};
  const evidenceReferences = Array.isArray(candidate?.evidence) ? candidate.evidence.map((row) => row.evidenceRef).filter(nonempty) : [];
  const markFailure = (code: string, detail: string, field?: string) => failures.push({ code, detail, ...(field ? { field } : {}) });

  try {
    assertFrozenInputContract();
    if (!candidate || !context || !timestamp(context.generatedAt)) throw new Error('GENERATION_CONTEXT_INVALID');
    if (!timestamp(candidate.observedAt)) throw new Error('CANDIDATE_OBSERVED_AT_INVALID');
    if (!ALLOWED_RADARS.has(candidate.radar)) markFailure('RADAR_UNSUPPORTED', 'Radar is not in the frozen enum.', 'radar');
    const mapped = mapSourceEvidence(candidate.sourceName);
    if (mapped.errors.length || !mapped.sourceAuthority) markFailure('SOURCE_AUTHORITY_UNKNOWN', 'Source name has no frozen authority mapping.', 'sourceAuthority');
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) markFailure('SOURCE_EVIDENCE_MISSING', 'No source evidence was provided.');
    for (const row of candidate.evidence ?? []) {
      if (!nonempty(row.evidenceRef) || !nonempty(row.sourceName) || !nonempty(row.sourceAuthority)) markFailure('SOURCE_EVIDENCE_INVALID', 'Evidence rows require stable reference, source name, and mapped authority.');
      const rowMapping = mapSourceEvidence(row.sourceName);
      if (rowMapping.errors.length || row.sourceAuthority !== rowMapping.sourceAuthority) markFailure('SOURCE_EVIDENCE_AUTHORITY_MISMATCH', 'Evidence source authority must match the frozen per-source map.');
      if (!nonempty(row.sourceUrl)) markFailure('SOURCE_ITEM_URL_MISSING', 'Source evidence requires its original item URL; third-party references cannot substitute.', 'sourceAuthority');
      else if (!/^https:\/\//i.test(row.sourceUrl) || !URL.canParse(row.sourceUrl)) markFailure('SOURCE_URL_INVALID', 'Evidence URL must be the original source HTTPS URL.');
      if (!timestamp(row.observedAt)) markFailure('SOURCE_EVIDENCE_OBSERVED_AT_MISSING', 'Source evidence must retain an explicit observedAt timestamp.');
      if (row.sourcePublishedAt && timestamp(row.observedAt) && Date.parse(row.sourcePublishedAt) > Date.parse(row.observedAt)) markFailure('TIME_ORDER_POLICY_UNDEFINED', 'Source publication later than observation has no frozen ordering rule.');
    }
    const sourceRefs = evidenceReferences.filter((ref) => candidate.evidence.some((row) => row.evidenceRef === ref));
    if (candidate.evidence.length > 0 && !candidate.evidence.some((row) => row.sourceName === candidate.sourceName && row.sourceAuthority === mapped.sourceAuthority)) markFailure('PRIMARY_SOURCE_EVIDENCE_MISSING', 'Candidate source must be represented by a mapped per-item evidence row.');
    if (timestamp(candidate.observedAt) && Date.parse(context.generatedAt) < Date.parse(candidate.observedAt)) markFailure('GENERATION_TIME_PRECEDES_OBSERVATION', 'Generation timestamp cannot precede the candidate observation.');

    const put = (field: string, value: unknown, method: string, details: Record<string, any>) => {
      const authorityRow = INPUT_AUTHORITY.get(field);
      if (!authorityRow) { markFailure('UNKNOWN_INPUT_AUTHORITY', 'Field is not declared by the frozen authority map.', field); return; }
      if (!authorityRow.generationMethods.includes(method)) { markFailure('UNSUPPORTED_GENERATION_METHOD', `${method} is not permitted by the frozen field authority.`, field); return; }
      const authority = authorityRow.primaryAuthority;
      const relation = details.observedAtRelationship ?? 'SOURCE_EVIDENCE';
      const record: Record<string, unknown> = { field, value, generationMethod: method, authority, observedAtRelationship: relation, generatedAt: context.generatedAt };
      if (method === 'MODEL_JUDGMENT') {
        const judgment = details.judgment as Judgment;
        if (judgment.authority !== undefined && judgment.authority !== authority) { markFailure('UNSUPPORTED_MODEL_AUTHORITY', 'Model output cannot override the frozen primary authority.', field); return; }
        const expectedRubricVersion = authority === 'SCORE_INPUT_RUBRIC_1.0' ? SCORE_RUBRIC_VERSION : policyVersion(authority);
        if (judgment.rubricVersion !== expectedRubricVersion) { markFailure('MODEL_RUBRIC_VERSION_INVALID', 'Model judgment must declare the frozen rubric/policy version.', field); return; }
        if (!nonempty(judgment.modelId) || !nonempty(judgment.provider) || !nonempty(judgment.generationConfigRef) || !Number.isFinite(judgment.generationConfidence) || !refsExist(judgment.evidenceRefs, candidate.evidence)) { markFailure('MODEL_JUDGMENT_PROVENANCE_INVALID', 'Judgment needs version, model/provider/config, confidence, and candidate evidence references.', field); return; }
        Object.assign(record, { rubricVersion: judgment.rubricVersion, modelId: judgment.modelId, provider: judgment.provider, generationConfigRef: judgment.generationConfigRef, generationConfidence: judgment.generationConfidence, sourceEvidence: evidenceRows(judgment.evidenceRefs, candidate.evidence) });
        policyVersions[field] = judgment.rubricVersion;
      } else if (method === 'HUMAN_AUTHORITY') {
        Object.assign(record, { policyVersion: details.policyVersion, humanValidationRecord: details.humanValidationRecord });
        policyVersions[field] = details.policyVersion;
      } else if (method === 'DERIVED') {
        Object.assign(record, { policyVersion: details.policyVersion, derivedFrom: details.derivedFrom });
        policyVersions[field] = details.policyVersion;
      } else {
        Object.assign(record, { policyVersion: details.policyVersion, ruleId: details.ruleId, sourceEvidence: evidenceRows(details.evidenceRefs ?? sourceRefs, candidate.evidence) });
        policyVersions[field] = details.policyVersion;
      }
      if (relation === 'SAME_OBSERVATION' && context.candidateObservationObservedAt) record.candidateObservationObservedAt = context.candidateObservationObservedAt;
      if (relation === 'SOURCE_EVIDENCE') record.sourceEvidence = evidenceRows(details.evidenceRefs ?? sourceRefs, candidate.evidence);
      if (relation === 'PRIOR_STATE') record.decisionEvidenceRefs = details.decisionEvidenceRefs;
      if (relation === 'HUMAN_RECORD' && !record.humanValidationRecord) record.humanValidationRecord = details.humanValidationRecord;
      if (relation === 'DERIVED_FROM_INPUTS') record.derivedFrom ??= details.derivedFrom;
      if (method === 'DETERMINISTIC' && (!nonempty(details.ruleId) || !refsExist(details.evidenceRefs ?? sourceRefs, candidate.evidence))) { markFailure('DETERMINISTIC_PROVENANCE_INVALID', 'Deterministic values need a rule identifier and source evidence.', field); return; }
      const schemaResult = validateProvenanceRecord(record);
      if (!schemaResult.valid) { markFailure('TYPED_PROVENANCE_INVALID', schemaResult.errors.join('; '), field); return; }
      inputs[field] = value;
      provenance[field] = record as Provenance;
      observedAtRelationships[field] = String(relation);
    };

    const deterministic = (field: string, value: unknown, ruleId: string, refs = sourceRefs, version?: string, relationship = 'SOURCE_EVIDENCE') => put(field, value, 'DETERMINISTIC', { ruleId, evidenceRefs: refs, policyVersion: policyVersion(INPUT_AUTHORITY.get(field)?.primaryAuthority, version), observedAtRelationship: relationship });
    const derived = (field: string, value: unknown, from: string[], version?: string) => put(field, value, 'DERIVED', { derivedFrom: from, policyVersion: policyVersion(INPUT_AUTHORITY.get(field)?.primaryAuthority, version), observedAtRelationship: 'DERIVED_FROM_INPUTS' });
    const model = async (field: string, version = policyVersion(INPUT_AUTHORITY.get(field)!.primaryAuthority)) => {
      if (!judgmentProvider) { markFailure('MODEL_JUDGMENT_UNAVAILABLE', 'No injectable judgment provider is configured.', field); return; }
      try {
        const result = await judgmentProvider({ field, authority: INPUT_AUTHORITY.get(field)?.primaryAuthority, rubricVersion: version, candidate, evidence: candidate.evidence ?? [], context });
        if (!result) { markFailure('MODEL_JUDGMENT_MISSING', 'Judgment provider returned no result.', field); return; }
        put(field, result.value, 'MODEL_JUDGMENT', { judgment: result, observedAtRelationship: 'SOURCE_EVIDENCE' });
      } catch (error) { markFailure('MODEL_JUDGMENT_FAILED', error instanceof Error ? error.message : String(error), field); }
    };

    deterministic('radar', candidate.radar, 'RADAR_FROM_STRUCTURED_CANDIDATE');
    deterministic('title', candidate.title, 'TITLE_FROM_SOURCE_RECORD');
    if (!candidate.eventIdentity) markFailure('EVENT_IDENTITY_UNAVAILABLE', 'Contract 2.1.2 identity output is required.', 'entity');
    else if (candidate.eventIdentity.identityEngineVersion !== '2.1.2' || candidate.eventIdentity.eventKey !== `${candidate.eventIdentity.entity}:${candidate.eventIdentity.canonicalEventType}:${candidate.eventIdentity.eventIdentifier}` || !refsExist(candidate.eventIdentity.evidenceRefs, candidate.evidence)) markFailure('EVENT_IDENTITY_CONTEXT_INVALID', 'Event identity must match explicit Contract 2.1.2 output and cited evidence.', 'entity');
    else {
      deterministic('entity', candidate.eventIdentity.entity, `EVENT_ENTITY_${candidate.eventIdentity.identityEngineVersion}`, candidate.eventIdentity.evidenceRefs, '2.1.2');
      if (!VALID_EVENT_TYPES.has(candidate.eventIdentity.canonicalEventType)) markFailure('EVENT_TYPE_INVALID', 'Canonical Event Policy type is not accepted by Score Policy 2.1.', 'eventType');
      else {
        deterministic('eventType', candidate.eventIdentity.canonicalEventType, `EVENT_TYPE_${candidate.eventIdentity.identityEngineVersion}`, candidate.eventIdentity.evidenceRefs, '1.0');
        const eventClass = eventClassFor(candidate.eventIdentity.canonicalEventType);
        if (!eventClass) markFailure('EVENT_CLASS_UNRESOLVED', 'Frozen Contract 2.1.2 event-class map has no entry.', 'eventClass');
        else derived('eventClass', eventClass, ['eventType'], '2.1.0');
      }
    }
    if (mapped.sourceAuthority) deterministic('sourceAuthority', mapped.sourceAuthority, 'SOURCE_AUTHORITY_STATIC_MAP_V1', sourceRefs, '1.0');

    const deterministicRelevance = context.relevanceResolution;
    if (deterministicRelevance) {
      if (deterministicRelevance.authority !== 'SCORE_INPUT_GENERATION_POLICY_2.1.0' || deterministicRelevance.policyVersion !== '2.1.0') markFailure('RELEVANCE_RULE_AUTHORITY_INVALID', 'Deterministic relevance must come from frozen Score Input Generation Policy 2.1.0.', 'relevanceLevel');
      else deterministic('relevanceLevel', deterministicRelevance.value, deterministicRelevance.ruleId, deterministicRelevance.evidenceRefs, deterministicRelevance.policyVersion);
    }
    else await model('relevanceLevel');
    if (inputs.relevanceLevel && Object.hasOwn(RELEVANCE_TO_SCORE, String(inputs.relevanceLevel))) derived('relevanceScore', RELEVANCE_TO_SCORE[String(inputs.relevanceLevel)], ['relevanceLevel'], '2.1.0');
    else markFailure('RELEVANCE_SCORE_UNRESOLVED', 'Relevance level did not resolve to a frozen relevance score.', 'relevanceScore');

    for (const field of ['impact', 'actionability', 'confidence', 'novelty']) await model(field);
    if (context.momentumResolution) {
      if (context.momentumResolution.authority !== 'SCORE_INPUT_GENERATION_POLICY_2.1.0' || context.momentumResolution.policyVersion !== '2.1.0') markFailure('MOMENTUM_RULE_AUTHORITY_INVALID', 'Deterministic momentum must come from frozen Score Input Generation Policy 2.1.0.', 'momentum');
      else deterministic('momentum', context.momentumResolution.value, context.momentumResolution.ruleId, context.momentumResolution.evidenceRefs, context.momentumResolution.policyVersion);
    }
    else await model('momentum');

    if (candidate.eventIdentity && inputs.relevanceLevel) {
      const modifier = resolveRadarModifierV201({ radar: candidate.radar.toLowerCase(), title: candidate.title, entity: candidate.eventIdentity.entity, relevanceLevel: inputs.relevanceLevel });
      deterministic('radarModifier', modifier.radarModifier, `SCORE_POLICY_2.0.1_MODIFIER_RESOLVER:${modifier.matchedRules.join('+') || 'NO_MATCH'}`);
    } else markFailure('RADAR_MODIFIER_UNRESOLVED', 'Modifier requires valid Radar, title, entity, and relevance.', 'radarModifier');

    const security = context.securityAssessment;
    if (!security) markFailure('SECURITY_GATE_UNRESOLVED', 'No explicit deterministic Security Gate assessment.', 'securityGate');
    else if (security.authority !== 'SECURITY_GATE_POLICY' || security.policyVersion !== '1.0') markFailure('SECURITY_GATE_AUTHORITY_INVALID', 'Security assessment does not identify the frozen primary authority and version.', 'securityGate');
    else {
      deterministic('securityGate', security.gate, security.ruleId, security.evidenceRefs, security.policyVersion);
      if (security.escalation !== undefined) deterministic('securityEscalation', security.escalation, security.escalationRuleId ?? '', security.escalationEvidenceRefs ?? [], security.policyVersion);
    }

    const riskFacts = context.deterministicRiskResolution;
    const hasRiskContext = nonempty(candidate.version) && nonempty(candidate.intendedUsage) && nonempty(context.trackedEnvironmentRef) && candidate.evidence.length > 0;
    if (!hasRiskContext) markFailure('RISK_UNRESOLVED', 'Risk requires candidate version, intended use, tracked environment, and evidence.', 'risk');
    else if (riskFacts?.status === 'CONFLICT') markFailure('RISK_UNRESOLVED', 'Conflicting authoritative risk facts; no model may override them.', 'risk');
    else if (riskFacts?.status === 'DECISIVE') {
      if (riskFacts.authority !== 'RISK_POLICY_1.0' || riskFacts.policyVersion !== '1.0') markFailure('RISK_AUTHORITY_INVALID', 'Deterministic risk must come from the frozen Risk Policy 1.0 authority.', 'risk');
      else if (!riskFacts.value || !riskFacts.ruleId || !refsExist(riskFacts.evidenceRefs, candidate.evidence)) markFailure('RISK_DETERMINISTIC_PROVENANCE_INVALID', 'Decisive risk result lacks a policy rule or cited evidence.', 'risk');
      else deterministic('risk', riskFacts.value, riskFacts.ruleId, riskFacts.evidenceRefs, riskFacts.policyVersion ?? '1.0');
    } else {
      await model('risk');
      const riskRecord = provenance.risk;
      const level = inputs.risk as string | undefined;
      const minConfidence = level ? riskPolicy.enum[level]?.minimumGenerationConfidence : undefined;
      if (riskRecord?.generationMethod === 'MODEL_JUDGMENT' && (minConfidence === undefined || Number(riskRecord.generationConfidence) < minConfidence)) {
        delete inputs.risk; delete provenance.risk; delete policyVersions.risk; delete observedAtRelationships.risk;
        markFailure('RISK_JUDGMENT_CONFIDENCE_LOW', 'Model risk judgment does not meet the frozen level-specific confidence minimum.', 'risk');
      }
    }

    const validation = context.priorValidationLookup;
    if (!validation || !validation.complete || !validation.healthy) markFailure('PRIOR_VALIDATION_UNRESOLVED', 'Human validation lookup is absent, incomplete, or unhealthy.', 'priorValidation');
    else if (validation.authority !== 'EXPLICIT_HUMAN_VALIDATION' || !nonempty(validation.registryVersion) || !refsExist(validation.evidenceRefs, candidate.evidence)) markFailure('PRIOR_VALIDATION_AUTHORITY_INVALID', 'Only a complete explicit human-authority lookup with cited evidence is accepted.', 'priorValidation');
    else if (validation.resolution === 'CONFLICT') markFailure('PRIOR_VALIDATION_UNRESOLVED', 'Conflicting active validation records.', 'priorValidation');
    else {
      let active = false;
      if (validation.resolution === 'ACTIVE_MATCH') {
        const record = validation.record;
        const scopeMatches = record && record.status === 'ACTIVE' && record.createdByAuthority === 'EXPLICIT_HUMAN_VALIDATION'
          && record.entity === candidate.eventIdentity?.entity && record.validatedVersion === candidate.version
          && record.validatedUsage === candidate.intendedUsage && record.validatedEnvironment === context.trackedEnvironmentRef
          && JSON.stringify([...record.validatedCapabilities].sort()) === JSON.stringify([...(candidate.capabilityScope ?? [])].sort())
          && refsExist(record.evidenceRefs, candidate.evidence) && nonempty(record.validationId) && nonempty(record.recordVersion)
          && nonempty(record.validatedBy) && timestamp(record.validatedAt);
        if (!scopeMatches) markFailure('PRIOR_VALIDATION_SCOPE_MISMATCH', 'ACTIVE human validation does not match current entity, version, capabilities, use, and environment.', 'priorValidation');
        else active = true;
      } else if (validation.resolution === 'LATEST_STALE' && validation.record?.status !== 'STALE') markFailure('PRIOR_VALIDATION_LIFECYCLE_MISMATCH', 'Lookup resolution and stored stale state disagree.', 'priorValidation');
      else if (validation.resolution === 'LATEST_REVOKED' && validation.record?.status !== 'REVOKED') markFailure('PRIOR_VALIDATION_LIFECYCLE_MISMATCH', 'Lookup resolution and stored revoked state disagree.', 'priorValidation');
      const humanValidationRecord = {
        resolution: validation.resolution,
        ...(validation.record?.validationId ? { validationId: validation.record.validationId } : {}),
        ...(validation.record?.recordVersion ? { recordVersion: validation.record.recordVersion } : {}),
        registryVersion: validation.registryVersion,
        ...(validation.record?.validatedBy ? { validatedBy: validation.record.validatedBy } : {}),
        ...(validation.record?.validatedAt ? { validatedAt: validation.record.validatedAt } : {}),
        evidenceRefs: validation.evidenceRefs,
        completeLookupReceipt: validation.completeLookupReceipt,
      };
      if (!nonempty(validation.completeLookupReceipt)) markFailure('PRIOR_VALIDATION_RECEIPT_MISSING', 'Complete human registry lookup receipt is required.', 'priorValidation');
      else put('priorValidation', active, 'HUMAN_AUTHORITY', { policyVersion: '1.0', humanValidationRecord, observedAtRelationship: 'HUMAN_RECORD' });
    }

    const registry = context.registryResult;
    if (!registry || !registry.committed || registry.registryWriteStatus !== 'COMMITTED') markFailure('REGISTRY_RESULT_UNAVAILABLE', 'Duplicate must come from an explicit committed Event/Observation Registry result.', 'duplicate');
    else if (!candidate.eventIdentity || registry.eventKey !== candidate.eventIdentity.eventKey || !['NEW', 'DUPLICATE', 'UPDATE'].includes(registry.eventState) || registry.policyVersion !== '1.0' || typeof registry.duplicate !== 'boolean' || registry.duplicate !== (registry.eventState === 'DUPLICATE') || !nonempty(registry.transactionId) || !nonempty(registry.observationId)) markFailure('REGISTRY_RESULT_INVALID', 'Committed Registry result is incomplete or does not match candidate identity.', 'duplicate');
    else derived('duplicate', registry.duplicate, [`registry:${registry.transactionId}`, `observation:${registry.observationId}`], '1.0');

    const missingRequiredInputs = REQUIRED_INPUTS.filter((field) => !Object.hasOwn(inputs, field));
    for (const field of missingRequiredInputs) if (!failures.some((row) => row.field === field)) markFailure('REQUIRED_INPUT_MISSING', 'No valid generated value is available.', field);
    for (const [field, row] of Object.entries(provenance)) {
      const map = INPUT_AUTHORITY.get(field);
      if (!map || row.authority !== map.primaryAuthority) markFailure('SCORE_INPUT_AUTHORITY_DRIFT', 'Generated authority differs from frozen package ownership.', field);
    }
    const eligibility = resolveScoreInputEligibility({ inputs, provenance } as Candidate);
    if (eligibility.status !== 'SCORE_READY') markFailure('ELIGIBILITY_REJECTED', eligibility.diagnostics.join('; '));
    const status = failures.length === 0 && eligibility.status === 'SCORE_READY' ? 'SCORE_READY' : 'RECEIPT_ONLY';
    return {
      status,
      inputs: status === 'SCORE_READY' ? inputs : null,
      provenance: status === 'SCORE_READY' ? provenance : null,
      generationFailures: failures,
      missingRequiredInputs: [...new Set(missingRequiredInputs)],
      receiptOnlyReasons: [...new Set(failures.map((row) => row.code))],
      policyVersions,
      evidenceReferences: [...new Set(evidenceReferences)],
      observedAtRelationships,
      attemptedFieldCount: Object.keys(inputs).length,
      eligibility,
    };
  } catch (error) {
    return {
      status: 'RECEIPT_ONLY', inputs: null, provenance: null,
      generationFailures: [{ code: 'GENERATION_EXCEPTION_FAIL_CLOSED', detail: error instanceof Error ? error.message : String(error) }],
      missingRequiredInputs: [...REQUIRED_INPUTS], receiptOnlyReasons: ['GENERATION_EXCEPTION_FAIL_CLOSED'],
      policyVersions: {}, evidenceReferences: [...new Set(evidenceReferences)], observedAtRelationships: {}, attemptedFieldCount: 0, eligibility: null,
    };
  }
}

/** Downstream calls are impossible for receipt-only results. Registry and publisher are never called by this boundary. */
export function dispatchGeneratedScore<TScore, TAction>(result: GenerationResult, score: (inputs: Record<string, unknown>) => TScore, action: (scored: TScore, inputs: Record<string, unknown>) => TAction): { status: 'RECEIPT_ONLY'; reasons: string[] } | { status: 'SCORE_READY'; score: TScore; action: TAction } {
  if (result.status !== 'SCORE_READY' || !result.inputs || !result.provenance) return { status: 'RECEIPT_ONLY', reasons: result.receiptOnlyReasons };
  const scored = score(result.inputs);
  return { status: 'SCORE_READY', score: scored, action: action(scored, result.inputs) };
}

export const scoreInputAuthorityAudit = {
  consumedInputs: CONSUMED_INPUTS.length,
  missingAuthority: scoreInputPolicy.authorityMap.missingAuthorities,
  competingAuthority: scoreInputPolicy.authorityMap.competingPrimaryAuthorities,
  unknownAuthority: scoreInputPolicy.authorityMap.unknownAuthorityEntries,
  authorities: Object.fromEntries(CONSUMED_INPUTS.map((row: any) => [row.field, row.primaryAuthority])),
};
