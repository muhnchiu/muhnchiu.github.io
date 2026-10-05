import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {loadRubric,evaluateJudgment,FIELDS,PINS,sha256,createPackage,measureStability} from '../src/lib/radar-judgment/provider.mjs';
import {lookupHumanValidation} from '../src/lib/radar-judgment/human.mjs';
import {projectScoreInputs} from '../src/lib/radar-judgment/projection.ts';
// Explicit output directory only. Production files are read; no ingestion, Registry writer or Score dispatcher is imported.
const output=process.argv[2];if(output&&resolve(output).startsWith(join(homedir(),'.local/state/horizon-production')))throw Error('PRODUCTION_OUTPUT_NOT_AUTHORIZED');if(!output)throw Error('EXPLICIT_ISOLATED_OUTPUT_DIRECTORY_REQUIRED');
const state=join(homedir(),'.local/state/horizon');const baseline=JSON.parse(await readFile(join(state,'radar-score-rubric-normative-closure-production-projection-v1.json')));
const rubric=await loadRubric();const generatedAt=new Date().toISOString();const providerRows=[],scoreRows=[],lookupRows=[],stability=[];const registryHashes=[];
const observations=[];const events=[];
for(const family of ['dev-claude-code','ai-arxiv-cs-lg','sec-nvd']){
 const store=join(homedir(),'.local/state/horizon-production/radar-v2-prod-identity-'+family);
 for(const [filename,target]of [['radar-event-registry.jsonl',events],['radar-observation-registry.jsonl',observations]]){const bytes=await readFile(join(store,filename));registryHashes.push({path:join(store,filename),sha256:sha256(bytes)});target.push(...bytes.toString().trim().split('\n').map(JSON.parse));}
 const control=JSON.parse(await readFile(store+'-ingestion-runtime/control.json'));if(control.ingestion!=='DISABLED'||control.scheduler!=='DISABLED')throw Error('PRODUCTION_CONTROL_BASELINE_DRIFT');
}
if(events.length!==30||observations.length!==30)throw Error('PRODUCTION_BASELINE_DRIFT');
for(const obs of observations){
 const event=events.find(e=>e.eventKey===obs.eventKey);if(!event||!event.observationIds.includes(obs.observationId))throw Error('REGISTRY_INTEGRITY_FAILED');
 const prior=baseline.records.find(r=>r.eventKey===obs.eventKey&&r.observationId===obs.observationId);if(!prior?.currentNativeCaptureEvidence?.length)throw Error('CAPTURE_REFERENCE_MISSING');
 const captureRef=prior.currentNativeCaptureEvidence[0];const captureBytes=await readFile(captureRef.capturePath);if(sha256(captureBytes)!==captureRef.captureSha256)throw Error('CAPTURE_HASH_MISMATCH');const capture=JSON.parse(captureBytes);
 const native=capture.sourceRecords.find(r=>(r.link??r.itemUrl)===obs.canonicalSourceUrl);if(!native||sha256(JSON.stringify(native))!==captureRef.recordSha256)throw Error('NATIVE_RECORD_HASH_MISMATCH');
 const evidenceRef='capture:sha256:'+captureRef.captureSha256+':record:'+captureRef.recordSha256;
 const request={runId:'READ_ONLY_PRODUCTION_JUDGMENT_PROJECTION_V1',eventKey:obs.eventKey,observationId:obs.observationId,radar:obs.radar.toUpperCase(),sourceFamily:obs.sourceName,sourceIdentity:capture.source.sourceIdentifier,sourceEvidence:[{evidenceRef,sha256:captureRef.captureSha256}],normalizedCandidateFacts:{entity:event.entity,canonicalEventType:event.canonicalEventType,title:native.title??native.id},observedAt:obs.observedAt,rubricVersion:'1.0',rubricHash:PINS.payload,fieldEvidence:{}};
 const run=()=>Promise.all(FIELDS.map(field=>evaluateJudgment(request,field,{rubric})));const judgments=await run();
 const human=await lookupHumanValidation({eventKey:obs.eventKey,observationId:obs.observationId,entity:event.entity});
 const candidate={radar:request.radar,sourceName:obs.sourceName,title:native.title??native.id,sourceUrl:obs.sourceUrl,observedAt:obs.observedAt,evidence:[{evidenceRef,sourceName:obs.sourceName,sourceAuthority:obs.sourceAuthority,sourceUrl:obs.sourceUrl,observedAt:obs.observedAt}],eventIdentity:{entity:event.entity,canonicalEventType:event.canonicalEventType,eventKey:event.eventKey,eventIdentifier:event.eventKey.split(':')[2],identityEngineVersion:'1.0',evidenceRefs:[evidenceRef]}};
 const projection=await projectScoreInputs(candidate,{generatedAt},createPackage(judgments),human,obs.observationId);
 providerRows.push({eventKey:obs.eventKey,observationId:obs.observationId,sourceName:obs.sourceName,captureEvidence:{...captureRef,evidenceRef},judgments,complete:judgments.every(j=>j.status==='JUDGMENT_READY'),missingFieldEvidence:prior.missingFieldEvidence});
 lookupRows.push({eventKey:obs.eventKey,observationId:obs.observationId,...human});
 scoreRows.push({eventKey:obs.eventKey,observationId:obs.observationId,...projection});
 stability.push({eventKey:obs.eventKey,observationId:obs.observationId,...await measureStability(run,3)});
}
for(const a of registryHashes)if(sha256(await readFile(a.path))!==a.sha256)throw Error('PRODUCTION_STATE_MUTATION');
await mkdir(output,{recursive:true});
const common={mode:'READ_ONLY_PROJECTION',generatedAt,registryWrites:0,scoreExecution:'NOT_RUN',actionExecution:'NOT_RUN',publication:'NOT_AUTHORIZED',rubricHash:PINS.payload};
const outputs={
 'radar-production-judgment-projection-v1.json':{...common,records:providerRows,fieldReady:Object.fromEntries(FIELDS.map(f=>[f,providerRows.filter(r=>r.judgments.find(j=>j.field===f).status==='JUDGMENT_READY').length])),completeJudgments:providerRows.filter(r=>r.complete).length,providerCompleteHumanBlocked:0,otherEvidenceBlocked:30,registryHashes},
 'radar-human-validation-lookup-v1.json':{...common,records:lookupRows,found:lookupRows.filter(r=>r.status==='VALIDATION_FOUND').length,productionAuthorityConfiguration:'UNAVAILABLE',globalValidRecordCount:'UNKNOWN_NOT_QUERIED'},
 'radar-score-input-readiness-projection-v1.json':{...common,records:scoreRows,scoreReady:scoreRows.filter(r=>r.status==='SCORE_READY').length,receiptOnly:scoreRows.filter(r=>r.status==='RECEIPT_ONLY').length,unexplainedNonReady:scoreRows.filter(r=>r.status!=='SCORE_READY'&&!r.receiptOnlyReasons.length).length},
 'radar-judgment-provider-stability-v1.json':{...common,repetitions:3,scope:'30 fixed captured records; fail-closed evidence availability repeated',modelCalls:0,realModelStability:'NOT_MEASURED_NO_CONFIGURED_MODEL_OR_COMPLETE_INPUT',records:stability,downstreamAffectingInstability:stability.filter(r=>FIELDS.some(f=>r.fields[f].downstreamAffectingInstability)).length}
};
for(const [name,value]of Object.entries(outputs))await writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
console.log(JSON.stringify({records:30,completeJudgments:outputs['radar-production-judgment-projection-v1.json'].completeJudgments,scoreReady:outputs['radar-score-input-readiness-projection-v1.json'].scoreReady,output:resolve(output)}));
