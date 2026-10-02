import { buildShadowMetrics } from './metrics.mjs';

/** Shadow is opt-in; parsing the handoff and creating state are both skipped while disabled. */
export function shadowEnabled(value = process.env.HORIZON_RADAR_V2_SHADOW_ENABLED) {
  return value === true || value === 'true';
}

export function disabledResult() {
  const metrics = buildShadowMetrics({ status: 'DISABLED', records: [], receivedCount: 0 });
  return {
    status: 'DISABLED', consumed: false, outputWritten: false, records: [],
    publicationEvaluation: 'NOT_AVAILABLE', publisherInvocation: 'FORBIDDEN',
    metrics,
    sideEffects: { productionRegistryWrites: 0, publisherCalls: 0, deploymentCalls: 0, v1Mutations: 0, gitOperations: 0, scheduleMutations: 0 },
  };
}
