import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BootstrapAdmin,canonical,sha256} from '../src/lib/radar-bootstrap/index.mjs';
import {loadRubric} from '../src/lib/radar-judgment/provider.mjs';
import {createAuthoredFixture,fixtureBinding} from '../src/lib/radar-qualification/fixture.mjs';
import {QualificationStore} from '../src/lib/radar-qualification/store.mjs';
import {FixtureAuthority} from '../src/lib/radar-qualification/approval.mjs';

import {setup} from './radar-qualification-test-support.mjs';

async function approved(f){await f.review();return f.approve();}
async function mutate(f,fn){await f.store.locked('ISOLATED_FAILURE_MUTATION',async()=>{const s=await f.store.load();fn(s.state.fixtures[0]);s.state.audits.push({operation:'ISOLATED_FAILURE_MUTATION'});await f.store.commit(s.state,f.author);});}
async function diagnostic(f,fn,expected){const r=await approved(f);const receipt=structuredClone(r.receipt);fn(receipt);const v=await f.service.verify(f.b.qualificationSampleId,{diagnosticReceipt:receipt});assert.equal(v.verificationState,expected);assert.equal(v.executionAuthorized,false);}
const cases=[
 ['valid-canonical-approval-15-steps',async f=>{const r=await approved(f);assert.equal(r.verification.verificationState,'APPROVED_VERIFIED');assert.equal(r.verification.stages.length,15);assert.equal(r.verification.executionAuthorized,false);}],
 ['wrong-author-principal',async f=>{await assert.rejects(f.service.author.sign({fixtureDraftHash:f.b.fixtureHash,qualificationSampleId:f.b.qualificationSampleId,fixtureVersion:'1.0'},{principalId:'horizon-principal:owner',keyId:f.actor.keyId}),/AUTHORIZATION/);}],
 ['author-cannot-approve',async f=>{await f.review();await assert.rejects(f.service.approve(f.b.qualificationSampleId,{ownerId:'horizon-author:author',keyId:f.author.keyId}),/AUTHENTICATION/);}],
 ['unknown-approver',async f=>{await f.review();await assert.rejects(f.service.approve(f.b.qualificationSampleId,{...f.actor,ownerId:'horizon-owner:unknown'}),/AUTHENTICATION/);}],
 ['unknown-key',async f=>{await f.review();await assert.rejects(f.service.approve(f.b.qualificationSampleId,{...f.actor,keyId:'horizon-principal-key:unknown'}),/AUTHENTICATION/);}],
 ['cross-principal-key-wrong-scope',async f=>{await f.review();await assert.rejects(f.service.approve(f.b.qualificationSampleId,{...f.actor,keyId:f.author.keyId}),/AUTHENTICATION/);}],
 ['invalid-signature',async f=>diagnostic(f,r=>r.signature=Buffer.alloc(64).toString('base64'),'APPROVAL_SIGNATURE_INVALID')],
 ['tampered-author-provenance',async f=>{await f.review();await mutate(f,r=>r.authorProvenance.signature=Buffer.alloc(64).toString('base64'));await assert.rejects(f.approve(),/BINDING|AUTHENTICATION/);}],
 ['tampered-fixture',async f=>{await f.review();await mutate(f,r=>r.fixture.evidenceFixture.impact[0].bytes+='tamper');await assert.rejects(f.approve(),/EVIDENCE_BINDING/);}],
 ['tampered-receipt',async f=>diagnostic(f,r=>r.extra='tampered','APPROVAL_RECEIPT_CORRUPT')],
 ['fixture-hash-mismatch',async f=>diagnostic(f,r=>r.payload.fixtureHash='0'.repeat(64),'APPROVAL_BINDING_MISMATCH')],
 ['evidence-hash-mismatch',async f=>diagnostic(f,r=>r.payload.evidenceHash='0'.repeat(64),'APPROVAL_BINDING_MISMATCH')],
 ['rubric-mismatch',async f=>diagnostic(f,r=>r.payload.rubricHash='0'.repeat(64),'APPROVAL_BINDING_MISMATCH')],
 ['protocol-mismatch',async f=>diagnostic(f,r=>r.payload.qualificationProtocolVersion='2.0','APPROVAL_BINDING_MISMATCH')],
 ['provider-mismatch',async f=>diagnostic(f,r=>r.payload.providerTarget.providerId='wrong','APPROVAL_BINDING_MISMATCH')],
 ['model-mismatch',async f=>diagnostic(f,r=>r.payload.modelTarget.modelId='wrong','APPROVAL_BINDING_MISMATCH')],
 ['revoked-principal',async f=>{await f.review();f.setTime('2026-10-06T01:01:00.000Z');await f.admin.governance('revoke-principal',{principalId:'horizon-principal:owner',principalKeyId:null,reasonCode:'ADMINISTRATIVE_WITHDRAWAL',invalidFrom:null});await assert.rejects(f.approve(),/REVOKED/);}],
 ['revoked-key',async f=>{await f.review();f.setTime('2026-10-06T01:01:00.000Z');await f.admin.governance('revoke-principal-key',{principalId:'horizon-principal:owner',principalKeyId:f.actor.keyId,reasonCode:'ADMINISTRATIVE_WITHDRAWAL',invalidFrom:null});await assert.rejects(f.approve(),/REVOKED/);}],
 ['retired-key-rejects-new-approval',async f=>{await f.review();f.setTime('2026-10-06T01:01:00.000Z');const newKeyId='horizon-principal-key:rotated',newPublicKey=await f.signerFactory(newKeyId).create();await f.admin.governance('rotate-principal-key',{principalId:'horizon-principal:owner',newKeyId,newPublicKey,newKeyProof:p=>f.signerFactory(newKeyId).sign(Buffer.from(canonical(p)))});await assert.rejects(f.approve(),/REVOKED/);}],
 ['expired-key-rejects-new-approval',async f=>{await f.review();f.setTime('2026-10-06T01:01:00.000Z');const newKeyId='horizon-principal-key:rotated',newPublicKey=await f.signerFactory(newKeyId).create();await f.admin.governance('rotate-principal-key',{principalId:'horizon-principal:owner',newKeyId,newPublicKey,newKeyProof:p=>f.signerFactory(newKeyId).sign(Buffer.from(canonical(p)))});f.setTime('2026-10-06T01:01:00.001Z');await assert.rejects(f.approve(),/EXPIRED/);}],
 ['draft-approval-attempt',async f=>{await assert.rejects(f.approve(),/NOT_APPROVED/);assert.equal((await f.store.load()).state.fixtures[0].state,'DRAFT');}],
 ['post-review-mutation',async f=>{await f.review();await mutate(f,r=>r.fixture.normalizedCandidateFacts.title='mutated');await assert.rejects(f.approve(),/BINDING/);}],
 ['duplicate-approval-preserves-original-receipt',async f=>{const first=await approved(f);const second=await f.approve();assert.equal(second.operationDisposition,'IDEMPOTENT_EXISTING_APPROVAL');assert.deepEqual(first.receipt,second.receipt);}],
 ['conflicting-receipt-not-accepted',async f=>diagnostic(f,r=>r.payload.operationNonce='conflicting-nonce','APPROVAL_BINDING_MISMATCH')],
 ['approval-store-corruption',async f=>{await approved(f);await writeFile(join(f.store.store,'current.json'),'corrupt');assert.equal((await f.service.verify(f.b.qualificationSampleId)).verificationState,'APPROVAL_AUTHORITY_UNAVAILABLE');}],
 ['audit-failure-no-approval',async f=>{await f.review();f.setFault('commit-audit');await assert.rejects(f.approve(),/INJECTED_AUDIT_FAILURE/);f.setFault(null);assert.equal((await f.store.load()).state.fixtures[0].state,'REVIEW');}],
 ['audit-start-failure-releases-lock',async f=>{await f.review();f.setFault('audit-start');await assert.rejects(f.approve(),/INJECTED_AUDIT_FAILURE/);f.setFault(null);assert.equal((await f.approve()).verification.verificationState,'APPROVED_VERIFIED');}],
 ['revoked-approval-never-reactivated',async f=>{await approved(f);f.setTime('2026-10-06T01:01:00.000Z');await f.service.revoke(f.b.qualificationSampleId,f.actor);assert.equal((await f.service.verify(f.b.qualificationSampleId)).verificationState,'APPROVAL_REVOKED');await assert.rejects(f.approve(),/APPROVAL_REVOKED/);}],
 ['prepared-journal-not-committed',async f=>{await approved(f);const p=JSON.parse(await readFile(join(f.store.store,'current.json')));await writeFile(join(f.store.store,'journals',p.transactionId+'.json'),JSON.stringify({...p,state:'PREPARED'}));assert.equal((await f.service.verify(f.b.qualificationSampleId)).verificationState,'APPROVAL_AUTHORITY_UNAVAILABLE');}],
 ['evidence-types-required',async f=>{const content=structuredClone(f.fixture);content.evidenceFixture.impact.pop();assert.throws(()=>fixtureBinding(content,f.rubric),/EVIDENCE_INCOMPLETE/);}],
];
for(const [name,run] of cases)test(name,async()=>{const f=await setup();try{await run(f);}finally{await f.close();}});
