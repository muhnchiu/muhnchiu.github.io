import {canonical,sha256} from '../radar-judgment/provider.mjs';
import {lockExecutionSet,executeLockedSet,assertExecutionReplay} from '../radar-score-action-closure/execution.mjs';
/** Canonical generator status is preserved; this receipt does not define new policy. */
export function closeRecord({eventKey,observationId,generated,registry,security,human,judgments,evidence,evaluatedAt}) {
  if(!eventKey||!observationId||!registry?.committed||registry.eventKey!==eventKey||registry.observationId!==observationId)throw Error('REGISTRY_STATE_REQUIRED');
  if(!['SCORE_READY','RECEIPT_ONLY'].includes(generated?.status))throw Error('UNEXPLAINED_PRODUCTION_RECORD_STATE');
  const ready=generated.status==='SCORE_READY';
  if(!ready&&(!generated.receiptOnlyReasons?.length||!generated.missingRequiredInputs?.length))throw Error('UNEXPLAINED_PRODUCTION_RECORD_STATE');
  if(ready&&security?.scoreEligible!==true)throw Error('SECURITY_GATE_BLOCKED');
  const receipt={eventKey,observationId,terminalStatus:generated.status,reasonCode:ready?'SCORE_READY':generated.receiptOnlyReasons[0],reasonCodes:ready?[]:generated.receiptOnlyReasons,blockingFields:generated.missingRequiredInputs,authorityState:{humanValidation:human.status,registry:'COMMITTED',judgment:judgments.map(j=>({field:j.field,status:j.status,reasonCodes:j.reasonCodes}))},evidenceState:{sourceCapture:'HASH_VERIFIED',rubricEvidence:judgments.every(j=>j.status==='JUDGMENT_READY')?'COMPLETE':'INCOMPLETE'},provenance:{registry,evidence},evaluatedAt,policyBinding:{score:'2.1.1',inputContract:'2.1.0',rubric:'1.0',security:'1.0.0',action:'2.1.0'},security,actionState:ready?'ACTION_EVALUATED':'ACTION_NOT_EVALUATED_DUE_TO_SCORE_STATE',scoreExecuted:false,actionExecuted:false};
  if(ready){const item={eventKey,observationId,source:evidence.sourceName,scoreInput:{inputs:generated.inputs,provenance:generated.provenance},registryState:registry,securityResult:security};const locked=lockExecutionSet([item]);const executed=executeLockedSet(locked);assertExecutionReplay(executed,executeLockedSet(locked));receipt.execution=executed;receipt.scoreExecuted=true;receipt.actionExecuted=true;}
  return {...receipt,receiptSha256:sha256(canonical(receipt))};
}
/** One attempt is the bounded retry policy: no fallback or automatic retry. Tests use isolated adapters. */
export async function auditedAttempt(stage,operation,{audit=[],identity={},now=()=>new Date().toISOString()}={}) {
  try{const value=await operation();audit.push({stage,...identity,attempt:1,status:'SUCCESS',evaluatedAt:now(),resultSha256:sha256(canonical(value))});return {ok:true,value};}
  catch(error){const code=error?.message||'EXECUTION_FAILED';audit.push({stage,...identity,attempt:1,status:'FAILED',reasonCode:code,evaluatedAt:now()});return {ok:false,terminalStatus:'RECEIPT_ONLY',reasonCode:code,actionState:'ACTION_NOT_EVALUATED_DUE_TO_SCORE_STATE',attempts:1};}
}
