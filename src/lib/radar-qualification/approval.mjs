import {randomUUID} from 'node:crypto';
import {canonical,exact,time,lifecycle,seal,verifySeal,signatureValid,fail} from '../radar-bootstrap/index.mjs';
import {AuthorProvenance} from './author.mjs';
import {fixtureBinding} from './fixture.mjs';
import {QualificationStore,digest} from './store.mjs';

const KEYS=['approvalType','approvalReceiptVersion','approvalId','ownerId','keyId','signedAt','operationId','operationNonce','qualificationSampleId','fixtureVersion','fixtureHash','evidenceHash','projectedEvidenceHash','projectionMapHash','rubricId','rubricVersion','rubricHash','qualificationProtocolVersion','providerTarget','modelTarget','schemaVersion','schemaHash','fixtureAuthorId','authorPrincipalId','authorProvenanceHash','reviewStateHash','decision','previousApprovalId'];
const REVOCATION_KEYS=['revocationType','revocationReceiptVersion','revocationId','approvalId','fixtureHash','ownerId','keyId','signedAt','revokedAt','reasonCode','invalidFrom','operationId','operationNonce'];
const rules=[['authorityUnavailable','APPROVAL_AUTHORITY_UNAVAILABLE'],['receiptCorrupt','APPROVAL_RECEIPT_CORRUPT'],['bindingMismatch','APPROVAL_BINDING_MISMATCH'],['conflictingApproval','BLOCKED_CONFLICTING_APPROVAL'],['authenticationFailed','APPROVAL_AUTHENTICATION_FAILED'],['authorizationFailed','APPROVAL_AUTHORIZATION_FAILED'],['keyRevoked','APPROVAL_KEY_REVOKED'],['ownerRevoked','APPROVAL_OWNER_REVOKED'],['expired','APPROVAL_EXPIRED'],['signatureInvalid','APPROVAL_SIGNATURE_INVALID'],['approvalRevoked','APPROVAL_REVOKED'],['notApproved','NOT_APPROVED']];
const eq=(a,b)=>canonical(a)===canonical(b);
function owner(trust,ownerId,keyId,at,{current=false}={}){
  const p=trust.state.principals.find(p=>p.roleBindings.ownerId===ownerId);if(!p)fail('APPROVAL_AUTHENTICATION_FAILED');
  const key=p.keys.find(k=>k.keyId===keyId);if(!key)fail('APPROVAL_AUTHENTICATION_FAILED');
  if(!eq(p.roles,['HORIZON_RADAR_OWNER'])||!eq(p.scopes,['PROVIDER_QUALIFICATION_FIXTURE_APPROVAL']))fail('APPROVAL_AUTHORIZATION_FAILED');
  lifecycle(p,at,{current});lifecycle(key,at,{current});return {principal:p,key};
}
function bindings(row,b){const f=row.fixture;return {qualificationSampleId:b.qualificationSampleId,fixtureVersion:f.fixtureVersion,fixtureHash:b.fixtureHash,evidenceHash:b.evidenceFixtureHash,projectedEvidenceHash:b.projectedEvidenceHash,projectionMapHash:b.projectionMapHash,rubricId:f.rubricId,rubricVersion:f.rubricVersion,rubricHash:f.rubricHash,qualificationProtocolVersion:f.qualificationProtocolVersion,providerTarget:f.providerTarget,modelTarget:f.modelTarget,schemaVersion:f.expectedSchemaVersion,schemaHash:f.expectedSchemaHash,fixtureAuthorId:row.authorProvenance.payload.fixtureAuthorId,authorPrincipalId:row.authorProvenance.payload.fixtureAuthorPrincipalId,authorProvenanceHash:digest(row.authorProvenance),reviewStateHash:digest(row.review)};}

/** The canonical fixture authority service is the sole path to signed approval/revocation transitions. */
export class FixtureAuthority {
  constructor({store=new QualificationStore(),rubric,author=new AuthorProvenance({admin:store.admin,signerFactory:store.signerFactory,now:store.now})}={}){this.store=store;this.rubric=rubric;this.author=author;}
  async createDraft(fixture,{principalId,keyId}){
    return this.store.locked('CREATE_FIXTURE_DRAFT',async()=>{
      const s=await this.store.load({allowEmpty:true});if(s.state.fixtures.length)fail('QUALIFICATION_ONE_FIXTURE_ALREADY_EXISTS');
      const b=fixtureBinding(fixture,this.rubric),signed=await this.author.sign({fixtureDraftHash:b.fixtureHash,qualificationSampleId:b.qualificationSampleId,fixtureVersion:fixture.fixtureVersion},{principalId,keyId});
      const row={qualificationSampleId:b.qualificationSampleId,fixture:structuredClone(fixture),fixtureHash:b.fixtureHash,state:'DRAFT',authorProvenance:signed.receipt,review:null,approval:null,revocations:[]};
      const state=structuredClone(s.state);state.fixtures.push(row);state.audits.push({operation:'CREATE_FIXTURE_DRAFT',sampleId:b.qualificationSampleId,fixtureHash:b.fixtureHash,authorProvenanceHash:digest(signed.receipt),createdAt:this.store.now()});
      await this.store.commit(state,{principalId,keyId});return {state:'DRAFT',...b,authorProvenance:signed.verification};
    });
  }
  async review(sampleId,{principalId,keyId}){
    return this.store.locked('REVIEW_FIXTURE',async()=>{
      const s=await this.store.load(),row=s.state.fixtures.find(r=>r.qualificationSampleId===sampleId);if(!row||row.state!=='DRAFT')fail('FIXTURE_REVIEW_STATE_REQUIRED');
      const b=fixtureBinding(row.fixture,this.rubric);if(row.fixtureHash!==b.fixtureHash||sampleId!==b.qualificationSampleId||row.authorProvenance.payload.fixtureAuthorPrincipalId!==principalId||row.authorProvenance.payload.authorKeyId!==keyId)fail('AUTHOR_PROVENANCE_FAILURE');
      const proof=await this.author.verify(row.authorProvenance,{fixtureDraftHash:b.fixtureHash,qualificationSampleId:sampleId,fixtureVersion:row.fixture.fixtureVersion});
      row.review={state:'REVIEW',qualificationSampleId:sampleId,fixtureHash:b.fixtureHash,evidenceHash:b.evidenceFixtureHash,authorProvenanceHash:proof.authorProvenanceHash,createdAt:this.store.now(),previousState:'DRAFT'};
      row.state='REVIEW';s.state.audits.push({operation:'REVIEW_FIXTURE',sampleId,reviewStateHash:digest(row.review),createdAt:this.store.now()});await this.store.commit(s.state,{principalId,keyId});return {state:'REVIEW',reviewStateHash:digest(row.review)};
    });
  }
  async authenticate(row,action,actor,trust){
    const issuedAt=this.store.now(),{principal,key}=owner(trust,actor.ownerId,actor.keyId,issuedAt,{current:true});
    if(principal.principalId===row.authorProvenance.payload.fixtureAuthorPrincipalId||key.publicKey===trust.state.principals.find(p=>p.principalId===row.authorProvenance.payload.fixtureAuthorPrincipalId)?.keys.find(k=>k.keyId===row.authorProvenance.payload.authorKeyId)?.publicKey)fail('APPROVAL_AUTHORIZATION_FAILED');
    const expiry=Math.min(time(issuedAt)+60000,...[principal.validUntil,key.validUntil].filter(Boolean).map(time));
    const challenge={authenticationType:'PROVIDER_FIXTURE_AUTHORITY_OPERATION_AUTHENTICATION_1.0',ownerId:actor.ownerId,keyId:actor.keyId,operationId:randomUUID(),operationNonce:randomUUID(),action,qualificationSampleId:row.qualificationSampleId,approvalId:row.approval?.payload.approvalId??null,issuedAt,expiresAt:new Date(expiry).toISOString(),trustSnapshotHash:trust.head,fixtureHash:row.fixtureHash,providerTarget:row.fixture.providerTarget,modelTarget:row.fixture.modelTarget};
    const signer=this.store.signerFactory(actor.keyId);if(await signer.public()!==key.publicKey)fail('APPROVAL_AUTHENTICATION_FAILED');
    const signature=await signer.sign(Buffer.from(canonical(challenge)));
    if(!signatureValid(challenge,signature,key.publicKey)||time(this.store.now())>expiry||(await this.store.admin.load()).head!==trust.head)fail('APPROVAL_AUTHENTICATION_FAILED');
    return {challenge,signature,signer,principal,key};
  }
  async approve(sampleId,actor){
    return this.store.locked('APPROVE_FIXTURE',async()=>{
      const s=await this.store.load(),row=s.state.fixtures.find(r=>r.qualificationSampleId===sampleId);if(!row)fail('NOT_APPROVED');
      const trust=await this.store.admin.load();const auth=await this.authenticate(row,row.approval?'IDEMPOTENT_LOOKUP':'APPROVE',actor,trust);
      if(row.approval){const v=await this.verify(sampleId);if(v.verificationState!=='APPROVED_VERIFIED')fail(v.verificationState);return {operationDisposition:'IDEMPOTENT_EXISTING_APPROVAL',receipt:row.approval,verification:v};}
      if(row.state!=='REVIEW'||!row.review)fail('NOT_APPROVED');
      const b=fixtureBinding(row.fixture,this.rubric);if(row.fixtureHash!==b.fixtureHash||sampleId!==b.qualificationSampleId||row.review.fixtureHash!==b.fixtureHash||row.review.evidenceHash!==b.evidenceFixtureHash||row.review.authorProvenanceHash!==digest(row.authorProvenance))fail('APPROVAL_BINDING_MISMATCH');
      await this.author.verify(row.authorProvenance,{fixtureDraftHash:b.fixtureHash,qualificationSampleId:sampleId,fixtureVersion:row.fixture.fixtureVersion});
      const signedAt=this.store.now();owner(trust,actor.ownerId,actor.keyId,signedAt,{current:true});
      const receipt=await seal({approvalType:'PROVIDER_QUALIFICATION_FIXTURE_APPROVAL',approvalReceiptVersion:'1.0',ownerId:actor.ownerId,keyId:actor.keyId,signedAt,operationId:auth.challenge.operationId,operationNonce:auth.challenge.operationNonce,...bindings(row,b),decision:'APPROVED',previousApprovalId:null},'approvalId','pqapproval',auth.signer);
      verifySeal(receipt,'approvalId','pqapproval',auth.key.publicKey,KEYS);
      if(time(this.store.now())>time(auth.challenge.expiresAt)||(await this.store.admin.load()).head!==trust.head||(await this.store.load()).head!==s.head)fail('APPROVAL_AUTHORITY_UNAVAILABLE');
      row.approval=receipt;row.state='APPROVED';s.state.audits.push({operation:'APPROVE_FIXTURE',sampleId,receiptHash:digest(receipt),authentication:{challenge:auth.challenge,signature:auth.signature},createdAt:this.store.now()});
      await this.store.commit(s.state,{principalId:auth.principal.principalId,keyId:actor.keyId});
      const verification=await this.verify(sampleId);if(verification.verificationState!=='APPROVED_VERIFIED')fail(verification.verificationState);
      return {operationDisposition:'APPROVED',receipt,verification};
    });
  }
  async verify(sampleId,{context='AUTHORIZE_QUALIFICATION',evaluationAt=this.store.now(),targets=null,diagnosticReceipt=null}={}){
    const failures=new Set(),stages=[];let s,trust,row,b,p,resolved,receipt;
    const stage=(n,name,ok)=>stages.push({step:n,name,status:ok?'PASS':'FAIL'});
    try{time(evaluationAt);if(!['AUTHORIZE_QUALIFICATION','HISTORICAL_PROOF','NEW_APPROVAL'].includes(context))fail('APPROVAL_AUTHORITY_UNAVAILABLE');s=await this.store.load();trust=await this.store.admin.load();row=s.state.fixtures.find(r=>r.qualificationSampleId===sampleId);if(!row)fail('APPROVAL_AUTHORITY_UNAVAILABLE');}catch{failures.add('authorityUnavailable');}
    receipt=diagnosticReceipt??row?.approval;
    stage(1,'Parse receipt',!!receipt);if(!receipt)failures.add('notApproved');
    if(receipt){try{exact(receipt,['payload','canonicalPayloadHash','signature']);exact(receipt.payload,KEYS);p=receipt.payload;time(p.signedAt);if(p.approvalType!=='PROVIDER_QUALIFICATION_FIXTURE_APPROVAL'||p.approvalReceiptVersion!=='1.0'||p.decision!=='APPROVED'||p.previousApprovalId!==null||typeof receipt.signature!=='string'||Buffer.from(receipt.signature,'base64').length!==64||Buffer.from(receipt.signature,'base64').toString('base64')!==receipt.signature)fail('SCHEMA');stage(2,'Strict schema/encoding',true);}catch{failures.add('receiptCorrupt');stage(2,'Strict schema/encoding',false);p=null;}}
    if(row){try{b=fixtureBinding(row.fixture,this.rubric);if(row.fixtureHash!==b.fixtureHash||sampleId!==b.qualificationSampleId)fail('BINDING');stage(3,'Fixture hash',true);stage(4,'Evidence/projection/sample identities',true);}catch{failures.add('bindingMismatch');stage(3,'Fixture hash',false);stage(4,'Evidence/projection/sample identities',false);}}
    if(p&&row&&b){try{if(!row.review||row.review.state!=='REVIEW'||row.review.fixtureHash!==b.fixtureHash||row.review.evidenceHash!==b.evidenceFixtureHash||row.review.authorProvenanceHash!==digest(row.authorProvenance)||Object.entries(bindings(row,b)).some(([k,v])=>!eq(p[k],v))||(targets&&(!eq(targets.providerTarget,p.providerTarget)||!eq(targets.modelTarget,p.modelTarget))))fail('BINDING');await this.author.verify(row.authorProvenance,{fixtureDraftHash:b.fixtureHash,qualificationSampleId:sampleId,fixtureVersion:row.fixture.fixtureVersion},{evaluationAt,context:context==='HISTORICAL_PROOF'?'HISTORICAL_PROOF':'REVIEW'});stage(5,'All exact bindings and author provenance',true);}catch{failures.add('bindingMismatch');stage(5,'All exact bindings and author provenance',false);}}
    if(p&&trust){const principal=trust.state.principals.find(q=>q.roleBindings.ownerId===p.ownerId);stage(6,'Resolve owner',!!principal);const key=principal?.keys.find(k=>k.keyId===p.keyId);stage(7,'Resolve owner key',!!key);if(!principal||!key)failures.add('authenticationFailed');else{resolved={principal,key};
      if(!eq(principal.roles,['HORIZON_RADAR_OWNER'])||!eq(principal.scopes,['PROVIDER_QUALIFICATION_FIXTURE_APPROVAL'])||principal.principalId===p.authorPrincipalId||trust.state.roots.some(r=>r.publicKey===key.publicKey)||trust.state.principals.some(q=>q.principalId===p.authorPrincipalId&&q.keys.some(k=>k.publicKey===key.publicKey)))failures.add('authorizationFailed');stage(8,'Scope/separation',!failures.has('authorizationFailed'));
      const outside=(r,at)=>time(at)<time(r.validFrom)||(r.validUntil!==null&&time(at)>time(r.validUntil));
      if(outside(principal,p.signedAt)||outside(key,p.signedAt)||(context!=='HISTORICAL_PROOF'&&outside(principal,evaluationAt)))failures.add('expired');
      if(key.revokedAt!==null&&time(p.signedAt)>=time(key.invalidFrom??key.revokedAt))failures.add('keyRevoked');
      if((principal.revokedAt!==null&&time(p.signedAt)>=time(principal.invalidFrom??principal.revokedAt))||(context!=='HISTORICAL_PROOF'&&principal.status!=='ACTIVE'))failures.add('ownerRevoked');
      if(context==='NEW_APPROVAL'&&key.status!=='ACTIVE')failures.add('authorizationFailed');stage(9,'Signing/current owner lifetime',!failures.has('expired'));stage(10,'Effective revocation',!failures.has('keyRevoked')&&!failures.has('ownerRevoked'));
    }}
    if(p){const base={...p};delete base.approvalId;const idValid=p.approvalId==='pqapproval:sha256:'+digest(base);if(!idValid)failures.add('bindingMismatch');stage(11,'Canonical approval identity',idValid);const hashValid=receipt.canonicalPayloadHash===digest(p);if(!hashValid)failures.add('bindingMismatch');stage(12,'Canonical payload hash',hashValid);if(resolved){const valid=signatureValid(p,receipt.signature,resolved.key.publicKey);if(!valid)failures.add('signatureInvalid');stage(13,'Ed25519 signature',valid);}}
    if(row&&s){
      if(row.state!=='APPROVED'||!row.approval||!eq(row.approval,receipt)||!s.state.audits.some(a=>a.operation==='APPROVE_FIXTURE'&&a.sampleId===sampleId&&a.receiptHash===digest(row.approval)))failures.add('notApproved');
      for(const r of row.revocations){try{if(!resolved)fail('AUTHORITY');const rp=r.payload,revActor=owner(trust,rp.ownerId,rp.keyId,rp.signedAt);verifySeal(r,'revocationId','pqrevocation',revActor.key.publicKey,REVOCATION_KEYS);if(rp.approvalId!==row.approval?.payload.approvalId||rp.fixtureHash!==row.fixtureHash)fail('BINDING');const cutoff=rp.invalidFrom??rp.revokedAt;if(time(evaluationAt)>=time(cutoff))failures.add('approvalRevoked');}catch{failures.add('authorityUnavailable');}}
      stage(14,'Committed state/audit/revocation/context',!failures.has('notApproved')&&!failures.has('approvalRevoked'));
    }
    const known=rules.filter(([predicate])=>failures.has(predicate));const verificationState=known[0]?.[1]??'APPROVED_VERIFIED';stage(15,'One terminal',true);
    // Success requires every dependent verification stage, never defaults a missing check to true.
    if(verificationState==='APPROVED_VERIFIED'&&(stages.length!==15||stages.some(s=>s.status!=='PASS')))return {verificationState:'APPROVAL_AUTHORITY_UNAVAILABLE',reasonCodes:['INCOMPLETE_VERIFICATION'],stages,executionAuthorized:false};
    return {verificationState,reasonCodes:known.map(r=>r[1]),context,approvalId:p?.approvalId??null,stages,executionAuthorized:false};
  }
  async revoke(sampleId,actor,{reasonCode='ADMINISTRATIVE_WITHDRAWAL',invalidFrom=null}={}){
    return this.store.locked('REVOKE_FIXTURE',async()=>{const s=await this.store.load(),row=s.state.fixtures.find(r=>r.qualificationSampleId===sampleId);if(!row?.approval)fail('NOT_APPROVED');const trust=await this.store.admin.load(),auth=await this.authenticate(row,'REVOKE',actor,trust),at=this.store.now();if(!['ADMINISTRATIVE_WITHDRAWAL','FIXTURE_INTEGRITY_COMPROMISE'].includes(reasonCode)||(reasonCode==='ADMINISTRATIVE_WITHDRAWAL'?invalidFrom!==null:invalidFrom===null||time(invalidFrom)>time(at)))fail('APPROVAL_REVOCATION_INVALID');
      const receipt=await seal({revocationType:'PROVIDER_QUALIFICATION_FIXTURE_REVOCATION',revocationReceiptVersion:'1.0',approvalId:row.approval.payload.approvalId,fixtureHash:row.fixtureHash,ownerId:actor.ownerId,keyId:actor.keyId,signedAt:at,revokedAt:at,reasonCode,invalidFrom,operationId:auth.challenge.operationId,operationNonce:auth.challenge.operationNonce},'revocationId','pqrevocation',auth.signer);verifySeal(receipt,'revocationId','pqrevocation',auth.key.publicKey,REVOCATION_KEYS);row.revocations.push(receipt);row.state='REVOKED';s.state.audits.push({operation:'REVOKE_FIXTURE',receiptHash:digest(receipt),sampleId,createdAt:at});await this.store.commit(s.state,{principalId:auth.principal.principalId,keyId:actor.keyId});return receipt;});
  }
}
