import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const sourceRoot = join(repositoryRoot, 'vendor/horizon-policies/radar/score/2.1.0');
if (!process.argv[2]) throw new Error('Usage: node scripts/build-score-policy-v2.1-conformance.mjs <output-directory>');
const output = resolve(process.argv[2]);
const serialization = 'UTF-8 JSON, 2-space indentation, object insertion order, one LF newline; SHA-256 over exact bytes.';
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const payloadNames = [
  'radar-score-policy-v2.1.0.json',
  'radar-score-policy-v2.1.0.md',
  'radar-score-replay-v2.0.1-compatibility.json',
  'radar-action-decision-policy-v2.1.0.json',
  'radar-action-boundary-fixtures-v2.1.0.json',
  'radar-risk-policy-v1.0.json',
  'radar-prior-validation-lifecycle-policy-v1.0.json',
  'radar-prior-validation-lifecycle-fixtures-v1.0.json',
  'radar-score-input-generation-policy-v2.1.0.json',
  'radar-score-input-provenance-schema-v2.1.json',
  'radar-score-calibration-dataset-schema-v2.1.json',
];

const sourceManifestBytes = await readFile(join(sourceRoot, 'radar-score-policy-v2.1.0-manifest.json'));
const manifest = JSON.parse(sourceManifestBytes.toString('utf8'));
if (manifest.status !== 'FROZEN' || manifest.frozen !== true || manifest.scorePolicyVersion !== '2.1.0') {
  throw new Error('Canonical Score Policy 2.1.0 manifest is not frozen.');
}
if (manifest.artifacts?.length !== 11) throw new Error(`Expected 11 declared payloads, got ${manifest.artifacts?.length}`);
const payloadData = new Map();
for (const name of payloadNames) {
  const bytes = await readFile(join(sourceRoot, name));
  const entry = manifest.artifacts.find((item) => item.path === name);
  if (!entry || entry.sha256 !== sha256(bytes)) throw new Error(`Canonical payload hash mismatch: ${name}`);
  payloadData.set(name, bytes);
}
if (manifest.artifacts.some((item) => !payloadData.has(item.path))) throw new Error('Manifest contains an undeclared semantic payload.');

manifest.artifacts = payloadNames.map((path) => ({
  ...manifest.artifacts.find((item) => item.path === path),
  sha256: sha256(payloadData.get(path)),
}));
manifest.serialization = serialization;
const manifestBytes = Buffer.from(canonicalJson(manifest));
const integrity = {
  artifact: 'radar-score-policy-v2.1.0-package-integrity',
  integrityVersion: '1.0',
  packageIdentity: manifest.artifact,
  packageVersion: manifest.packageVersion,
  manifestFilename: 'radar-score-policy-v2.1.0-manifest.json',
  manifestSha256: sha256(manifestBytes),
  payloadCount: payloadData.size,
  serialization,
  status: 'FROZEN',
  frozen: true,
};

await mkdir(output, { recursive: true });
const previousFiles = await readdir(output);
const allowedExisting = new Set([...payloadNames, 'radar-score-policy-v2.1.0-manifest.json', 'package-integrity.json']);
const unexpectedExisting = previousFiles.filter((name) => !allowedExisting.has(name));
if (unexpectedExisting.length) throw new Error(`Refusing to remove unexpected output entries: ${unexpectedExisting.join(', ')}`);
for (const name of previousFiles) await rm(join(output, name), { recursive: true, force: true });
for (const [name, bytes] of payloadData) await writeFile(join(output, name), bytes);
await writeFile(join(output, 'radar-score-policy-v2.1.0-manifest.json'), manifestBytes);
await writeFile(join(output, 'package-integrity.json'), Buffer.from(canonicalJson(integrity)));
console.log(JSON.stringify({ output, payloads: payloadData.size, manifestSha256: integrity.manifestSha256 }, null, 2));
