import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { policyArtifactPath } from './policy-artifact-path.mjs';
import { evaluateRadarPolicy } from '../src/lib/radar-intelligence/score-policy.ts';
import { resolveRadarModifierV201 } from '../src/lib/radar-intelligence/radar-modifier-resolver-v2.0.1.mjs';

const file = async (name) => readFile(policyArtifactPath(name));
const sourceFile = async (name) => readFile(policyArtifactPath(name));
const json = async (name) => JSON.parse(await file(name));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const [manifestBytes, policyBytes, markdownBytes, replayBytes, baselineBytes, baselineReplayBytes] = await Promise.all([
  file('radar-score-v2.0.1-manifest.json'), file('radar-score-policy-v2.0.1.json'),
  file('radar-score-policy-v2.0.1.md'), file('radar-score-replay-v2.0.1.json'),
  sourceFile('radar-score-v2.0-manifest.json'), sourceFile('radar-score-replay-v2.0.json'),
]);
const [manifest, policy, replay, baselineManifest, baselineReplay] = await Promise.all([
  json('radar-score-v2.0.1-manifest.json'), json('radar-score-policy-v2.0.1.json'),
  json('radar-score-replay-v2.0.1.json'), JSON.parse(baselineBytes),
  JSON.parse(baselineReplayBytes),
]);
assert.equal(manifest.scoreVersion, '2.0.1');
assert.equal(policy.scoreVersion, manifest.scoreVersion);
assert.equal(replay.scoreVersion, manifest.scoreVersion);
assert.equal(policy.status, 'FROZEN');
assert.equal(replay.status, 'FROZEN');
assert.equal(manifest.status, 'FROZEN');
assert.equal(manifest.supersedes, '2.0');
assert.equal(policy.supersedes, '2.0');
assert.equal(baselineManifest.scoreVersion, '2.0');
assert.equal(baselineManifest.status, 'frozen');
assert.deepEqual(manifest.artifactHashes, {
  policyJsonSha256: sha256(policyBytes),
  policyMarkdownSha256: sha256(markdownBytes),
  replayJsonSha256: sha256(replayBytes),
});
const markdownPolicy = markdownBytes.toString().match(/```json\n([\s\S]*?)\n```/);
assert.ok(markdownPolicy, 'Markdown must embed its canonical JSON policy block.');
assert.deepEqual(JSON.parse(markdownPolicy[1]), policy, 'Markdown and JSON policy must be identical.');
assert.equal(replay.fixtures.length, 50);
assert.equal(baselineReplay.fixtures.length, 50);
assert.deepEqual(manifest.replayCounts, { total: 50, high: 8, medium: 8, low: 13, filtered: 21, net: 16 });
assert.deepEqual(replay.summary, manifest.replayCounts);
assert.deepEqual(policy.expectedDistribution, manifest.replayCounts);

const priorById = new Map(baselineReplay.fixtures.map((row) => [row.id, row]));
let deterministicCount = 0;
const deltas = [];
for (const row of replay.fixtures) {
  const previous = priorById.get(row.id);
  assert.ok(previous, `Missing 2.0 historical F${row.id}.`);
  const resolved = resolveRadarModifierV201({
    radar: row.radar, title: row.title, entity: row.entity, relevanceLevel: row.input.relevanceLevel,
  });
  assert.equal(row.radarModifier, resolved.radarModifier, `Modifier differs for F${row.id}.`);
  assert.deepEqual(row.matchedRules, resolved.matchedRules);
  assert.deepEqual(row.modifierComponents, resolved.modifierComponents);
  assert.equal(typeof row.modifierReason, 'string');
  const rescored = evaluateRadarPolicy({ ...row, input: { ...row.input, radarModifier: resolved.radarModifier } });
  for (const field of ['baseScore', 'directBonus', 'finalScore', 'signal', 'action', 'filtered', 'filterReason']) {
    assert.equal(row[field], rescored[field], `${field} differs after independent score evaluation for F${row.id}.`);
  }
  deterministicCount += 1;
  const fields = ['baseScore', 'directBonus', 'radarModifier', 'finalScore', 'signal', 'action', 'filtered', 'filterReason'];
  const changed = fields.filter((field) => row[field] !== (field === 'radarModifier' ? previous.input[field] : previous.expected[field]));
  if (changed.length) deltas.push({ id: row.id, fields: changed });
}
assert.deepEqual(deltas, [{ id: 34, fields: ['radarModifier', 'finalScore'] }]);
assert.equal(replay.deltaAudit.changed.length, 1);
assert.equal(replay.regressionAudit.adoptCount, 0);
assert.equal(replay.regressionAudit.entityOverrideCount, 0);
assert.deepEqual(replay.regressionAudit.highFixtureIds, [1, 2, 10, 11, 21, 22, 24, 25]);
assert.deepEqual(replay.regressionAudit.boundaryCrossings, []);
assert.ok(replay.regressionAudit.duplicateHardFilterFixtures.includes(40));
assert.ok(replay.regressionAudit.directBonusFixtures.includes(1));
assert.ok(replay.regressionAudit.securityGateFilteredFixtures.includes(34));

const byId = new Map(replay.fixtures.map((row) => [row.id, row]));
for (const id of [13, 15, 17]) assert.equal(byId.get(id).radarModifier, 0, `App unrelated F${id} must resolve to 0.`);
const row34 = byId.get(34);
assert.equal(row34.radarModifier, -2);
assert.equal(row34.finalScore, 15);
assert.equal(row34.signal, 'filtered');
assert.equal(row34.action, 'ignore');
assert.equal(row34.filtered, true);
assert.equal(row34.filterReason, 'Security Gate UNRELATED');
const row32 = byId.get(32);
assert.deepEqual([row32.radarModifier, row32.finalScore, row32.signal, row32.action, row32.filtered], [-2, 57, 'medium', 'watch', false]);
const row35 = byId.get(35);
assert.deepEqual([row35.radarModifier, row35.finalScore, row35.signal, row35.action, row35.filtered], [1, 49, 'low', 'read', false]);
const row36 = byId.get(36);
assert.deepEqual([row36.radarModifier, row36.finalScore, row36.signal, row36.action, row36.filtered], [-2, 65, 'medium', 'test', false]);
const row40 = byId.get(40);
assert.deepEqual([row40.finalScore, row40.signal, row40.action, row40.filtered, row40.filterReason], [57, 'filtered', 'ignore', true, 'DUPLICATE_UPDATE']);

console.log('Score Policy 2.0.1 cross-artifact integrity and replay: PASS');
console.log(`Modifier determinism: ${deterministicCount}/50; expected delta: F34 only; distribution: 8/8/13/21/net16.`);
