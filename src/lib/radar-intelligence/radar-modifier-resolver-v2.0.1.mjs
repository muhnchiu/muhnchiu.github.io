/**
 * Standalone deterministic resolver for Score Policy 2.0.1.
 * It is intentionally not imported by the production Radar or Score Policy 2.0 path.
 */

const BOUNDS = Object.freeze({ min: -10, max: 10 });
const RULES = Object.freeze({
  ai: [
    { id: 'AI_PRICE_OR_COST', terms: ['免费', 'free', '降价', 'price'], value: 5 },
    { id: 'AI_CAPABILITY', terms: ['agent', 'voice', 'capability'], value: 3 },
  ],
  dev: [
    { id: 'DEV_CONTEXT_TOOL', terms: ['claude code', 'jev', 'mcp', 'compaction'], value: 5 },
    { id: 'DEV_WORKFLOW_TOOL', terms: ['agent', 'harness', 'review', 'abide'], value: 3 },
  ],
  skill: [{ id: 'SKILL_TRAINING_RESEARCH', terms: ['skillopt'], value: 3 }],
  app: [
    { id: 'APP_STACK_MATCH', terms: ['atuin', 'ghostty', 'tmux', 'shell'], value: 3 },
    { id: 'APP_NEGATIVE_RELEVANT_ONLY', terms: ['vpn', 'minio', 'radicle'], value: -3 },
  ],
  sec: [
    { id: 'SECURITY_TOPICAL', terms: ['ai', 'mcp', 'agent', 'gecko'], value: 3 },
  ],
});

const normalize = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US');
const includesLiteral = (text, term) => text.includes(normalize(term));
const wholeToken = (text, term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text);
};

export function clampRadarModifierV201(value) {
  if (!Number.isFinite(value)) throw new TypeError('Radar modifier must be finite.');
  return Math.max(BOUNDS.min, Math.min(BOUNDS.max, value));
}

function firstMatch(text, rules, { securityAiWholeToken = false } = {}) {
  for (const rule of rules) {
    for (const term of rule.terms) {
      const matched = securityAiWholeToken
        ? wholeToken(text, term)
        : includesLiteral(text, term);
      if (matched) return { rule, term };
    }
  }
  return null;
}

export function resolveRadarModifierV201(input) {
  if (!input || !['ai', 'dev', 'skill', 'app', 'sec'].includes(input.radar)) {
    throw new TypeError('radar must be one of ai, dev, skill, app, sec.');
  }
  const title = normalize(input.title);
  const entity = normalize(input.entity);
  const combined = `${title}\n${entity}`;
  const matchedRules = [];
  const modifierComponents = [];

  if (input.radar === 'sec') {
    matchedRules.push('SECURITY_DEFAULT_BIAS');
    modifierComponents.push({ rule: 'SECURITY_DEFAULT_BIAS', value: -2 });
    const match = firstMatch(combined, RULES.sec, { securityAiWholeToken: true });
    if (match) {
      matchedRules.push(match.rule.id);
      modifierComponents.push({ rule: match.rule.id, term: match.term, value: match.rule.value });
    }
  } else if (input.radar === 'skill') {
    const match = firstMatch(combined, RULES.skill);
    if (match) {
      matchedRules.push(match.rule.id);
      modifierComponents.push({ rule: match.rule.id, term: match.term, value: match.rule.value });
    }
  } else {
    const match = firstMatch(combined, RULES[input.radar]);
    if (match) {
      if (input.radar === 'app' && match.rule.value < 0 && input.relevanceLevel === 'UNRELATED') {
        matchedRules.push('APP_NEGATIVE_SUPPRESSED_UNRELATED');
        modifierComponents.push({ rule: 'APP_NEGATIVE_SUPPRESSED_UNRELATED', term: match.term, value: 0 });
      } else {
        matchedRules.push(match.rule.id);
        modifierComponents.push({ rule: match.rule.id, term: match.term, value: match.rule.value });
      }
    }
  }

  const rawModifier = modifierComponents.reduce((total, component) => total + component.value, 0);
  const radarModifier = clampRadarModifierV201(rawModifier);
  const modifierReason = matchedRules.length
    ? `Matched ${matchedRules.join(' + ')}; raw=${rawModifier}; clamped=${radarModifier}.`
    : 'No modifier trigger matched; raw=0; clamped=0.';

  return { radarModifier, matchedRules, modifierComponents, modifierReason };
}

export const SCORE_POLICY_201_RESOLVER_RULES = RULES;
