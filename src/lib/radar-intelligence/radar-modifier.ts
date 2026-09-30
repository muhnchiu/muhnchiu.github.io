import { FROZEN_SCORE_POLICY } from './policy.ts';
import type { ModifierTriggers, RadarCategory } from './types.ts';

export function clampRadarModifier(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('Radar modifier must be finite.');
  return Math.max(FROZEN_SCORE_POLICY.modifierBounds.min, Math.min(FROZEN_SCORE_POLICY.modifierBounds.max, value));
}

/** Apply only the generic trigger categories frozen in the Score Policy V2.0 specification. */
export function calculateRadarModifier(radar: RadarCategory, triggers: ModifierTriggers): number {
  let modifier = 0;
  switch (radar) {
    case 'ai':
      if (triggers.priceOrCostChange) modifier += 5;
      if (triggers.capabilityChange) modifier += 3;
      break;
    case 'dev':
      if (triggers.contextTool) modifier += 5;
      else if (triggers.aiCodingWorkflowTool) modifier += 3;
      break;
    case 'skill':
      if (triggers.trainingResearch) modifier += 3;
      if (triggers.nonMaterialSkillUpdate) modifier -= 2;
      break;
    case 'app':
      if (triggers.stackComponentMatch) modifier += 3;
      else if (triggers.genericConsumerApp) modifier -= 3;
      break;
    case 'sec':
      modifier -= 2;
      if (triggers.aiSecurityTopic) modifier += 3;
      if (triggers.ecosystemCritical) modifier += 0;
      break;
  }
  return clampRadarModifier(modifier);
}

/** Replay fixtures carry the already-resolved generic modifier as an explicit policy input. */
export function resolveRadarModifier(inputModifier: number): number {
  return clampRadarModifier(inputModifier);
}
