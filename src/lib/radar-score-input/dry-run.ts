import { normalizeEvidence, prepareEvidenceCommit } from '../radar-evidence-pipeline.mjs';
import { generateScoreInputs, type GenerationContext, type JudgmentProvider, type StructuredCandidate } from './generator.ts';

/** Offline source boundary: normalize evidence and prepare identity, then stop before any Registry call. */
export async function runScoreInputProductionDryRun(
  raw: Record<string, unknown>,
  args: { radar: string; observedAt: string; retrievedAt?: string; generatedAt: string; context?: Partial<GenerationContext>; judgmentProvider?: JudgmentProvider; structuredHandoffVerified?: boolean },
) {
  const evidence = normalizeEvidence(raw, { observedAt: args.observedAt, retrievedAt: args.retrievedAt });
  const prepared = prepareEvidenceCommit(raw, { radar: args.radar, observedAt: args.observedAt, retrievedAt: args.retrievedAt });
  const rowEvidence = evidence.normalized && typeof evidence.normalized.evidenceRef === 'string' ? [{
    evidenceRef: evidence.normalized.evidenceRef,
    sourceName: String(evidence.normalized.sourceName ?? ''),
    sourceAuthority: evidence.normalized.sourceAuthority,
    ...(typeof evidence.normalized.sourceUrl === 'string' ? { sourceUrl: evidence.normalized.sourceUrl } : {}),
    ...(typeof evidence.normalized.sourcePublishedAt === 'string' ? { sourcePublishedAt: evidence.normalized.sourcePublishedAt } : {}),
    observedAt: args.observedAt,
  }] : [];
  if (args.structuredHandoffVerified !== true) {
    return {
      status: 'RECEIPT_ONLY' as const,
      reason: args.radar === 'skill' || args.radar === 'SKILL' ? 'SKILL_STRUCTURED_INPUT_UNAVAILABLE' : 'STRUCTURED_SOURCE_HANDOFF_UNVERIFIED',
      evidenceErrors: evidence.errors,
      identityPrepared: false,
      observationCommitPrepared: false,
      commitObservationCalled: false,
      scoreGeneration: null,
    };
  }
  const eventIdentity = prepared.commitRequest ? {
    entity: String(raw.entity),
    canonicalEventType: String(raw.canonicalEventType),
    eventKey: prepared.commitRequest.eventKey,
    eventIdentifier: String(raw.eventIdentifier),
    evidenceRefs: rowEvidence.map((row) => row.evidenceRef),
    identityEngineVersion: '2.1.2',
  } : undefined;
  const candidate = {
    radar: args.radar.toUpperCase(),
    sourceName: String(raw.sourceName ?? ''),
    title: String(raw.title ?? ''),
    ...(typeof raw.sourceUrl === 'string' ? { sourceUrl: raw.sourceUrl } : {}),
    ...(typeof raw.sourcePublishedAt === 'string' ? { sourcePublishedAt: raw.sourcePublishedAt } : {}),
    observedAt: args.observedAt,
    evidence: rowEvidence,
    ...(eventIdentity ? { eventIdentity } : {}),
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    ...(Array.isArray(raw.capabilityScope) ? { capabilityScope: raw.capabilityScope as string[] } : {}),
    ...(typeof raw.intendedUsage === 'string' ? { intendedUsage: raw.intendedUsage } : {}),
  } satisfies StructuredCandidate;
  const scoreGeneration = await generateScoreInputs(candidate, { generatedAt: args.generatedAt, ...(args.context ?? {}) }, args.judgmentProvider);
  return {
    status: scoreGeneration.status,
    reason: scoreGeneration.status === 'SCORE_READY' ? null : scoreGeneration.receiptOnlyReasons[0] ?? 'SCORE_INPUT_INCOMPLETE',
    evidenceErrors: evidence.errors,
    identityPrepared: Boolean(prepared.commitRequest),
    observationCommitPrepared: Boolean(prepared.commitRequest),
    commitObservationCalled: false,
    observationCommitRequest: prepared.commitRequest,
    scoreGeneration,
  };
}
