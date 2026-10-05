import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {canonical,sha256} from './provider.mjs';
const string={type:'string',minLength:1,maxLength:2048};const date={type:'string',format:'date-time'};
const object=p=>({type:'object',additionalProperties:false,properties:p,required:Object.keys(p)});
export const humanSchema=object({validationId:string,eventKey:string,observationId:{type:['string','null'],minLength:1},eventScopeAuthorized:{type:'boolean'},entity:string,recordVersion:string,status:{enum:['ACTIVE','STALE','REVOKED']},validatedBy:string,validatorAuthorityRef:string,validationType:string,validatedAt:date,scope:object({validatedVersion:string,validatedCapabilities:{type:'array',items:string,minItems:1,uniqueItems:true},validatedUsage:string,validatedEnvironment:string}),evidenceRefs:{type:'array',items:string,minItems:1,uniqueItems:true},provenance:object({authority:{const:'EXPLICIT_HUMAN_VALIDATION'},method:{const:'AUTHENTICATED_HUMAN'},authenticationRef:string}),recordHash:{type:'string',pattern:'^[a-f0-9]{64}$'}});
const ajv=new Ajv();addFormats(ajv);const valid=ajv.compile(humanSchema);
export function hashValidation(record){const {recordHash,...payload}=record;return sha256(canonical(payload));}
const result=(status,reason,extra={})=>({status,reasonCodes:[reason],authority:'EXPLICIT_HUMAN_VALIDATION',...extra});
/** A configured, authenticated authority port is required. No storage write API is exposed. */
export async function lookupHumanValidation(query,authority){
  if(!authority?.readSnapshot||!authority.verifyIdentity)return result('UNAVAILABLE','HUMAN_VALIDATION_STORE_UNAVAILABLE');
  let snapshot;try{snapshot=await authority.readSnapshot();}catch{return result('UNAVAILABLE','HUMAN_VALIDATION_LOOKUP_FAILED');}
  if(!snapshot?.healthy||!snapshot.complete||!snapshot.registryVersion||!snapshot.receiptRef||!Array.isArray(snapshot.records))return result('UNAVAILABLE','HUMAN_VALIDATION_SNAPSHOT_INCOMPLETE');
  const seen=new Set();for(const row of snapshot.records){let authenticated=false;try{authenticated=await authority.verifyIdentity(row,snapshot);}catch{}
    if(!valid(row)||row.recordHash!==hashValidation(row)||authenticated!==true||seen.has(row.validationId+'@'+row.recordVersion)||(!row.observationId&&!row.eventScopeAuthorized))return result('INVALID_VALIDATION','HUMAN_VALIDATION_RECORD_INVALID');seen.add(row.validationId+'@'+row.recordVersion);
  }
  const meta={registryVersion:snapshot.registryVersion,receiptRef:snapshot.receiptRef,complete:true,healthy:true};
  const currentAll=[];
  for(const id of new Set(snapshot.records.map(r=>r.validationId))){const versions=snapshot.records.filter(r=>r.validationId===id);const latest=Math.max(...versions.map(r=>Date.parse(r.validatedAt)));const rows=versions.filter(r=>Date.parse(r.validatedAt)===latest);if(rows.length!==1)return result('CONFLICTING_VALIDATION','HUMAN_VALIDATION_CONFLICT',meta);currentAll.push(rows[0]);}
  const current=currentAll.filter(r=>r.eventKey===query.eventKey&&r.entity===query.entity&&(r.observationId===query.observationId||(!r.observationId&&r.eventScopeAuthorized))&&r.scope.validatedVersion===query.version&&canonical([...r.scope.validatedCapabilities].sort())===canonical([...(query.capabilities??[])].sort())&&r.scope.validatedUsage===query.usage&&r.scope.validatedEnvironment===query.environment);
  if(!current.length)return result('NO_VALIDATION',snapshot.records.length?'NO_MATCHING_VALIDATION_SCOPE':'NO_VALIDATION_RECORD',meta);
  const active=current.filter(r=>r.status==='ACTIVE');
  if(active.length>1)return result('CONFLICTING_VALIDATION','HUMAN_VALIDATION_CONFLICT',meta);
  if(!active.length){const latest=Math.max(...current.map(r=>Date.parse(r.validatedAt)));const rows=current.filter(r=>Date.parse(r.validatedAt)===latest);if(rows.length!==1)return result('CONFLICTING_VALIDATION','HUMAN_VALIDATION_CONFLICT',meta);const record=rows[0];return result(record.status==='STALE'?'STALE_VALIDATION':'REVOKED_VALIDATION','HUMAN_VALIDATION_'+record.status,{...meta,record});}
  const record=active[0];
  return result('VALIDATION_FOUND','AUTHENTICATED_SCOPE_MATCH',{...meta,record});
}
export function toPriorValidationLookup(lookup,candidate){
  const absent={complete:false,healthy:false,authority:'EXPLICIT_HUMAN_VALIDATION',resolution:'NO_ACTIVE_RECORD',registryVersion:'UNAVAILABLE',evidenceRefs:[],completeLookupReceipt:''};
  if(!lookup.complete||!lookup.healthy||!candidate.evidence.some(e=>e.evidenceRef===lookup.receiptRef))return absent;
  const resolution={VALIDATION_FOUND:'ACTIVE_MATCH',NO_VALIDATION:'NO_ACTIVE_RECORD',STALE_VALIDATION:'LATEST_STALE',REVOKED_VALIDATION:'LATEST_REVOKED',CONFLICTING_VALIDATION:'CONFLICT'}[lookup.status];if(!resolution)return absent;
  const r=lookup.record;return {complete:true,healthy:true,authority:'EXPLICIT_HUMAN_VALIDATION',resolution,registryVersion:lookup.registryVersion,evidenceRefs:[lookup.receiptRef],completeLookupReceipt:lookup.receiptRef,...(r?{record:{validationId:r.validationId,recordVersion:r.recordVersion,validatedBy:r.validatedBy,validatedAt:r.validatedAt,status:r.status,entity:r.entity,...r.scope,evidenceRefs:r.evidenceRefs,createdByAuthority:r.provenance.authority}}:{})};
}
