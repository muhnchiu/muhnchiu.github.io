import { assertFrozenRuntimePackages, frozenClassificationMatrix, frozenDecisionTable, frozenEscalationMatrix, frozenSecurityPolicy } from './frozen-policies.mjs';

const RELATIONSHIPS = ['directExposure', 'dependencyRelationship', 'ecosystemRelationship'];
const ESCALATION_KEYS = ['activeExploitation', 'supplyChainImpact', 'reachableDependency', 'officialEmergencyAdvisory'];
const STATES = new Set(['TRUE', 'FALSE', 'UNKNOWN', 'NOT_APPLICABLE', 'MISSING']);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const refs = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const instant = (v) => typeof v === 'string' && v.endsWith('Z') && Number.isFinite(Date.parse(v));
const invalid = (reasonCodes) => ({ status: 'INVALID_INPUT', classificationResolution: 'INVALID_INPUT', gateClass: null, escalationResult: 'UNRESOLVED', hardFilter: false, outgoingSignal: null, reasonCodes, scoreEligible: false });

function validateRelation(row) {
  if (!isObj(row) || !STATES.has(row.state)) return 'SECURITY_CLASS_INVALID_INPUT';
  if (row.state === 'MISSING') return null;
  const p = row.provenance;
  if (!isObj(p) || !refs(p.evidenceRefs) || typeof p.sourceAuthority !== 'string' || !p.sourceAuthority || typeof p.authorityMapVersion !== 'string' || !p.authorityMapVersion) return 'SECURITY_CLASS_PROVENANCE_INVALID';
  if (row.state === 'UNKNOWN' && (typeof p.reason !== 'string' || !p.reason.trim())) return 'SECURITY_CLASS_PROVENANCE_INVALID';
  if (row.state === 'NOT_APPLICABLE' && (!p.ruleId || !p.ruleVersion || !p.applicabilityBasis)) return 'SECURITY_CLASS_PROVENANCE_INVALID';
  if (row.state === 'FALSE' && (!p.queryId || p.coverageComplete !== true)) return 'SECURITY_CLASS_PROVENANCE_INVALID';
  return null;
}

function trackedEnvironmentState(baseline) {
  if (!isObj(baseline) || !baseline.baselineVersion || !sha(baseline.baselineSha256) || !instant(baseline.observedAt)
    || !baseline.trackedTechnologyCatalog || !baseline.directDeploymentInventory || !baseline.dependencyGraph
    || !baseline.trackedEcosystemCatalog || !isObj(baseline.coverageAttestation)
    || !baseline.sourceAuthorityMapVersion || !sha(baseline.sourceAuthorityMapSha256)) return 'MISSING';
  const coverage = ['trackedTechnologyCatalog', 'directDeploymentInventory', 'completeDependencyGraph', 'trackedEcosystemCatalog'];
  const complete = baseline.scopeCompleteness === 'COMPLETE' && coverage.every((key) => baseline.coverageAttestation[key] === true);
  return complete ? 'VERSIONED_COMPLETE' : 'VERSIONED_INCOMPLETE';
}

function classificationRow(environmentState, relationships) {
  return frozenClassificationMatrix.rows.find((row) => row.trackedEnvironmentState === environmentState
    && RELATIONSHIPS.every((key) => row.relationshipStates[key] === relationships[key]));
}

function escalationRow(vector) {
  return frozenEscalationMatrix.rows.find((row) => ESCALATION_KEYS.every((key) => row.keyStates[key] === vector[key]));
}

function decisionRow({ gateApplicability, classificationResolution, gateClass, incomingSignal, escalationResult, vector }) {
  return frozenDecisionTable.rows.find((row) => row.radar === 'SEC' && row.gateApplicability === gateApplicability
    && row.classificationResolution === classificationResolution && row.securityGateClass === gateClass
    && row.incomingSignal === incomingSignal && row.escalationResult === escalationResult
    && ESCALATION_KEYS.every((key) => (row.escalationVector?.[key] ?? 'MISSING') === (vector?.[key] ?? 'MISSING')));
}

export function resolveSecurityClassificationMatrixRow({ trackedEnvironmentState, relationshipStates }) {
  return classificationRow(trackedEnvironmentState, relationshipStates);
}

export function resolveSecurityEscalationMatrixRow(vector) {
  return escalationRow(vector);
}

export function resolveSecurityDecisionTableRow(input) {
  return decisionRow(input);
}

function normalizeEscalation(input) {
  const vector = {};
  for (const key of ESCALATION_KEYS) {
    const row = input?.[key];
    if (row === undefined) { vector[key] = 'MISSING'; continue; }
    if (!isObj(row) || !STATES.has(row.state)) return { error: 'SECURITY_CLASS_INVALID_INPUT' };
    if (row.state !== 'MISSING') {
      const p = row.provenance;
      if (!isObj(p) || !refs(p.evidenceRefs) || !p.sourceAuthority || !p.authorityMapVersion) return { error: 'SECURITY_CLASS_PROVENANCE_INVALID' };
      if (row.state === 'UNKNOWN' && !p.reason) return { error: 'SECURITY_CLASS_PROVENANCE_INVALID' };
      if (row.state === 'NOT_APPLICABLE' && (!p.ruleId || !p.ruleVersion || !p.applicabilityBasis)) return { error: 'SECURITY_CLASS_PROVENANCE_INVALID' };
      if (row.state === 'FALSE' && (!p.queryId || p.coverageComplete !== true)) return { error: 'SECURITY_CLASS_PROVENANCE_INVALID' };
    }
    vector[key] = row.state;
  }
  return { vector };
}

/** Frozen Security Gate Policy 1.0.0 evaluator. It never owns score modifiers or publication. */
export function evaluateSecurityGateV100({ radar, applicability, applicabilityProvenance, candidateIdentity, baseline, relationships, escalation, incomingSignal = 'low' }) {
  try {
    assertFrozenRuntimePackages();
    if (!['AI', 'DEV', 'APP', 'SEC'].includes(radar) || !['high', 'medium', 'low'].includes(incomingSignal)) return invalid(['SECURITY_GATE_INVALID_INPUT']);
    if (radar !== 'SEC') return { status: 'NOT_APPLICABLE', policyVersion: '1.0.0', classificationResolution: 'NOT_APPLICABLE', gateClass: 'N/A', escalationResult: 'NOT_EVALUATED', hardFilter: false, outgoingSignal: incomingSignal, capApplied: false, capExemption: false, reasonCodes: ['SECURITY_GATE_NOT_APPLICABLE'], scoreEligible: true };
    if (!['APPLICABLE', 'NOT_APPLICABLE', 'UNKNOWN', 'MISSING'].includes(applicability ?? 'MISSING')) return invalid(['SECURITY_GATE_INVALID_INPUT']);
    if (applicability === 'NOT_APPLICABLE') {
      const p = applicabilityProvenance;
      if (!isObj(p) || !p.ruleId || !p.ruleVersion || !refs(p.evidenceRefs) || !p.applicabilityBasis) return invalid(['SECURITY_CLASS_PROVENANCE_INVALID']);
      const row = decisionRow({ gateApplicability: 'NOT_APPLICABLE', classificationResolution: null, gateClass: null, incomingSignal, escalationResult: 'NOT_EVALUATED', vector: null });
      if (!row) return invalid(['SECURITY_DECISION_ROW_MISSING']);
      return { status: 'NOT_APPLICABLE', policyVersion: '1.0.0', classificationResolution: null, gateClass: 'N/A', escalationResult: 'NOT_EVALUATED', hardFilter: false, outgoingSignal: incomingSignal, capApplied: false, capExemption: false, reasonCodes: row.reasonCodes, scoreEligible: true };
    }

    const normalizedEscalation = normalizeEscalation(escalation);
    if (normalizedEscalation.error) return invalid([normalizedEscalation.error]);
    const eRow = escalationRow(normalizedEscalation.vector);
    if (!eRow) return invalid(['SECURITY_ESCALATION_MATRIX_ROW_MISSING']);

    let relationshipsState = Object.fromEntries(RELATIONSHIPS.map((key) => [key, relationships?.[key]?.state ?? 'MISSING']));
    for (const key of RELATIONSHIPS) {
      const error = relationships?.[key] === undefined ? null : validateRelation(relationships[key]);
      if (error) return invalid([error]);
      if (!STATES.has(relationshipsState[key])) return invalid(['SECURITY_CLASS_INVALID_INPUT']);
    }
    const envState = trackedEnvironmentState(baseline);
    const cRow = classificationRow(envState, relationshipsState);
    if (!cRow) return invalid(['SECURITY_CLASSIFICATION_MATRIX_ROW_MISSING']);
    const identityResolved = isObj(candidateIdentity) && typeof candidateIdentity.canonicalId === 'string' && candidateIdentity.canonicalId.length > 0
      && typeof candidateIdentity.evidenceRef === 'string' && candidateIdentity.evidenceRef.length > 0
      && isObj(candidateIdentity.component) && ((typeof candidateIdentity.component.componentId === 'string' && candidateIdentity.component.componentId.length > 0)
        || (candidateIdentity.component.scope === 'TECHNOLOGY_WIDE' && candidateIdentity.component.evidenceRef));
    const classificationResolution = applicability === 'APPLICABLE' && envState === 'VERSIONED_COMPLETE' && identityResolved ? cRow.classificationResolution : 'UNRESOLVED';
    const gateClass = classificationResolution === 'RESOLVED' ? cRow.securityGateClass : null;
    const gateApplicability = applicability === 'APPLICABLE' ? 'APPLICABLE' : 'APPLICABLE';
    const vector = normalizedEscalation.vector;
    const effectiveEscalationResult = classificationResolution === 'RESOLVED' ? eRow.escalationResult : 'NOT_EVALUATED';
    const row = decisionRow({ gateApplicability, classificationResolution, gateClass, incomingSignal, escalationResult: effectiveEscalationResult, vector: classificationResolution === 'RESOLVED' ? vector : null });
    if (!row) return invalid(['SECURITY_DECISION_ROW_MISSING']);
    const escalationReasons = eRow.reasonCodes.filter((code) => !['SECURITY_SIGNAL_CAP_APPLIED', 'SECURITY_SIGNAL_CAP_EXEMPT_ESCALATION'].includes(code));
    const reasonCodes = [...new Set([...(classificationResolution === 'RESOLVED' ? cRow.reasonCodes : ['SECURITY_CLASS_INPUT_UNKNOWN']), ...(classificationResolution === 'RESOLVED' ? escalationReasons : []), ...row.reasonCodes])];
    const hardFilter = classificationResolution === 'RESOLVED' && gateClass === 'UNRELATED' && row.hardFilter === true;
    const outgoingSignal = hardFilter ? 'filtered' : row.outgoingSignal;
    return {
      status: classificationResolution === 'RESOLVED' ? 'RESOLVED' : 'UNRESOLVED',
      policyVersion: '1.0.0', trackedEnvironmentState: envState,
      classificationResolution, gateClass, relationshipStates: relationshipsState,
      escalationVector: classificationResolution === 'RESOLVED' ? vector : null, escalationResult: effectiveEscalationResult,
      observedEscalationEvaluation: { vector, result: eRow.escalationResult },
      hardFilter, outgoingSignal, capApplied: row.capApplied, capExemption: row.capExemption,
      decisionDisposition: row.disposition, reasonCodes,
      scoreEligible: classificationResolution === 'RESOLVED',
    };
  } catch (error) {
    return { ...invalid(['SECURITY_GATE_EVALUATION_FAILED']), diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

export const securityGateConformanceArtifacts = Object.freeze({
  classificationRows: frozenClassificationMatrix.rows.length,
  escalationRows: frozenEscalationMatrix.rows.length,
  decisionRows: frozenDecisionTable.rows.length,
  classificationFixtures: frozenSecurityPolicy.classification.classes.length,
  escalationFixtures: frozenEscalationMatrix.combinationCount,
});
