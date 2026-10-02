import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveEscalationReasonCodes, resolveEscalationResult } from '../scripts/security-gate-reason-codes.mjs';

const KEYS = ['activeExploitation', 'supplyChainImpact', 'reachableDependency', 'officialEmergencyAdvisory'];
const STATES = ['TRUE', 'FALSE', 'UNKNOWN', 'NOT_APPLICABLE', 'MISSING'];

test('reason-code derivation is correct for every four-key state vector', () => {
  let checked = 0;
  for (const a of STATES) for (const b of STATES) for (const c of STATES) for (const d of STATES) {
    const vector = Object.fromEntries(KEYS.map((key, i) => [key, [a, b, c, d][i]]));
    const codes = deriveEscalationReasonCodes(vector);
    const hasTrue = Object.values(vector).includes('TRUE');
    assert.equal(codes.includes('SECURITY_ESCALATION_KEY_TRUE'), hasTrue);
    assert.equal(codes.includes('SECURITY_ESCALATION_NO_KEY_TRUE'), !hasTrue);
    for (const [state, code] of [
      ['UNKNOWN', 'SECURITY_ESCALATION_INPUT_UNKNOWN'],
      ['MISSING', 'SECURITY_ESCALATION_INPUT_MISSING'],
      ['NOT_APPLICABLE', 'SECURITY_ESCALATION_NOT_APPLICABLE'],
    ]) assert.equal(codes.includes(code), Object.values(vector).includes(state));
    assert.equal(resolveEscalationResult(vector), hasTrue ? 'ESCALATE' :
      Object.values(vector).some((state) => state === 'UNKNOWN' || state === 'MISSING') ? 'UNRESOLVED' : 'NO_ESCALATION');
    checked++;
  }
  assert.equal(checked, 625);
});

test('missing keys are classified as MISSING and malformed states are rejected', () => {
  assert.deepEqual(deriveEscalationReasonCodes({ activeExploitation: 'TRUE' }), [
    'SECURITY_ESCALATION_KEY_TRUE', 'SECURITY_ESCALATION_INPUT_MISSING',
  ]);
  assert.throws(() => deriveEscalationReasonCodes({ activeExploitation: 'MAYBE' }), /invalid escalation state/);
  assert.throws(() => deriveEscalationReasonCodes({ extra: 'FALSE' }), /unexpected escalation key/);
});
