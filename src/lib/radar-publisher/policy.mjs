import fs from 'node:fs/promises';
import path from 'node:path';
import {sha, strictParse} from './canonical.mjs';
const PIN = "efa85473b15ba8b94e36a83b0f59090f1925851b7feeda714d371616d6f9c67e";
export async function loadFrozenPolicy(directory) {
  const root=await fs.realpath(directory);
  async function bytes(relative) {
    if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split('/').includes('..'))throw Error('POLICY_PATH_INVALID');
    const target=path.join(root,relative); if(await fs.realpath(target)!==target)throw Error('POLICY_SYMLINK');
    return fs.readFile(target);
  }
  const mb=await bytes('manifest.json');if(sha(mb)!==PIN)throw Error('POLICY_MANIFEST_CHANGED');
  const ib=await bytes('integrity.json');if(sha(ib)!=='c838a4085686e6e5175948444867f2f24fe81c79d6a8717663eb9174c6e232a3')throw Error('POLICY_OUTER_INTEGRITY_CHANGED');
  const manifest=strictParse(mb.toString()),integrity=strictParse(ib.toString());
  if(manifest.policyVersion!=='1.0.0'||manifest.status!=='FROZEN'||integrity.manifest.sha256!==PIN||integrity.algorithm!=='SHA-256')throw Error('POLICY_INTEGRITY');
  if(JSON.stringify(manifest.artifacts)!==JSON.stringify(integrity.artifacts))throw Error('POLICY_INTEGRITY');
  const artifacts={};for(const a of [...manifest.artifacts,...manifest.dependencies]){
    const b=await bytes(a.path);if(sha(b)!==a.sha256)throw Error('POLICY_ARTIFACT_CHANGED');
    if(a.path.endsWith('.json'))artifacts[a.path]=strictParse(b.toString());
  }
  const main=artifacts[manifest.entrypoint];
  if(manifest.entrypoint!=='radar-publication-policy-v1.json'||main.status!=='FROZEN'||main.freezeStatus!=='FROZEN'||main.policyVersion!=='1.0.0'||main.effectiveAuthorization!==false||main.instructionIdentityCanonicalization.hashAlgorithm!=='SHA-256'||!main.instructionIdentityCanonicalization.profile.startsWith('RFC8785_JCS'))throw Error('POLICY_NOT_FROZEN');
  for(const ref of main.references)if(!artifacts[ref])throw Error('POLICY_REFERENCE_MISSING');
  if(main.instructionIdentityCanonicalization.spec.sha256!==manifest.artifacts.find(a=>a.path===main.instructionIdentityCanonicalization.spec.path)?.sha256)throw Error('POLICY_CANONICAL_BINDING');
  return {main,manifest,manifestSha256:PIN,artifacts};
}
// Frozen table consumes validated owner proof states; it introduces no eligibility predicates.
export function evaluateFrozenPolicy(policy,facts) {
  const table=policy.artifacts['radar-publication-decision-table-v2.json'];
  if(!facts||typeof facts!=='object'||Array.isArray(facts)||Object.keys(facts).some(k=>!table.stageOrder.includes(k)))throw Error('INVALID_CLOSED_OWNER_ENVELOPE');
  for(const key of table.stageOrder){const d=table.domains[key],v=facts[key];
    if(Object.hasOwn(d.terminalValues,v))return structuredClone(d.terminalValues[v]);
    if(!d.passValues.includes(v))throw Error('INVALID_OWNER_PROOF_STATE:'+key);
  }
  return {disposition:'PUBLICATION_AUTHORIZED',reasonCodes:['PUBLICATION_AUTHORIZED']};
}
