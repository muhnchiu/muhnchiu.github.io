import { generateScoreInputs, type StructuredCandidate, type GenerationContext } from '../radar-score-input/generator.ts';
import { FIELDS, replayPackage } from './provider.mjs';
import { toPriorValidationLookup } from './human.mjs';
/** Projection never imports or invokes dispatchGeneratedScore. */
export async function projectScoreInputs(candidate: StructuredCandidate, context: GenerationContext, pkg: any, humanLookup: any, observationId: string) {
  const results = replayPackage(pkg);
  return generateScoreInputs(candidate, {...context,priorValidationLookup:toPriorValidationLookup(humanLookup,candidate)}, request => {
    if(!FIELDS.includes(request.field)) return undefined;
    const row=results.find((r:any)=>r.field===request.field);
    if(row?.status!=='JUDGMENT_READY'||row.binding.eventKey!==candidate.eventIdentity?.eventKey||row.binding.observationId!==observationId||row.binding.evidence.some((e:any)=>e.observedAt!==candidate.observedAt||!candidate.evidence.some(c=>c.evidenceRef===e.evidenceRef&&(e.kind!=='SOURCE_FACT'||(c.sourceAuthority===e.sourceAuthority&&c.sourceUrl===e.sourceUrl))))||row.provenance.evidenceRefs.some((ref:string)=>!candidate.evidence.some(e=>e.evidenceRef===ref))) return undefined;
    return {value:row.value,rubricVersion:'1.0',authority:'SCORE_INPUT_RUBRIC_1.0',modelId:row.provenance.modelId,provider:row.provenance.providerId,generationConfigRef:row.provenance.configFingerprint,generationConfidence:row.provenance.generationConfidence,evidenceRefs:row.evidenceRefs};
  });
}
