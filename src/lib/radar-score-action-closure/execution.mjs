import {canonical,sha256} from '../radar-judgment/provider.mjs';
import {resolveScoreInputEligibility} from '../radar-score-input/eligibility.ts';
import {evaluateScorePolicy211} from '../radar-shadow-runtime/score-evaluator-v2.1.1.mjs';
import {assertFrozenRuntimePackages,frozenScorePolicy,frozenActionPolicy,frozenScoreManifest,frozenSecurityPolicy} from '../radar-shadow-runtime/frozen-policies.mjs';
const digest=v=>sha256(canonical(v));
const policyHash=frozenScoreManifest.artifacts.find(a=>a.path==='radar-score-policy-v2.1.1.json').sha256;
const actionHash=frozenScoreManifest.artifacts.find(a=>a.path==='radar-action-decision-policy-v2.1.0.json').sha256;
export function validateExecutionItem(item){
  if(!item?.eventKey||!item.observationId||!item.source||!item.scoreInput?.inputs||!item.scoreInput.provenance)throw Error('SCORE_INPUT_INCOMPLETE');
  const {inputs,provenance}=item.scoreInput;
  if(resolveScoreInputEligibility(item.scoreInput).status!=='SCORE_READY')throw Error('SCORE_INPUT_INCOMPLETE');
  if(Object.entries(inputs).some(([field,value])=>canonical(provenance[field]?.value)!==canonical(value)))throw Error('SCORE_POLICY_INPUT_MISMATCH');
  const r=item.registryState;
  if(r?.committed!==true||r.registryWriteStatus!=='COMMITTED'||r.eventKey!==item.eventKey||r.observationId!==item.observationId||!r.transactionId||!['NEW','DUPLICATE','UPDATE'].includes(r.eventState)||typeof r.duplicate!=='boolean')throw Error('REGISTRY_STATE_MISMATCH');
  if(r.duplicate!==(r.eventState==='DUPLICATE')||inputs.duplicate!==r.duplicate)throw Error('DUPLICATE_STATE_MISMATCH');
  if(inputs.entity!==item.eventKey.split(':')[0]||inputs.eventType!==item.eventKey.split(':')[1])throw Error('REGISTRY_STATE_MISMATCH');
  const s=item.securityResult;
  if(String(inputs.radar).toUpperCase()==='SEC'&&(!frozenActionPolicy.input.required.signal.enum.includes(s?.outgoingSignal)||typeof s?.hardFilter!=='boolean'||!((s?.status==='RESOLVED'&&s?.classificationResolution==='RESOLVED'&&frozenSecurityPolicy.classification.classes.includes(s?.gateClass))||(s?.status==='NOT_APPLICABLE'&&s?.classificationResolution==='NOT_APPLICABLE'&&s?.gateClass==='N/A'&&s?.policyVersion==='1.0.0'&&s?.reasonCodes?.includes('SECURITY_GATE_NOT_APPLICABLE')))))throw Error('SECURITY_UNRESOLVED');
  if(!s||String(inputs.radar).toUpperCase()==='SEC'&&(!['RESOLVED','NOT_APPLICABLE'].includes(s.status)||!s.scoreEligible||inputs.securityGate!==s.gateClass)||String(inputs.radar).toUpperCase()!=='SEC'&&(s.status!=='NOT_APPLICABLE'||inputs.securityGate!=='N/A'))throw Error('SECURITY_UNRESOLVED');
  return true;
}
export function lockExecutionSet(items){
  assertFrozenRuntimePackages();const cloned=structuredClone(items);const seen=new Set();
  for(const item of cloned){validateExecutionItem(item);const id=item.eventKey+'@'+item.observationId;if(seen.has(id))throw Error('DUPLICATE_EXECUTION_IDENTITY');seen.add(id);}
  const records=cloned.map(item=>({...item,scoreInputHash:digest(item.scoreInput.inputs),provenanceHash:digest(item.scoreInput.provenance),securityHash:digest(item.securityResult),registryHash:digest(item.registryState)}));
  const payload={manifestVersion:'1.0',status:'LOCKED',policyVersion:'2.1.1',policyHash,actionPolicyHash:actionHash,count:records.length,records};
  return JSON.parse(canonical({...payload,manifestHash:digest(payload)}));
}
export function executeLockedSet(manifest){
  assertFrozenRuntimePackages();const {manifestHash,...payload}=manifest;
  if(manifestHash!==digest(payload)||payload.manifestVersion!=='1.0'||Object.keys(payload).some(k=>!['manifestVersion','status','policyVersion','policyHash','actionPolicyHash','count','records'].includes(k))||payload.status!=='LOCKED'||payload.policyVersion!=='2.1.1'||payload.policyHash!==policyHash||payload.actionPolicyHash!==actionHash||payload.count!==payload.records?.length)throw Error('EXECUTION_MANIFEST_INTEGRITY_INVALID');
  // Validate the whole immutable set before any Score/Action execution.
  const seen=new Set();
  for(const r of payload.records){const identity=r.eventKey+'@'+r.observationId;if(seen.has(identity))throw Error('DUPLICATE_EXECUTION_IDENTITY');seen.add(identity);validateExecutionItem(r);if(r.scoreInputHash!==digest(r.scoreInput.inputs)||r.provenanceHash!==digest(r.scoreInput.provenance)||r.securityHash!==digest(r.securityResult)||r.registryHash!==digest(r.registryState))throw Error('EXECUTION_INPUT_CORRUPTED');}
  const records=payload.records.map(r=>{const output=evaluateScorePolicy211({...r.scoreInput,securityGateResult:r.securityResult});if(output.status!=='SCORED')throw Error('SCORE_POLICY_INPUT_MISMATCH');if(!frozenScorePolicy.actionPolicy.actionVocabulary.includes(output.policyAction))throw Error('UNKNOWN_ACTION_SEMANTIC');return {eventKey:r.eventKey,observationId:r.observationId,source:r.source,inputHash:r.scoreInputHash,provenanceHash:r.provenanceHash,policyVersion:'2.1.1',policyHash:payload.policyHash,score:output.finalScore,signal:output.signal,modifiers:{radarModifier:output.radarModifier,components:output.modifierComponents,directBonus:output.directBonus},hardFilter:output.filtered,reasonCodes:output.filterReasons,securityResult:output.securityGate,action:output.policyAction,actionPolicyHash:payload.actionPolicyHash,actionInputHash:digest({scoreReference:digest(output),inputs:r.scoreInput.inputs,policyHash:payload.actionPolicyHash}),actionOutputHash:digest({action:output.policyAction,reasonCodes:output.filterReasons,policyVersion:frozenActionPolicy.policyVersion,policyHash:payload.actionPolicyHash,scoreReference:digest(output)}),outputHash:digest(output),output};});
  return {manifestHash,records,count:records.length,scoreCalls:records.length,actionCalls:records.length,publisherCalls:0,registryWrites:0};
}
export function assertExecutionReplay(left,right){if(canonical(left)!==canonical(right))throw Error('EXECUTION_REPLAY_MISMATCH');return {scoreMismatches:0,actionMismatches:0,status:left.count?'PASS':'NOT_APPLICABLE'};}
