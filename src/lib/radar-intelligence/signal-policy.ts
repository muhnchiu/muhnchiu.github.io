import { FROZEN_SCORE_POLICY } from './policy.ts';
import { applySecuritySignalCap } from './security-gate.ts';
import type { RadarSignal, SecurityEscalation, SecurityGate } from './types.ts';

export function signalForScore(score: number): RadarSignal {
  if (score >= FROZEN_SCORE_POLICY.thresholds.high) return 'high';
  if (score >= FROZEN_SCORE_POLICY.thresholds.medium) return 'medium';
  if (score >= FROZEN_SCORE_POLICY.thresholds.low) return 'low';
  return 'filtered';
}

export function applySignalPolicy(score: number, gate: SecurityGate, escalation: SecurityEscalation = {}): RadarSignal {
  return applySecuritySignalCap(signalForScore(score), gate, escalation);
}
