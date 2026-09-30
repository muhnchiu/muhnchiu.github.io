import { decideRadarAction } from './action-policy.ts';
import { FROZEN_SCORE_POLICY } from './policy.ts';
import { resolveRadarModifier } from './radar-modifier.ts';
import { scoreForRelevance } from './relevance.ts';
import { applySignalPolicy } from './signal-policy.ts';
import { isSecurityHardFiltered } from './security-gate.ts';
import type { RadarPolicyEvent, RadarPolicyInput, RadarPolicyResult } from './types.ts';

const clampScore = (score: number) => Math.max(0, Math.min(100, score));

function validateInput(input: RadarPolicyInput): void {
  for (const [name, value] of Object.entries({
    impact: input.impact, actionability: input.actionability, confidence: input.confidence,
    novelty: input.novelty, momentum: input.momentum,
  })) {
    if (!Number.isInteger(value) || value < 0 || value > 10) throw new RangeError(`${name} must be an integer from 0 to 10.`);
  }
}

export function evaluateRadarPolicy(event: RadarPolicyEvent): RadarPolicyResult {
  const input = event.input;
  validateInput(input);

  const relevance = scoreForRelevance(input.relevanceLevel);
  if (input.relevanceScore !== relevance) throw new RangeError(`relevanceScore does not match ${input.relevanceLevel}.`);
  const weights = FROZEN_SCORE_POLICY.weights;
  const weighted = relevance * weights.relevance
    + input.impact * weights.impact
    + input.actionability * weights.actionability
    + input.confidence * weights.confidence
    + input.novelty * weights.novelty
    + input.momentum * weights.momentum;

  // The frozen replay’s exact baseScore values establish floor(weighted × 10).
  const baseScore = Math.floor(weighted * 10);
  const bonusRule = FROZEN_SCORE_POLICY.directBonus;
  const directBonus = input.relevanceLevel === 'DIRECT'
    && (input.impact >= bonusRule.minImpact || input.actionability >= bonusRule.minActionability)
    ? Math.min(bonusRule.value, bonusRule.cap)
    : 0;
  const modifier = resolveRadarModifier(input.radarModifier);
  const finalScore = clampScore(baseScore + directBonus + modifier);

  const hardFilterReason = input.eventType === 'funding' ? 'funding news'
    : isSecurityHardFiltered(event.radar, input.securityGate) ? 'Security Gate UNRELATED'
      : input.relevanceLevel === 'UNRELATED' && input.impact <= 2 ? 'UNRELATED + low impact'
        : input.duplicate ? 'DUPLICATE_UPDATE'
          : null;

  const gatedSignal = applySignalPolicy(finalScore, input.securityGate, input.securityEscalation);
  const filtered = hardFilterReason !== null;
  const signal = filtered ? 'filtered' : gatedSignal;
  const action = decideRadarAction(signal, input);

  return {
    scoreVersion: FROZEN_SCORE_POLICY.scoreVersion,
    baseScore,
    directBonus,
    modifier,
    finalScore,
    signal,
    action,
    filtered,
    filterReason: hardFilterReason,
  };
}

/** V1 remains outside the V2 policy engine and is never rescored. */
export function assertV2PolicyInput(sourceSchemaVersion: number): void {
  if (sourceSchemaVersion !== 2) throw new TypeError('Score Policy 2.0 only evaluates Radar V2 inputs.');
}
