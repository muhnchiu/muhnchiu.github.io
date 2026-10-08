import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setup} from './radar-qualification-test-support.mjs';
import {configureProductionAdapter} from '../src/lib/radar-judgment/production-adapter.mjs';
import {QualificationRunner,currentTargets,transportObserver,validateQualificationResponse,classifyQualificationFailure} from '../src/lib/radar-qualification/runner.mjs';
import {QualificationTiming} from '../src/lib/radar-qualification/timing.mjs';
import {PINS,sha256} from '../src/lib/radar-judgment/provider.mjs';

async function fixture({mode='valid',fault=null,timing=null}={}){
  const configDir=await mkdtemp(join(tmpdir(),'horizon-qualification-config-test-')),configPath=join(configDir,'config.json');
  await writeFile(configPath,JSON.stringify({agents:{defaults:{model:{primary:'ISOLATED_TEST/ISOLATED_MODEL'}}},models:{providers:{ISOLATED_TEST:{api:'anthropic-messages',apiKey:'ISOLATED_FAKE_CREDENTIAL_NOT_REAL',baseUrl:'https://fixture.invalid/v1',models:[{id:'ISOLATED_MODEL'}]}}}}));
  const provider=await configureProductionAdapter(configPath);const targets=await currentTargets(provider,{authenticationBindingRevision:'ISOLATED_TEST_REVISION'});
  const f=await setup(targets);await f.review();await f.approve();let attempted=0;
  const fetchImpl=async(url,opts)=>{
    attempted++;assert.equal(new URL(url).hostname,'fixture.invalid');
    if(mode==='transport')throw Error('ISOLATED_TRANSPORT_FAILURE');
    if(mode==='timeout')return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('ISOLATED_ABORT')), {once:true}));
    const context=JSON.parse(JSON.parse(opts.body).messages[0].content),expected=f.fixture.expectedAssessment[context.field];
    assert.equal(context.expectedAssessment,undefined);assert(!JSON.stringify(context).includes('"expectedAssessment"'));
    let response={field:context.field,value:expected.value,status:'JUDGMENT_READY',reasonCodes:[expected.reasonCode],evidenceRefs:f.fixture.evidenceFixture[context.field].map(e=>e.evidenceRef),conflictEvidenceRefs:[],provenance:{providerId:context.providerMetadata.providerId,providerVersion:context.providerMetadata.providerVersion,modelId:context.providerMetadata.modelId,rubricVersion:'1.0',rubricHash:PINS.payload,observationId:context.observationId,evaluatedAt:context.evaluatedAt,configFingerprint:context.providerMetadata.configFingerprint,requestFingerprint:context.providerMetadata.requestFingerprint,evidenceRefs:f.fixture.evidenceFixture[context.field].map(e=>e.evidenceRef),generationConfidence:0.9},assessments:structuredClone(expected.assessments)};
    if(mode==='schema')response.extra=true;
    if(mode==='provenance')response.provenance.requestFingerprint='0'.repeat(64);
    if(mode==='proof')response.assessments[0].proofs[0].sha256='0'.repeat(64);
    if(mode==='stability'&&attempted===5){response.assessments.find(a=>a.state==='TRUE').state='FALSE';response.assessments[1].state='TRUE';response.value=1;response.reasonCodes=['IMPACT_VALUE_1'];}
    const raw={stop_reason:'tool_use',content:[{type:'tool_use',name:'submit_judgment',input:response}]};
    if(mode==='model')raw.model='DIFFERENT_MODEL';
    if(mode==='version')raw.model_version='NEW_OBSERVABLE_VERSION';
    return new Response(JSON.stringify(raw),{status:200,headers:{'content-type':'application/json'}});
  };
  const providerFactory=(ignored,opts)=>configureProductionAdapter(configPath,opts);
  const runner=new QualificationRunner({service:f.service,providerFactory,fetchImpl,timing,now:()=> '2026-10-06T01:00:00.000Z',fault:p=>{if(p===fault)throw Error('ISOLATED_AUDIT_FAILURE');}});
  return {...f,runner,getAttempts:()=>attempted,configPath,close:async()=>{await f.close();await rm(configDir,{recursive:true,force:true});},run:()=>runner.run(f.b.qualificationSampleId,{authenticationBindingRevision:'ISOLATED_TEST_REVISION',...f.actor})};
}
const cases=[
 ['valid-12-calls-3-groups-exact',async()=>{const f=await fixture();try{const r=await f.run();assert.equal(r.terminalStatus,'PROVIDER_CAPABILITY_QUALIFIED');assert.equal(r.attemptedCalls,12);assert.equal(r.validSamples,12);assert.equal(r.productionRegistryWrites,0);assert.equal((await f.store.load()).state.control.state,'DISABLED');await assert.rejects(f.runner.callWhileDisabled(),/DISABLED/);assert.equal(f.getAttempts(),12);}finally{await f.close();}}],
 ['disabled-kill-switch-no-calls',async()=>{const f=await fixture();try{await assert.rejects(f.runner.callWhileDisabled(),/DISABLED/);assert.equal(f.getAttempts(),0);}finally{await f.close();}}],
 ...['transport','timeout','schema','provenance','proof','model','version','stability'].map(mode=>['fail-closed-'+mode,async()=>{const f=await fixture({mode});try{const r=await f.run();assert.notEqual(r.terminalStatus,'PROVIDER_CAPABILITY_QUALIFIED');assert.equal(f.getAttempts(),mode==='stability'?5:1);assert.equal((await f.store.load()).state.control.state,'DISABLED');if(mode==='stability')assert.equal(r.terminalStatus,'FAILED_STABILITY');if(['model','version'].includes(mode))assert.equal(r.terminalStatus,'BLOCKED_PROVIDER_VERSION_DRIFT');}finally{await f.close();}}]),
 ...['pre-call-audit','post-call-audit','final-audit'].map(fault=>['fail-closed-'+fault,async()=>{const f=await fixture({fault});try{try{const r=await f.run();assert.equal(r.terminalStatus,'PROVIDER_CAPABILITY_FAILED');assert.equal(r.reasonCode,'QUALIFICATION_AUDIT_FAILURE');}catch(e){assert.match(e.message,/AUDIT_FAILURE/);}assert.equal((await f.store.load()).state.control.state,'DISABLED');assert.equal(f.getAttempts(),fault==='pre-call-audit'?0:fault==='post-call-audit'?1:12);}finally{await f.close();}}]),
 ['no-automatic-second-run',async()=>{const f=await fixture({mode:'transport'});try{await f.run();await assert.rejects(f.run(),/ALREADY_ATTEMPTED/);assert.equal(f.getAttempts(),1);}finally{await f.close();}}],
 ['configuration-drift-before-calls',async()=>{const f=await fixture();try{const config=JSON.parse(await readFile(f.configPath));config.models.providers.ISOLATED_TEST.baseUrl='https://other.invalid/v1';await writeFile(f.configPath,JSON.stringify(config));await assert.rejects(f.run(),/VERSION_DRIFT/);assert.equal(f.getAttempts(),0);}finally{await f.close();}}],
 ['owner-revision-drift-before-calls',async()=>{const f=await fixture();try{await assert.rejects(f.runner.preflight(f.b.qualificationSampleId,'CHANGED_REVISION'),/VERSION_DRIFT/);assert.equal(f.getAttempts(),0);}finally{await f.close();}}],
 ['unknown-owner-cannot-enable',async()=>{const f=await fixture();try{await assert.rejects(f.runner.run(f.b.qualificationSampleId,{authenticationBindingRevision:'ISOLATED_TEST_REVISION',ownerId:'horizon-owner:unknown',keyId:f.actor.keyId}),/NOT_ENROLLED/);assert.equal(f.getAttempts(),0);}finally{await f.close();}}],
 ['revoked-approval-blocks-preflight',async()=>{const f=await fixture();try{await f.service.revoke(f.b.qualificationSampleId,f.actor);await assert.rejects(f.run(),/APPROVAL_FAILURE/);assert.equal(f.getAttempts(),0);}finally{await f.close();}}],
 ['store-corruption-blocks-preflight',async()=>{const f=await fixture();try{await writeFile(join(f.store.store,'current.json'),'corrupt');await assert.rejects(f.run(),/STORE_CORRUPT/);assert.equal(f.getAttempts(),0);}finally{await f.close();}}],
 ['missing-owner-revision-never-defaults',async()=>{const f=await fixture();try{await assert.rejects(f.runner.preflight(f.b.qualificationSampleId,undefined),/MISSING_OWNER/);assert.equal(f.getAttempts(),0);}finally{await f.close();}}],
];
for(const [name,run] of cases)test(name,run);
test('frozen-terminal-priority-transport-before-incomplete-groups',()=>{
  assert.equal(classifyQualificationFailure('PROVIDER_TIMEOUT'),'BLOCKED_PROVIDER_UNAVAILABLE');
  assert.equal(classifyQualificationFailure('PROVIDER_EXECUTION_FAILED'),'BLOCKED_PROVIDER_UNAVAILABLE');
  assert.equal(classifyQualificationFailure('QUALIFICATION_STRUCTURED_RESPONSE_INVALID'),'FAILED_SCHEMA');
  assert.equal(classifyQualificationFailure('QUALIFICATION_PROVENANCE_BINDING_INVALID'),'FAILED_PROVENANCE');
  assert.equal(classifyQualificationFailure('QUALIFICATION_PROOF_INVALID'),'FAILED_EVIDENCE_BINDING');
  assert.equal(classifyQualificationFailure('QUALIFICATION_AUDIT_FAILURE'),'PROVIDER_CAPABILITY_FAILED');
  assert.equal(classifyQualificationFailure('QUALIFICATION_KILL_SWITCH_DISABLED_OR_EXPIRED'),'PROVIDER_CAPABILITY_BLOCKED');
});

test('explicit bounded timeout resume preserves first attempt and blocks third run',async()=>{
 const f=await fixture({mode:'timeout',timing:new QualificationTiming()});try{const first=await f.run(),original=JSON.stringify((await f.store.load()).state.runs[0]);assert.equal(first.attemptedCalls,1);f.runner.fetchImpl=async()=>{throw Error('ISOLATED_TRANSPORT_FAILURE');};const second=await f.runner.run(f.b.qualificationSampleId,{authenticationBindingRevision:'ISOLATED_TEST_REVISION',...f.actor,resumeOriginalRunId:first.qualificationRunId});assert.equal(second.attemptedCalls,1);assert.notEqual(first.qualificationRunId,second.qualificationRunId);assert.notEqual(first.attemptId,second.attemptId);assert.equal(second.resumeOriginalRunId,first.qualificationRunId);assert.equal(second.calls[0].attemptIndex,2);assert.equal(JSON.stringify((await f.store.load()).state.runs[0]),original);assert.equal((await f.store.load()).state.control.state,'DISABLED');await assert.rejects(f.runner.run(f.b.qualificationSampleId,{authenticationBindingRevision:'ISOLATED_TEST_REVISION',...f.actor,resumeOriginalRunId:first.qualificationRunId}),/ALREADY_ATTEMPTED/);}
 finally{await f.close();}
});
