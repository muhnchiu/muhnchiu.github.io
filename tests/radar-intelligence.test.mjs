import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { policyArtifactPath } from '../scripts/policy-artifact-path.mjs';
import {
  applySecuritySignalCap,
  clampRadarModifier,
  calculateRadarModifier,
  classifyRelevance,
  evaluateRadarPolicy,
  FROZEN_REPLAY_SUMMARY,
  FROZEN_SCORE_POLICY,
  signalForScore,
  assertV2PolicyInput,
} from '../src/lib/radar-intelligence/index.ts';

const replay = JSON.parse(await readFile(policyArtifactPath('radar-score-replay-v2.0.json'), 'utf8'));
const keys = ['baseScore', 'directBonus', 'finalScore', 'signal', 'action', 'filtered', 'filterReason'];
const resultView = (result) => Object.fromEntries(keys.map((key) => [key, result[key]]));

test('all 50 frozen replay fixtures match every expected field and resolved modifier', () => {
  const actualSummary = { total: 0, high: 0, medium: 0, low: 0, filtered: 0, net: 0 };
  for (const fixture of replay.fixtures) {
    const actual = evaluateRadarPolicy(fixture);
    assert.deepEqual(resultView(actual), fixture.expected, `fixture ${fixture.id}: ${fixture.title}`);
    assert.equal(actual.modifier, fixture.input.radarModifier, `fixture ${fixture.id} resolved modifier`);
    actualSummary.total += 1;
    actualSummary[actual.signal] += 1;
    if (actual.signal === 'high' || actual.signal === 'medium') actualSummary.net += 1;
  }
  assert.deepEqual(actualSummary, FROZEN_REPLAY_SUMMARY);
});

test('frozen named high and boundary regressions remain exact', () => {
  const expected = new Map([
    ['fast-jev-compaction', ['fast-jev-compaction', 90, 'high', 'test']],
    ['GPT-6 Sol/Luna', ['openai-gpt6', 81, 'high', 'test']],
    ['Opus 5.5', ['anthropic-opus', 81, 'high', 'test']],
    ['GLM-5.2 Free', ['glm-5.2-openrouter', 81, 'high', 'test']],
    ['abide', ['abide', 79, 'high', 'test']],
    ['jev-review MCP', ['jev-review-mcp', 79, 'high', 'read']],
    ['CometixCode', ['cometixcode', 77, 'high', 'read']],
    ['Atuin', ['atuin', 75, 'high', 'test']],
    ['ChatGPT voice agent', ['chatgpt-voice-agent', 72, 'medium', 'read']],
    ['Claude Code v2.1.281', ['claude-code', 72, 'medium', 'read']],
  ]);
  for (const [label, [entity, ...wanted]] of expected) {
    const fixture = replay.fixtures.find((item) => item.entity === entity && item.expected.finalScore === wanted[0]);
    assert.ok(fixture, `frozen fixture exists: ${label}`);
    const result = evaluateRadarPolicy(fixture);
    assert.deepEqual([result.finalScore, result.signal, result.action], wanted, label);
  }
});

test('thresholds, direct bonus, clamp, and score version are frozen', () => {
  assert.equal(signalForScore(24), 'filtered');
  assert.equal(signalForScore(25), 'low');
  assert.equal(signalForScore(49), 'low');
  assert.equal(signalForScore(50), 'medium');
  assert.equal(signalForScore(74), 'medium');
  assert.equal(signalForScore(75), 'high');
  assert.equal(FROZEN_SCORE_POLICY.scoreVersion, '2.0');
  assert.deepEqual(FROZEN_SCORE_POLICY.weights, { relevance: 0.3, impact: 0.25, actionability: 0.15, confidence: 0.15, novelty: 0.1, momentum: 0.05 });
  assert.throws(() => assertV2PolicyInput(1), /only evaluates Radar V2/);
  assert.doesNotThrow(() => assertV2PolicyInput(2));
  const maximum = replay.fixtures[0];
  const bothBonusConditions = {
    ...maximum,
    input: { ...maximum.input, impact: 10, actionability: 10, confidence: 10, novelty: 10, momentum: 10, radarModifier: 10 },
  };
  const result = evaluateRadarPolicy(bothBonusConditions);
  assert.equal(result.directBonus, 5, 'direct bonus cannot accumulate twice');
  assert.equal(result.finalScore, 100, 'final score clamps to 100');
  assert.equal(clampRadarModifier(100), 10);
  assert.equal(clampRadarModifier(-100), -10);
  assert.throws(() => clampRadarModifier(Number.NaN), /must be finite/);
});

test('security gates and escalation cap are enforced independently of score', () => {
  assert.equal(applySecuritySignalCap('high', 'DIRECTLY_EXPOSED'), 'high');
  assert.equal(applySecuritySignalCap('high', 'DEPENDENCY_RELEVANT'), 'high');
  assert.equal(applySecuritySignalCap('high', 'ECOSYSTEM_RELEVANT'), 'medium');
  assert.equal(applySecuritySignalCap('high', 'ECOSYSTEM_RELEVANT', { reachableDependency: true }), 'high');
  assert.equal(applySecuritySignalCap('high', 'ECOSYSTEM_RELEVANT', { officialEmergencyAdvisory: true }), 'high');
  const filtered = replay.fixtures.find(({ expected }) => expected.filterReason === 'Security Gate UNRELATED');
  assert.equal(evaluateRadarPolicy(filtered).signal, 'filtered');
});

test('generic modifiers are bounded and popularity changes only weighted momentum', () => {
  assert.equal(calculateRadarModifier('ai', { priceOrCostChange: true, capabilityChange: true }), 8);
  assert.equal(calculateRadarModifier('skill', { trainingResearch: true }), 3);
  assert.equal(calculateRadarModifier('app', { genericConsumerApp: true }), -3);
  assert.equal(calculateRadarModifier('sec', {}), -2);
  assert.equal(calculateRadarModifier('ai', { priceOrCostChange: true, capabilityChange: true }), 8);

  const fixture = replay.fixtures[0];
  const lowerMomentum = { ...fixture, input: { ...fixture.input, momentum: fixture.input.momentum - 1 } };
  const baseline = evaluateRadarPolicy(fixture);
  const lower = evaluateRadarPolicy(lowerMomentum);
  assert.ok(baseline.baseScore - lower.baseScore <= 1);
  assert.equal(baseline.directBonus, lower.directBonus);
  assert.equal(baseline.modifier, lower.modifier);
  assert.equal(baseline.action, lower.action);
});

test('relevance classification does not promote interest-only evidence to DIRECT', () => {
  assert.equal(classifyRelevance({ activeStackMatch: false, interestStackMatch: true, trackedDomainMatch: false }), 'ADJACENT');
  assert.equal(classifyRelevance({ activeStackMatch: false, interestStackMatch: false, trackedDomainMatch: true }), 'EXPLORATORY');
  assert.equal(classifyRelevance({ activeStackMatch: true, interestStackMatch: true, trackedDomainMatch: true }), 'DIRECT');
});

test('duplicate input is consumed as a filter; engine contains no fixture/entity override branches', async () => {
  const duplicate = replay.fixtures.find(({ id }) => id === 19);
  assert.equal(duplicate.input.duplicate, true);
  assert.equal(evaluateRadarPolicy(duplicate).filterReason, 'DUPLICATE_UPDATE');
  for (const file of ['action-policy.ts', 'index.ts', 'policy.ts', 'radar-modifier.ts', 'relevance.ts', 'score-policy.ts', 'security-gate.ts', 'signal-policy.ts', 'types.ts']) {
    const source = await readFile(new URL(`../src/lib/radar-intelligence/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:title|entity|id)\s*===/i, `${file} has no fixture-specific branch`);
    assert.doesNotMatch(source, /fast-jev-compaction|CometixCode|Atuin|GPT-6/i, `${file} has no entity override`);
  }
});
