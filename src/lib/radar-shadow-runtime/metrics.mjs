export const SHADOW_METRIC_NAMES = Object.freeze([
  'runs_total', 'runs_success', 'runs_failed',
  'records_received', 'records_candidate_ready', 'records_receipt_only',
  'records_identity_ready', 'records_identity_unresolved',
  'records_score_ready', 'records_score_incomplete',
  'records_security_resolved', 'records_security_unresolved',
  'records_evaluated', 'records_would_filter', 'records_would_action',
  'records_error', 'sources_observed', 'sources_not_observed',
  'duplicate_deliveries', 'deduplicated_records', 'retry_count',
  'V1_behavioral_delta_count', 'production_registry_write_count',
  'publisher_invocation_count', 'deployment_count', 'silent_fallback_count',
]);

export function buildShadowMetrics({ status, records = [], receivedCount = records.length, expectedSourceFamilies } = {}) {
  const metrics = Object.fromEntries(SHADOW_METRIC_NAMES.map((name) => [name, 0]));
  metrics.runs_total = status === 'DISABLED' ? 0 : 1;
  metrics.runs_success = ['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(status) ? 1 : 0;
  metrics.runs_failed = status === 'FAILED' || status === 'STORAGE_FAILED' ? 1 : 0;
  metrics.records_received = receivedCount;
  metrics.records_candidate_ready = records.filter((row) => row.candidateDisposition === 'CANDIDATE_READY').length;
  metrics.records_receipt_only = records.filter((row) => row.terminalOutcome === 'RECEIPT_ONLY').length;
  metrics.records_identity_ready = records.filter((row) => row.identityDisposition === 'READY').length;
  metrics.records_identity_unresolved = records.filter((row) => row.identityDisposition === 'UNRESOLVED').length;
  metrics.records_score_ready = records.filter((row) => row.scoreEligibility === 'SCORE_READY').length;
  metrics.records_score_incomplete = records.filter((row) => row.scoreEligibility === 'SCORE_INPUT_INCOMPLETE').length;
  metrics.records_security_resolved = records.filter((row) => row.securityDisposition === 'RESOLVED' || row.securityDisposition === 'NOT_APPLICABLE').length;
  metrics.records_security_unresolved = records.filter((row) => row.securityDisposition === 'UNRESOLVED').length;
  metrics.records_evaluated = records.filter((row) => row.evaluationDisposition === 'EVALUATED').length;
  metrics.records_would_filter = records.filter((row) => row.terminalOutcome === 'WOULD_FILTER').length;
  metrics.records_would_action = records.filter((row) => row.terminalOutcome === 'WOULD_ACTION').length;
  metrics.records_error = records.filter((row) => row.terminalOutcome === 'ERROR').length;
  const observed = new Set(records.map((row) => row.sourceFamily).filter((value) => typeof value === 'string' && value));
  metrics.sources_observed = observed.size;
  metrics.sources_not_observed = Array.isArray(expectedSourceFamilies)
    ? new Set(expectedSourceFamilies).size - [...new Set(expectedSourceFamilies)].filter((source) => observed.has(source)).length
    : null;
  metrics.duplicate_deliveries = records.filter((row) => row.duplicate === true).length;
  metrics.deduplicated_records = metrics.duplicate_deliveries;
  metrics.retry_count = records.reduce((total, row) => total + (Number.isInteger(row.retryCount) ? row.retryCount : 0), 0);
  // This runner has no V1 write path, Production Registry writer, Publisher, or Deployment adapter.
  metrics.V1_behavioral_delta_count = 0;
  metrics.production_registry_write_count = 0;
  metrics.publisher_invocation_count = 0;
  metrics.deployment_count = 0;
  metrics.silent_fallback_count = 0;
  return metrics;
}

export function safetyInvariantViolations(metrics) {
  return [
    ['production_registry_write_count', 0, 'SHADOW_PRODUCTION_SIDE_EFFECT_RISK'],
    ['publisher_invocation_count', 0, 'SHADOW_PRODUCTION_SIDE_EFFECT_RISK'],
    ['deployment_count', 0, 'SHADOW_PRODUCTION_SIDE_EFFECT_RISK'],
    ['silent_fallback_count', 0, 'SHADOW_SILENT_FALLBACK'],
    ['V1_behavioral_delta_count', 0, 'SHADOW_V1_BEHAVIORAL_DELTA'],
  ].filter(([key, allowed]) => metrics[key] !== allowed).map(([, , code]) => code);
}
