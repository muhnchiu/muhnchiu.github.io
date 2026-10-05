import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {loadFrozenPolicy,evaluateFrozenPolicy} from './policy.mjs';
import {canonical,strictParse,instruction,instructionFromText,sha} from './canonical.mjs';
const TYPE='SYNTHETIC_TEST_AUTHORIZATION';
const fail=(status,reason)=>{throw Object.assign(Error(reason),{status});};
const validHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
// Compare exact UTC instants, including arbitrary fractional digits; no millisecond truncation.
const utc=x=>{if(typeof x!=='string')return null;const m=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(?:Z|\+00:00)$/.exec(x);if(!m)return null;const t=Date.parse(m[1]+'Z');if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,19)!==m[1])return null;return {seconds:t/1000,fraction:m[2]??''};};
const compareTime=(a,b)=>{if(a.seconds!==b.seconds)return a.seconds<b.seconds?-1:1;const n=Math.max(a.fraction.length,b.fraction.length),x=a.fraction.padEnd(n,'0'),y=b.fraction.padEnd(n,'0');return x<y?-1:x>y?1:0;};
const eq=(a,b)=>canonical(a)===canonical(b);
const scopeWithNormalizedIds=scope=>{if(!scope||!Array.isArray(scope.observationIds)||scope.observationIds.some(x=>typeof x!=='string'||!/^[a-f0-9]{16}$/.test(x)))fail('REJECTED_AUTHORIZATION_INVALID','INVALID_OBSERVATION_SCOPE');return {...scope,observationIds:[...new Set(scope.observationIds)].sort()};};
export function signSynthetic(value,secret){return createHmac('sha256',secret).update(canonical(value)).digest('hex');}
function signatureValid(value,signature,secret){if(!validHash(signature))return false;return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(signSynthetic(value,secret),'hex'));}
async function atomic(file,value,beforeRename=async()=>{}){const temp=file+'.'+randomUUID()+'.tmp';let handle;
  try {handle=await fs.open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();await handle.close();handle=null;await beforeRename(temp);await fs.rename(temp,file);const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}
  finally{if(handle)await handle.close();await fs.rm(temp,{force:true});}
}
// There is no production adapter, destination resolver, or public transport in this module.
export async function createIsolatedPublisher({root,policyDirectory,secret,issuer='synthetic-human',now=()=>new Date(),fault=async()=>{}}){
  const real=await fs.realpath(root),tmp=await fs.realpath(os.tmpdir());
  if(!path.basename(real).startsWith('horizon-publisher-canary-')||!(real.startsWith(tmp+path.sep)||real.startsWith('/private/tmp/')))throw Error('ISOLATED_ROOT_REQUIRED');
  if(typeof secret!=='string'||secret.length<32)throw Error('SYNTHETIC_AUTHORITY_KEY_REQUIRED');
  const marker=path.join(real,'ISOLATED_SYNTHETIC_ONLY.json'),stateFile=path.join(real,'state.json'),controlFile=path.join(real,'control.json'),lockFile=path.join(real,'lock');
  const initial={namespace:'ISOLATED_SYNTHETIC_ONLY',sink:[],committed:{},receipts:[],audit:[]};
  try{const fd=await fs.open(marker,'wx',0o600);await fd.writeFile(JSON.stringify({namespace:initial.namespace,productionCapable:false}));await fd.close();await atomic(stateFile,initial);await atomic(controlFile,{state:'DISABLED',generation:0});}
  catch(e){if(e.code!=='EEXIST')throw e;}
  async function read(file){if((await fs.lstat(file)).isSymbolicLink())throw Error('ISOLATED_SYMLINK');return JSON.parse(await fs.readFile(file,'utf8'));}
  async function locked(fn,lock=lockFile){let fd;for(let i=0;i<500;i++){try{fd=await fs.open(lock,'wx',0o600);break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,2));}}if(!fd)throw Error('ISOLATED_LOCK_UNAVAILABLE');try{return await fn();}finally{await fd.close();await fs.unlink(lock);}}
  async function state(){return validateState(await read(stateFile));}
  function validateState(s){
    if(s.namespace!==initial.namespace||!Array.isArray(s.sink)||!Array.isArray(s.receipts)||!Array.isArray(s.audit)||!s.committed||typeof s.committed!=='object'||Array.isArray(s.committed))throw Error('CORRUPTED_STATE');
    const corrupt=(kind,detail)=>fail('REJECTED_STATE_INTEGRITY',kind+':'+detail);
    const identityKeys=['instructionId','eventKey','observationId','observationIds','targetChannel','payloadHash','idempotencyKey'];
    const hasIdentity=r=>r&&identityKeys.some(k=>Object.hasOwn(r,k));
    const agrees=(r,expected)=>r&&identityKeys.every(k=>Object.hasOwn(r,k)&&eq(r[k],expected[k]));
    function identityFrom(value,kind){
      try{
        const result=instruction({domain:'horizon-publication-instruction-v1',eventKey:value.eventKey,observationIds:value.observationIds,targetChannel:value.targetChannel,contentSha256:value.contentSha256});
        const parsed=JSON.parse(result.canonicalText);
        return {instructionId:result.instructionId,eventKey:parsed.eventKey,observationId:parsed.observationIds[0],observationIds:parsed.observationIds,targetChannel:parsed.targetChannel,payloadHash:parsed.contentSha256,idempotencyKey:result.instructionId};
      }catch{corrupt(kind,'INVALID_PERSISTED_INSTRUCTION');}
    }
    // The already persisted scoped instruction is the authority. Recompute only with
    // the unchanged frozen identity algorithm; never replace a persisted value.
    function completedIdentity(r){
      const grant=r.provenance?.authorizationGrant,scope=grant?.scope,bound=r.provenance?.authorizationScope;
      if(!scope||!bound)corrupt('RECEIPT_IDENTITY_MISMATCH','MISSING_INSTRUCTION_SCOPE');
      const expected=identityFrom(scope,'RECEIPT_IDENTITY_MISMATCH');
      const normalized=v=>({...v,observationIds:[...new Set(v.observationIds)].sort()});
      if(scope.instructionId!==expected.instructionId||!Array.isArray(bound.observationIds)||!eq(normalized(scope),normalized(bound))||r.authorizationReference!==grant.authorizationId||!agrees(r,expected))corrupt('RECEIPT_IDENTITY_MISMATCH','SCOPED_INSTRUCTION_BINDING');
      return expected;
    }
    const completed=new Map(),completedIds=new Set(),byAttempt=new Map();
    for(const r of s.receipts){
      if(!r||typeof r.attemptId!=='string'||!r.attemptId)corrupt('RECEIPT_IDENTITY_MISMATCH','INVALID_ATTEMPT');
      if(!byAttempt.has(r.attemptId))byAttempt.set(r.attemptId,[]);byAttempt.get(r.attemptId).push(r);
      if(r.status==='EXECUTED'){
        if(completed.has(r.attemptId)||completedIds.has(r.instructionId))corrupt('RECEIPT_IDENTITY_MISMATCH','DUPLICATE_SUCCESS_RECEIPT');
        const expected=completedIdentity(r);completed.set(r.attemptId,{receipt:r,expected});completedIds.add(expected.instructionId);
      }else if(hasIdentity(r)){
        if(r.provenance?.authorizationGrant)completedIdentity(r);
        const expected=identityFrom({...r,contentSha256:r.payloadHash},'RECEIPT_IDENTITY_MISMATCH');
        if(!agrees(r,expected))corrupt('RECEIPT_IDENTITY_MISMATCH','ATTEMPT_INSTRUCTION_BINDING');
      }
    }
    const sinkIds=new Set(),sinkAttempts=new Set();
    for(const row of s.sink){
      if(!row||sinkIds.has(row.instructionId)||sinkAttempts.has(row.attemptId))corrupt('SINK_IDENTITY_MISMATCH','DUPLICATE_OR_INVALID_SINK');
      const execution=completed.get(row.attemptId);if(!execution)corrupt('RECEIPT_IDENTITY_MISMATCH','MISSING_SUCCESS_RECEIPT');
      const {receipt:r,expected}=execution;
      if(!agrees(row,expected)||typeof row.payload!=='string'||sha(Buffer.from(row.payload,'utf8'))!==expected.payloadHash||row.authorizationReference!==r.authorizationReference||row.resultStatus!=='EXECUTED')corrupt('SINK_IDENTITY_MISMATCH','SCOPED_INSTRUCTION_OR_PAYLOAD');
      const record=s.committed[expected.instructionId];
      if(!record||record.attemptId!==r.attemptId||record.payloadHash!==expected.payloadHash||identityKeys.some(k=>Object.hasOwn(record,k)&&!eq(record[k],expected[k])))corrupt('IDEMPOTENCY_IDENTITY_MISMATCH','COMMITTED_EXECUTION_BINDING');
      sinkIds.add(expected.instructionId);sinkAttempts.add(row.attemptId);
    }
    for(const [attempt]of completed)if(!sinkAttempts.has(attempt))corrupt('SINK_IDENTITY_MISMATCH','MISSING_COMMITTED_SINK');
    if(Object.keys(s.committed).length!==sinkIds.size||Object.keys(s.committed).some(k=>!sinkIds.has(k)))corrupt('IDEMPOTENCY_IDENTITY_MISMATCH','ORPHAN_COMMITTED_IDENTITY');
    for(const r of s.receipts)if(r.status==='DUPLICATE_EXECUTION'){
      const record=s.committed[r.instructionId];
      if(!record||r.originalExecutionAttemptId!==record.attemptId||!agrees(r,completed.get(record.attemptId)?.expected??{}))corrupt('IDEMPOTENCY_IDENTITY_MISMATCH','REPLAY_EXECUTION_BINDING');
    }
    for(const a of s.audit){
      if(!a||typeof a!=='object')corrupt('AUDIT_IDENTITY_MISMATCH','INVALID_AUDIT');
      const owner=byAttempt.get(a.attemptId),postIdentity=owner?.filter(hasIdentity)??[];
      if((hasIdentity(a)||postIdentity.length)&&!postIdentity.some(r=>agrees(a,r)))corrupt('AUDIT_IDENTITY_MISMATCH','ATTEMPT_IDENTITY_BINDING');
      if(a.operation==='SINK_WRITE_RESULT'&&a.result==='COMMITTED'&&!completed.has(a.attemptId))corrupt('AUDIT_IDENTITY_MISMATCH','ORPHAN_SUCCESS_AUDIT');
    }
    for(const r of s.receipts){const rows=s.audit.filter(a=>a.attemptId===r.attemptId);
      if(!Array.isArray(r.audit)||r.audit.some(a=>!rows.some(p=>eq(p,a))))corrupt('AUDIT_IDENTITY_MISMATCH','RECEIPT_AUDIT_BINDING');
    }
    for(const [attempt,{receipt:r}]of completed){
      const rows=s.audit.filter(a=>a.attemptId===attempt);
      const required={EXECUTION_INTENT:'REQUESTED',FROZEN_POLICY_RESULT:'PUBLICATION_AUTHORIZED',AUTHORIZATION_RESULT:'VALID_SCOPED_CURRENT',INSTRUCTION_ID_RESULT:'MATCH',SINK_WRITE_INTENT:'PREPARED',SINK_WRITE_RESULT:'COMMITTED'};
      for(const [operation,result]of Object.entries(required))if(!rows.some(a=>a.operation===operation&&a.result===result))corrupt('AUDIT_IDENTITY_MISMATCH','MISSING_'+operation);
      // Response-loss traces may repeat the exact committed audit row. They describe
      // one execution and are compared without rewriting the append-only history.
      const successes=new Set(rows.filter(a=>a.operation==='SINK_WRITE_RESULT'&&a.result==='COMMITTED').map(canonical));
      if(successes.size!==1)corrupt('AUDIT_IDENTITY_MISMATCH','CONFLICTING_SUCCESS_AUDIT');
    }
    return s;
  }
  async function setEnabled(enabled){return locked(async()=>{const ctl=await read(controlFile),s=await state();const next={state:enabled?'ENABLED':'DISABLED',generation:ctl.generation+1};
    // Control changes fail closed: disabled control is written before audit; enable only after audit.
    if(!enabled)await atomic(controlFile,next);
    s.audit.push({operation:enabled?'ENABLE':'DISABLE',namespace:initial.namespace,at:now().toISOString()});await atomic(stateFile,validateState(s));if(enabled)await atomic(controlFile,next);return next;
  });}
  // Emergency disable deliberately does not wait for an execution lock.
  async function kill(){return locked(async()=>{const ctl=await read(controlFile);await atomic(controlFile,{state:'DISABLED',generation:ctl.generation+1,audit:[...(ctl.audit??[]),{operation:'KILL_SWITCH_ACTIVATED',namespace:initial.namespace,at:now().toISOString()}]});},path.join(real,'commit.lock'));}
  async function execute(request){const attemptId=randomUUID();let identity={},provenance={},trace=[];
    const audit=(operation,result)=>trace.push({attemptId,operation,result,namespace:initial.namespace,at:now().toISOString()});
    const receipt=status=>({attemptId,status,...identity,provenance,namespace:initial.namespace,realPublication:false,executionTimestamp:now().toISOString(),audit:trace.map(a=>({...a,...identity}))});
    try{return await locked(async()=>{let s;
      try{
        audit('EXECUTION_INTENT','REQUESTED');request=strictParse(canonical(request));
        let policy;try{policy=await loadFrozenPolicy(policyDirectory);}catch(e){fail('REJECTED_POLICY_INTEGRITY',e.message);}
        await state();const ctl=await read(controlFile);if(ctl.state!=='ENABLED'){audit('KILL_SWITCH_REJECTION','DISABLED');fail('REJECTED_PUBLISHER_DISABLED','PUBLISHER_DISABLED');}
        const parsed=instructionFromText(request.instructionText);const value=JSON.parse(parsed.canonicalText);
        identity={instructionId:parsed.instructionId,eventKey:value.eventKey,observationId:value.observationIds[0],observationIds:value.observationIds,targetChannel:value.targetChannel,payloadHash:value.contentSha256,idempotencyKey:parsed.instructionId,authorizationReference:request.authorization?.grant?.authorizationId??null};
        audit('INSTRUCTION_ID_RESULT',parsed.instructionId===request.instructionId?'MATCH':'MISMATCH');
        if(parsed.instructionId!==request.instructionId)fail('REJECTED_INSTRUCTION_ID_MISMATCH','SUPPLIED_ID_MISMATCH');
        if(!value.eventKey.startsWith('synthetic-'))fail('REJECTED_AUTHORIZATION_INVALID','NON_SYNTHETIC_IDENTITY');
        if(sha(Buffer.from(request.payload??''))!==value.contentSha256)fail('REJECTED_AUTHORIZATION_INVALID','PAYLOAD_HASH_MISMATCH');
        // A signed test owner capture explicitly supplies simulated existing-owner proof states.
        // It cannot be used for production Score/Action, Registry, or human authorization.
        const capture=request.capture;
        if(!capture||capture.type!==TYPE||!signatureValid(capture.body,capture.signature,secret)||capture.body.namespace!==real||!eq(capture.body.instruction,value)||!capture.body.currentScope)fail('REJECTED_AUTHORIZATION_INVALID','OWNER_CAPTURE_INVALID');
        let decision;try{decision=evaluateFrozenPolicy(policy,capture.body.gateFacts);}catch(e){fail('REJECTED_NOT_AUTHORIZED',e.message);}
        audit('FROZEN_POLICY_RESULT',decision.disposition);
        if(decision.disposition!=='PUBLICATION_AUTHORIZED')fail('REJECTED_NOT_AUTHORIZED',decision.disposition);
        await fault('authorization-store');
        const auth=request.authorization;if(!auth){audit('AUTHORIZATION_RESULT','MISSING');fail('REJECTED_NOT_AUTHORIZED','MISSING_AUTHORIZATION');}
        const model=policy.artifacts['radar-publication-authorization-authority-v1.json'];
        if(auth.type!==TYPE||auth.authorityId!==model.authorityId||auth.namespace!==real||auth.lookupHealth!=='COMPLETE_HEALTHY'||auth.complete!==true||!Array.isArray(auth.grants)||!Array.isArray(auth.revokedAuthorizationIds)||!signatureValid({grants:auth.grants,revokedAuthorizationIds:auth.revokedAuthorizationIds,asOf:auth.asOf,namespace:auth.namespace,authorityId:auth.authorityId,lookupHealth:auth.lookupHealth,complete:auth.complete},auth.lookupSignature,secret))fail('REJECTED_AUTHORIZATION_INVALID','LOOKUP_OR_PROVENANCE_INVALID');
        const grants=[...new Map(auth.grants.map(g=>[canonical(g),g])).values()];
        if(grants.length!==1)fail('REJECTED_AUTHORIZATION_INVALID','CONFLICT_OR_MISSING');
        const g=grants[0];
        if(!g||model.requiredRecordFields.some(k=>!Object.hasOwn(g,k))||g.issuerPrincipalId!==issuer||g.decision!=='APPROVE'||!validHash(g.provenanceSha256)||!g.authorizationId||!g.revocationHistoryRef||!signatureValid(g,auth.grantSignature,secret))fail('REJECTED_AUTHORIZATION_INVALID','GRANT_INVALID');
        const current=utc(now().toISOString()),issue=utc(g.issuedAt),end=utc(g.expiresAt),lookupTime=utc(auth.asOf);
        if(!current||!issue||!end||!lookupTime||compareTime(issue,current)>0||compareTime(end,issue)<=0||compareTime(lookupTime,current)!==0)fail('REJECTED_AUTHORIZATION_INVALID','TIME_OR_LOOKUP_STALE');
        if(auth.revokedAuthorizationIds.includes(g.authorizationId))fail('REJECTED_AUTHORIZATION_REVOKED','REVOKED');
        if(compareTime(current,end)>=0)fail('REJECTED_AUTHORIZATION_EXPIRED','EXPIRED');
        const scope=scopeWithNormalizedIds(capture.body.currentScope),grantScope=scopeWithNormalizedIds(g.scope);
        if(Object.keys(g.scope).sort().join()!==[...model.scopeFields].sort().join()||!eq(grantScope,scope)||g.scope.policyVersion!==policy.main.policyVersion||g.scope.instructionId!==identity.instructionId||g.scope.eventKey!==value.eventKey||!eq(grantScope.observationIds,value.observationIds)||g.scope.targetChannel!==value.targetChannel||g.scope.contentSha256!==value.contentSha256||model.scopeFields.filter(k=>k.endsWith('Sha256')).some(k=>!validHash(scope[k])))fail('REJECTED_AUTHORIZATION_INVALID','SCOPE_STALE_OR_INVALID');
        identity.authorizationReference=g.authorizationId;provenance={type:TYPE,policyVersion:policy.main.policyVersion,manifestSha256:policy.manifestSha256,ownerCaptureSha256:sha(canonical(capture.body)),authorizationLookupSha256:sha(canonical(auth)),issuerPrincipalId:g.issuerPrincipalId,authorizationScope:structuredClone(g.scope),authorizationGrant:structuredClone(g),authorizationGrantSignature:auth.grantSignature};audit('AUTHORIZATION_RESULT','VALID_SCOPED_CURRENT');
        s=await state();await fault('idempotency-store');
        if(s.committed[identity.instructionId]){
          if(s.committed[identity.instructionId].payloadHash!==identity.payloadHash)throw Error('CORRUPTED_IDEMPOTENCY');
          audit('DUPLICATE_DETECTION','COMMITTED');const r=receipt('DUPLICATE_EXECUTION');r.originalExecutionAttemptId=s.committed[identity.instructionId].attemptId;s.receipts.push(r);s.audit.push(...r.audit);await fault('audit');await atomic(stateFile,validateState(s));return r;
        }
        if(s.sink.some(row=>row.eventKey===identity.eventKey&&row.targetChannel===identity.targetChannel&&row.payloadHash===identity.payloadHash))fail('REJECTED_AUTHORIZATION_INVALID','PUBLICATION_HISTORY_PROOF_CONTRADICTS_COMMITTED_CONTENT');
        audit('SINK_WRITE_INTENT','PREPARED');await fault('sink');await fault('audit');await fault('before-commit');
        return await locked(async()=>{const latest=await read(controlFile);if(latest.state!=='ENABLED'||latest.generation!==ctl.generation){audit('KILL_SWITCH_REJECTION','DISABLED_OR_CHANGED');fail('REJECTED_PUBLISHER_DISABLED','KILL_SWITCH');}
        // Revalidate time at the execution boundary, not just at evaluation time.
        if(compareTime(utc(now().toISOString()),end)>=0)fail('REJECTED_AUTHORIZATION_EXPIRED','EXPIRED_DURING_EXECUTION');
        audit('SINK_WRITE_RESULT','COMMITTED');
        const r=receipt('EXECUTED'),row={...identity,attemptId,payload:request.payload,executionTimestamp:r.executionTimestamp,authorizationReference:g.authorizationId,resultStatus:'EXECUTED'};
        s.sink.push(row);s.committed[identity.instructionId]={attemptId,payloadHash:identity.payloadHash};s.receipts.push(r);s.audit.push(...r.audit);
        // Sink, idempotency, audit and success receipt commit as one fsynced atomic file.
        await atomic(stateFile,validateState(s),async temp=>{await fault('partial-sink',temp);});await fault('post-commit');return r;},path.join(real,'commit.lock'));
      }catch(e){const status=e.status??'EXECUTION_FAILED';audit(e.status?'REJECTION':'FAILURE',e.message);const r={...receipt(status),reason:e.message,persistenceStatus:'NOT_PERSISTED'};
        try{const clean=await state();r.commitOutcome=clean.committed[identity.instructionId]?.attemptId===attemptId?'COMMITTED_RECONCILED':'NOT_COMMITTED';
        // Finalize this new failure trace from verified commit history. Never rewrite
        // existing state: a pre-rename failure has no successful sink result to persist.
        if(r.commitOutcome==='NOT_COMMITTED')r.audit=r.audit.map(a=>a.operation==='SINK_WRITE_RESULT'&&a.result==='COMMITTED'?{...a,result:'FAILED'}:a);
        clean.receipts.push(r);clean.audit.push(...r.audit);await fault('failure-audit');await atomic(stateFile,validateState(clean));r.persistenceStatus='PERSISTED';}catch(error){r.persistenceError=error.message;}
        return r;
      }
    });}catch(e){audit('FAILURE',e.message);return {...receipt('EXECUTION_FAILED'),reason:e.message,persistenceStatus:'NOT_PERSISTED'};}
  }
  return Object.freeze({execute,enable:()=>setEnabled(true),disable:()=>setEnabled(false),kill,snapshot:()=>locked(state),control:()=>read(controlFile),root:real});
}
