import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {configureProductionAdapter} from '../radar-judgment/production-adapter.mjs';
import {FIELDS,PINS,canonical,sha256,responseSchema} from '../radar-judgment/provider.mjs';
import {time,lifecycle,signatureValid,fail} from '../radar-bootstrap/index.mjs';
import {fixtureBinding,validateAssessment} from './fixture.mjs';
import {durableNew,digest} from './store.mjs';
import {observeFetch,instrumentAdapter} from './timing.mjs';

const ajv=new Ajv({allErrors:true});addFormats(ajv);const schemaValid=ajv.compile(responseSchema);
const eq=(a,b)=>canonical(a)===canonical(b);
const ADAPTER_PATH=new URL('../radar-judgment/production-adapter.mjs',import.meta.url);

/** Frozen decision-table priority: transport unavailability precedes incomplete sample groups. */
export function classifyQualificationFailure(code){
  if(/STORE_|AUTHORITY_DRIFT/.test(code))return 'PROVIDER_CAPABILITY_BLOCKED';
  if(/AUDIT_|DISABLE_FAILED/.test(code))return 'PROVIDER_CAPABILITY_FAILED';
  if(code==='FAILED_SILENT_FALLBACK')return code;
  if(code==='BLOCKED_PROVIDER_VERSION_DRIFT')return code;
  if(/RUBRIC_BASELINE/.test(code))return 'BLOCKED_RUBRIC_VERSION_MISMATCH';
  if(/INPUT_DRIFT|FIXTURE_BINDING/.test(code))return 'BLOCKED_FIXTURE_BINDING_MISMATCH';
  if(code==='FIXTURE_APPROVAL_FAILURE')return 'BLOCKED_FIXTURE_NOT_APPROVED';
  if(/KILL_SWITCH|LOCK_UNAVAILABLE/.test(code))return 'PROVIDER_CAPABILITY_BLOCKED';
  if(['PROVIDER_TIMEOUT','PROVIDER_EXECUTION_FAILED','PROVIDER_CREDENTIALS_OR_CONFIGURATION_UNAVAILABLE'].includes(code))return 'BLOCKED_PROVIDER_UNAVAILABLE';
  if(code==='QUALIFICATION_STRUCTURED_RESPONSE_INVALID')return 'FAILED_SCHEMA';
  if(code==='QUALIFICATION_PROVENANCE_BINDING_INVALID')return 'FAILED_PROVENANCE';
  if(/PROOF_|ASSESSMENT_|RUBRIC_RESULT_|FAILED_EVIDENCE_BINDING/.test(code))return 'FAILED_EVIDENCE_BINDING';
  if(code==='FAILED_STABILITY')return 'FAILED_STABILITY';
  return 'PROVIDER_CAPABILITY_FAILED';
}

/** Real fetch pass-through: only public model/version identity and body hashes escape this observer. */
export function transportObserver(fetchImpl=fetch,timing=null){return observeFetch(fetchImpl,{timing});}

export async function currentTargets(provider,{authenticationBindingRevision}){
  if(typeof authenticationBindingRevision!=='string'||!authenticationBindingRevision)fail('MISSING_OWNER_SUPPLIED_AUTHENTICATION_BINDING_REVISION');
  return {providerTarget:{providerId:provider.adapter.id,adapterVersion:provider.adapter.version,adapterHash:sha256(await readFile(ADAPTER_PATH)),endpointClass:provider.metadata.api+':'+provider.metadata.endpointOrigin+provider.metadata.endpointPath,authenticationMechanism:'ANTHROPIC_MESSAGES_X_API_KEY',credentialSourceRef:'~/.openclaw/openclaw.json:models.providers.'+provider.adapter.id+'.apiKey',authenticationBindingRevision},modelTarget:{modelId:provider.adapter.modelId,observableVersionStatus:'UNOBSERVABLE',observableVersion:null,configurationFingerprint:provider.adapter.configFingerprint}};
}
function inputPayload(row,b,field,runId,rubric,at){const spec=rubric.fields.find(f=>f.field===field);
  const evidence=b.projectedEvidence[field].map(({bytes,validFrom,validUntil,...metadata})=>({...metadata,text:bytes}));
  return {runId,eventKey:b.eventKey,observationId:b.observationId,radar:'DEV',sourceFamily:'NON_PRODUCTION_QUALIFICATION',sourceIdentity:b.qualificationSampleId,observedAt:row.fixture.observedAt,normalizedCandidateFacts:row.fixture.normalizedCandidateFacts,rubricVersion:'1.0',rubricHash:PINS.payload,field,evidence,predicates:spec.levels,frozenRubric:rubric,evaluatedAt:at};
}
export function validateQualificationResponse(response,{payload,adapter,rows,spec}){
  if(!schemaValid(response)||response.conflictEvidenceRefs.length)fail('QUALIFICATION_STRUCTURED_RESPONSE_INVALID');
  const p=response.provenance,requestFingerprint=digest(payload);
  if(response.field!==payload.field||p.observationId!==payload.observationId||p.providerId!==adapter.id||p.providerVersion!==adapter.version||p.modelId!==adapter.modelId||p.configFingerprint!==adapter.configFingerprint||p.requestFingerprint!==requestFingerprint||p.evaluatedAt!==payload.evaluatedAt)fail('QUALIFICATION_PROVENANCE_BINDING_INVALID');
  validateAssessment({field:response.field,value:response.value,reasonCode:response.reasonCodes[0],assessments:response.assessments},payload.field,rows,spec);
  const used=[...new Set(response.assessments.flatMap(a=>a.proofs.map(p=>p.evidenceRef)))].sort();
  if(response.reasonCodes.length!==1||!eq(used,[...response.evidenceRefs].sort())||!eq([...p.evidenceRefs].sort(),used))fail('QUALIFICATION_PROOF_BINDING_INVALID');
  // Set order is immaterial; states, proof bindings, values and reasons remain exact.
  return {field:response.field,value:response.value,reasonCode:response.reasonCodes[0],assessments:response.assessments.map(a=>({...a,proofs:[...a.proofs].sort((a,b)=>canonical(a).localeCompare(canonical(b)))})).sort((a,b)=>a.predicateId.localeCompare(b.predicateId)),evidenceRefs:used,normalizedEvidence:rows};
}

export class QualificationRunner {
  constructor({service,providerFactory=configureProductionAdapter,fetchImpl=fetch,now=()=>new Date().toISOString(),fault=()=>{},timing=null}){this.timing=timing;this.service=service;this.store=service.store;this.rubric=service.rubric;this.providerFactory=providerFactory;this.fetchImpl=fetchImpl;this.now=now;this.fault=fault;}
  async preflight(sampleId,revision){
    const observer=transportObserver(this.fetchImpl,this.timing);let provider;this.timing?.mark('Q2','START');try{provider=instrumentAdapter(await this.providerFactory(undefined,{fetchImpl:observer.fetch}),this.timing);this.timing?.mark('Q2','END');this.timing?.mark('Q4');}catch{fail('PROVIDER_CREDENTIALS_OR_CONFIGURATION_UNAVAILABLE');}
    const targets=await currentTargets(provider,{authenticationBindingRevision:revision});const snapshot=await this.store.load();
    if(snapshot.state.control.state!=='DISABLED')fail('QUALIFICATION_KILL_SWITCH_NOT_DISABLED');
    const row=snapshot.state.fixtures.find(r=>r.qualificationSampleId===sampleId);if(!row)fail('FIXTURE_APPROVAL_FAILURE');
    const approval=await this.service.verify(sampleId,{targets});if(approval.verificationState!=='APPROVED_VERIFIED')fail(approval.reasonCodes.includes('APPROVAL_BINDING_MISMATCH')?'BLOCKED_PROVIDER_VERSION_DRIFT':'FIXTURE_APPROVAL_FAILURE');
    this.timing?.mark('Q1');const b=fixtureBinding(row.fixture,this.rubric);return {provider,observer,targets,row,b,approval,snapshot};
  }
  async run(sampleId,{authenticationBindingRevision,ownerId,keyId,resumeOriginalRunId=null}){
    this.timing?.mark('Q0');this.timing?.assertReady();
    return this.store.locked('NON_PRODUCTION_PROVIDER_QUALIFICATION',async()=>{
      const pre=await this.preflight(sampleId,authenticationBindingRevision),trust=await this.store.admin.load();
      const principal=trust.state.principals.find(p=>p.roleBindings.ownerId===ownerId),key=principal?.keys.find(k=>k.keyId===keyId),at=this.now();
      lifecycle(principal,at,{current:true});lifecycle(key,at,{current:true});if(!eq(principal.roles,['HORIZON_RADAR_OWNER'])||!eq(principal.scopes,['PROVIDER_QUALIFICATION_FIXTURE_APPROVAL']))fail('QUALIFICATION_ENABLEMENT_AUTHORIZATION_FAILED');
      const signer=this.store.signerFactory(keyId);if(await signer.public()!==key.publicKey)fail('QUALIFICATION_ENABLEMENT_AUTHENTICATION_FAILED');
      const grantId='pqgrant:'+randomUUID(),runNonce=randomUUID();
      const declaredBindings={...pre.targets,fixtureHash:pre.b.fixtureHash,approvalReceiptHash:digest(pre.row.approval),protocolVersion:'1.0',rubricHash:PINS.payload,schemaHash:digest(responseSchema),transportObserverHash:sha256(await readFile(new URL('./runner.mjs',import.meta.url))),outputValidatorHash:sha256(await readFile(new URL('./fixture.mjs',import.meta.url)))};
      const qualificationRunId='pq-run:sha256:'+digest({qualificationSampleId:sampleId,enablementGrantId:grantId,runNonce,declaredBindings});
      const priorRuns=pre.snapshot.state.runs.filter(r=>r.qualificationSampleId===sampleId);
      if(priorRuns.length&&!(this.timing&&priorRuns.length===1&&priorRuns[0].qualificationRunId===resumeOriginalRunId&&priorRuns[0].reasonCode==='PROVIDER_TIMEOUT'&&priorRuns[0].attemptedCalls===1&&priorRuns[0].validSamples===0))fail('QUALIFICATION_ALREADY_ATTEMPTED_NO_AUTOMATIC_RETRY');
      if(resumeOriginalRunId&&!priorRuns.length)fail('QUALIFICATION_RESUME_BASELINE_MISMATCH');
      const attemptId='pqattempt:'+randomUUID();
      // Clock begins before signing/setup; setup can reduce but never extend the frozen 60-second grant.
      const grant={type:'BOUNDED_NON_PRODUCTION_QUALIFICATION_ENABLEMENT',grantId,qualificationSampleId:sampleId,exactTargetBindingHash:digest(declaredBindings),protocolVersion:'1.0',fixtureApprovalHash:digest(pre.row.approval),notBefore:at,expiresAt:new Date(time(at)+60000).toISOString(),maxCalls:12,authorizedRunId:qualificationRunId,ownerId,keyId,attemptId,resumeOriginalRunId};
      const signedGrant={payload:grant,canonicalPayloadHash:digest(grant),signature:await signer.sign(Buffer.from(canonical(grant)))};
      if(!signatureValid(grant,signedGrant.signature,key.publicKey)||(await this.store.admin.load()).head!==trust.head)fail('QUALIFICATION_ENABLEMENT_AUTHENTICATION_FAILED');
      await mkdir(join(this.store.store,'runs'),{recursive:true,mode:0o700});
      const runDir=join(this.store.store,'runs',digest(qualificationRunId));await mkdir(runDir,{recursive:false,mode:0o700});
      await durableNew(join(runDir,'enablement.json'),signedGrant);
      const startState=structuredClone(pre.snapshot.state);startState.control={state:'ENABLED',grant:signedGrant,qualificationRunId};startState.audits.push({operation:'BOUNDED_QUALIFICATION_ENABLEMENT',qualificationRunId,grantHash:digest(signedGrant),createdAt:this.now()});await this.store.commit(startState,{principalId:principal.principalId,keyId});
      try {
      let terminalStatus='PROVIDER_CAPABILITY_BLOCKED',reasonCode=null,results=[],calls=[],previousAuditHash=null;
      const auditWrite=async(stage,path,value)=>{try{this.fault(stage);await durableNew(path,value);}catch{fail('QUALIFICATION_AUDIT_FAILURE');}};
      const first=new Map(),inputHashes=new Map();let controller=null;
      const assertEnabled=async()=>{
        const active=await this.store.load();const g=active.state.control;
        if(g.state!=='ENABLED'||g.qualificationRunId!==qualificationRunId||!eq(g.grant,signedGrant)||time(this.now())<time(grant.notBefore)||time(this.now())>=time(grant.expiresAt)||pre.observer.observed.length>=12)fail('QUALIFICATION_KILL_SWITCH_DISABLED_OR_EXPIRED');
        const t=await this.store.admin.load();if(t.head!==trust.head)fail('QUALIFICATION_AUTHORITY_DRIFT');
      };
      try{
        for(let groupIndex=1;groupIndex<=3;groupIndex++)for(const field of FIELDS){
          if(priorRuns.reduce((n,r)=>n+r.attemptedCalls,0)+calls.length>=12)fail('QUALIFICATION_TOTAL_SAMPLE_CALL_BUDGET_EXHAUSTED');
          await assertEnabled();const fresh=await this.providerFactory();const targets=await currentTargets(fresh,{authenticationBindingRevision});if(!eq(targets,pre.targets))fail('BLOCKED_PROVIDER_VERSION_DRIFT');
          const verify=await this.service.verify(sampleId,{targets});if(verify.verificationState!=='APPROVED_VERIFIED')fail('FIXTURE_APPROVAL_FAILURE');
          this.timing&&(this.timing.currentCall=calls.length+1);this.timing?.mark('Q5','START');
          const startedAt=this.now(),payload=inputPayload(pre.row,pre.b,field,qualificationRunId,this.rubric,startedAt),requestHash=digest(payload),semantic={...payload};delete semantic.evaluatedAt;
          this.timing?.mark('Q5','END',{requestHash});this.timing?.assertReady();
          if(inputHashes.has(field)&&inputHashes.get(field)!==digest(semantic))fail('QUALIFICATION_INPUT_DRIFT');inputHashes.set(field,digest(semantic));
          const callIndex=calls.length+1;const base={type:'NON_PRODUCTION_PROVIDER_QUALIFICATION_CALL',qualificationRunId,qualificationSampleId:sampleId,attemptId,resumeOriginalRunId,fixtureHash:pre.b.fixtureHash,evidenceFixtureHash:pre.b.evidenceFixtureHash,projectedEvidenceHash:pre.b.projectedEvidenceHash,projectionMapHash:pre.b.projectionMapHash,providerId:pre.targets.providerTarget.providerId,modelId:pre.targets.modelTarget.modelId,observableVersionStatus:pre.targets.modelTarget.observableVersionStatus,observableVersion:pre.targets.modelTarget.observableVersion,adapterVersion:pre.targets.providerTarget.adapterVersion,adapterHash:pre.targets.providerTarget.adapterHash,rubricId:pre.row.fixture.rubricId,rubricVersion:'1.0',rubricHash:PINS.payload,qualificationProtocolVersion:'1.0',groupIndex,field,attemptIndex:priorRuns.length+1,requestHash,startedAt,previousAuditHash};
          const prepared={...base,terminalStatus:'PREPARED',completedAt:null,responseHash:null,callDisposition:'OUTBOUND_NOT_YET_SENT'};await auditWrite('pre-call-audit',join(runDir,callIndex+'-prepared.json'),prepared);previousAuditHash=digest(prepared);
          controller=new AbortController();controller.signal.addEventListener('abort',()=>this.timing?.mark('Q22','POINT',{aborted:true}),{once:true});let timer,monitor,busy=false,response;const observedBefore=pre.observer.observed.length;
          try{
            monitor=setInterval(async()=>{if(busy)return;busy=true;try{const c=await this.store.load();if(c.state.control.state!=='ENABLED'||c.state.control.qualificationRunId!==qualificationRunId)controller?.abort();}catch{controller?.abort();}finally{busy=false;}},100);
            const remaining=Math.min(5000,time(grant.expiresAt)-time(this.now()));if(remaining<=0)fail('QUALIFICATION_KILL_SWITCH_DISABLED_OR_EXPIRED');
            response=await Promise.race([Promise.resolve().then(()=>pre.provider.adapter.execute(payload,{signal:controller.signal,requestFingerprint:requestHash})),new Promise((_,reject)=>{timer=setTimeout(()=>{this.timing?.mark('Q21');controller.abort();reject(Error('PROVIDER_TIMEOUT'));},remaining);})]);
            const observed=pre.observer.observed.at(-1);
            if(pre.observer.observed.length!==observedBefore+1)fail('QUALIFICATION_CALL_ACCOUNTING_INVALID');
            if((observed.modelId!==null&&observed.modelId!==pre.targets.modelTarget.modelId)||observed.observableVersionStatus!==pre.targets.modelTarget.observableVersionStatus||observed.observableVersion!==pre.targets.modelTarget.observableVersion)fail('BLOCKED_PROVIDER_VERSION_DRIFT');
            this.timing?.mark('Q18','START');const normalized=validateQualificationResponse(response,{payload,adapter:pre.provider.adapter,rows:pre.b.projectedEvidence[field],spec:this.rubric.fields.find(f=>f.field===field)});
            this.timing?.mark('Q18','END');this.timing?.assertReady();const expected=pre.row.fixture.expectedAssessment[field];
            if(first.has(field)&&!eq(first.get(field),normalized))fail('FAILED_STABILITY');
            if(normalized.value!==expected.value||normalized.reasonCode!==expected.reasonCode||!eq(normalized.assessments.map(a=>[a.predicateId,a.state]),[...expected.assessments].sort((a,b)=>a.predicateId.localeCompare(b.predicateId)).map(a=>[a.predicateId,a.state])))fail('FAILED_EVIDENCE_BINDING');
            first.set(field,normalized);this.timing?.mark('Q20');
            const complete={...base,previousAuditHash,terminalStatus:'VALID_SAMPLE',completedAt:this.now(),responseHash:digest(response),callDisposition:'COMPLETED_VALID_SAMPLE'};await auditWrite('post-call-audit',join(runDir,callIndex+'-completed.json'),complete);previousAuditHash=digest(complete);calls.push(complete);
            results.push({groupIndex,field,normalized,responseHash:digest(response),requestHash,generationConfidence:response.provenance.generationConfidence});
          }catch(error){const complete={...base,previousAuditHash,terminalStatus:error.message==='PROVIDER_TIMEOUT'?'PROVIDER_TIMEOUT':error.code??'PROVIDER_EXECUTION_FAILED',completedAt:this.now(),responseHash:response?digest(response):pre.observer.observed.length>observedBefore?(pre.observer.observed.at(-1)?.responseHash??null):null,callDisposition:'FAILED_OR_UNCERTAIN_CALL'};try{await auditWrite('post-call-audit',join(runDir,callIndex+'-failed.json'),complete);previousAuditHash=digest(complete);}catch{complete.terminalStatus='QUALIFICATION_AUDIT_FAILURE';complete.callDisposition='UNCERTAIN_CALL';}calls.push(complete);if(complete.terminalStatus==='QUALIFICATION_AUDIT_FAILURE')fail('QUALIFICATION_AUDIT_FAILURE');throw error;
          }finally{clearTimeout(timer);clearInterval(monitor);controller=null;}
        }
        // At completion budget is exhausted, so validate deadline and control without the pre-call budget guard.
        const final=await this.store.load();if(final.state.control.state!=='ENABLED'||time(this.now())>=time(grant.expiresAt)||calls.length!==12||results.length!==12||pre.observer.observed.length!==12)fail('QUALIFICATION_FINAL_GATE_FAILED');terminalStatus='PROVIDER_CAPABILITY_QUALIFIED';
      }catch(error){reasonCode=error.code??(error.message==='PROVIDER_TIMEOUT'?'PROVIDER_TIMEOUT':'PROVIDER_EXECUTION_FAILED');terminalStatus=classifyQualificationFailure(reasonCode);}
      finally{controller?.abort();}
      this.timing?.mark('Q25');this.timing&&(this.timing.currentCall=null);
      const outcome={qualificationRunId,qualificationSampleId:sampleId,attemptId,resumeOriginalRunId,timing:this.timing?.snapshot()??null,transport:pre.observer.observed,fixtureHash:pre.b.fixtureHash,declaredBindings,grantHash:digest(signedGrant),terminalStatus,reasonCode,attemptedCalls:pre.observer.observed.length,completedCalls:calls.filter(c=>c.responseHash!==null).length,validSamples:calls.filter(c=>c.terminalStatus==='VALID_SAMPLE').length,failedCalls:calls.filter(c=>c.terminalStatus!=='VALID_SAMPLE').length,auditRows:calls.length,productionModelCalls:0,productionRegistryWrites:0,results,calls,createdAt:this.now(),lastAuditHash:previousAuditHash};
      await auditWrite('final-audit',join(runDir,'run-terminal.json'),outcome);
      const current=await this.store.load();current.state.control={state:'DISABLED'};current.state.runs.push(outcome);current.state.audits.push({operation:'QUALIFICATION_TERMINAL_AND_DISABLE',qualificationRunId,outcomeHash:digest(outcome),createdAt:this.now()});await this.store.commit(current.state,{principalId:principal.principalId,keyId});
      if((await this.store.load()).state.control.state!=='DISABLED')fail('QUALIFICATION_DISABLE_FAILED');return outcome;
      } finally {
        // Audit/terminal write failure must not leave an executable enablement or permit a retry.
        const current=await this.store.load();
        if(current.state.control.state==='ENABLED'){
          current.state.control={state:'DISABLED'};
          if(!current.state.runs.some(r=>r.qualificationRunId===qualificationRunId))current.state.runs.push({qualificationRunId,qualificationSampleId:sampleId,terminalStatus:'QUALIFICATION_ABORTED_UNCERTAIN',attemptedCalls:pre.observer.observed.length,productionModelCalls:0,productionRegistryWrites:0});
          current.state.audits.push({operation:'QUALIFICATION_ABORT_AND_DISABLE',qualificationRunId,createdAt:this.now()});await this.store.commit(current.state,{principalId:principal.principalId,keyId});
        }
      }
    });
  }
  async callWhileDisabled(){const state=await this.store.load();if(state.state.control.state==='DISABLED')fail('QUALIFICATION_KILL_SWITCH_DISABLED');fail('EXPLICIT_BOUNDED_RUN_REQUIRED');}
}
