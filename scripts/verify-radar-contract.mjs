import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const contractPath = 'vendor/horizon-contracts';
const expectedSha = '5ac615eda0de0b0fa1d2cc398309fc2657bacc49';
const expectedContractVersion = '2.0.0';
const expectedSchemaVersion = 2;
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`[radar-contract] FAIL: ${message}`);
  process.exit(1);
};

try {
  const gitmodules = readFileSync(resolve(root, '.gitmodules'), 'utf8');
  if (!gitmodules.includes('path = vendor/horizon-contracts') || !gitmodules.includes('url = https://github.com/muhnchiu/horizon-contracts.git')) {
    fail('public horizon-contracts submodule URL/path mismatch');
  }

  const indexLine = run('git', ['ls-files', '--stage', '--', contractPath]);
  const indexedSha = indexLine.split(/\s+/)[1];
  if (indexedSha !== expectedSha) fail(`submodule gitlink must pin ${expectedSha}, got ${indexedSha || 'missing'}`);

  const checkedOutSha = run('git', ['-C', contractPath, 'rev-parse', 'HEAD']);
  if (checkedOutSha !== expectedSha) fail(`checked-out submodule must be ${expectedSha}, got ${checkedOutSha}`);

  const manifest = JSON.parse(readFileSync(resolve(root, contractPath, 'radar/v2/contract-manifest.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(resolve(root, contractPath, 'radar/v2/radar-v2.schema.json'), 'utf8'));
  if (manifest.contractVersion !== expectedContractVersion) fail(`contractVersion must be ${expectedContractVersion}`);
  if (manifest.schemaVersion !== expectedSchemaVersion || schema.properties?.schemaVersion?.const !== expectedSchemaVersion) {
    fail(`schemaVersion must be ${expectedSchemaVersion} in manifest and schema`);
  }

  const distributionNotes = readFileSync(resolve(root, contractPath, 'radar/v2/DISTRIBUTION.md'), 'utf8');
  if (!distributionNotes.includes('430a838275c78c37a6f7be99cc98a99c4267394c') || !distributionNotes.includes('8264d9f16033151c151675b405d35f6a1c681b80f215fc4c9f19a28168dfb028')) {
    fail('Contract 2.0 distribution provenance/hash does not match the approved canonical baseline');
  }

  const historicalRoot = resolve(root, contractPath, 'radar/v2/2.1.0');
  const historicalManifest = JSON.parse(readFileSync(resolve(historicalRoot, 'contract-manifest.json'), 'utf8'));
  const historicalSchema = JSON.parse(readFileSync(resolve(historicalRoot, 'radar-v2.schema.json'), 'utf8'));
  if (historicalManifest.contractVersion !== '2.1.0' || historicalManifest.schemaVersion !== 2 || historicalSchema.properties?.schemaVersion?.const !== 2) {
    fail('historical Contract 2.1.0 manifest/schema version mismatch');
  }
  if (historicalManifest.artifactSha256 !== '7ff640854b6ede9e7e03307628825951063f34ca84f1c0a92f29857b4bade400') {
    fail('historical Contract 2.1.0 artifact hash mismatch');
  }

  const historical211Root = resolve(root, contractPath, 'radar/v2/2.1.1');
  const historical211Manifest = JSON.parse(readFileSync(resolve(historical211Root, 'contract-manifest.json'), 'utf8'));
  const historical211Schema = JSON.parse(readFileSync(resolve(historical211Root, 'radar-v2.schema.json'), 'utf8'));
  if (historical211Manifest.contractVersion !== '2.1.1' || historical211Manifest.schemaVersion !== 2 || historical211Schema.properties?.schemaVersion?.const !== 2) {
    fail('historical Contract 2.1.1 manifest/schema version mismatch');
  }
  if (historical211Manifest.canonicalCommit !== 'afbf42fc554588117c23c17607005c11d29793d3') fail('Contract 2.1.1 canonical commit mismatch');
  const historical211Digest = createHash('sha256');
  for (const file of historical211Manifest.artifactFiles) {
    historical211Digest.update(file, 'utf8');
    historical211Digest.update('\0');
    historical211Digest.update(readFileSync(resolve(historical211Root, file)));
    historical211Digest.update('\0');
  }
  if (historical211Digest.digest('hex') !== historical211Manifest.artifactSha256) fail('Contract 2.1.1 distribution artifact hash mismatch');

  const currentRoot = resolve(root, contractPath, 'radar/v2/2.1.2');
  const currentManifest = JSON.parse(readFileSync(resolve(currentRoot, 'contract-manifest.json'), 'utf8'));
  const currentSchema = JSON.parse(readFileSync(resolve(currentRoot, 'radar-v2.schema.json'), 'utf8'));
  if (currentManifest.contractVersion !== '2.1.2' || currentManifest.schemaVersion !== 2 || currentSchema.properties?.schemaVersion?.const !== 2) {
    fail('Contract 2.1.2 manifest/schema version mismatch');
  }
  if (currentManifest.canonicalSchema !== 'contracts/radar-v2/2.1.2/radar-v2.schema.json') fail('Contract 2.1.2 canonical schema path mismatch');
  const currentDigest = createHash('sha256');
  for (const file of currentManifest.artifactFiles) {
    currentDigest.update(file, 'utf8');
    currentDigest.update('\0');
    currentDigest.update(readFileSync(resolve(currentRoot, file)));
    currentDigest.update('\0');
  }
  if (currentDigest.digest('hex') !== currentManifest.artifactSha256) fail('Contract 2.1.2 distribution artifact hash mismatch');
  const previousKeyPattern = new RegExp(historical211Schema.$defs.eventKey.pattern);
  const currentKeyPattern = new RegExp(currentSchema.$defs.eventKey.pattern);
  const replayKeys = [
    'deepseek-v4.1:model-release:initial',
    'glm-5.2-openrouter:pricing-change:pricing',
  ];
  for (const eventKey of replayKeys) {
    if (previousKeyPattern.test(eventKey)) fail(`2.1.1 unexpectedly accepts ${eventKey}`);
    if (!currentKeyPattern.test(eventKey)) fail(`2.1.2 rejects frozen Event Replay key ${eventKey}`);
  }
  console.log(`[radar-contract] PASS: 2.0 preserved; 2.1.0/2.1.1 historical packages verified; 2.1.2 / schema 2 pinned at ${expectedSha}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
