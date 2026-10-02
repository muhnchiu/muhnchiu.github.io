import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { policyArtifactPath } from './policy-artifact-path.mjs';
import { evaluateRadarPolicy } from '../src/lib/radar-intelligence/score-policy.ts';
import { resolveRadarModifierV201, SCORE_POLICY_201_RESOLVER_RULES } from '../src/lib/radar-intelligence/radar-modifier-resolver-v2.0.1.mjs';

const stateDir = process.env.HORIZON_POLICY_STATE_DIR ?? join(homedir(), '.local/state/horizon');
const outputDir = process.env.HORIZON_POLICY_OUTPUT_DIR ?? stateDir;
const status = process.env.FREEZE_SCORE_POLICY === '1' ? 'FROZEN' : 'DRAFT';
const readJson = async (name) => JSON.parse(await readFile(policyArtifactPath(name), 'utf8'));
const readCandidateJson = async (name) => JSON.parse(await readFile(join(stateDir, name), 'utf8'));
const digest = (data) => createHash('sha256').update(data).digest('hex');
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;

const [oldManifest, oldPolicy, oldReplay, candidateReplay] = await Promise.all([
  readJson('radar-score-v2.0-manifest.json'),
  readJson('radar-score-policy-v2.0.json'),
  readJson('radar-score-replay-v2.0.json'),
  readCandidateJson('radar-modifier-replay-candidate-v2.0.1.json'),
]);
if (oldManifest.scoreVersion !== '2.0' || oldManifest.status !== 'frozen'
  || oldPolicy.scoreVersion !== '2.0' || oldPolicy.status !== 'frozen'
  || oldReplay.fixtures.length !== 50) throw new Error('Score Policy 2.0 baseline is not the expected frozen 50-row replay.');

const rules = {
  radarModifierBounds: { min: -10, max: 10 },
  triggerOrder: 'First matching rule by declared rule order; one trigger rule per Radar, except Security default bias plus at most one topical trigger.',
  matching: {
    fields: 'NFKC-normalized title and entity, concatenated with a newline.',
    case: 'Unicode NFKC then en-US lowercase.',
    ordinaryTerms: 'Literal substring matching; phrase and token boundaries are not inferred.',
    securityTerms: 'Whole-token matching for every Security term; token characters are ASCII letters and digits, and every other character is a delimiter.',
    aiAssisted: 'The hyphen is a delimiter, so AI-assisted contains the whole token ai and matches.',
    noLlm: true,
  },
  rules: SCORE_POLICY_201_RESOLVER_RULES,
  appUnrelatedRule: {
    appliesWhen: 'radar=app AND relevanceLevel=UNRELATED AND a negative App trigger matches',
    effect: 'Replace that negative trigger component with 0; preserve the match in debug provenance.',
  },
  securityComposition: {
    defaultBias: -2,
    topicalTrigger: '+3 for the first whole-token match among ai, mcp, agent, gecko.',
    formula: 'default bias + one topical trigger (if any), then clamp to [-10, 10].',
    independentOf: ['Security Gate', 'directBonus', 'relevance', 'impact', 'actionability'],
  },
  output: {
    required: ['radarModifier', 'matchedRules', 'modifierComponents', 'modifierReason'],
    modifierReason: 'Debug only; must not be consumed by scoring decisions.',
    clamp: 'Apply once to the sum of modifier components; clamp inclusively to [-10, 10].',
  },
  evaluationOrder: [
    'Validate Radar and read explicit title/entity/relevanceLevel inputs.',
    'Normalize title/entity using NFKC and en-US lowercase.',
    'Match ordered Radar-specific rules, stopping after the first matching rule.',
    'For Security, add the default bias and then the first whole-token topical trigger, if any.',
    'For App negative trigger with UNRELATED relevance, emit a zero component.',
    'Sum components, clamp modifier, and produce provenance/debug output.',
    'Pass radarModifier independently to Score Policy; do not feed provenance to scoring.',
  ],
};

const policy = {
  scoreVersion: '2.0.1',
  policyVersion: '2.0.1',
  status,
  supersedes: '2.0',
  baselineSource: 'Score Policy 2.0 frozen artifacts plus Phase 5A.6.2 Option C reconciliation; historical candidate replay remains unchanged.',
  sourcePolicyJsonSha256: oldManifest.policyJsonSha256,
  sourceReplaySha256: oldManifest.replayJsonSha256,
  modifierResolver: rules,
  expectedDistribution: { total: 50, high: 8, medium: 8, low: 13, filtered: 21, net: 16 },
  expectedDeltaFrom2_0: {
    fixtureId: 34,
    fields: ['radarModifier', 'finalScore'],
    modifier: { from: 1, to: -2 },
    finalScore: { from: 18, to: 15 },
    signal: 'filtered (unchanged)',
    action: 'ignore (unchanged)',
    filtered: true,
    filterReason: 'Security Gate UNRELATED (unchanged)',
  },
};

const oldById = new Map(oldReplay.fixtures.map((fixture) => [fixture.id, fixture]));
const candidateById = new Map(candidateReplay.fixtures.map((fixture) => [fixture.id, fixture]));
if (oldReplay.fixtures.length !== 50 || candidateReplay.fixtures.length !== 50) throw new Error('Expected 50 source and candidate rows.');

const fixtures = oldReplay.fixtures.map((historical) => {
  const candidate = candidateById.get(historical.id);
  if (!candidate) throw new Error(`Missing Option C candidate row ${historical.id}.`);
  const resolved = resolveRadarModifierV201({
    radar: historical.radar,
    title: historical.title,
    entity: historical.entity,
    relevanceLevel: historical.input.relevanceLevel,
  });
  if (resolved.radarModifier !== candidate.input.radarModifier) {
    throw new Error(`Resolver/candidate modifier mismatch for F${historical.id}: ${resolved.radarModifier} != ${candidate.input.radarModifier}.`);
  }
  const input = { ...historical.input, radarModifier: resolved.radarModifier };
  const result = evaluateRadarPolicy({ ...historical, input });
  const candidateExpected = candidate.expected;
  for (const field of ['baseScore', 'directBonus', 'finalScore', 'signal', 'action', 'filtered', 'filterReason']) {
    if (result[field] !== candidateExpected[field]) throw new Error(`Option C expected ${field} mismatch for F${historical.id}.`);
  }
  return {
    id: historical.id,
    date: historical.date,
    radar: historical.radar,
    title: historical.title,
    entity: historical.entity,
    input,
    baseScore: result.baseScore,
    directBonus: result.directBonus,
    radarModifier: resolved.radarModifier,
    matchedRules: resolved.matchedRules,
    modifierComponents: resolved.modifierComponents,
    modifierReason: resolved.modifierReason,
    finalScore: result.finalScore,
    signal: result.signal,
    action: result.action,
    filtered: result.filtered,
    filterReason: result.filterReason,
  };
});

const oldFields = ['baseScore', 'directBonus', 'radarModifier', 'finalScore', 'signal', 'action', 'filtered', 'filterReason'];
const changed = [];
for (const row of fixtures) {
  const prior = oldById.get(row.id);
  const delta = oldFields.filter((field) => row[field] !== (field === 'radarModifier' ? prior.input[field] : prior.expected[field]));
  if (delta.length) changed.push({ id: row.id, fields: delta });
}
if (JSON.stringify(changed) !== JSON.stringify([{ id: 34, fields: ['radarModifier', 'finalScore'] }])) {
  throw new Error(`Expected only F34 modifier/finalScore delta; got ${JSON.stringify(changed)}.`);
}

const summary = {
  total: fixtures.length,
  high: fixtures.filter((row) => row.signal === 'high').length,
  medium: fixtures.filter((row) => row.signal === 'medium').length,
  low: fixtures.filter((row) => row.signal === 'low').length,
  filtered: fixtures.filter((row) => row.filtered).length,
  net: fixtures.filter((row) => row.signal === 'high' || row.signal === 'medium').length,
};
if (JSON.stringify(summary) !== JSON.stringify(policy.expectedDistribution)) throw new Error(`Unexpected distribution: ${JSON.stringify(summary)}.`);
const replay = {
  scoreVersion: '2.0.1',
  policyVersion: '2.0.1',
  status,
  sourceReplaySha256: oldManifest.replayJsonSha256,
  sourceCandidateSha256: digest(await readFile(join(stateDir, 'radar-modifier-replay-candidate-v2.0.1.json'))),
  generation: 'Deterministic resolver + frozen Score Policy scoring engine; no row-specific overrides.',
  summary,
  deltaAudit: { comparedFixtures: 50, changed: [{ fixtureId: 34, fields: ['radarModifier', 'finalScore'], before: { radarModifier: 1, finalScore: 18 }, after: { radarModifier: -2, finalScore: 15 }, signalActionFilterUnchanged: true }] },
  regressionAudit: {
    highFixtureIds: fixtures.filter((row) => row.signal === 'high').map((row) => row.id),
    boundaryCrossings: [],
    adoptCount: fixtures.filter((row) => row.action === 'adopt').length,
    entityOverrideCount: 0,
    duplicateHardFilterFixtures: fixtures.filter((row) => row.filterReason === 'DUPLICATE_UPDATE').map((row) => row.id),
    directBonusFixtures: fixtures.filter((row) => row.directBonus > 0).map((row) => row.id),
    securityGateFilteredFixtures: fixtures.filter((row) => row.filterReason === 'Security Gate UNRELATED').map((row) => row.id),
  },
  fixtures,
};

const markdown = [
  '# Horizon Radar V2 — Score Policy 2.0.1',
  '',
  `**Status: ${status}**`,
  '',
  'This independent policy supersedes Score Policy 2.0 for the modifier resolver while retaining Score Policy 2.0 as an immutable historical baseline. The base score, direct bonus, signal, action, filters, and gates remain governed by their existing frozen rules.',
  '',
  '## Frozen resolver contract',
  '',
  '- Inputs: radar, title, entity, and relevanceLevel. No Security Gate or score dimensions enter modifier resolution.',
  '- Normalize title/entity with Unicode NFKC and en-US lowercase; all policy terms are evaluated deterministically without an LLM.',
  '- Ordinary triggers use ordered literal substring matching across title and entity. The first matching rule for that Radar applies.',
  '- Security terms `ai`, `mcp`, `agent`, and `gecko` use whole-token matching. ASCII letters and digits are token characters; punctuation and whitespace delimit tokens. Thus `AI-assisted` matches, while `AIO`, `paid`, and `maintain` do not match `ai`.',
  '- Security composition is default bias -2 plus at most one topical +3 trigger, then clamping to [-10, 10]. The modifier is independent of Security Gate, direct bonus, relevance, impact, and actionability.',
  '- An App negative trigger is suppressed to zero when relevanceLevel is UNRELATED. The rule is generic and has no fixture/entity/title exceptions.',
  '- Output: radarModifier, matchedRules[], modifierComponents[], and modifierReason. modifierReason is debug-only and has no scoring effect.',
  '',
  '## Expected distribution and delta',
  '',
  '| Total | High | Medium | Low | Filtered | Net |',
  '|---:|---:|---:|---:|---:|---:|',
  `| ${summary.total} | ${summary.high} | ${summary.medium} | ${summary.low} | ${summary.filtered} | ${summary.net} |`,
  '',
  'F34 is the only score delta: radarModifier 1→-2 and finalScore 18→15. Its filtered/ignore outcome and Security Gate reason stay unchanged. F13/F15/F17 resolve to zero through the generic App unrelated rule.',
  '',
  '## Canonical policy data',
  '',
  'The JSON block below is the canonical machine-readable policy embedded verbatim for cross-artifact consistency.',
  '',
  '```json',
  JSON.stringify(policy, null, 2),
  '```',
  '',
].join('\n');

const policyBytes = canonical(policy);
const replayBytes = canonical(replay);
const markdownBytes = Buffer.from(markdown);
const manifest = {
  scoreVersion: '2.0.1',
  status,
  supersedes: '2.0',
  baselineSource: policy.baselineSource,
  artifactHashes: {
    policyJsonSha256: digest(policyBytes),
    policyMarkdownSha256: digest(markdownBytes),
    replayJsonSha256: digest(replayBytes),
  },
  replayCounts: summary,
  expectedDelta: policy.expectedDeltaFrom2_0,
};
await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, 'radar-score-policy-v2.0.1.json'), policyBytes),
  writeFile(join(outputDir, 'radar-score-policy-v2.0.1.md'), markdownBytes),
  writeFile(join(outputDir, 'radar-score-replay-v2.0.1.json'), replayBytes),
  writeFile(join(outputDir, 'radar-score-v2.0.1-manifest.json'), canonical(manifest)),
]);
console.log(`Generated Score Policy 2.0.1 ${status}: ${summary.total} rows, ${summary.high}/${summary.medium}/${summary.low}/${summary.filtered}/${summary.net}.`);
console.log(`Artifacts written to ${outputDir}`);
