import { resolveScoreInputEligibility } from '../radar-score-input/eligibility.ts';
import { resolveRadarModifierV201 } from '../radar-intelligence/radar-modifier-resolver-v2.0.1.mjs';
import { assertFrozenRuntimePackages, frozenActionPolicy, frozenScorePolicy } from './frozen-policies.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const fail = (code) => ({ status: 'RECEIPT_ONLY', reasonCodes: [code], score: null, signal: null, policyAction: null, filtered: null });

function actionFor(signal, input) {
  const rules = frozenActionPolicy.precedence;
  const firstDiscovery = (frozenActionPolicy.eventClassMapping.futureContract21Adapter.FIRST_DISCOVERY ?? []).includes(input.eventType);
  const versionRelease = (frozenActionPolicy.eventClassMapping.futureContract21Adapter.VERSION_RELEASE ?? []).includes(input.eventType);
  for (const rule of rules) {
    switch (rule.id) {
      case 'P01': if (signal === 'filtered') return rule.then;
        break;
      case 'P02': if (input.risk === 'high' && signal === 'high') return rule.then;
        break;
      case 'P03': if (input.risk === 'high' && ['medium', 'low'].includes(signal)) return rule.then;
        break;
      case 'P04': if (signal === 'high' && input.eventClass === 'VERSION_RELEASE' && versionRelease) return rule.then;
        break;
      case 'P05': if (signal === 'high' && input.eventClass === 'FIRST_DISCOVERY' && firstDiscovery && input.actionability >= 7 && input.relevanceScore >= 8) return rule.then;
        break;
      case 'P06': if (signal === 'high' && input.eventClass === 'FIRST_DISCOVERY' && firstDiscovery && !(input.actionability >= 7 && input.relevanceScore >= 8) && input.impact >= 6) return rule.then;
        break;
      case 'P07': if (signal === 'high' && input.eventClass === 'FIRST_DISCOVERY' && firstDiscovery) return rule.then;
        break;
      case 'P08': if (signal === 'high' && input.eventClass === 'OTHER' && input.priorValidation === true && input.risk === 'low' && input.relevanceLevel === 'DIRECT' && input.relevanceScore >= 8 && input.actionability >= 7 && input.confidence >= 6 && input.impact >= 7) return rule.then;
        break;
      case 'P09': if (signal === 'high' && input.actionability >= 5) return rule.then;
        break;
      case 'P10': if (signal === 'high') return rule.then;
        break;
      case 'P11': if (signal === 'medium' && input.actionability >= 6 && input.relevanceScore >= 7) return rule.then;
        break;
      case 'P12': if (signal === 'medium' && input.impact >= 5) return rule.then;
        break;
      case 'P13': if (signal === 'medium') return rule.then;
        break;
      case 'P14': if (signal === 'low' && input.actionability >= 4) return rule.then;
        break;
      case 'P15': if (signal === 'low') return rule.then;
        break;
      default: throw new Error(`SCORE_ACTION_RULE_UNIMPLEMENTED:${rule.id}`);
    }
  }
  throw new Error('SCORE_ACTION_NO_RULE_MATCH');
}

function validateNumericInputs(input) {
  for (const name of ['impact', 'actionability', 'confidence', 'novelty', 'momentum']) {
    if (!Number.isInteger(input[name]) || input[name] < 0 || input[name] > 10) return false;
  }
  return true;
}

function calculateCore(input) {
  if (!validateNumericInputs(input)) throw new Error('SCORE_NUMERIC_INPUT_INVALID');
  const relevanceMap = frozenScorePolicy.scoreCalculation.relevanceMap;
  if (relevanceMap[input.relevanceLevel] !== input.relevanceScore) throw new Error('SCORE_RELEVANCE_MISMATCH');
  const weights = frozenScorePolicy.scoreCalculation.weights;
  const weighted = relevanceMap[input.relevanceLevel] * weights.relevance
    + input.impact * weights.impact
    + input.actionability * weights.actionability
    + input.confidence * weights.confidence
    + input.novelty * weights.novelty
    + input.momentum * weights.momentum;
  const baseScore = Math.floor(weighted * 10);
  const bonus = frozenScorePolicy.directBonus;
  const directBonus = input.relevanceLevel === 'DIRECT' && (input.impact >= 7 || input.actionability >= 7)
    ? Math.min(bonus.value, bonus.cap) : 0;
  const modifier = resolveRadarModifierV201({ radar: String(input.radar).toLowerCase(), title: input.title, entity: input.entity, relevanceLevel: input.relevanceLevel });
  if (input.radarModifier !== modifier.radarModifier) throw new Error('SCORE_MODIFIER_MISMATCH');
  const finalScore = clamp(baseScore + directBonus + modifier.radarModifier, 0, 100);
  const thresholds = frozenScorePolicy.signalThresholds;
  const signal = finalScore >= thresholds.high ? 'high' : finalScore >= thresholds.medium ? 'medium' : finalScore >= thresholds.low ? 'low' : 'low';
  return { baseScore, directBonus, modifier, finalScore, signal };
}

/** Pre-gate score signal used only as the Security Gate's explicit incoming signal. */
export function deriveScorePolicy211PreGateSignal({ inputs, provenance }) {
  try {
    assertFrozenRuntimePackages();
    const eligibility = resolveScoreInputEligibility({ inputs, provenance });
    if (eligibility.status !== 'SCORE_READY') return { status: 'RECEIPT_ONLY', signal: null, eligibility };
    const core = calculateCore(inputs);
    return { status: 'READY', signal: core.signal, baseScore: core.baseScore, directBonus: core.directBonus, radarModifier: core.modifier.radarModifier };
  } catch (error) {
    return { status: 'RECEIPT_ONLY', signal: null, reason: error instanceof Error ? error.message : 'SCORE_CORE_FAILED' };
  }
}

/** Score Policy 2.1.1 only. It validates the frozen input contract and never invokes a publisher. */
export function evaluateScorePolicy211({ inputs, provenance, securityGateResult }) {
  try {
    assertFrozenRuntimePackages();
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || !provenance || typeof provenance !== 'object') return fail('SCORE_INPUT_INVALID');
    const eligibility = resolveScoreInputEligibility({ inputs, provenance });
    if (eligibility.status !== 'SCORE_READY') return { ...fail('SCORE_INPUT_INCOMPLETE'), eligibility };
    const radar = String(inputs.radar).toLowerCase();
    if (!['ai', 'dev', 'app', 'sec', 'skill'].includes(radar)) return fail('SCORE_RADAR_UNSUPPORTED');
    const core = calculateCore(inputs);

    let gate = securityGateResult;
    if (radar !== 'sec') {
      gate = gate ?? { status: 'NOT_APPLICABLE', gateClass: 'N/A', escalationResult: 'NOT_EVALUATED', hardFilter: false, outgoingSignal: null };
      if (gate.status !== 'NOT_APPLICABLE') return fail('SECURITY_GATE_RADAR_SCOPE_MISMATCH');
    } else if (!gate || !['RESOLVED', 'NOT_APPLICABLE'].includes(gate.status)) {
      return fail('SECURITY_GATE_UNRESOLVED');
    }
    if (radar === 'sec' && inputs.securityGate !== gate.gateClass) return fail('SECURITY_GATE_SCORE_INPUT_MISMATCH');

    const { baseScore, directBonus, finalScore } = core;
    let signal = core.signal;
    const modifier = core.modifier;
    if (radar === 'sec') {
      if (gate.hardFilter) signal = 'filtered';
      else if (gate.outgoingSignal) signal = gate.outgoingSignal;
    }

    const filterReasons = [];
    if (inputs.eventType === 'funding') filterReasons.push('FUNDING_HARD_FILTER');
    if (radar === 'sec' && gate.hardFilter) filterReasons.push('SECURITY_UNRELATED_HARD_FILTER');
    if (inputs.relevanceLevel === 'UNRELATED' && inputs.impact <= 2) filterReasons.push('UNRELATED_LOW_IMPACT_HARD_FILTER');
    if (inputs.duplicate === true) filterReasons.push('COMMITTED_REGISTRY_DUPLICATE_HARD_FILTER');
    const filtered = filterReasons.length > 0;
    if (filtered) signal = 'filtered';
    const policyAction = actionFor(signal, inputs);
    if (!frozenScorePolicy.actionPolicy.actionVocabulary.includes(policyAction)) return fail('SCORE_ACTION_ENUM_INVALID');

    return {
      status: 'SCORED', policyVersion: '2.1.1',
      baseScore, directBonus, radarModifier: modifier.radarModifier, modifierComponents: modifier.modifierComponents,
      finalScore, signal, policyAction, filtered, filterReasons,
      securityGate: gate, eligibility, publicationDecision: 'NONE',
    };
  } catch (error) {
    return { ...fail('SCORE_POLICY_EVALUATION_FAILED'), diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

export const scoreActionForTesting = actionFor;
