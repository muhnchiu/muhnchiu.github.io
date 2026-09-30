import { FROZEN_SCORE_POLICY } from './policy.ts';
import type { RadarAction, RadarPolicyInput, RadarSignal } from './types.ts';

const FIRST_DISCOVERY_EVENTS = new Set([
  'model-release', 'project-discovery', 'skill-release', 'research-release', 'price-change', 'capability-change',
]);

function adoptEligible(input: RadarPolicyInput): boolean {
  const rule = FROZEN_SCORE_POLICY.adopt;
  return input.priorValidation
    && input.risk === 'low'
    && input.relevanceLevel === 'DIRECT'
    && input.relevanceScore >= rule.minRelevance
    && input.actionability >= rule.minActionability
    && input.confidence >= rule.minConfidence
    && input.impact >= rule.minImpact;
}

export function decideRadarAction(signal: RadarSignal, input: RadarPolicyInput): RadarAction {
  if (signal === 'filtered') return 'ignore';

  if (signal === 'high') {
    const firstDiscovery = FIRST_DISCOVERY_EVENTS.has(input.eventType) && !input.priorValidation;
    if (firstDiscovery) return input.actionability >= 7 && input.risk !== 'high' ? 'test' : 'read';
    if (input.eventType === 'version-release') return 'read';
    if (adoptEligible(input)) return 'adopt';
    return input.actionability >= 7 && input.risk !== 'high' ? 'test' : 'read';
  }

  if (signal === 'medium') {
    if (input.risk === 'high') return 'watch';
    if (input.relevanceLevel === 'DIRECT' && input.actionability >= 6) return 'test';
    if (input.eventType === 'research-release' || input.actionability >= 4) return 'read';
    return 'watch';
  }

  if (input.risk === 'high') return 'watch';
  return input.actionability >= 4 ? 'read' : 'watch';
}
