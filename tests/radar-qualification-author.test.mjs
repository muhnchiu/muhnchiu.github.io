import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BootstrapAdmin,canonical,sha256} from '../src/lib/radar-bootstrap/index.mjs';
import {AuthorProvenance} from '../src/lib/radar-qualification/author.mjs';

// Isolated test keys are ephemeral memory fixtures, never real principal keys or production records.
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'horizon-author-test-'));
  let now='2026-10-06T01:00:00.000Z';
  const keys=new Map();
  const factory=ref=>({ref,async create(){assert(!keys.has(ref));keys.set(ref,generateKeyPairSync('ed25519'));return this.public();},
    async public(){return keys.get(ref).publicKey.export({type:'spki',format:'der'}).toString('base64');},
    async sign(bytes){return sign(null,bytes,keys.get(ref).privateKey).toString('base64');}});
  const admin=new BootstrapAdmin({store:join(dir,'bootstrap'),anchor:join(dir,'anchor'),signerFactory:factory,now:()=>now});
  const pending=await admin.prepareRoot();
  await admin.activateRoot({confirmation:admin.confirmationInstruction(pending),interactive:true,confirmationRecordId:'ISOLATED_NON_PRODUCTION_CONFIRMATION'});
  for(const kind of ['author','owner']) {
    const keyId='horizon-principal-key:'+kind,principalId='horizon-principal:'+kind;
    const publicKey=await factory(keyId).create();
    const request=await admin.issueEnrollmentRequest({principalId,principalType:'CRYPTOGRAPHIC_OPERATOR_PRINCIPAL',displayLabel:null,
      principalCreatedAt:now,keyId,publicKey,requestedRoles:[kind==='author'?'PROVIDER_QUALIFICATION_FIXTURE_AUTHOR':'HORIZON_RADAR_OWNER'],
      requestedScopes:[kind==='author'?'PROVIDER_QUALIFICATION_FIXTURE_AUTHORING':'PROVIDER_QUALIFICATION_FIXTURE_APPROVAL'],
      roleBindings:{[kind==='author'?'fixtureAuthorId':'ownerId']:(kind==='author'?'horizon-author:':'horizon-owner:')+kind,principalId},validFrom:now,validUntil:null});
    await admin.enrollPrincipal({request,proof:await factory(keyId).sign(Buffer.from(canonical(request)))});
  }
  const author=new AuthorProvenance({admin,signerFactory:factory,now:()=>now});
  const bindings={fixtureDraftHash:sha256('ISOLATED_NON_PRODUCTION_DRAFT'),qualificationSampleId:'pqsample:sha256:'+sha256('ISOLATED_SAMPLE'),fixtureVersion:'1.0'};
  const options={principalId:'horizon-principal:author',keyId:'horizon-principal-key:author'};
  return {dir,admin,author,bindings,options,factory,setTime:t=>now=t,close:()=>rm(dir,{recursive:true,force:true})};
}
const cases=[
  ['valid-author-signature',async f=>{const r=await f.author.sign(f.bindings,f.options);assert.equal(r.verification.status,'VERIFIED');assert.equal((await f.author.verify(r.receipt,f.bindings)).status,'VERIFIED');}],
  ['owner-cannot-author',async f=>{await assert.rejects(f.author.sign(f.bindings,{principalId:'horizon-principal:owner',keyId:'horizon-principal-key:owner'}),/AUTHORIZATION_FAILED/);}],
  ['unknown-author',async f=>{await assert.rejects(f.author.sign(f.bindings,{...f.options,principalId:'horizon-principal:unknown'}),/PRINCIPAL_UNKNOWN/);}],
  ['unknown-key',async f=>{await assert.rejects(f.author.sign(f.bindings,{...f.options,keyId:'horizon-principal-key:unknown'}),/NOT_ENROLLED/);}],
  ['fixture-hash-mismatch',async f=>{const r=await f.author.sign(f.bindings,f.options);await assert.rejects(f.author.verify(r.receipt,{...f.bindings,fixtureDraftHash:'0'.repeat(64)}),/BINDING_MISMATCH/);}],
  ['sample-mismatch',async f=>{const r=await f.author.sign(f.bindings,f.options);await assert.rejects(f.author.verify(r.receipt,{...f.bindings,qualificationSampleId:'pqsample:sha256:'+'0'.repeat(64)}),/BINDING_MISMATCH/);}],
  ['version-mismatch',async f=>{const r=await f.author.sign(f.bindings,f.options);await assert.rejects(f.author.verify(r.receipt,{...f.bindings,fixtureVersion:'2.0'}),/BINDING_MISMATCH/);}],
  ['invalid-signature',async f=>{const r=await f.author.sign(f.bindings,f.options);r.receipt.signature=Buffer.alloc(64).toString('base64');await assert.rejects(f.author.verify(r.receipt,f.bindings),/AUTHENTICATION_FAILED/);}],
  ['tampered-payload',async f=>{const r=await f.author.sign(f.bindings,f.options);r.receipt.payload.authoringOperationNonce='tampered';await assert.rejects(f.author.verify(r.receipt,f.bindings),/BINDING_MISMATCH/);}],
  ['unknown-wrapper-field',async f=>{const r=await f.author.sign(f.bindings,f.options);r.receipt.trusted=true;await assert.rejects(f.author.verify(r.receipt,f.bindings),/INVALID_RECEIPT_SCHEMA/);}],
  ['enrollment-hash-mismatch',async f=>{const r=await f.author.sign(f.bindings,f.options);r.receipt.payload.authorEnrollmentHash='0'.repeat(64);await assert.rejects(f.author.verify(r.receipt,f.bindings),/ENROLLMENT_BINDING_MISMATCH/);}],
  ['corrupt-trust',async f=>{const r=await f.author.sign(f.bindings,f.options);await writeFile(join(f.admin.store,'current.json'),'corrupt');await assert.rejects(f.author.verify(r.receipt,f.bindings),/AUTHORITY_UNAVAILABLE/);}],
  ['principal-revocation',async f=>{const r=await f.author.sign(f.bindings,f.options);f.setTime('2026-10-06T01:01:00.000Z');await f.admin.governance('revoke-principal',{principalId:f.options.principalId,principalKeyId:null,reasonCode:'ADMINISTRATIVE_WITHDRAWAL',invalidFrom:null});await assert.rejects(f.author.verify(r.receipt,f.bindings),/REVOKED/);assert.equal((await f.author.verify(r.receipt,f.bindings,{context:'HISTORICAL_PROOF',evaluationAt:'2026-10-06T01:00:00.000Z'})).status,'VERIFIED');}],
  ['normal-rotation-preserves-historical-signature',async f=>{const r=await f.author.sign(f.bindings,f.options);f.setTime('2026-10-06T01:01:00.000Z');const newKeyId='horizon-principal-key:rotated',newPublicKey=await f.factory(newKeyId).create();await f.admin.governance('rotate-principal-key',{principalId:f.options.principalId,newKeyId,newPublicKey,newKeyProof:p=>f.factory(newKeyId).sign(Buffer.from(canonical(p)))});assert.equal((await f.author.verify(r.receipt,f.bindings)).status,'VERIFIED');await assert.rejects(f.author.sign(f.bindings,f.options),/EXPIRED|REVOKED/);}],
  ['retroactive-compromise',async f=>{const r=await f.author.sign(f.bindings,f.options);f.setTime('2026-10-06T01:02:00.000Z');await f.admin.governance('revoke-principal-key',{principalId:f.options.principalId,principalKeyId:f.options.keyId,reasonCode:'COMPROMISE',invalidFrom:'2026-10-06T01:00:00.000Z'});await assert.rejects(f.author.verify(r.receipt,f.bindings),/REVOKED/);}],
  ['wrong-keychain-handle',async f=>{f.author.signerFactory=()=>f.factory('horizon-principal-key:owner');await assert.rejects(f.author.sign(f.bindings,f.options),/SIGNER_BINDING_MISMATCH/);}],
];
for(const [name,run] of cases)test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.close();}});
