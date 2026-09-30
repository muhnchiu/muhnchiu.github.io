import { FROZEN_SCORE_POLICY } from './policy.ts';
import type { RelevanceLevel } from './types.ts';

export function scoreForRelevance(level: RelevanceLevel): number {
  return FROZEN_SCORE_POLICY.relevanceMap[level];
}

/** ACTIVE_STACK evidence may be direct; INTEREST_STACK evidence alone is adjacent at most. */
export function classifyRelevance(evidence: {
  activeStackMatch: boolean;
  interestStackMatch: boolean;
  trackedDomainMatch: boolean;
}): RelevanceLevel {
  if (evidence.activeStackMatch) return 'DIRECT';
  if (evidence.interestStackMatch) return 'ADJACENT';
  if (evidence.trackedDomainMatch) return 'EXPLORATORY';
  return 'UNRELATED';
}
