import {readFile} from 'node:fs/promises';
import {scoreActionForTesting} from '../radar-shadow-runtime/score-evaluator-v2.1.1.mjs';
import {frozenActionPolicy,assertFrozenRuntimePackages} from '../radar-shadow-runtime/frozen-policies.mjs';
import {verifyActionSpace} from '../../../scripts/verify-score-policy-v2.1-actions.mjs';
import {sha256} from '../radar-judgment/provider.mjs';
export async function auditFrozenActionRuntime(){
 assertFrozenRuntimePackages();const path=new URL('../../../fixtures/radar-score-input/action-space/exhaustive-delta-analysis-v2.1.json',import.meta.url);const bytes=await readFile(path);const fixture=JSON.parse(bytes);const mapping=frozenActionPolicy.eventClassMapping.futureContract21Adapter;
 let passed=0,adopt=0;for(const row of fixture.rows){const x=Object.fromEntries(fixture.columns.map((c,i)=>[c,row[i]]));const eventType=x.eventClass==='FIRST_DISCOVERY'?mapping.FIRST_DISCOVERY[0]:x.eventClass==='VERSION_RELEASE'?mapping.VERSION_RELEASE[0]:'documentation';const result=scoreActionForTesting(x.signal,{...x,eventType});if(result!==x.revisedCandidateAction)throw Error('UNEXPECTED_POLICY_DELTA');passed++;if(result==='adopt')adopt++;}
 const audit=await verifyActionSpace();if(passed!==48384||adopt!==8||audit.intentionalSemanticDelta!==288||audit.unknownDelta||audit.unintendedDelta)throw Error('UNEXPECTED_POLICY_DELTA');return {...audit,directFrozenRuntimePassed:passed,directFrozenRuntimeAdopt:adopt,auditFixtureSha256:sha256(bytes),accounting:'APPROVED_48384_SURFACE; DISTINCT_HISTORICAL_BASELINE_DELTAS_RETAINED'};
}
