import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { policyArtifactPath, policyPackageRoot } from './policy-artifact-path.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const baseline = JSON.parse(await readFile(join(projectRoot, 'radar-runtime-baseline-v1.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitHead = (path) => execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const policyPin = gitHead(policyPackageRoot);
const contractPath = join(projectRoot, 'vendor/horizon-contracts');
const contractPin = gitHead(contractPath);

assert.equal(baseline.runtimeBaselineVersion, 1);
assert.equal(baseline.status, 'FROZEN');
assert.equal(baseline.policyDistribution.commit, policyPin, 'Policy submodule differs from Runtime Baseline pin.');
assert.equal(baseline.contract.distributionCommit, contractPin, 'Contract submodule differs from Runtime Baseline pin.');
assert.equal(baseline.contract.version, '2.1.2');
assert.equal(baseline.contract.schemaVersion, 2);
assert.equal(baseline.scorePolicy.version, '2.0.1');
assert.equal(baseline.eventPolicy.version, '1.0');
assert.equal(baseline.observationPolicy.version, '1.0');
assert.equal(baseline.registryPolicy.version, '1.0');
assert.equal(baseline.historicalVerificationBaseline.scorePolicy, '2.0');
assert.equal(baseline.historicalVerificationBaseline.activeRuntimePolicy, false);

const manifestBytes = await readFile(join(policyPackageRoot, 'distribution-manifest.json'));
const packageMapBytes = await readFile(join(policyPackageRoot, 'radar/policy-package-map-v1.json'));
const manifest = JSON.parse(manifestBytes);
const packageMap = JSON.parse(packageMapBytes);
assert.equal(manifest.contractDistributionCommit, contractPin);
assert.equal(manifest.runtimeBaselineVersion, baseline.runtimeBaselineVersion);
assert.equal(manifest.policyDistributionCommit, null, 'Self-referential commit SHA must remain external to its own tree.');
assert.equal(packageMap.artifacts.length, manifest.artifacts.length);

for (const [index, artifact] of packageMap.artifacts.entries()) {
  const listed = manifest.artifacts[index];
  assert.equal(listed.path, artifact.distributionPath);
  assert.equal(listed.version, artifact.policyVersion);
  assert.equal(listed.sha256, artifact.sha256);
  assert.equal(listed.status, artifact.status);
  const bytes = await readFile(join(policyPackageRoot, artifact.distributionPath));
  assert.equal(sha256(bytes), artifact.sha256, `${artifact.distributionPath} hash mismatch.`);
}
const score20Artifacts = packageMap.artifacts.filter((artifact) => artifact.policyVersion === '2.0');
assert.equal(score20Artifacts.length, 4, 'Historical Score Policy 2.0 package is incomplete.');
assert.ok(score20Artifacts.every((artifact) => artifact.status === 'HISTORICAL_VERIFICATION_BASELINE'));
const activeScorePolicy = packageMap.artifacts.find((artifact) => artifact.artifactType === 'scorePolicy' && artifact.policyVersion === '2.0.1');
assert.equal(activeScorePolicy?.requiredForRuntime, true, 'Score Policy 2.0.1 must be the active runtime policy.');

const registryManifest = JSON.parse(await readFile(policyArtifactPath('radar-registry-policy-v1-canonical-manifest.json'), 'utf8'));
const registryCompatibility = JSON.parse(await readFile(policyArtifactPath('radar-registry-score-compatibility-v1.json'), 'utf8'));
assert.equal(registryManifest.status, 'FROZEN');
assert.equal(registryManifest.policyVersion, '1.0');
assert.equal(registryCompatibility.status, 'VERIFIED');
assert.deepEqual(registryCompatibility.compatibility.map((entry) => entry.result), ['COMPATIBLE', 'COMPATIBLE']);
assert.equal(baseline.compatibility.result, 'COMPATIBLE');

console.log('Radar policy distribution pin and package integrity: PASS');
console.log(`Contract pin: ${contractPin}`);
console.log(`Policy pin: ${policyPin}`);
console.log(`Artifacts: ${packageMap.artifacts.length}; SHA-256 verified`);
