import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = new URL('../../../vendor/horizon-policies/radar/score/2.1.0/', import.meta.url);
const readJson = (name: string): any => JSON.parse(readFileSync(new URL(name, PACKAGE_ROOT), 'utf8'));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const manifestBytes = readFileSync(new URL('radar-score-policy-v2.1.0-manifest.json', PACKAGE_ROOT));
const integrityBytes = readFileSync(new URL('package-integrity.json', PACKAGE_ROOT));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const integrity = JSON.parse(integrityBytes.toString('utf8'));
export const scoreInputPolicy = readJson('radar-score-input-generation-policy-v2.1.0.json');
export const scorePolicy = readJson('radar-score-policy-v2.1.0.json');
export const actionPolicy = readJson('radar-action-decision-policy-v2.1.0.json');
export const riskPolicy = readJson('radar-risk-policy-v1.0.json');
export const priorValidationPolicy = readJson('radar-prior-validation-lifecycle-policy-v1.0.json');
export const provenanceSchema = readJson('radar-score-input-provenance-schema-v2.1.json');

export const CONSUMED_INPUTS = scoreInputPolicy.authorityMap.consumedScoreInputs as Array<Record<string, any>>;
export const REQUIRED_INPUTS = scoreInputPolicy.requiredFields as string[];
export const CONDITIONAL_INPUTS = scoreInputPolicy.conditionalFields as string[];
export const INPUT_AUTHORITY = new Map(CONSUMED_INPUTS.map((row) => [row.field, row]));

/** Fail closed if the frozen package and its typed provenance contract drift apart. */
export function assertFrozenInputContract(): void {
  if (sha256(manifestBytes) !== '1326c47743ad68c4e1d37a6e1572119b518b038b34e0328a8711d4e0da9802ba') throw new Error('FROZEN_SCORE_MANIFEST_HASH_MISMATCH');
  if (sha256(integrityBytes) !== '5403cd02026d140f809886d3641d183f8be0ed2b8a9e6b0a0fdd881c32207536') throw new Error('FROZEN_SCORE_OUTER_HASH_MISMATCH');
  if (scoreInputPolicy.status !== 'FROZEN' || scoreInputPolicy.policyVersion !== '2.1.0') throw new Error('FROZEN_SCORE_INPUT_POLICY_MISMATCH');
  if (manifest.status !== 'FROZEN' || manifest.packageVersion !== '2.1.0' || manifest.artifacts.length !== 11 || integrity.manifestSha256 !== sha256(manifestBytes) || integrity.payloadCount !== 11) throw new Error('FROZEN_SCORE_PACKAGE_METADATA_MISMATCH');
  for (const artifact of manifest.artifacts) {
    const bytes = readFileSync(new URL(artifact.path, PACKAGE_ROOT));
    if (sha256(bytes) !== artifact.sha256) throw new Error(`FROZEN_SCORE_PAYLOAD_HASH_MISMATCH:${artifact.path}`);
  }
  const required = new Set(REQUIRED_INPUTS);
  const conditional = new Set(CONDITIONAL_INPUTS);
  const rows = new Set(CONSUMED_INPUTS.map((row) => row.field));
  const schemaFields = new Set(provenanceSchema.$defs.fieldRecord.oneOf.flatMap((variant: any) => {
    const constraints = variant.allOf[1];
    return [constraints.properties.field.const];
  }));
  if (CONSUMED_INPUTS.length !== 19 || rows.size !== 19 || schemaFields.size !== 19) throw new Error('SCORE_INPUT_AUTHORITY_COUNT_MISMATCH');
  if ([...rows].some((field) => !required.has(field) && !conditional.has(field)) || [...required, ...conditional].some((field) => !rows.has(field))) throw new Error('SCORE_INPUT_REQUIRED_FIELD_MISMATCH');
  if ([...rows].some((field) => !schemaFields.has(field)) || [...schemaFields].some((field) => !rows.has(field))) throw new Error('SCORE_INPUT_PROVENANCE_SCHEMA_MISMATCH');
  if (scoreInputPolicy.authorityMap.missingAuthorities !== 0 || scoreInputPolicy.authorityMap.competingPrimaryAuthorities !== 0 || scoreInputPolicy.authorityMap.unknownAuthorityEntries !== 0) throw new Error('SCORE_INPUT_AUTHORITY_DRIFT');
  const knownAuthorities = new Set(provenanceSchema.$defs.commonRecord.properties.authority.enum);
  if (CONSUMED_INPUTS.some((row) => !knownAuthorities.has(row.primaryAuthority))) throw new Error('SCORE_INPUT_UNKNOWN_AUTHORITY');
  for (const row of CONSUMED_INPUTS) {
    if (!row.primaryAuthority || row.primaryAuthority === 'UNKNOWN' || !Array.isArray(row.generationMethods) || row.generationMethods.length === 0) throw new Error(`SCORE_INPUT_AUTHORITY_INVALID:${row.field}`);
  }
}

export const FROZEN_PACKAGE_PATH = fileURLToPath(PACKAGE_ROOT);
