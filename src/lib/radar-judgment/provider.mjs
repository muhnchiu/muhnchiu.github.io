import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
export const FIELDS = Object.freeze(['impact','actionability','confidence','novelty']);
export const PINS = Object.freeze({payload:'f6476a231761ce0621223428b10fec938f9cd110447f76edff3bf203f920137c',manifest:'908e32841e78c84b22049e688804f1be6f4a80396922aadbd05161d7f51699d9',integrity:'f200b047efa7cbb26c66d3b87bfa13ab5bb6bf95b267eb638b30dc1296900516'});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
const text = {type:'string',minLength:1,maxLength:2048};
const hash = {type:'string',pattern:'^[a-f0-9]{64}$'};
const refs = {type:'array',items:text,minItems:1,uniqueItems:true};
const object = properties => ({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const provenanceSchema = object({providerId:text,providerVersion:text,modelId:text,rubricVersion:{const:'1.0'},rubricHash:{const:PINS.payload},observationId:text,evaluatedAt:{type:'string',format:'date-time'},configFingerprint:hash,requestFingerprint:hash,evidenceRefs:refs,generationConfidence:{type:'number',minimum:0,maximum:1}});
export const responseSchema = object({field:{enum:FIELDS},value:{type:'integer',minimum:0,maximum:10},status:{const:'JUDGMENT_READY'},reasonCodes:refs,evidenceRefs:refs,conflictEvidenceRefs:{type:'array',items:text,uniqueItems:true},provenance:provenanceSchema,assessments:{type:'array',minItems:11,maxItems:11,items:object({predicateId:text,state:{enum:['TRUE','FALSE','UNKNOWN']},proofs:{type:'array',items:object({evidenceRef:text,claimId:text,sha256:hash})}})}});
const ajv = new Ajv({allErrors:true}); addFormats(ajv);
const validateResponse = ajv.compile(responseSchema);
const verifiedRubrics=new WeakSet();
let replayRubric;
const freezeDeep=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(freezeDeep);Object.freeze(o);}return o;};
export async function loadRubric(directory=join(homedir(),'.local/state/horizon/policies/score-input-rubric/1.0')) {
  const names = {'radar-score-input-rubric-v1.json':PINS.payload,'manifest.json':PINS.manifest,'package-integrity.json':PINS.integrity};
  const loaded={};
  for(const [name,pin] of Object.entries(names)) {const bytes=await readFile(join(directory,name));if(sha256(bytes)!==pin)throw Error('FROZEN_RUBRIC_BASELINE_MISMATCH');loaded[name]=JSON.parse(bytes);}
  for(const a of loaded['package-integrity.json'].artifacts){const path=resolve(directory,a.path);if(!path.startsWith(resolve(directory)+sep)||sha256(await readFile(path))!==a.sha256)throw Error('FROZEN_RUBRIC_BASELINE_MISMATCH');}
  const rubric=loaded['radar-score-input-rubric-v1.json'];if(rubric.status!=='FROZEN')throw Error('FROZEN_RUBRIC_BASELINE_MISMATCH');const frozen=freezeDeep(structuredClone(rubric));verifiedRubrics.add(frozen);replayRubric=frozen;return frozen;
}
const fail = (field,status,code) => ({field,status,value:null,reasonCodes:[code],evidenceRefs:[],provenance:null});
function normalize(request, field, rubric, verifyContext) {
  if(!request || !['runId','eventKey','observationId','radar','sourceFamily','sourceIdentity','observedAt'].every(k=>typeof request[k]==='string'&&request[k].length) || !Number.isFinite(Date.parse(request.observedAt)) || request.rubricVersion!=='1.0'||request.rubricHash!==PINS.payload || !request.normalizedCandidateFacts || !Array.isArray(request.sourceEvidence)) throw Error('INPUT_BINDING_INVALID');
  const spec=rubric.fields.find(f=>f.field===field);const rows=[];const seen=new Set();
  for(const item of request.fieldEvidence?.[field]??[]) {
    const type=spec.evidenceTypes.find(t=>t.type===item.type);
    if(!type || seen.has(item.evidenceRef)||typeof item.bytes!=='string'||item.bytes.length>262144||sha256(item.bytes)!==item.sha256||!item.recordIdentity||!item.versionIdentity||item.scope!==request.eventKey||item.observationId!==request.observationId||!Number.isFinite(Date.parse(item.observedAt))||!Array.isArray(item.claimBindings)||!item.claimBindings.length||new Set(item.claimBindings).size!==item.claimBindings.length||item.claimBindings.some(c=>typeof c!=='string'||!c))throw Error('INVALID_EVIDENCE_BINDING');
    if(item.kind==='SOURCE_FACT') {if(!type.authorityModes.sourceFact.authority.includes(item.sourceAuthority)||!['official','research','ecosystem','media','community'].includes(item.sourceLevel)||!/^https?:\/\//.test(item.sourceUrl)||!request.sourceEvidence.some(e=>e.evidenceRef===item.evidenceRef&&e.sha256===item.sha256))throw Error('INVALID_SOURCE_AUTHORITY');}
    else if(item.kind==='CONTEXT_FACT') {if(!item.approvedContextRef||!item.approvedOwner||!item.contextVersion||verifyContext?.(item,request)!==true||item.type.endsWith('_0'))throw Error('INVALID_CONTEXT_AUTHORITY');}
    else throw Error('UNKNOWN_EVIDENCE_KIND');
    if((item.validUntil&&!Number.isFinite(Date.parse(item.validUntil)))||(item.validFrom&&!Number.isFinite(Date.parse(item.validFrom))))throw Error('INVALID_EVIDENCE_TIME');
    if(item.superseded===true || (item.validUntil&&Date.parse(item.validUntil)<Date.parse(request.observedAt)) || (item.validFrom&&Date.parse(item.validFrom)>Date.parse(request.observedAt)))throw Error('STALE_REQUIRED_EVIDENCE');
    seen.add(item.evidenceRef); const keys=['type','evidenceRef','sha256','recordIdentity','versionIdentity','scope','observationId','observedAt','claimBindings','kind','sourceAuthority','sourceLevel','sourceUrl','approvedContextRef','approvedOwner','contextVersion']; rows.push(Object.fromEntries(keys.filter(k=>item[k]!==undefined).map(k=>[k,structuredClone(item[k])])));
  }
  return {spec,rows,complete:spec.evidenceTypes.every(t=>rows.some(r=>r.type===t.type))};
}
/** MODEL_JUDGMENT supplies clause entailment; runtime validates frozen labels, immutable bindings and precedence. */
export async function evaluateJudgment(request, field, {rubric,adapter,verifyContext,timeoutMs=5000,now=()=>new Date().toISOString()}={}) {
  if(!verifiedRubrics.has(rubric))throw Error('FROZEN_RUBRIC_BASELINE_MISMATCH');
  if(!FIELDS.includes(field))return fail(field,'INVALID_EVIDENCE','UNSUPPORTED_FIELD');
  let input;try{input=normalize(request,field,rubric,verifyContext);}catch{return fail(field,'INVALID_EVIDENCE','INVALID_INPUT_EVIDENCE');}
  if(!input.complete)return fail(field,'INSUFFICIENT_EVIDENCE',input.spec.insufficientEvidence.missingCode);
  if(!adapter?.execute||!adapter.id||!adapter.version||!adapter.modelId||!/^([a-f0-9]{64})$/.test(adapter.configFingerprint))return fail(field,'PROVIDER_ERROR','PROVIDER_UNAVAILABLE');
  const payload={runId:request.runId,eventKey:request.eventKey,observationId:request.observationId,radar:request.radar,sourceFamily:request.sourceFamily,sourceIdentity:request.sourceIdentity,observedAt:request.observedAt,normalizedCandidateFacts:request.normalizedCandidateFacts,rubricVersion:'1.0',rubricHash:PINS.payload,field,evidence:input.rows.map(e=>({...e,text:request.fieldEvidence[field].find(r=>r.evidenceRef===e.evidenceRef).bytes})),predicates:input.spec.levels,frozenRubric:rubric,evaluatedAt:now()};
  const fingerprint=sha256(canonical(payload));const controller=new AbortController();let timer;
  try {
    const result=await Promise.race([Promise.resolve().then(()=>adapter.execute(structuredClone(payload),{signal:controller.signal,requestFingerprint:fingerprint})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('PROVIDER_TIMEOUT'));},timeoutMs);})]);
    if(!validateResponse(result))return fail(field,'INVALID_EVIDENCE','STRUCTURED_RESPONSE_INVALID');
    if(result.conflictEvidenceRefs.length)return fail(field,'INVALID_EVIDENCE','CONFLICTING_EVIDENCE');
    const p=result.provenance;
    if(result.field!==field||p.observationId!==request.observationId||p.providerId!==adapter.id||p.providerVersion!==adapter.version||p.modelId!==adapter.modelId||p.configFingerprint!==adapter.configFingerprint||p.requestFingerprint!==fingerprint||p.evaluatedAt!==payload.evaluatedAt)return fail(field,'INVALID_EVIDENCE','PROVENANCE_BINDING_INVALID');
    const levelIds=new Set(input.spec.levels.map(l=>l.predicateId));const ids=new Set(result.assessments.map(a=>a.predicateId));
    if(ids.size!==11||[...ids].some(id=>!levelIds.has(id)))return fail(field,'INVALID_EVIDENCE','PREDICATE_BINDING_INVALID');
    const used=new Set();
    for(const a of result.assessments) {if(a.state!=='UNKNOWN'&&!a.proofs.length)return fail(field,'INVALID_EVIDENCE','UNPROVEN_PREDICATE');for(const proof of a.proofs){const e=input.rows.find(e=>e.evidenceRef===proof.evidenceRef);if(!e||e.sha256!==proof.sha256||!e.claimBindings.includes(proof.claimId))return fail(field,'INVALID_EVIDENCE','PROOF_BINDING_INVALID');used.add(proof.evidenceRef);}}
    if(input.spec.evidenceTypes.some(t=>!input.rows.some(e=>e.type===t.type&&used.has(e.evidenceRef))))return fail(field,'INVALID_EVIDENCE','MISSING_REQUIRED_PROOF_CLASS');
    const proven=input.spec.levels.filter(l=>result.assessments.find(a=>a.predicateId===l.predicateId).state==='TRUE');const selected=proven.at(-1);
    if(!selected || input.spec.levels.some(l=>l.value>selected.value&&result.assessments.find(a=>a.predicateId===l.predicateId).state==='UNKNOWN'))return fail(field,'INSUFFICIENT_EVIDENCE',input.spec.insufficientEvidence.unknownCode);
    if(selected.value!==result.value||result.reasonCodes.length!==1||result.reasonCodes[0]!==selected.reasonCode||canonical([...used].sort())!==canonical([...result.evidenceRefs].sort())||canonical([...p.evidenceRefs].sort())!==canonical([...result.evidenceRefs].sort()))return fail(field,'INVALID_EVIDENCE','RUBRIC_RESULT_MISMATCH');
    return {...structuredClone(result),binding:{eventKey:request.eventKey,observationId:request.observationId,inputFingerprint:fingerprint,responseFingerprint:sha256(canonical(result)),evidence:input.rows},replay:{mode:'CAPTURED_STRUCTURED_JUDGMENT',version:'1.0'}};
  }catch(error){return fail(field,'PROVIDER_ERROR',error?.message==='PROVIDER_TIMEOUT'?'PROVIDER_TIMEOUT':'PROVIDER_EXECUTION_FAILED');}finally{clearTimeout(timer);}
}
export function createPackage(results) {if(!Array.isArray(results)||results.length!==4||new Set(results.map(r=>r.field)).size!==4||results.some(r=>!FIELDS.includes(r.field)))throw Error('DUPLICATE_OR_PARTIAL_PROVIDER_RESULT');const ready=results.filter(r=>r.status==='JUDGMENT_READY');if(new Set(ready.map(r=>r.binding?.eventKey+'@'+r.binding?.observationId)).size>1)throw Error('MIXED_PROVIDER_IDENTITIES');const payload={packageVersion:'1.0',rubricHash:PINS.payload,results:structuredClone(results)};return {...payload,packageHash:sha256(canonical(payload))};}
export async function writePackage(directory,pkg){if((resolve(directory)===join(homedir(),'.local/state/horizon-production')||resolve(directory).startsWith(join(homedir(),'.local/state/horizon-production')+sep)))throw Error('PRODUCTION_PACKAGE_WRITE_NOT_AUTHORIZED');replayPackage(pkg);const path=join(directory,pkg.packageHash+'.json');const bytes=canonical(pkg)+'\n';try{await writeFile(path,bytes,{flag:'wx',mode:0o400});}catch(e){if(e.code!=='EEXIST'||await readFile(path,'utf8')!==bytes)throw e;}return path;}
export function replayPackage(pkg){const {packageHash,...payload}=pkg;if(payload.packageVersion!=='1.0'||payload.rubricHash!==PINS.payload||sha256(canonical(payload))!==packageHash)throw Error('JUDGMENT_PACKAGE_INTEGRITY_INVALID');createPackage(payload.results);for(const r of payload.results){if(r.status==='JUDGMENT_READY'){const {binding,replay,...response}=r;if(!validateResponse(response)||response.conflictEvidenceRefs.length||!binding||!replay||replay.version!=='1.0'||binding.observationId!==r.provenance.observationId||binding.inputFingerprint!==r.provenance.requestFingerprint||sha256(canonical(response))!==binding.responseFingerprint||!Array.isArray(binding.evidence)||r.evidenceRefs.some(ref=>!binding.evidence.some(e=>e.evidenceRef===ref)))throw Error('JUDGMENT_PACKAGE_RESPONSE_INVALID');
if(!replayRubric)throw Error('FROZEN_RUBRIC_NOT_LOADED');const spec=replayRubric.fields.find(f=>f.field===r.field);const ids=new Set(r.assessments.map(a=>a.predicateId));const selected=spec.levels.filter(l=>r.assessments.some(a=>a.predicateId===l.predicateId&&a.state==='TRUE')).at(-1);if(ids.size!==11||spec.levels.some(l=>!ids.has(l.predicateId))||!selected||selected.value!==r.value||r.reasonCodes.length!==1||r.reasonCodes[0]!==selected.reasonCode||spec.levels.some(l=>l.value>selected.value&&r.assessments.find(a=>a.predicateId===l.predicateId).state==='UNKNOWN')||r.assessments.some(a=>(a.state!=='UNKNOWN'&&!a.proofs.length)||a.proofs.some(p=>!binding.evidence.some(e=>e.evidenceRef===p.evidenceRef&&e.sha256===p.sha256&&e.claimBindings.includes(p.claimId)))))throw Error('JUDGMENT_PACKAGE_RUBRIC_INVALID');
}else if(!['INSUFFICIENT_EVIDENCE','INVALID_EVIDENCE','PROVIDER_ERROR'].includes(r.status)||r.value!==null||!Array.isArray(r.reasonCodes)||!r.reasonCodes.length||r.provenance!==null)throw Error('JUDGMENT_PACKAGE_RESPONSE_INVALID');}return structuredClone(payload.results);}
export async function measureStability(run,repetitions=3){if(!Number.isInteger(repetitions)||repetitions<2||repetitions>10)throw Error('INVALID_STABILITY_BOUND');const runs=[];for(let i=0;i<repetitions;i++)runs.push(await run());return {repetitions,fields:Object.fromEntries(FIELDS.map(field=>{const rows=runs.map(r=>r.find(x=>x.field===field));if(rows.some(r=>!r))throw Error('PARTIAL_STABILITY_RUN');const agrees=fn=>rows.every(r=>canonical(fn(r))===canonical(fn(rows[0])));return [field,{exactAgreement:agrees(r=>[r.status,r.value]),rubricLevelAgreement:agrees(r=>r.assessments?.filter(a=>a.state==='TRUE').map(a=>a.predicateId)??[]),reasonCodeAgreement:agrees(r=>r.reasonCodes),evidenceReferenceAgreement:agrees(r=>[...r.evidenceRefs].sort()),downstreamAffectingInstability:!agrees(r=>[r.status,r.value])}];}))};}
