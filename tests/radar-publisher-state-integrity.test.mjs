import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createIsolatedPublisher} from '../src/lib/radar-publisher/isolated.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const base=path.join(os.homedir(),'.local/state/horizon/verification/publication-publisher-canary-v1');
export const original=JSON.parse(await fs.readFile(path.join(base,'happy-path-state.json'),'utf8'));
const success=s=>s.receipts.find(r=>r.status==='EXECUTED');
const audit=s=>s.audit.find(r=>r.operation==='SINK_WRITE_RESULT'&&r.result==='COMMITTED');
const id=s=>s.sink[0].instructionId;
export const variants=[
 ...['eventKey','observationId','instructionId','payloadHash'].map(k=>({name:'sink '+k,reason:'SINK_IDENTITY_MISMATCH',mutate:s=>{s.sink[0][k]=k==='eventKey'?'synthetic-corrupt:version-update:2.0':k==='observationId'?'fedcba9876543210':'0'.repeat(64);}})),
 ...['eventKey','observationId','instructionId','payloadHash'].map(k=>({name:'receipt '+k,reason:'RECEIPT_IDENTITY_MISMATCH',mutate:s=>{success(s)[k]=k==='eventKey'?'synthetic-corrupt:version-update:2.0':k==='observationId'?'fedcba9876543210':'0'.repeat(64);}})),
 ...['eventKey','observationId','instructionId','payloadHash'].map(k=>({name:'audit '+k,reason:'AUDIT_IDENTITY_MISMATCH',mutate:s=>{audit(s)[k]=k==='eventKey'?'synthetic-corrupt:version-update:2.0':k==='observationId'?'fedcba9876543210':'0'.repeat(64);}})),
 {name:'sink payload bytes',reason:'SINK_IDENTITY_MISMATCH',mutate:s=>{s.sink[0].payload='modified payload';}},
 {name:'sink observationIds',reason:'SINK_IDENTITY_MISMATCH',mutate:s=>{s.sink[0].observationIds=['fedcba9876543210'];}},
 {name:'sink target',reason:'SINK_IDENTITY_MISMATCH',mutate:s=>{s.sink[0].targetChannel='wrong-target';}},
 {name:'receipt observationIds',reason:'RECEIPT_IDENTITY_MISMATCH',mutate:s=>{success(s).observationIds=['fedcba9876543210'];}},
 {name:'instruction grant scope',reason:'RECEIPT_IDENTITY_MISMATCH',mutate:s=>{success(s).provenance.authorizationGrant.scope.eventKey='synthetic-corrupt:version-update:2.0';}},
 {name:'idempotency instructionId key',reason:'IDEMPOTENCY_IDENTITY_MISMATCH',mutate:s=>{const k=id(s);s.committed['0'.repeat(64)]=s.committed[k];delete s.committed[k];}},
 {name:'idempotency bound attempt',reason:'IDEMPOTENCY_IDENTITY_MISMATCH',mutate:s=>{s.committed[id(s)].attemptId='wrong-attempt';}},
 {name:'idempotency payload hash',reason:'IDEMPOTENCY_IDENTITY_MISMATCH',mutate:s=>{s.committed[id(s)].payloadHash='0'.repeat(64);}},
 {name:'missing sink',reason:'SINK_IDENTITY_MISMATCH',mutate:s=>{s.sink=[];}},
 {name:'missing receipt',reason:'RECEIPT_IDENTITY_MISMATCH',mutate:s=>{s.receipts=s.receipts.filter(r=>r.status!=='EXECUTED');}},
 {name:'missing successful audit',reason:'AUDIT_IDENTITY_MISMATCH',mutate:s=>{s.audit=s.audit.filter(r=>r.operation!=='SINK_WRITE_RESULT');}},
 {name:'duplicate conflicting sink',reason:'SINK_IDENTITY_MISMATCH',mutate:s=>{s.sink.push({...s.sink[0],eventKey:'synthetic-conflict:version-update:2.0'});}},
 {name:'duplicate conflicting receipt',reason:'RECEIPT_IDENTITY_MISMATCH',mutate:s=>{s.receipts.push({...success(s),eventKey:'synthetic-conflict:version-update:2.0'});}},
 {name:'orphan receipt',reason:'RECEIPT_IDENTITY_MISMATCH',mutate:s=>{s.receipts.push({...success(s),attemptId:'orphan-execution'});}},
 {name:'orphan successful audit',reason:'AUDIT_IDENTITY_MISMATCH',mutate:s=>{s.audit.push({...audit(s),attemptId:'orphan-execution'});}},
 {name:'orphan idempotency',reason:'IDEMPOTENCY_IDENTITY_MISMATCH',mutate:s=>{s.committed['0'.repeat(64)]={...s.committed[id(s)]};}},
 {name:'duplicate conflicting replay receipt',reason:'RECEIPT_IDENTITY_MISMATCH',mutate:s=>{const r=s.receipts.find(r=>r.status==='DUPLICATE_EXECUTION');r.eventKey='synthetic-conflict:version-update:2.0';}},
 {name:'replay original attempt mismatch',reason:'IDEMPOTENCY_IDENTITY_MISMATCH',mutate:s=>{const r=s.receipts.find(r=>r.status==='DUPLICATE_EXECUTION');r.originalExecutionAttemptId='wrong-attempt';}},

 {name:'nested success receipt audit',reason:'AUDIT_IDENTITY_MISMATCH',mutate:s=>{success(s).audit[0].eventKey='synthetic-corrupt:version-update:2.0';}},
 {name:'nested replay receipt audit',reason:'AUDIT_IDENTITY_MISMATCH',mutate:s=>{s.receipts.find(r=>r.status==='DUPLICATE_EXECUTION').audit[0].observationId='fedcba9876543210';}},
 {name:'replay grant scope mismatch',reason:'RECEIPT_IDENTITY_MISMATCH',mutate:s=>{s.receipts.find(r=>r.status==='DUPLICATE_EXECUTION').provenance.authorizationGrant.scope.eventKey='synthetic-corrupt:version-update:2.0';}},
 {name:'idempotency explicit identity mismatch',reason:'IDEMPOTENCY_IDENTITY_MISMATCH',mutate:s=>{s.committed[id(s)].eventKey='synthetic-corrupt:version-update:2.0';}},
 {name:'missing post-identity audit field',reason:'AUDIT_IDENTITY_MISMATCH',mutate:s=>{delete audit(s).observationId;}},

];
export async function copyState(value){const root=await fs.mkdtemp(path.join(os.tmpdir(),'horizon-publisher-canary-remediation-'));await fs.writeFile(path.join(root,'state.json'),JSON.stringify(value));await fs.copyFile(path.join(base,'happy-path-control.json'),path.join(root,'control.json'));await fs.copyFile(path.join(base,'happy-path-ISOLATED_SYNTHETIC_ONLY.json'),path.join(root,'ISOLATED_SYNTHETIC_ONLY.json'));const pub=await createIsolatedPublisher({root,policyDirectory:path.join(os.homedir(),'.local/state/horizon/policies/publication/1.0.0'),secret:'read-only-state-probe-'+ '0'.repeat(40)});return {pub,root};}

const fixture=JSON.parse(await fs.readFile(new URL('../fixtures/radar-publisher/state-corruption-cases-v1.json',import.meta.url)));
assert.deepEqual(fixture.cases.map(c=>c.name),variants.map(v=>v.name));
for(const v of variants)test(v.name+' rejects snapshot and execution without persisted writes',async()=>{
 const value=structuredClone(original);v.mutate(value);const {pub,root}=await copyState(value);const before=await fs.readFile(path.join(root,'state.json'));
 await assert.rejects(pub.snapshot(),e=>e.status==='REJECTED_STATE_INTEGRITY'&&e.message.startsWith(v.reason+':'));
 const r=await pub.execute({});assert.equal(r.status,'REJECTED_STATE_INTEGRITY');assert.ok(r.reason.startsWith(v.reason+':'));assert.equal(r.persistenceStatus,'NOT_PERSISTED');
 assert.deepEqual(await fs.readFile(path.join(root,'state.json')),before);assert.equal((await pub.control()).state,'DISABLED');
});
test('historical accepted state and IDs remain byte-identical',async()=>{const {pub,root}=await copyState(original);const before=await fs.readFile(path.join(root,'state.json'));assert.deepEqual(await pub.snapshot(),original);assert.deepEqual(await fs.readFile(path.join(root,'state.json')),before);assert.equal((await pub.control()).state,'DISABLED');});
