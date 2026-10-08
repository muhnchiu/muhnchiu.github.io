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

export async function setup({providerTarget,modelTarget}={}){
  const dir=await mkdtemp(join(tmpdir(),'horizon-fixture-authority-test-'));let at='2026-10-06T01:00:00.000Z',fault=null;
  const keys=new Map();const signerFactory=ref=>({ref,async create(){keys.set(ref,generateKeyPairSync('ed25519'));return this.public();},async public(){return keys.get(ref).publicKey.export({type:'spki',format:'der'}).toString('base64');},async sign(bytes){return sign(null,bytes,keys.get(ref).privateKey).toString('base64');}});
  const admin=new BootstrapAdmin({store:join(dir,'bootstrap'),anchor:join(dir,'root-anchor'),signerFactory,now:()=>at});const pending=await admin.prepareRoot();await admin.activateRoot({confirmation:admin.confirmationInstruction(pending),interactive:true,confirmationRecordId:'ISOLATED_TEST_CONFIRMATION'});
  for(const type of ['author','owner']){const keyId='horizon-principal-key:'+type,principalId='horizon-principal:'+type;const request=await admin.issueEnrollmentRequest({principalId,principalType:'CRYPTOGRAPHIC_OPERATOR_PRINCIPAL',displayLabel:null,principalCreatedAt:at,keyId,publicKey:await signerFactory(keyId).create(),requestedRoles:[type==='author'?'PROVIDER_QUALIFICATION_FIXTURE_AUTHOR':'HORIZON_RADAR_OWNER'],requestedScopes:[type==='author'?'PROVIDER_QUALIFICATION_FIXTURE_AUTHORING':'PROVIDER_QUALIFICATION_FIXTURE_APPROVAL'],roleBindings:{[type==='author'?'fixtureAuthorId':'ownerId']:(type==='author'?'horizon-author:':'horizon-owner:')+type,principalId},validFrom:at,validUntil:null});await admin.enrollPrincipal({request,proof:await signerFactory(keyId).sign(Buffer.from(canonical(request)))});}
  const rubric=await loadRubric();const store=new QualificationStore({store:join(dir,'qualification'),anchor:join(dir,'qualification-anchor'),admin,signerFactory,now:()=>at,fault:p=>{if(p===fault)throw Error('INJECTED_AUDIT_FAILURE');}});
  const service=new FixtureAuthority({store,rubric});
  const target={providerId:'ISOLATED_TEST',adapterVersion:'1.0',adapterHash:sha256('test-adapter'),endpointClass:'ISOLATED_NO_TRANSPORT',authenticationMechanism:'ISOLATED_TEST',credentialSourceRef:'NO_CREDENTIAL',authenticationBindingRevision:'ISOLATED_TEST_REVISION'};
  const model={modelId:'ISOLATED_TEST',observableVersionStatus:'UNOBSERVABLE',observableVersion:null,configurationFingerprint:sha256('test-config')};
  const fixture=createAuthoredFixture({rubric,providerTarget:providerTarget??target,modelTarget:modelTarget??model,observedAt:at});const b=fixtureBinding(fixture,rubric);
  const author={principalId:'horizon-principal:author',keyId:'horizon-principal-key:author'},actor={ownerId:'horizon-owner:owner',keyId:'horizon-principal-key:owner'};
  await service.createDraft(fixture,author);
  return {dir,admin,store,service,fixture,b,author,actor,signerFactory,rubric,setTime:v=>at=v,setFault:v=>fault=v,review:()=>service.review(b.qualificationSampleId,author),approve:()=>service.approve(b.qualificationSampleId,actor),close:()=>rm(dir,{recursive:true,force:true})};
}
