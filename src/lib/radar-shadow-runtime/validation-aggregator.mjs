import { createHash } from 'node:crypto';

export const STOP_CONDITIONS = Object.freeze({
  productionRegistryWriteCount: 'SHADOW_PRODUCTION_SIDE_EFFECT',
  publisherInvocationCount: 'SHADOW_PRODUCTION_SIDE_EFFECT',
  deploymentCount: 'SHADOW_PRODUCTION_SIDE_EFFECT',
  v1BehavioralDeltaCount: 'SHADOW_V1_BEHAVIORAL_DELTA',
  silentFallbackCount: 'SHADOW_SILENT_FALLBACK',
  semanticNondeterminismCount: 'SHADOW_NONDETERMINISM',
  stateCorruptionCount: 'SHADOW_STATE_CORRUPTION',
  stateWriteFailures: 'SHADOW_STATE_CORRUPTION',
  idempotencyViolationCount: 'SHADOW_IDEMPOTENCY_FAILURE',
  batchIsolationFailureCount: 'SHADOW_BATCH_ISOLATION_FAILURE',
  baselineIntegrityFailureCount: 'SHADOW_BASELINE_INTEGRITY_FAILURE',
  contractDriftCount: 'SHADOW_BASELINE_INTEGRITY_FAILURE',
  protectedPathMutationCount: 'SHADOW_PROTECTED_PATH_MUTATION',
  privacyLeakCount: 'SHADOW_VALIDATION_EVIDENCE_LEAK',
});

const OUTCOMES = new Set(['CANDIDATE_READY', 'RECEIPT_ONLY', 'IDENTITY_UNRESOLVED', 'SCORE_INPUT_INCOMPLETE', 'SECURITY_GATE_UNRESOLVED', 'WOULD_FILTER', 'WOULD_ACTION', 'ERROR', 'CANDIDATE_REJECTED']);
const asCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const uniq = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value))].sort();
const digest = (value) => createHash('sha256').update(value).digest('hex');

export function aggregateDailyEvidence({ date, validationRunIds = [], sourcesExpected = ['AI', 'DEV', 'APP', 'SEC'], runs = [], injections = {}, policyDebt = [], generatedAt = null }) {
  const records = runs.flatMap((run) => Array.isArray(run.records) ? run.records : []);
  const expected = uniq(sourcesExpected);
  const observed = uniq(runs.flatMap((run) => run.sourcesObserved ?? []));
  const notObserved = expected.filter((source) => !observed.includes(source));
  const terminal = records.map((record) => OUTCOMES.has(record.terminalOutcome) ? record.terminalOutcome : 'ERROR');
  const counter = (key) => asCount(injections[key]) + runs.reduce((sum, run) => sum + asCount(run[key]), 0);
  const stopConditionsTriggered = uniq(Object.entries(STOP_CONDITIONS).filter(([key]) => counter(key) > 0).map(([, value]) => value));
  const errors = records.filter((record) => record.terminalOutcome === 'ERROR').slice(0, 10).map((record) => ({ recordId: record.recordId ?? null, reasonCode: record.errorCode ?? 'UNCLASSIFIED_ERROR' }));
  const debtOutcomes = new Set(['IDENTITY_UNRESOLVED', 'SCORE_INPUT_INCOMPLETE', 'SECURITY_GATE_UNRESOLVED', 'RECEIPT_ONLY', 'CANDIDATE_REJECTED']);
  const debtReasons = new Set(['IDENTITY_UNRESOLVED', 'IDENTITY_AUTHORITY_UNRESOLVED', 'SCORE_INPUT_INCOMPLETE', 'SECURITY_GATE_UNRESOLVED', 'SOURCE_NOT_OBSERVED', 'SKILL_STRUCTURED_INPUT_UNAVAILABLE', 'AGGREGATE_ONLY_SOURCE', 'PUBLICATION_SEMANTICS_UNDEFINED']);
  const observedDebtRows = [];
  for (const record of records) {
    const outcome = record.terminalOutcome;
    const reasonCode = record.errorCode ?? record.identityReason ?? record.scoreEligibilityReason ?? record.securityReason ?? (debtOutcomes.has(outcome) ? outcome : null);
    if (reasonCode && (debtReasons.has(reasonCode) || debtReasons.has(outcome))) observedDebtRows.push({ debtId: record.debtId ?? null, reasonCode, terminalOutcome: outcome, recordId: record.recordId ?? null, sourceFamily: record.sourceFamily ?? null, radar: record.radar ?? null });
  }
  for (const source of notObserved) observedDebtRows.push({ debtId: 'PD-REMAINING-SOURCE-MAPPINGS', reasonCode: 'SOURCE_NOT_OBSERVED', terminalOutcome: 'SOURCE_NOT_OBSERVED', recordId: null, sourceFamily: source, radar: source });
  for (const item of policyDebt) observedDebtRows.push(item);
  const groupedDebt = new Map();
  for (const row of observedDebtRows) {
    const debtId = row.debtId ?? ({ IDENTITY_UNRESOLVED: 'PD-IDENTITY-SOURCE-AUTHORITY', IDENTITY_AUTHORITY_UNRESOLVED: 'PD-IDENTITY-SOURCE-AUTHORITY', SCORE_INPUT_INCOMPLETE: 'PD-SCORE-INPUT-COVERAGE', SECURITY_GATE_UNRESOLVED: 'PD-SECURITY-GATE-SOURCE-FACTS', SOURCE_NOT_OBSERVED: 'PD-REMAINING-SOURCE-MAPPINGS', SKILL_STRUCTURED_INPUT_UNAVAILABLE: 'PD-SKILL-STRUCTURED-INTERFACE', AGGREGATE_ONLY_SOURCE: 'PD-AGGREGATE-EVENT-CAPABILITY', PUBLICATION_SEMANTICS_UNDEFINED: 'PD-PUBLICATION-SEMANTICS' })[row.reasonCode] ?? 'PD-REMAINING-SOURCE-MAPPINGS';
    const key = `${debtId}\0${row.reasonCode}`;
    const prior = groupedDebt.get(key) ?? { debtId, reasonCode: row.reasonCode, records: [], radars: new Set(), sourceFamilies: new Set() };
    if (row.recordId) prior.records.push(row.recordId);
    if (row.radar) prior.radars.add(row.radar);
    if (row.sourceFamily) prior.sourceFamilies.add(row.sourceFamily);
    groupedDebt.set(key, prior);
  }
  const observedDebt = [...groupedDebt.values()].map((item) => ({
    debtId: item.debtId, firstObservedAt: generatedAt ?? `${date}T00:00:00.000Z`, lastObservedAt: generatedAt ?? `${date}T00:00:00.000Z`,
    observationCount: item.records.length || 1, radars: [...item.radars].sort(), sourceFamilies: [...item.sourceFamilies].sort(),
    reasonCode: item.reasonCode, sampleRecordIds: uniq(item.records).slice(0, 10),
    severity: 'KNOWN_DEBT', blocksShadow: false, blocksProduction: true,
  }));
  const metricCounters = Object.fromEntries(Object.keys(STOP_CONDITIONS).map((key) => [key, counter(key)]));
  const dayStatus = stopConditionsTriggered.length || errors.length ? 'FAILED' : observedDebt.length ? 'PASS_WITH_DEBT' : 'PASS';
  const count = (outcome) => terminal.filter((value) => value === outcome).length;
  return {
    schemaVersion: '1.0', date, generatedAt,
    validationRunIds: uniq(validationRunIds),
    sourcesExpected: expected,
    sourcesObserved: observed,
    sourcesNotObserved: notObserved,
    sourceStatuses: Object.fromEntries(expected.map((source) => [source, observed.includes(source) ? 'OBSERVED' : 'NOT_OBSERVED'])),
    recordsReceived: asCount(runs.reduce((sum, run) => sum + (run.recordsReceived ?? run.records?.length ?? 0), 0)),
    recordsCandidateReady: records.filter((record) => record.candidateDisposition === 'CANDIDATE_READY').length,
    recordsReceiptOnly: records.filter((record) => record.persistenceClassification === 'RECEIPT_ONLY' || record.terminalOutcome === 'RECEIPT_ONLY').length,
    identityReady: records.filter((record) => record.identityDisposition === 'READY').length,
    identityUnresolved: count('IDENTITY_UNRESOLVED'),
    scoreReady: records.filter((record) => record.scoreEligibility === 'SCORE_READY' || record.evaluationDisposition === 'EVALUATED').length,
    scoreIncomplete: count('SCORE_INPUT_INCOMPLETE'),
    securityResolved: records.filter((record) => record.securityDisposition === 'RESOLVED' || record.securityDisposition === 'NOT_APPLICABLE').length,
    securityUnresolved: count('SECURITY_GATE_UNRESOLVED'),
    recordsEvaluated: records.filter((record) => record.evaluationDisposition === 'EVALUATED').length,
    wouldFilter: count('WOULD_FILTER'),
    wouldAction: count('WOULD_ACTION'),
    errors,
    duplicateDeliveries: records.filter((record) => record.duplicate === true).length,
    deduplicatedRecords: records.filter((record) => record.duplicate === true).length,
    stateWriteFailures: asCount(runs.reduce((sum, run) => sum + (run.stateWriteFailures ?? 0), 0)),
    ...metricCounters,
    v1BehavioralDeltaCount: counter('v1BehavioralDeltaCount'),
    productionRegistryWriteCount: counter('productionRegistryWriteCount'),
    publisherInvocationCount: counter('publisherInvocationCount'),
    deploymentCount: counter('deploymentCount'),
    silentFallbackCount: counter('silentFallbackCount'),
    semanticNondeterminismCount: counter('semanticNondeterminismCount'),
    policyDebtObserved: observedDebt,
    stopConditionsTriggered,
    stopEvidence: stopConditionsTriggered.map((condition) => ({ condition, detected: true })),
    dayStatus,
    metrics: {
      totalRuns: validationRunIds.length,
      successfulRuns: dayStatus === 'FAILED' ? 0 : validationRunIds.length,
      failedRuns: dayStatus === 'FAILED' ? validationRunIds.length : 0,
      totalRecords: records.length,
      receiptOnlyRate: records.length ? Number((count('RECEIPT_ONLY') / records.length).toFixed(6)) : 0,
      identityReadyRate: records.length ? Number((records.filter((record) => record.identityDisposition === 'READY').length / records.length).toFixed(6)) : 0,
      scoreReadyRate: records.length ? Number((records.filter((record) => record.scoreEligibility === 'SCORE_READY' || record.evaluationDisposition === 'EVALUATED').length / records.length).toFixed(6)) : 0,
      securityResolvedRate: records.length ? Number((records.filter((record) => record.securityDisposition === 'RESOLVED' || record.securityDisposition === 'NOT_APPLICABLE').length / records.length).toFixed(6)) : 0,
      wouldFilterRate: records.length ? Number((count('WOULD_FILTER') / records.length).toFixed(6)) : 0,
      wouldActionRate: records.length ? Number((count('WOULD_ACTION') / records.length).toFixed(6)) : 0,
      errorRate: records.length ? Number((count('ERROR') / records.length).toFixed(6)) : 0,
      duplicateRate: records.length ? Number((records.filter((record) => record.duplicate === true).length / records.length).toFixed(6)) : 0,
      sourceObservationRate: expected.length ? Number((observed.length / expected.length).toFixed(6)) : 0,
      ...Object.fromEntries(Object.keys(STOP_CONDITIONS).map((key) => [key, counter(key)])),
    },
    semanticDigest: digest(JSON.stringify({ records: records.map((r) => [r.recordId, r.terminalOutcome, r.errorCode]), stopConditionsTriggered, observedDebt, dayStatus })),
  };
}

export function privacyGuard(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const patterns = [
    /(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,"}]+/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
    /(?:set-cookie|cookie|authorization)\s*[:=]\s*[^\n]+/i,
    /(?:\/Users\/|\/home\/|\/private\/tmp\/|[A-Za-z]:\\Users\\)/,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}
