#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {randomUUID} from 'node:crypto';
import {BootstrapAdmin,KeychainSigner,canonical} from '../src/lib/radar-bootstrap/index.mjs';
const [operation,...args]=process.argv.slice(2);
const admin=new BootstrapAdmin();
function display(p){return {result:'AWAITING_OPERATOR_CONFIRMATION',phase92:'IN_PROGRESS',nextGate:'OPERATOR_CONFIRM_BOOTSTRAP_ROOT',operation:'INITIALIZE_ROOT',ceremonyId:p.ceremonyId,bootstrapRootId:p.bootstrapRootId,rootKeyId:p.keyId,publicKeyFingerprint:p.publicKeyFingerprint,rootScope:p.rootScope,targetTrustRegistry:p.targetRegistry,ceremonyVersion:p.ceremonyVersion,securityConsequence:'This fingerprint becomes the initial Horizon trust anchor.',confirmationInstruction:admin.confirmationInstruction(p)};}
async function interactiveConfirmation(instruction){if(!process.stdin.isTTY||!process.stdout.isTTY)throw Object.assign(new Error('AWAITING_OPERATOR_CONFIRMATION'),{code:'AWAITING_OPERATOR_CONFIRMATION'});const rl=createInterface({input:process.stdin,output:process.stdout});try{return await rl.question(instruction+'\nType the exact confirmation above: ');}finally{rl.close();}}
try{
 let result;
 if(operation==='initialize-root')result=display(await admin.prepareRoot());
 else if(operation==='confirm-root'){
  const p=await admin.prepareRoot();console.log(JSON.stringify(display(p),null,2));const confirmation=await interactiveConfirmation(admin.confirmationInstruction(p));result=await admin.activateRoot({confirmation,interactive:true,confirmationRecordId:'interactive-console:'+randomUUID()});result={terminal:'ROOT_VERIFIED',rootId:result.state.roots[0].bootstrapRootId,generation:result.state.generation};
 }else if(operation==='verify'){
  const r=await admin.load();result={terminal:'ROOT_VERIFIED',generation:r.state.generation,roots:r.state.roots.length,principals:r.state.principals.length};
 }else if(operation==='enroll-principal'){
  const values=JSON.parse(await readFile(args[0],'utf8'));const request=await admin.issueEnrollmentRequest(values);const proof=await new KeychainSigner(request.keyId).sign(Buffer.from(canonical(request)));result=await admin.enrollPrincipal({request,proof});
 }else if(['rotate-root','rotate-principal-key','revoke-principal','revoke-principal-key','revoke-root'].includes(operation)){
  const values=operation==='revoke-root'?{}:JSON.parse(await readFile(args[0],'utf8'));if(operation.startsWith('rotate-'))values.newKeyProof=payload=>new KeychainSigner(values.newKeyId).sign(Buffer.from(canonical(payload)));result=await admin.governance(operation,values);
 }else if(operation==='recover-root'){
  const candidate=JSON.parse(await readFile(args[0],'utf8'));const {sha256}=await import('../src/lib/radar-judgment/provider.mjs');const fingerprint=sha256(Buffer.from(candidate.newPublicKey,'base64'));const instruction='CONFIRM RECOVER_ROOT '+candidate.newBootstrapRootId+' '+fingerprint;console.log(JSON.stringify({operation:'RECOVER_ROOT',newRootId:candidate.newBootstrapRootId,keyId:candidate.newKeyId,fingerprint,targetRegistry:admin.store,securityConsequence:'Accept a replacement root; suspend current old-epoch grants.'},null,2));result=await admin.recoverRoot({candidate,confirmation:await interactiveConfirmation(instruction),interactive:true,confirmationRecordId:'interactive-console:'+randomUUID()});
 }else throw Object.assign(new Error('EXPLICIT_BOOTSTRAP_OPERATION_REQUIRED'),{code:'EXPLICIT_BOOTSTRAP_OPERATION_REQUIRED'});
 console.log(JSON.stringify(result,null,2));
}catch(error){console.log(JSON.stringify({result:'BLOCKED',code:error.code??'BOOTSTRAP_SAFE_FAILURE'}));process.exitCode=1;}
