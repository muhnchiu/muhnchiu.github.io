import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scoreRoot = new URL('../../../vendor/horizon-policies/radar/score/2.1.1/', import.meta.url);
const securityRoot = new URL('../../../vendor/horizon-policies/radar/security-gate/1.0.0/', import.meta.url);
const read = (root, file) => readFileSync(new URL(file, root));
const json = (root, file) => JSON.parse(read(root, file).toString('utf8'));

const scoreManifestBytes = read(scoreRoot, 'radar-score-policy-v2.1.1-manifest.json');
const scoreIntegrityBytes = read(scoreRoot, 'package-integrity.json');
const securityManifestBytes = read(securityRoot, 'radar-security-gate-v1.0.0-manifest.json');
const securityIntegrityBytes = read(securityRoot, 'package-integrity.json');

export const FROZEN_PINS = Object.freeze({
  contract: '5ac615eda0de0b0fa1d2cc398309fc2657bacc49',
  distribution: 'f01683ad960663267361f5a5519ddbc7095d6543',
  scorePolicy: '2.1.1',
  securityGate: '1.0.0',
  registryPolicy: '1.0',
  eventPolicy: '1.0',
  observationPolicy: '1.0',
});

export const frozenScorePolicy = json(scoreRoot, 'radar-score-policy-v2.1.1.json');
export const frozenScoreManifest = JSON.parse(scoreManifestBytes.toString('utf8'));
export const frozenScoreIntegrity = JSON.parse(scoreIntegrityBytes.toString('utf8'));
export const frozenActionPolicy = json(scoreRoot, 'radar-action-decision-policy-v2.1.0.json');
export const frozenRiskPolicy = json(scoreRoot, 'radar-risk-policy-v1.0.json');
export const frozenPriorValidationPolicy = json(scoreRoot, 'radar-prior-validation-lifecycle-policy-v1.0.json');
export const frozenInputGenerationPolicy = json(scoreRoot, 'radar-score-input-generation-policy-v2.1.0.json');
export const frozenProvenanceSchema = json(scoreRoot, 'radar-score-input-provenance-schema-v2.1.json');

export const frozenSecurityPolicy = json(securityRoot, 'radar-security-gate-policy-v1.json');
export const frozenSecurityManifest = JSON.parse(securityManifestBytes.toString('utf8'));
export const frozenSecurityIntegrity = JSON.parse(securityIntegrityBytes.toString('utf8'));
export const frozenClassificationMatrix = json(securityRoot, 'radar-security-gate-classification-matrix-v1.json');
export const frozenEscalationMatrix = json(securityRoot, 'radar-security-escalation-decision-matrix-v1.json');
export const frozenDecisionTable = json(securityRoot, 'radar-security-gate-decision-table-v2.json');
export const frozenClassificationFixtures = json(securityRoot, 'radar-security-gate-classification-boundary-fixtures-v1.json');
export const frozenEscalationFixtures = json(securityRoot, 'radar-security-escalation-boundary-fixtures-v1.json');
export const frozenHistoricalProjection = json(securityRoot, 'radar-security-gate-historical-projection-v1.json');

export function assertFrozenRuntimePackages() {
  if (frozenScorePolicy.policyVersion !== '2.1.1' || frozenScorePolicy.status !== 'FROZEN') throw new Error('FROZEN_SCORE_POLICY_VERSION_MISMATCH');
  if (sha256(scoreManifestBytes) !== '91b2a895908efd4ad696a47b580af9c2828170aafec5f77b6f33e550878f5009') throw new Error('FROZEN_SCORE_MANIFEST_HASH_MISMATCH');
  if (sha256(scoreIntegrityBytes) !== '18c47a3e1e9571161a17464332ce3d06ed610998f72e35361ceb2fab4ef3e2c5') throw new Error('FROZEN_SCORE_OUTER_HASH_MISMATCH');
  if (sha256(securityManifestBytes) !== 'f69e8c6fe7700cf0fcb4013d6b79078f749ac4312f09bee2f49f576ed809a6b0') throw new Error('FROZEN_SECURITY_MANIFEST_HASH_MISMATCH');
  if (sha256(securityIntegrityBytes) !== 'db740325e333636fbef597fef15eea209a1d8909b6556cfd5f57857d6a37e64d') throw new Error('FROZEN_SECURITY_OUTER_HASH_MISMATCH');
  for (const [root, manifest, expectedCount] of [[scoreRoot, frozenScoreManifest, 11], [securityRoot, frozenSecurityManifest, 12]]) {
    if (manifest.status !== 'FROZEN' || manifest.artifacts.length !== expectedCount) throw new Error('FROZEN_PACKAGE_MANIFEST_INVALID');
    for (const artifact of manifest.artifacts) {
      if (sha256(read(root, artifact.path)) !== artifact.sha256) throw new Error(`FROZEN_PACKAGE_PAYLOAD_HASH_MISMATCH:${artifact.path}`);
    }
  }
  if (frozenScorePolicy.securityGate.dependency.version !== '1.0.0' || frozenScorePolicy.securityGate.dependency.exactPin !== true) throw new Error('FROZEN_SCORE_SECURITY_DEPENDENCY_MISMATCH');
  if (frozenScorePolicy.publicationBoundary?.semantics !== 'UNDEFINED' || frozenScorePolicy.publicationBoundary?.adoptAuthorization !== false) throw new Error('PUBLICATION_SEMANTICS_LEAK');
  if (frozenSecurityPolicy.policyVersion !== '1.0.0' || frozenSecurityPolicy.status !== 'FROZEN') throw new Error('FROZEN_SECURITY_POLICY_VERSION_MISMATCH');
  return {
    scorePolicy: 'PASS', scorePayloads: frozenScoreManifest.artifacts.length,
    securityGate: 'PASS', securityPayloads: frozenSecurityManifest.artifacts.length,
    pins: FROZEN_PINS,
  };
}

export const frozenPackagePaths = Object.freeze({
  score: fileURLToPath(scoreRoot), security: fileURLToPath(securityRoot),
});
