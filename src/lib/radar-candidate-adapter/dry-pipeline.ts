import { runScoreInputProductionDryRun } from '../radar-score-input/dry-run.ts';
import { adaptProductionCandidate, type AdapterContext, type AdapterInput } from './adapters.ts';

const registryRadar: Record<string, string> = { AI: 'ai', DEV: 'dev', APP: 'app', SEC: 'security', SKILL: 'skill' };

/** Offline shadow integration. It stops before the Registry API and has no Publisher capability. */
export async function runProductionCandidateDryPipeline(input: AdapterInput, context: AdapterContext & { generatedAt?: string }) {
  const adapter = adaptProductionCandidate(input, context);
  if (!adapter.candidate || adapter.status !== 'CANDIDATE_READY') {
    return {
      adapterStatus: adapter.status,
      evidenceValid: false,
      eventIdentityResolvable: false,
      observationIdentityResolvable: false,
      generatedScoreInputCount: 0,
      provenanceValid: false,
      status: 'RECEIPT_ONLY' as const,
      receiptReasons: adapter.receiptReasons,
      commitObservationCalled: false,
      registryWrites: 0,
      publisherCalls: 0,
    };
  }
  const candidate = adapter.candidate;
  const rawRecord = candidate.rawSourceMetadata.record;
  const raw = {
    sourceName: candidate.sourceName,
    title: candidate.title,
    ...(candidate.itemUrl ? { sourceUrl: candidate.itemUrl, evidenceRef: candidate.itemUrl } : {}),
    ...(candidate.publishedAt ? { sourcePublishedAt: candidate.publishedAt } : {}),
    ...(typeof rawRecord.entity === 'string' ? { entity: rawRecord.entity } : {}),
    ...(typeof rawRecord.canonicalEventType === 'string' ? { canonicalEventType: rawRecord.canonicalEventType } : {}),
    ...(typeof rawRecord.eventIdentifier === 'string' ? { eventIdentifier: rawRecord.eventIdentifier } : {}),
    ...(typeof rawRecord.version === 'string' ? { version: rawRecord.version } : {}),
    ...(Array.isArray(rawRecord.capabilityScope) ? { capabilityScope: rawRecord.capabilityScope } : {}),
    ...(typeof rawRecord.intendedUsage === 'string' ? { intendedUsage: rawRecord.intendedUsage } : {}),
  };
  const generatedAt = context.generatedAt;
  if (!generatedAt) {
    return { adapterStatus: adapter.status, evidenceValid: false, eventIdentityResolvable: false, observationIdentityResolvable: false, generatedScoreInputCount: 0, provenanceValid: false, status: 'RECEIPT_ONLY' as const, receiptReasons: ['MISSING_GENERATED_AT'], commitObservationCalled: false, registryWrites: 0, publisherCalls: 0 };
  }
  const pipeline = await runScoreInputProductionDryRun(raw, {
    radar: registryRadar[candidate.radar],
    observedAt: context.observedAt ?? '',
    generatedAt,
    structuredHandoffVerified: true,
  });
  const result = pipeline.scoreGeneration;
  const identity = !!pipeline.observationCommitRequest;
  return {
    adapterStatus: adapter.status,
    evidenceValid: pipeline.evidenceErrors.length === 0,
    eventIdentityResolvable: identity,
    observationIdentityResolvable: identity,
    generatedScoreInputCount: Object.keys(result?.inputs ?? {}).length,
    provenanceValid: result?.eligibility?.status === 'ELIGIBLE',
    status: pipeline.status,
    receiptReasons: [...new Set([...adapter.downstreamGaps, ...(pipeline.reason ? [pipeline.reason] : [])])],
    evidenceErrors: pipeline.evidenceErrors,
    identityError: pipeline.observationCommitRequest ? null : pipeline.evidenceErrors.find((row: { code: string }) => row.code.startsWith('IDENTITY_'))?.code ?? (!raw.entity || !raw.canonicalEventType || !raw.eventIdentifier ? 'EVENT_IDENTITY_INCOMPLETE' : 'OBSERVATION_IDENTITY_INCOMPLETE'),
    scoreGeneration: result,
    commitObservationCalled: false,
    registryWrites: 0,
    publisherCalls: 0,
  };
}

export async function runProductionCandidateDryPipelineBatch(inputs: AdapterInput[], context: AdapterContext & { generatedAt?: string }) {
  return Promise.all(inputs.map(async (input) => {
    try { return await runProductionCandidateDryPipeline(input, context); }
    catch (error) {
      return { adapterStatus: 'RECEIPT_ONLY' as const, evidenceValid: false, eventIdentityResolvable: false, observationIdentityResolvable: false, generatedScoreInputCount: 0, provenanceValid: false, status: 'RECEIPT_ONLY' as const, receiptReasons: ['ADAPTER_EXCEPTION'], diagnostic: error instanceof Error ? error.name : 'unknown', commitObservationCalled: false, registryWrites: 0, publisherCalls: 0 };
    }
  }));
}
