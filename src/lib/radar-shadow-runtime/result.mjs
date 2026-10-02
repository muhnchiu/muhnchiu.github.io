export const SHADOW_TERMINAL_OUTCOMES = Object.freeze([
  'CANDIDATE_REJECTED', 'RECEIPT_ONLY', 'IDENTITY_UNRESOLVED',
  'SCORE_INPUT_INCOMPLETE', 'SECURITY_GATE_UNRESOLVED',
  'WOULD_FILTER', 'WOULD_ACTION', 'ERROR',
]);

export const ZERO_SIDE_EFFECTS = Object.freeze({
  productionRegistryWrites: 0, publisherCalls: 0, deploymentCalls: 0,
  v1Mutations: 0, gitOperations: 0, scheduleMutations: 0,
});

export function makeShadowRecord({ runId, recordId, radar, sourceFamily, receivedAt, inputDigest }) {
  return {
    runId, recordId, radar, sourceFamily, receivedAt, inputDigest,
    candidateDisposition: 'NOT_EVALUATED', candidateReason: null,
    evidenceDisposition: 'NOT_EVALUATED', evidenceReason: null,
    identityDisposition: 'NOT_EVALUATED', identityReason: null,
    scoreEligibility: 'NOT_EVALUATED', scoreEligibilityReason: null,
    securityDisposition: 'NOT_EVALUATED', securityReason: null,
    evaluationDisposition: 'NOT_EVALUATED', action: null,
    terminalOutcome: 'ERROR', retryCount: 0, duplicate: false, errorCode: null,
  };
}

export function isWouldPublishRequest(value) {
  if (typeof value === 'string') return value === 'WOULD_PUBLISH';
  if (Array.isArray(value)) return value.some(isWouldPublishRequest);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => {
    if (['outcome', 'terminalOutcome', 'shadowDisposition', 'publicationDecision'].includes(key) && entry === 'WOULD_PUBLISH') return true;
    return isWouldPublishRequest(entry);
  });
}

export function forbiddenPublicationReceipt(row) {
  return {
    ...row,
    terminalOutcome: 'CANDIDATE_REJECTED',
    persistenceClassification: 'RECEIPT_ONLY',
    candidateDisposition: row.candidateDisposition === 'NOT_EVALUATED' ? 'CANDIDATE_REJECTED' : row.candidateDisposition,
    candidateReason: 'WOULD_PUBLISH_FORBIDDEN',
    errorCode: 'WOULD_PUBLISH_FORBIDDEN',
  };
}
