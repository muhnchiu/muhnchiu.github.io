import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {exact,time,fail} from '../radar-bootstrap/index.mjs';
import {digest,same} from './snapshot-profile.mjs';

export const DOMAIN_SNAPSHOT_CONSTRAINT_HASH='8c9990e47446f090c004b6aa27f20267f33bca4125b6ed897a5819916bd02383';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0;
const ordinal=(a,b)=>a<b?-1:a>b?1:0;
export const compareDomainEntries=(a,b)=>ordinal(a.objectType,b.objectType)||ordinal(a.objectId,b.objectId)||ordinal(a.objectHash,b.objectHash);
function ordered(items,compare){if(!Array.isArray(items))fail('INVALID_SNAPSHOT_CONTENT');for(let i=1;i<items.length;i++)if(compare(items[i-1],items[i])>=0)fail('INVALID_SNAPSHOT_CONTENT');}
export async function loadDomainSnapshotProfile(directory){
 const p=JSON.parse(await readFile(join(directory,'radar-domain-snapshot-profile-v1.json')));
 if(p.status!=='FROZEN / SEMANTIC DECISION'||p.profileStatus!=='FROZEN'||p.constraintPayloadHash!==DOMAIN_SNAPSHOT_CONSTRAINT_HASH||digest(p.constraintPayload)!==DOMAIN_SNAPSHOT_CONSTRAINT_HASH)fail('DOMAIN_SNAPSHOT_PROFILE_CONFORMANCE_FAILURE');
 return p;
}
export function domainSnapshotIdentity(payload,profile){return 'domain-review-history-snapshot:sha256:'+digest(Object.fromEntries(profile.constraintPayload.definitions.object.identityPayloadKeys.map(k=>[k,payload[k]])));}
export function domainHistoryEntry(objectType,object){const objectHash=digest(object);return {objectType,objectHash,objectId:'domain-history-object:sha256:'+digest({objectType,objectHash}),object};}
export function verifyDomainActionFields(payload,profile){
 const o=profile.constraintPayload.definitions.object;exact(payload,o.signedPayloadRequiredFields);
 for(const [k,v]of Object.entries(o.wireConstants))if(!same(payload[k],v))fail('DOMAIN_SNAPSHOT_AUTHORITY_CONFORMANCE_FAILURE');
 if(payload.adminPrincipalId!==profile.storeScope.adminPrincipalId||payload.profileConstraintHash!==DOMAIN_SNAPSHOT_CONSTRAINT_HASH)fail('DOMAIN_SNAPSHOT_AUTHORITY_CONFORMANCE_FAILURE');
 for(const k of ['contentHash','authorityContextHash','cohortDefinitionHash','cohortMembershipHash','reviewHistoryManifestHash','referenceManifestHash','proofManifestHash','receiptManifestHash'])if(!hash(payload[k]))fail('INVALID_SNAPSHOT_BINDING');
 for(const k of ['operationId','operationNonce','adminKeyId','snapshotId','cohortId'])if(!text(payload[k]))fail('INVALID_SNAPSHOT_BINDING');
 if(!Number.isSafeInteger(payload.historyObjectCount)||payload.historyObjectCount<0||(payload.previousSnapshotId===null)!==(payload.previousSnapshotHash===null)||payload.previousSnapshotHash!==null&&!hash(payload.previousSnapshotHash))fail('INVALID_SNAPSHOT_BINDING');
 for(const k of ['evaluationAt','createdAt','signedAt'])time(payload[k]);
 if(time(payload.evaluationAt)>time(payload.createdAt)||time(payload.createdAt)>time(payload.signedAt)||payload.snapshotId!==domainSnapshotIdentity(payload,profile))fail('INVALID_SNAPSHOT_BINDING');
}
export function verifyDomainCohort(cohort,profile){
 const c=profile.constraintPayload.definitions['cohort-evaluation'];exact(cohort,c.cohortKeys);const d=cohort.definition;exact(d,c.definitionKeys);
 if(d.profile!==c.definitionProfile||d.cohortDefinitionVersion!==c.definitionVersion||d.storeId!==profile.storeScope.storeId||d.environment!==profile.storeScope.environment)fail('COHORT_CONFLICT_BLOCKED');
 for(const k of ['sourceFamily','eventType','domain','rubricId','rubricVersion'])if(!text(d[k]))fail('COHORT_CONFLICT_BLOCKED');
 for(const k of ['rubricHash','cohortMembershipHash','candidateReceiptInventoryHash'])if(!hash(d[k]))fail('COHORT_CONFLICT_BLOCKED');
 ordered(cohort.members,(a,b)=>ordinal(a.unitHash,b.unitHash));ordered(cohort.candidateInventory,(a,b)=>ordinal(a.candidateReceiptId,b.candidateReceiptId));
 const units=new Set;
 for(const m of cohort.members){exact(m,c.memberKeys);exact(m.binding,profile.constraintPayload.definitions['reference-binding'].unitBindingFields);exact(m.fieldJudgmentOutputHashes,['impact','actionability','confidence','novelty']);if(![1,2,3].includes(m.sampleIndex)||Object.values(m.fieldJudgmentOutputHashes).some(v=>!hash(v))||m.unitHash!==digest({binding:m.binding,sampleIndex:m.sampleIndex,fieldJudgmentOutputHashes:m.fieldJudgmentOutputHashes}))fail('COHORT_CONFLICT_BLOCKED');units.add(m.unitHash);for(const k of ['sourceFamily','eventType','domain','rubricId','rubricVersion','rubricHash'])if(m.binding[k]!==d[k])fail('COHORT_CONFLICT_BLOCKED');}
 const included=new Set;
 for(const r of cohort.candidateInventory){exact(r,c.candidateInventoryEntryKeys);if(!text(r.candidateReceiptId)||!hash(r.candidateReceiptHash)||!['INCLUDED','REJECTED'].includes(r.disposition)||!Array.isArray(r.reasonCodes)||r.reasonCodes.some(x=>!text(x)))fail('COHORT_CONFLICT_BLOCKED');ordered(r.unitHashes,ordinal);for(const u of r.unitHashes){if(!hash(u)||!units.has(u)||included.has(u))fail('COHORT_CONFLICT_BLOCKED');included.add(u);}if(r.disposition==='INCLUDED'){const members=r.unitHashes.map(u=>cohort.members.find(m=>m.unitHash===u));if(members.length!==3||!same(members.map(m=>m.sampleIndex).sort(),[1,2,3]))fail('COHORT_CONFLICT_BLOCKED');}}
 if(included.size!==units.size||d.memberCount!==cohort.members.length||d.candidateReceiptCount!==cohort.candidateInventory.length||d.cohortMembershipHash!==digest(cohort.members)||d.candidateReceiptInventoryHash!==digest(cohort.candidateInventory))fail('COHORT_CONFLICT_BLOCKED');
 const {cohortId,...base}=d;if(cohortId!=='domain-review-cohort:sha256:'+digest(base))fail('COHORT_CONFLICT_BLOCKED');
 for(const k of ['intervalStart','intervalEnd','sealedAt'])time(d[k]);if(time(d.intervalStart)>time(d.intervalEnd)||time(d.intervalEnd)>time(d.sealedAt))fail('COHORT_CONFLICT_BLOCKED');return true;
}
export function verifyDomainContent(content,profile){
 const defs=profile.constraintPayload.definitions;exact(content,defs.object.contentKeys);if(content.storeId!==profile.storeScope.storeId||content.environment!==profile.storeScope.environment||content.storeSchemaVersion!==1)fail('INVALID_SNAPSHOT_BINDING');time(content.evaluationAt);verifyDomainCohort(content.cohort,profile);if(time(content.cohort.definition.sealedAt)>time(content.evaluationAt))fail('INVALID_SNAPSHOT_BINDING');let count=0;const ids=new Set;
 for(const [name,definition]of Object.entries(defs['payload-manifest'].manifests)){const m=content[name];exact(m,defs['payload-manifest'].manifestKeys);if(m.manifestType!==definition.manifestType||m.manifestVersion!==definition.manifestVersion||m.count!==m.entries?.length)fail('INVALID_SNAPSHOT_CONTENT');ordered(m.entries,compareDomainEntries);for(const e of m.entries){exact(e,defs['payload-manifest'].entryKeys);if(!definition.objectTypes.includes(e.objectType)||!same(e,domainHistoryEntry(e.objectType,e.object))||ids.has(e.objectType+'\0'+e.objectId))fail('INVALID_SNAPSHOT_CONTENT');ids.add(e.objectType+'\0'+e.objectId);}count+=m.count;}
 if(count!==content.historyObjectCount)fail('INVALID_SNAPSHOT_CONTENT');return true;
}
export function verifyDomainPackageHashes(pkg,profile){
 const defs=profile.constraintPayload.definitions;exact(pkg,defs.object.packageKeys);exact(pkg.authorityContext,defs.object.authorityContextKeys);exact(pkg.commitProof,defs.object.commitProofKeys);verifyDomainContent(pkg.content,profile);const p=pkg.action.payload;verifyDomainActionFields(p,profile);
 for(const k of ['storeId','storeSchemaVersion','environment','evaluationAt','historyObjectCount'])if(!same(p[k],pkg.content[k]))fail('INVALID_SNAPSHOT_BINDING');
 for(const k of ['cohortId','cohortDefinitionVersion','cohortMembershipHash'])if(p[k]!==pkg.content.cohort.definition[k])fail('INVALID_SNAPSHOT_BINDING');
 if(p.cohortDefinitionHash!==digest(pkg.content.cohort.definition)||p.contentHash!==digest(pkg.content)||p.authorityContextHash!==digest(pkg.authorityContext)||p.previousAuthorityHeadHash!==pkg.authorityContext.domainAdministrationHeadHash)fail('INVALID_SNAPSHOT_BINDING');
 for(const name of Object.keys(defs['payload-manifest'].manifests))if(p[name+'Hash']!==digest(pkg.content[name]))fail('INVALID_SNAPSHOT_BINDING');
 for(const v of Object.values(pkg.authorityContext))if(!hash(v))fail('INVALID_SNAPSHOT_BINDING');for(const [k,v]of Object.entries(pkg.commitProof))if(k==='transactionId'?!text(v):!hash(v))fail('INVALID_SNAPSHOT_BINDING');return true;
}
