import type { RadarSignal, SecurityEscalation, SecurityGate } from './types.ts';

export function hasSecurityEscalation(escalation: SecurityEscalation = {}): boolean {
  return Boolean(escalation.activeExploitation || escalation.supplyChainImpact
    || escalation.reachableDependency || escalation.officialEmergencyAdvisory);
}

export function applySecuritySignalCap(
  signal: RadarSignal,
  gate: SecurityGate,
  escalation: SecurityEscalation = {},
): RadarSignal {
  if (gate !== 'ECOSYSTEM_RELEVANT' || hasSecurityEscalation(escalation)) return signal;
  return signal === 'high' ? 'medium' : signal;
}

export function isSecurityHardFiltered(radar: string, gate: SecurityGate): boolean {
  return radar === 'sec' && gate === 'UNRELATED';
}
