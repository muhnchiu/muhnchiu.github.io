const ESCALATION_STATES = new Set(['TRUE', 'FALSE', 'UNKNOWN', 'NOT_APPLICABLE', 'MISSING']);
const ESCALATION_KEYS = ['activeExploitation', 'supplyChainImpact', 'reachableDependency', 'officialEmergencyAdvisory'];

export function deriveEscalationReasonCodes(keyStates) {
  if (!keyStates || typeof keyStates !== 'object' || Array.isArray(keyStates)) throw new TypeError('keyStates must be an object');
  const values = ESCALATION_KEYS.map((key) => Object.hasOwn(keyStates, key) ? keyStates[key] : 'MISSING');
  if (Object.keys(keyStates).some((key) => !ESCALATION_KEYS.includes(key))) throw new TypeError('unexpected escalation key');
  if (values.some((state) => !ESCALATION_STATES.has(state))) throw new TypeError('invalid escalation state');
  const codes = [values.includes('TRUE') ? 'SECURITY_ESCALATION_KEY_TRUE' : 'SECURITY_ESCALATION_NO_KEY_TRUE'];
  if (values.includes('UNKNOWN')) codes.push('SECURITY_ESCALATION_INPUT_UNKNOWN');
  if (values.includes('MISSING')) codes.push('SECURITY_ESCALATION_INPUT_MISSING');
  if (values.includes('NOT_APPLICABLE')) codes.push('SECURITY_ESCALATION_NOT_APPLICABLE');
  return codes;
}

export function resolveEscalationResult(keyStates) {
  const values = ESCALATION_KEYS.map((key) => Object.hasOwn(keyStates, key) ? keyStates[key] : 'MISSING');
  if (values.includes('TRUE')) return 'ESCALATE';
  if (values.some((state) => state === 'UNKNOWN' || state === 'MISSING')) return 'UNRESOLVED';
  return 'NO_ESCALATION';
}
