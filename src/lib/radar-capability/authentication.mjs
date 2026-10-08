import {createPublicKey,verify} from 'node:crypto';
import Ajv from 'ajv/dist/2020.js';import addFormats from 'ajv-formats';
import {canonical,sha256} from '../radar-judgment/provider.mjs';
import {humanSchema,hashValidation} from '../radar-judgment/human.mjs';
const ajv=new Ajv();addFormats(ajv);const rowValid=ajv.compile(humanSchema);
const fields=['schemaVersion','validationId','validatorId','recordHash','eventKey','observationId','validationScope','rubricId','rubricVersion','attestedFields','evidenceReferences','createdAt','keyId','signedAt'];
const same=(a,b)=>canonical(a)===canonical(b);
const sameScope=(a,b)=>a&&b&&Array.isArray(a.validatedCapabilities)&&Array.isArray(b.validatedCapabilities)?same({...a,validatedCapabilities:[...a.validatedCapabilities].sort()},{...b,validatedCapabilities:[...b.validatedCapabilities].sort()}):same(a,b);
const result=(status,reason,extra={})=>({status,reasonCodes:[reason],...extra});
const instant=value=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw Error('INVALID_AUTHORITY_TIME');return Date.parse(value);};
function inWindow(entry,at){const t=instant(at),start=instant(entry.validFrom),end=entry.validUntil===null?Infinity:instant(entry.validUntil);if(start>end)throw Error('INVALID_AUTHORITY_WINDOW');return t>=start&&t<=end;}
export function authentic(payload,signature,publicKey){try{const key=createPublicKey({key:Buffer.from(publicKey,'base64'),format:'der',type:'spki'}),bytes=Buffer.from(signature,'base64');return key.asymmetricKeyType==='ed25519'&&bytes.length===64&&verify(null,Buffer.from(canonical(payload)),key,bytes);}catch{return false;}}
/** Public-key and authorization history supplied only by an independently authenticated Owner port. */
export function verifyIdentityAt({validatorId,keyId,signedAt,scope},trust){
 try{
  if(trust?.healthy!==true||trust.complete!==true||trust.ownerAuthenticated!==true||!Array.isArray(trust.validators)||!Array.isArray(trust.keys))return result('AUTHORITY_UNAVAILABLE','TRUST_SNAPSHOT_UNAUTHENTICATED');
  if(new Set(trust.validators.map(v=>v.validatorId)).size!==trust.validators.length||new Set(trust.keys.map(k=>k.keyId)).size!==trust.keys.length)return result('AUTHORITY_UNAVAILABLE','TRUST_IDENTITY_CONFLICT');
  const validator=trust.validators.find(v=>v.validatorId===validatorId),key=trust.keys.find(k=>k.keyId===keyId&&k.validatorId===validatorId);
  if(!validator)return result('AUTHORITY_UNAVAILABLE','UNKNOWN_VALIDATOR');if(!key)return result('AUTHORITY_UNAVAILABLE','UNKNOWN_KEY');
  if(!['ACTIVE','RETIRED','REVOKED','EXPIRED'].includes(key.status)||!['ACTIVE','REVOKED','EXPIRED'].includes(validator.status)||key.algorithm!=='Ed25519'||!key.publicKey)return result('AUTHORITY_UNAVAILABLE','TRUST_METADATA_INVALID');
  if((key.status==='RETIRED'||key.status==='EXPIRED')&&key.validUntil===null)return result('AUTHORITY_UNAVAILABLE','TRUST_METADATA_INVALID');
  if(key.status==='REVOKED'&&key.revokedAt===null)return result('AUTHORITY_UNAVAILABLE','KEY_REVOCATION_METADATA_INVALID');
  if(key.invalidFrom!==null&&(key.revokedAt===null||instant(key.invalidFrom)>instant(key.revokedAt)||key.invalidFrom!==key.revokedAt&&key.revocationReason!=='COMPROMISE'))return result('AUTHORITY_UNAVAILABLE','KEY_COMPROMISE_METADATA_INVALID');
  if(validator.status==='REVOKED'&&validator.revokedAt===null)return result('AUTHORITY_UNAVAILABLE','VALIDATOR_REVOCATION_METADATA_INVALID');
  const identity={publicKey:key.publicKey};
  if(!inWindow(validator,signedAt))return result('NOT_FOUND','OUTSIDE_VALIDATOR_VALIDITY',identity);
  if(!inWindow(key,signedAt))return result('NOT_FOUND','OUTSIDE_KEY_VALIDITY',identity);
  if(validator.revokedAt!==null&&instant(signedAt)>=instant(validator.revokedAt))return result('NOT_FOUND','VALIDATOR_REVOKED_AT_SIGNING',identity);
  if(key.revokedAt!==null&&instant(signedAt)>=instant(key.invalidFrom??key.revokedAt))return result('NOT_FOUND','KEY_REVOKED_AT_SIGNING',identity);
  if(!Array.isArray(validator.allowedScopes)||!validator.allowedScopes.some(s=>sameScope(s,scope)))return result('NOT_FOUND','INVALID_SCOPE',identity);
  return result('AUTHORIZED','EXPLICIT_SIGNED_AT_AUTHORIZATION',identity);
 }catch{return result('AUTHORITY_UNAVAILABLE','TRUST_METADATA_INVALID');}
}
export function verifyHumanEnvelope({record,payload,signature},trust,{rubricId='SCORE_INPUT_RUBRIC_1.0',rubricVersion='1.0'}={}){
 if(!record||!payload||!rowValid(record)||record.recordHash!==hashValidation(record)||!same(Object.keys(payload).sort(),[...fields].sort()))return result('AUTHORITY_UNAVAILABLE','INVALID_VALIDATION');
 if(!Array.isArray(payload.attestedFields)||!payload.attestedFields.every(f=>typeof f==='string')||!Array.isArray(payload.evidenceReferences)||!Number.isFinite(Date.parse(payload.createdAt)))return result('AUTHORITY_UNAVAILABLE','INVALID_VALIDATION');
 const auth=verifyIdentityAt({...payload,scope:payload.validationScope},trust);if(!auth.publicKey||!authentic(payload,signature,auth.publicKey))return result('AUTHORITY_UNAVAILABLE','INVALID_SIGNATURE');
 if(payload.validationId!==record.validationId||payload.validatorId!==record.validatedBy||payload.recordHash!==record.recordHash||payload.eventKey!==record.eventKey||payload.observationId!==record.observationId||!sameScope(payload.validationScope,record.scope)||!same([...payload.evidenceReferences].sort(),[...record.evidenceRefs].sort()))return result('AUTHORITY_UNAVAILABLE','RECORD_BINDING_MISMATCH');
 if(payload.attestedFields.some(f=>['impact','actionability','confidence','novelty'].includes(f)))return result('NOT_FOUND','NUMERIC_ATTESTATION_NOT_AUTHORIZED');
 if(payload.rubricId!==rubricId||payload.rubricVersion!==rubricVersion)return result('NOT_FOUND','RUBRIC_BINDING_MISMATCH');
 return auth.status==='AUTHORIZED'?result('VERIFIED','SIGNATURE_SCOPE_AND_BINDING_VALID',{record}):auth;
}
/** Ports must authenticate complete Owner-controlled history. Missing ports are never healthy absence. */
export async function lookupAuthenticatedHuman(query,{trustPort,storePort,rubric}={}){
 if(!trustPort?.load||!trustPort.verifySnapshot||!storePort?.load||!storePort.verifySnapshot)return result('AUTHORITY_UNAVAILABLE','PRODUCTION_AUTHORITY_PORT_NOT_CONFIGURED');
 let trust,snapshot;try{trust=await trustPort.load();snapshot=await storePort.load();if(await trustPort.verifySnapshot(trust)!==true||await storePort.verifySnapshot(snapshot)!==true||snapshot.complete!==true||snapshot.healthy!==true||!Array.isArray(snapshot.records))return result('AUTHORITY_UNAVAILABLE','STORE_INTEGRITY_INVALID');trust={...trust,ownerAuthenticated:true};}catch{return result('AUTHORITY_UNAVAILABLE','STORE_OR_TRUST_UNAVAILABLE');}
 const eligible=[],seen=new Set();for(const signed of snapshot.records){const verified=verifyHumanEnvelope(signed,trust,rubric),id=signed.record?.validationId+'@'+signed.record?.recordVersion;if(seen.has(id))return result('AUTHORITY_UNAVAILABLE','DUPLICATE_OR_CONFLICTING_RECORD');seen.add(id);if(verified.status==='AUTHORITY_UNAVAILABLE')return verified;if(verified.status==='VERIFIED')eligible.push(signed.record);}
 const current=[];for(const id of new Set(eligible.map(r=>r.validationId))){const versions=eligible.filter(r=>r.validationId===id),latest=Math.max(...versions.map(r=>instant(r.validatedAt))),rows=versions.filter(r=>instant(r.validatedAt)===latest);if(rows.length!==1)return result('AUTHORITY_UNAVAILABLE','CONFLICTING_VALIDATION');current.push(rows[0]);}
 const matching=current.filter(r=>r.eventKey===query.eventKey&&r.entity===query.entity&&(r.observationId===query.observationId||r.observationId===null&&r.eventScopeAuthorized)&&sameScope(r.scope,query.scope));const active=matching.filter(r=>r.status==='ACTIVE');if(active.length>1)return result('AUTHORITY_UNAVAILABLE','CONFLICTING_VALIDATION');return active.length?result('FOUND','AUTHENTICATED_SCOPE_MATCH',{record:active[0]}):result('NOT_FOUND','NO_ACTIVE_MATCHING_VALIDATION');
}
export const authenticatedRecordDigest=record=>sha256(canonical(record));
