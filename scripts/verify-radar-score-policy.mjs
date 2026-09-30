import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { policyArtifactPath } from './policy-artifact-path.mjs';
const paths = {
  manifest: policyArtifactPath('radar-score-v2.0-manifest.json'),
  policy: policyArtifactPath('radar-score-policy-v2.0.json'),
  replay: policyArtifactPath('radar-score-replay-v2.0.json'),
  markdown: policyArtifactPath('radar-score-policy-v2.0.md'),
};
const expected = {
  policy: '52f32078c63b07ddeb7f3b0d76c9e2a1e1cab6e5cfc67b08133f11153a7ad0e5',
  replay: 'cd383741a8532b83c1ea761aba0e98f97edf20c5c31d7c7f077e22bad25f8c9b',
  markdown: 'f5ac707d5f8cebb513bcd80f712e53391519f558a68fa3b0a2b5f59ed86ee6b6',
};
const digest = (data) => createHash('sha256').update(data).digest('hex');

const [manifestBytes, policyBytes, replayBytes, markdownBytes] = await Promise.all(
  Object.values(paths).map((path) => readFile(path)),
);
const manifest = JSON.parse(manifestBytes);
const policy = JSON.parse(policyBytes);
const replay = JSON.parse(replayBytes);
const hashes = {
  policy: digest(policyBytes),
  replay: digest(replayBytes),
  markdown: digest(markdownBytes),
};

for (const [key, hash] of Object.entries(hashes)) {
  if (hash !== expected[key]) throw new Error(`${key} SHA-256 differs from the frozen Phase 4.2.2 artifact.`);
}
if (manifest.scoreVersion !== '2.0' || manifest.status !== 'frozen'
  || manifest.baselineSource !== 'phase-4.2.1-deterministic') {
  throw new Error('Score policy manifest metadata does not match the frozen baseline.');
}
if (manifest.policyJsonSha256 !== hashes.policy || manifest.replayJsonSha256 !== hashes.replay
  || manifest.policyMarkdownSha256 !== hashes.markdown) {
  throw new Error('Score policy manifest artifact hashes do not match.');
}
if (policy.scoreVersion !== '2.0' || policy.status !== 'frozen'
  || policy.baselineSource !== 'phase-4.2.1-deterministic') {
  throw new Error('Policy JSON metadata does not match the frozen baseline.');
}
const summary = { ...replay.summary, net: replay.summary.high + replay.summary.medium };
const expectedSummary = { total: 50, high: 8, medium: 8, low: 13, filtered: 21, net: 16 };
if (JSON.stringify(summary) !== JSON.stringify(expectedSummary)
  || manifest.fixtureCount !== 50 || replay.fixtures.length !== 50) {
  throw new Error('Frozen replay summary/count does not match 50 / 8 / 8 / 13 / 21 / 16.');
}

console.log('Radar Score Policy 2.0 manifest and frozen artifact integrity: PASS');
console.log(`Fixtures: ${replay.fixtures.length}; SHA-256: policy/replay/markdown verified`);
