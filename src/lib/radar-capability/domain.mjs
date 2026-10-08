import {canonical} from '../radar-judgment/provider.mjs';
/** Frozen decision-table order; prerequisites are explicit, not inferred from zero judgments. */
export function domainDecision(predicates,rules){for(const [key,state]of rules){if(typeof predicates[key]!=='boolean')return {status:'BLOCKED_REVIEW_AUTHORITY_UNAVAILABLE',reasonCodes:['PREDICATE_UNAVAILABLE']};if(predicates[key])return {status:state,reasonCodes:[key]};}return {status:'PASS',reasonCodes:['EXACT_REFERENCE_MATCH']};}
export function zeroJudgmentState({realJudgments,mechanismReady,providerReady,populationComplete}){
 if(!mechanismReady||!providerReady||!populationComplete)return {status:'BLOCKED_REVIEW_AUTHORITY_UNAVAILABLE',reasonCodes:[!mechanismReady?'DOMAIN_EVALUATION_MECHANISM_NOT_QUALIFIED':!providerReady?'PROVIDER_EXECUTION_CAPABILITY_NOT_READY':'POPULATION_UNAVAILABLE']};
 return realJudgments===0?{status:'NOT_APPLICABLE_NO_REAL_JUDGMENT',reasonCodes:['KNOWN_ZERO_REAL_JUDGMENTS']}:{status:'REVIEW_REQUIRED',reasonCodes:['REAL_JUDGMENTS_REQUIRE_AUTHORIZED_REFERENCE']};
}
export function compareStructuredReference(judgments,references){
 const fields=['impact','actionability','confidence','novelty'];if(fields.some(f=>!judgments[f]||!references[f]))return {status:'INSUFFICIENT_EVIDENCE',reasonCodes:['INCOMPLETE_FOUR_FIELD_REFERENCE']};
 for(const f of fields){const j=judgments[f],r=references[f];if(j.field!==f||r.field!==f||j.status!=='JUDGMENT_READY'||r.status!=='JUDGMENT_READY'||j.conflictEvidenceRefs?.length||r.conflictEvidenceRefs?.length||!Array.isArray(j.assessments)||!Array.isArray(r.assessments))return {status:'INSUFFICIENT_EVIDENCE',reasonCodes:['INCOMPLETE_ASSESSMENT']};const states=x=>x.assessments.map(a=>[a.predicateId,a.state]).sort((a,b)=>a[0].localeCompare(b[0]));if(j.value!==r.value||canonical(j.reasonCodes)!==canonical(r.reasonCodes)||canonical(states(j))!==canonical(states(r)))return {status:'FAIL',reasonCodes:['SUPPORTED_REFERENCE_MISMATCH']};}
 return {status:'PASS',reasonCodes:['EXACT_REFERENCE_MATCH']};
}
/** Content comparator is only one component: never a production acceptance authority. */
export function domainMechanismReadiness({authorityReady,eligibilityReady,bindingReady,proofValidationReady,historyReady,auditReady}){
 const checks={authorityReady,eligibilityReady,bindingReady,proofValidationReady,historyReady,auditReady};const missing=Object.keys(checks).filter(k=>checks[k]!==true);return {status:missing.length?'BLOCKED':'READY',missing};
}
