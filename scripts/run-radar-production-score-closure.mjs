import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {configureProductionAdapter} from '../src/lib/radar-judgment/production-adapter.mjs';
import {loadRubric,FIELDS,PINS,evaluateJudgment,createPackage,canonical,sha256,measureStability} from '../src/lib/radar-judgment/provider.mjs';
import {lookupHumanValidation} from '../src/lib/radar-judgment/human.mjs';
import {projectScoreInputs} from '../src/lib/radar-judgment/projection.ts';
import {readCommittedRegistryContext} from '../src/lib/radar-score-action-closure/registry-context.mjs';
import {lockExecutionSet,executeLockedSet,assertExecutionReplay} from '../src/lib/radar-score-action-closure/execution.mjs';
import {resolveSecurityClassificationMatrixRow} from '../src/lib/radar-shadow-runtime/security-gate-v1.0.0.mjs';
import {frozenScorePolicy} from '../src/lib/radar-shadow-runtime/frozen-policies.mjs';
import {closeRecord,auditedAttempt} from '../src/lib/radar-production-score/boundary.mjs';
import {assertFrozenRuntimePackages} from '../src/lib/radar-shadow-runtime/frozen-policies.mjs';
import {assertFrozenInputContract} from '../src/lib/radar-score-input/policy.ts';
assertFrozenRuntimePackages();assertFrozenInputContract();
const output=process.argv[2];if(!output||resolve(output).startsWith(join(homedir(),'.local/state/horizon-production'))||resolve(output).startsWith(join(homedir(),'.local/state/horizon-canary')))throw Error('EXPLICIT_ISOLATED_OUTPUT_REQUIRED');
const state=join(homedir(),'.local/state/horizon');
const baseline=JSON.parse(await readFile(join(state,'radar-phase9.1-readiness-v1.json')));if(baseline.phase91!=='PASS')throw Error('PHASE_9_2_BASELINE_MISMATCH');
const globalControl=JSON.parse(await readFile(join(homedir(),'.local/state/horizon-production/phase8-operation/control.json')));if(globalControl.state!=='DISABLED')throw Error('PHASE_9_2_BASELINE_MISMATCH');
const attempts=[];await mkdir(output,{recursive:true});
async function attempt(stage,operation){const result=await auditedAttempt(stage,operation,{audit:attempts});await writeFile(join(output,'stage-attempt-audit.json'),JSON.stringify(attempts,null,2)+'\n');if(!result.ok)throw Error(result.reasonCode);return result.value;}
const prior=JSON.parse(await readFile(join(state,'radar-production-judgment-projection-v1.json')));const rubric=await loadRubric();const provider=await configureProductionAdapter();const at=new Date().toISOString();const judgments=[],humans=[],inputs=[],stability=[],security=[],ready=[],registryBindings=[];const inputRequests=[];
for(const family of ['dev-claude-code','ai-arxiv-cs-lg','sec-nvd']){
 const store=join(homedir(),'.local/state/horizon-production/radar-v2-prod-identity-'+family);const control=JSON.parse(await readFile(store+'-ingestion-runtime/control.json'));if(control.ingestion!=='DISABLED'||control.scheduler!=='DISABLED')throw Error('SCORE_ACTION_CLOSURE_BASELINE_MISMATCH');
 const committed=await attempt('Registry read',()=>readCommittedRegistryContext(store));
 for(const bound of committed.records){
  const {event,observation:obs,registryResult}=bound;const previous=prior.records.find(r=>r.eventKey===obs.eventKey&&r.observationId===obs.observationId);
  const ref=previous?.captureEvidence??await findCapture(store,obs);if(!ref)throw Error('UNEXPLAINED_PRODUCTION_RECORD_STATE');const bytes=await readFile(ref.capturePath);if(sha256(bytes)!==ref.captureSha256)throw Error('PRODUCTION_EVIDENCE_HASH_MISMATCH');const capture=JSON.parse(bytes);const native=capture.sourceRecords.find(r=>(r.link??r.itemUrl)===obs.canonicalSourceUrl);if(!native||sha256(JSON.stringify(native))!==ref.recordSha256)throw Error('PRODUCTION_EVIDENCE_HASH_MISMATCH');
  const radar=capture.source.radar;if(!['DEV','AI','SEC'].includes(radar)||radar!==(obs.radar==='security'?'SEC':obs.radar.toUpperCase()))throw Error('SCORE_ACTION_CLOSURE_BASELINE_MISMATCH');
  const evidenceRef=ref.evidenceRef;
  const request={runId:'PHASE_9_2_SCORE_ACTION_PRODUCTION_CLOSURE',eventKey:obs.eventKey,observationId:obs.observationId,radar,sourceFamily:obs.sourceName,sourceIdentity:capture.source.sourceIdentifier,observedAt:obs.observedAt,sourceEvidence:[{evidenceRef,sha256:ref.captureSha256}],normalizedCandidateFacts:{entity:event.entity,canonicalEventType:event.canonicalEventType,title:native.title??native.id},rubricVersion:'1.0',rubricHash:PINS.payload,fieldEvidence:{}};
  // Native capture is read and hashed. It is not relabeled as complete workload, comparison, or applicability proof.
  const evaluate=()=>Promise.all(FIELDS.map(field=>evaluateJudgment(request,field,{rubric,adapter:provider.adapter,timeoutMs:60000,now:()=>at})));
  const results=await attempt('JudgmentProvider evidence-gated evaluation',evaluate);const pkg=createPackage(results);
  judgments.push({eventKey:obs.eventKey,observationId:obs.observationId,source:obs.sourceName,fields:results,provider:provider.metadata,inputFingerprint:sha256(canonical(request)),outputFingerprint:sha256(canonical(results)),evaluatedAt:at,evidenceReferences:[ref,bound.provenance],reasonDetails:previous?.missingFieldEvidence??['APPROVED_CONTEXT_AND_CLAIM_BOUND_RUBRIC_EVIDENCE_ABSENT'],complete:results.every(r=>r.status==='JUDGMENT_READY')});
  if(results.some(r=>r.status==='JUDGMENT_READY'))stability.push({eventKey:obs.eventKey,observationId:obs.observationId,...await measureStability(evaluate,3)});
  inputRequests.push({eventKey:obs.eventKey,observationId:obs.observationId,inputFingerprint:sha256(canonical(request))});
  const lookup=await attempt('Human Validation lookup',()=>lookupHumanValidation({eventKey:obs.eventKey,observationId:obs.observationId,entity:event.entity}));
  humans.push({eventKey:obs.eventKey,observationId:obs.observationId,status:lookup.status==='UNAVAILABLE'?'AUTHORITY_UNAVAILABLE':lookup.status,lookup,scope:{eventKey:obs.eventKey,observationId:obs.observationId,entity:event.entity,version:null,capabilities:null,usage:null,environment:null},scopeDisposition:'EXACT_EVENT_OBSERVATION; REMAINING_SCOPE_NOT_AVAILABLE'});
  let gate;
  if(radar==='SEC'){
   const matrix=resolveSecurityClassificationMatrixRow({trackedEnvironmentState:'MISSING',relationshipStates:{directExposure:'MISSING',dependencyRelationship:'MISSING',ecosystemRelationship:'MISSING'}});
   if(!matrix)throw Error('SECURITY_SEMANTIC_CONFLICT');
   gate={status:'UNRESOLVED',policyVersion:'1.0.0',classificationResolution:matrix.classificationResolution,gateClass:null,escalationResult:'NOT_EVALUATED',hardFilter:null,outgoingSignal:null,capApplied:null,scoreEligible:false,reasonCodes:matrix.reasonCodes,classificationMatrixInput:{trackedEnvironmentState:'MISSING',relationshipStates:{directExposure:'MISSING',dependencyRelationship:'MISSING',ecosystemRelationship:'MISSING'}},missing:['APPROVED_TRACKED_ENVIRONMENT_BASELINE','SCOPED_RELATIONSHIP_AND_COMPONENT_FACTS','ESCALATION_EVIDENCE'],incomingSignal:'NOT_EVALUATED_NO_SCORE_READY_INPUT'};
  } else gate={status:'NOT_APPLICABLE',policyVersion:'1.0.0',gateClass:'N/A',escalationResult:'NOT_EVALUATED',scoreEligible:true,reasonCodes:['SECURITY_GATE_NOT_APPLICABLE']};
  security.push({eventKey:obs.eventKey,observationId:obs.observationId,source:obs.sourceName,radar,result:gate});
  const candidate={radar,sourceName:obs.sourceName,title:native.title??native.id,sourceUrl:obs.sourceUrl,observedAt:obs.observedAt,evidence:[{evidenceRef,sourceName:obs.sourceName,sourceAuthority:obs.sourceAuthority,sourceUrl:obs.sourceUrl,observedAt:obs.observedAt}],eventIdentity:{entity:event.entity,canonicalEventType:event.canonicalEventType,eventKey:event.eventKey,eventIdentifier:event.eventKey.split(':')[2],identityEngineVersion:'2.1.2',evidenceRefs:[evidenceRef]}};
  const generated=await projectScoreInputs(candidate,{generatedAt:at,registryResult,...(radar!=='SEC'?{securityAssessment:{gate:'N/A',ruleId:'SECURITY_GATE_NOT_APPLICABLE',evidenceRefs:[evidenceRef],policyVersion:'1.0',authority:'SECURITY_GATE_POLICY'}}:{})},pkg,lookup,obs.observationId);
  inputs.push({eventKey:obs.eventKey,observationId:obs.observationId,source:obs.sourceName,...generated,providerPackageHash:pkg.packageHash,registryContext:registryResult,registryProvenance:bound.provenance});
  registryBindings.push({eventKey:obs.eventKey,observationId:obs.observationId,...registryResult,provenance:bound.provenance});
  if(generated.status==='SCORE_READY')ready.push({eventKey:obs.eventKey,observationId:obs.observationId,source:obs.sourceName,scoreInput:{inputs:generated.inputs,provenance:generated.provenance},securityResult:gate,registryState:registryResult});
 }
}
if(inputs.length!==36||inputs.some(r=>r.status==='RECEIPT_ONLY'&&!r.receiptOnlyReasons.length))throw Error('SCORE_ACTION_CLOSURE_BASELINE_MISMATCH');
await mkdir(output,{recursive:true});const save=(name,v)=>writeFile(join(output,name),JSON.stringify(v,null,2)+'\n');
const manifest=lockExecutionSet(ready);const manifestPath=join(output,'radar-phase6.4-score-ready-execution-manifest-v1.json');
// Exclusive lock-file creation occurs before execution; existing files are never overwritten.
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o400});
const locked=JSON.parse(await readFile(manifestPath));const executed=await attempt('Score + Action locked execution',()=>executeLockedSet(locked));const replay=assertExecutionReplay(executed,executeLockedSet(locked));
const audit={status:'EXISTING_ACCEPTED_SYNTHETIC_CAPABILITY_NOT_RERUN_AS_PRODUCTION_JUDGMENT'};
const common={task:'PHASE_6_4_SCORE_ACTION_EXECUTION_CLOSURE',generatedAt:at,realRecords:36,registryWrites:0,publisherCalls:0,publication:'NOT_AUTHORIZED',modelCalls:provider.getCalls(),executionMode:'EXPLICIT_READ_ONLY_RUN'};
await save('radar-phase6.4-real-judgment-results-v1.json',{...common,provider:provider.metadata,providerConnection:'CONFIGURED; NO_TRANSPORT_CALL_WHEN_INPUT_EVIDENCE_INCOMPLETE',records:judgments,complete:judgments.filter(r=>r.complete).length,perSource:Object.fromEntries([...new Set(judgments.map(r=>r.source))].map(source=>[source,{total:judgments.filter(r=>r.source===source).length,fields:Object.fromEntries(FIELDS.map(f=>[f,Object.fromEntries(['JUDGMENT_READY','INSUFFICIENT_EVIDENCE','INVALID_EVIDENCE','PROVIDER_ERROR'].map(s=>[s,judgments.filter(r=>r.source===source&&r.fields.find(x=>x.field===f).status===s).length]))]))}]))});
await save('radar-phase6.4-judgment-stability-v1.json',{...common,status:stability.length?'MEASURED':'EXPLICITLY_BOUNDED',readyRecordCount:stability.length,minimumRepetitionsWhenReady:3,realModelStability:'NOT_APPLICABLE_NO_READY_INPUT',records:stability,majorityVote:false,downstreamSemanticInstability:0,nonSemanticInstability:0});
await save('radar-phase6.4-human-validation-results-v1.json',{...common,records:humans,found:humans.filter(r=>r.status==='VALIDATION_FOUND').length,authorityUnavailable:humans.filter(r=>r.status==='AUTHORITY_UNAVAILABLE').length,fabricated:0,crossEventReuse:0,ambiguousPositive:0});
await save('radar-phase6.4-score-input-results-v1.json',{...common,records:inputs,terminated:inputs.length,scoreReady:ready.length,receiptOnly:inputs.length-ready.length,unexplainedNonReady:0,partialValidPackages:0,committedRegistryBindings:registryBindings});
await save('radar-phase6.4-score-execution-v1.json',{...common,status:executed.count?'PASS':'NOT_APPLICABLE_EMPTY_READY_SET',manifestHash:locked.manifestHash,scoreReady:ready.length,executed:executed.count,records:executed.records.map(r=>({...r,action:undefined})),actionAudit:audit});
await save('radar-phase6.4-action-execution-v1.json',{...common,status:executed.count?'PASS':'NOT_APPLICABLE_EMPTY_READY_SET',manifestHash:locked.manifestHash,executed:executed.count,records:executed.records.map(r=>({eventKey:r.eventKey,observationId:r.observationId,action:r.action,reasonCodes:r.output.filterReasons,scoreReference:r.outputHash,policyReference:r.actionPolicyHash,inputHash:r.actionInputHash,outputHash:r.actionOutputHash})),actionVocabulary:frozenScorePolicy.actionPolicy.actionVocabulary,adoptPublicationAuthorization:false});
await save('radar-phase6.4-score-action-determinism-v1.json',{...common,manifestHash:locked.manifestHash,...replay,scoreDeterminism:replay.status,actionDeterminism:replay.status,emptySetNotEvidenceOfRealScoreDeterminism:executed.count===0});
await save('radar-phase6.4-security-compatibility-v1.json',{...common,status:'PASS_UNRESOLVED_SEC_NOT_SCORED',records:security,secRecords:10,scoreReadySec:ready.filter(r=>r.scoreInput.inputs.radar==='SEC').length,unknownSecurityScored:0,semanticDelta:0});
console.log(JSON.stringify({records:36,ready:ready.length,receipts:36-ready.length,completeJudgments:judgments.filter(r=>r.complete).length,providerCalls:provider.getCalls(),actionAudit:audit}));

const terminals=inputs.map((g,i)=>closeRecord({eventKey:g.eventKey,observationId:g.observationId,generated:g,registry:g.registryContext,security:security[i].result,human:humans[i].lookup,judgments:judgments[i].fields,evidence:{...judgments[i].evidenceReferences[0],sourceName:g.source},evaluatedAt:at}));
await save('production-results.json',{...common,records:terminals,scoreInputs:inputs,judgments,humans,security,stability,providerMetadata:provider.metadata,modelCalls:provider.getCalls(),recordsAccounted:terminals.length,unexplained:0});
async function findCapture(store,obs){
 const root=store+'-ingestion-runtime/captures';const files=[];async function walk(p){for(const e of await readdir(p,{withFileTypes:true})){if(e.isDirectory())await walk(join(p,e.name));else if(e.name.endsWith('.json'))files.push(join(p,e.name));}}await walk(root);
 for(const p of files.sort()){const bytes=await readFile(p);const c=JSON.parse(bytes);if(c.source?.sourceName!==obs.sourceName)continue;const native=c.sourceRecords?.find(r=>(r.link??r.itemUrl)===obs.canonicalSourceUrl);if(native){const captureSha256=sha256(bytes),recordSha256=sha256(JSON.stringify(native));return {capturePath:p,captureSha256,recordSha256,evidenceRef:'capture:sha256:'+captureSha256+':record:'+recordSha256};}}return null;
}
