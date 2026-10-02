import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_INTEGRITY_VERSION = '1.0';
export const PACKAGE_SERIALIZATION = 'UTF-8 JSON, 2-space indentation, object insertion order, one LF newline; SHA-256 over exact bytes.';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isInside = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

export async function verifyCandidatePackage(packageRoot) {
  const root = resolve(packageRoot);
  const realRoot = await realpath(root);
  const manifestPath = resolve(root, 'radar-score-policy-v2.1.0-manifest.json');
  const integrityPath = resolve(root, 'package-integrity.json');
  const result = { status: 'PASS', payloadCount: 0, resolved: 0, failures: [] };
  const fail = (code, path, detail) => result.failures.push({ code, path, detail });
  let manifestBytes; let integrityBytes;
  try { manifestBytes = await readFile(manifestPath); } catch { fail('PATH_NOT_FOUND', 'radar-score-policy-v2.1.0-manifest.json', 'manifest is absent'); }
  try { integrityBytes = await readFile(integrityPath); } catch { fail('PATH_NOT_FOUND', 'package-integrity.json', 'outer integrity artifact is absent'); }
  if (!manifestBytes || !integrityBytes) { result.status = 'FAIL'; return result; }

  let manifest; let integrity;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('INVALID_MANIFEST', 'radar-score-policy-v2.1.0-manifest.json', 'JSON parse failed'); }
  try { integrity = JSON.parse(integrityBytes.toString('utf8')); } catch { fail('INVALID_INTEGRITY', 'package-integrity.json', 'JSON parse failed'); }
  if (!manifest || !integrity) { result.status = 'FAIL'; return result; }
  if (integrity.packageVersion !== manifest.packageVersion || integrity.packageIdentity !== manifest.artifact) fail('INTEGRITY_BINDING_MISMATCH', 'package-integrity.json', 'package identity/version does not match manifest');
  if (integrity.manifestFilename !== 'radar-score-policy-v2.1.0-manifest.json' || integrity.manifestSha256 !== sha256(manifestBytes)) fail('MANIFEST_HASH_MISMATCH', 'radar-score-policy-v2.1.0-manifest.json', 'manifest outer hash mismatch');
  if (integrity.payloadCount !== manifest.artifacts?.length) fail('PAYLOAD_COUNT_MISMATCH', 'package-integrity.json', 'declared payload count differs from manifest');

  const seen = new Set();
  const payloadNames = new Set();
  for (const item of manifest.artifacts ?? []) {
    const relPath = item.path;
    if (typeof relPath !== 'string' || !relPath || isAbsolute(relPath)) { fail('PATH_ESCAPE', String(relPath), 'path must be a non-empty relative path'); continue; }
    const target = resolve(root, relPath);
    if (!isInside(root, target)) { fail('PATH_ESCAPE', relPath, 'resolved target escapes package root'); continue; }
    const normalized = relative(root, target);
    if (seen.has(normalized)) { fail('DUPLICATE_PAYLOAD', relPath, 'duplicate manifest payload path'); continue; }
    seen.add(normalized); payloadNames.add(normalized.replaceAll(sep, '/'));
    try {
      const realTarget = await realpath(target);
      if (!isInside(realRoot, realTarget)) { fail('PATH_ESCAPE', relPath, 'symlink target escapes package root'); continue; }
      const bytes = await readFile(realTarget);
      result.resolved += 1;
      if (sha256(bytes) !== item.sha256) fail('HASH_MISMATCH', relPath, 'payload SHA-256 differs from manifest');
    } catch { fail('PATH_NOT_FOUND', relPath, 'payload target does not exist'); }
  }
  result.payloadCount = manifest.artifacts?.length ?? 0;
  let files = [];
  try { files = await readdir(root, { recursive: true, withFileTypes: true }); } catch { fail('PATH_NOT_FOUND', '.', 'cannot enumerate package root'); }
  const actualPayloads = new Set();
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const rel = entry.parentPath ? relative(root, resolve(entry.parentPath, entry.name)).replaceAll(sep, '/') : entry.name;
    if (rel === 'radar-score-policy-v2.1.0-manifest.json' || rel === 'package-integrity.json') continue;
    actualPayloads.add(rel);
  }
  for (const name of actualPayloads) if (!payloadNames.has(name)) fail('UNDECLARED_PAYLOAD', name, 'file is not declared in manifest');
  for (const name of payloadNames) if (!actualPayloads.has(name)) fail('PATH_NOT_FOUND', name, 'declared payload was not found during enumeration');
  result.status = result.failures.length === 0 ? 'PASS' : 'FAIL';
  return result;
}

export async function verifyFrozenScorePolicyPackage(packageRoot) {
  const result = await verifyCandidatePackage(packageRoot);
  const root = resolve(packageRoot);
  const fail = (code, detail) => result.failures.push({ code, path: 'radar-score-policy-v2.1.0-manifest.json', detail });
  try {
    const manifest = JSON.parse(await readFile(resolve(root, 'radar-score-policy-v2.1.0-manifest.json'), 'utf8'));
    const integrity = JSON.parse(await readFile(resolve(root, 'package-integrity.json'), 'utf8'));
    if (manifest.scorePolicyVersion !== '2.1.0' || manifest.packageVersion !== '2.1.0' || manifest.status !== 'FROZEN' || manifest.frozen !== true) {
      fail('NOT_FROZEN', 'manifest must identify frozen Score Policy 2.1.0');
    }
    if (manifest.artifacts?.length !== 11 || integrity.payloadCount !== 11) fail('PAYLOAD_COUNT_MISMATCH', 'frozen package must declare exactly 11 semantic payloads');
    if (integrity.status !== 'FROZEN' || integrity.frozen !== true) fail('INTEGRITY_NOT_FROZEN', 'outer integrity artifact must be frozen');
    const expectedPins = {
      contract: { version: '2.1.2', distributionCommit: '5ac615eda0de0b0fa1d2cc398309fc2657bacc49' },
      eventPolicy: { version: '1.0', distributionCommit: '09c811f7a67ab5a6a1f9f45295d5d815ffb321be' },
      observationPolicy: { version: '1.0', distributionCommit: '09c811f7a67ab5a6a1f9f45295d5d815ffb321be' },
      registryPolicy: { version: '1.0', distributionCommit: '09c811f7a67ab5a6a1f9f45295d5d815ffb321be' },
    };
    for (const [name, expected] of Object.entries(expectedPins)) {
      const actual = manifest.compatibilityDeclarations?.[name];
      if (actual?.version !== expected.version || actual?.distributionCommit !== expected.distributionCommit) {
        fail('COMPATIBILITY_PIN_MISMATCH', `frozen manifest has an unexpected ${name} compatibility pin`);
      }
    }
    const historical = manifest.historicalBaselineReferences ?? {};
    const expectedHistorical = {
      'scorePolicy2.0': {
        policySha256: '52f32078c63b07ddeb7f3b0d76c9e2a1e1cab6e5cfc67b08133f11153a7ad0e5',
        markdownSha256: 'f5ac707d5f8cebb513bcd80f712e53391519f558a68fa3b0a2b5f59ed86ee6b6',
        replaySha256: 'cd383741a8532b83c1ea761aba0e98f97edf20c5c31d7c7f077e22bad25f8c9b',
        manifestSha256: '0335432467cb2a7690f627fd0d4d4b5136006fe2d63255aa03c4c39b914c544f',
      },
      'scorePolicy2.0.1': {
        policySha256: '6ee674ab532d57ad9b49df815e61c453255c1a866e1a8a2ddca7bf86a763549f',
        markdownSha256: '2341c1995890a5e33ca671d5da013de1b13e7f2ae1ad1f51bbd2e6c861da6cd6',
        replaySha256: '9bd845181c823a15030b80f74135fe3f6d9f6f464c86b093f7c2baaf2e76fb4f',
        manifestSha256: 'ee3d2f04624881864a15c663c634336cca7b895783d4242996019e0dd6d62bf5',
      },
    };
    if (JSON.stringify(historical) !== JSON.stringify(expectedHistorical)) fail('HISTORICAL_BASELINE_MISMATCH', 'frozen manifest historical Score Policy hashes differ from the approved baselines');
    const required = new Set([
      'radar-score-policy-v2.1.0.json', 'radar-score-policy-v2.1.0.md', 'radar-score-replay-v2.0.1-compatibility.json',
      'radar-action-decision-policy-v2.1.0.json', 'radar-action-boundary-fixtures-v2.1.0.json', 'radar-risk-policy-v1.0.json',
      'radar-prior-validation-lifecycle-policy-v1.0.json', 'radar-prior-validation-lifecycle-fixtures-v1.0.json',
      'radar-score-input-generation-policy-v2.1.0.json', 'radar-score-input-provenance-schema-v2.1.json',
      'radar-score-calibration-dataset-schema-v2.1.json',
    ]);
    const paths = new Set((manifest.artifacts ?? []).map((item) => item.path));
    if (paths.size !== 11 || [...required].some((path) => !paths.has(path))) fail('SEMANTIC_PAYLOAD_SET_MISMATCH', 'frozen package must contain the reviewed 11-payload set');
  } catch (error) {
    fail('INVALID_FROZEN_METADATA', error instanceof Error ? error.message : String(error));
  }
  result.status = result.failures.length === 0 ? 'PASS' : 'FAIL';
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: node scripts/verify-score-policy-v2.1-package.mjs <package-root>');
    process.exitCode = 2;
  } else {
    const result = await verifyFrozenScorePolicyPackage(root);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'PASS') process.exitCode = 1;
  }
}
