import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const policyPackageRoot = join(projectRoot, 'vendor/horizon-policies');
const packageMapPath = join(policyPackageRoot, 'radar/policy-package-map-v1.json');
const packageMap = JSON.parse(readFileSync(packageMapPath, 'utf8'));

export function policyArtifactPath(sourceArtifact) {
  const artifact = packageMap.artifacts.find((entry) => entry.sourceArtifact === sourceArtifact);
  if (!artifact) throw new Error(`Policy distribution package does not map ${sourceArtifact}.`);
  return join(policyPackageRoot, artifact.distributionPath);
}
