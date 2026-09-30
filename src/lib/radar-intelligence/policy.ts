export const FROZEN_SCORE_POLICY = Object.freeze({
  scoreVersion: '2.0' as const,
  baselineSource: 'phase-4.2.1-deterministic',
  weights: Object.freeze({ relevance: 0.30, impact: 0.25, actionability: 0.15, confidence: 0.15, novelty: 0.10, momentum: 0.05 }),
  relevanceMap: Object.freeze({ DIRECT: 9, ADJACENT: 5, EXPLORATORY: 3, UNRELATED: 1 }),
  thresholds: Object.freeze({ high: 75, medium: 50, low: 25 }),
  modifierBounds: Object.freeze({ min: -10, max: 10 }),
  directBonus: Object.freeze({ value: 5, cap: 5, minImpact: 7, minActionability: 7 }),
  adopt: Object.freeze({ minActionability: 7, minConfidence: 6, minRelevance: 8, minImpact: 7 }),
  replayHashes: Object.freeze({
    policyJson: '52f32078c63b07ddeb7f3b0d76c9e2a1e1cab6e5cfc67b08133f11153a7ad0e5',
    replayJson: 'cd383741a8532b83c1ea761aba0e98f97edf20c5c31d7c7f077e22bad25f8c9b',
    policyMarkdown: 'd1b9d6a542c0c0b73682db2662125569fd3c83f7a0e67802de334d5b63121a53',
  }),
});

export const FROZEN_REPLAY_SUMMARY = Object.freeze({ total: 50, high: 8, medium: 8, low: 13, filtered: 21, net: 16 });
