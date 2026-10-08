import {randomUUID} from 'node:crypto';
import {BootstrapAdmin, KeychainSigner, canonical, sha256, exact, time, lifecycle, seal, verifySeal, fail} from '../radar-bootstrap/index.mjs';

const ROLE = 'PROVIDER_QUALIFICATION_FIXTURE_AUTHOR';
const SCOPE = 'PROVIDER_QUALIFICATION_FIXTURE_AUTHORING';
const KEYS = ['receiptType','receiptVersion','authoringId','fixtureAuthorId','fixtureAuthorPrincipalId','authorKeyId','authoredAt','fixtureDraftHash','qualificationSampleId','fixtureVersion','authoringOperationId','authoringOperationNonce','authorEnrollmentId','authorEnrollmentHash'];
const BINDINGS = ['fixtureDraftHash','qualificationSampleId','fixtureVersion'];
const same = (a,b) => canonical(a) === canonical(b);

function validateBindings(bindings) {
  exact(bindings, BINDINGS);
  if (!/^[a-f0-9]{64}$/.test(bindings.fixtureDraftHash) ||
      !/^pqsample:sha256:[a-f0-9]{64}$/.test(bindings.qualificationSampleId) ||
      typeof bindings.fixtureVersion !== 'string' || !bindings.fixtureVersion || bindings.fixtureVersion.length > 200) fail('AUTHOR_PROVENANCE_FAILURE');
}

function resolveAuthor(snapshot, principalId, keyId, at, current) {
  const principal = snapshot.state.principals.find(p => p.principalId === principalId);
  if (!principal) fail('AUTHOR_PRINCIPAL_UNKNOWN');
  if (!same(principal.roles,[ROLE]) || !same(principal.scopes,[SCOPE]) ||
      principal.roleBindings.principalId !== principalId) fail('AUTHOR_AUTHORIZATION_FAILED');
  lifecycle(principal, at, {current});
  const key = principal.keys.find(k => k.keyId === keyId);
  lifecycle(key, at, {current});
  if (snapshot.state.roots.some(r => r.publicKey === key.publicKey) ||
      snapshot.state.principals.some(p => p.principalId !== principalId && p.keys.some(k => k.publicKey === key.publicKey))) fail('AUTHOR_APPROVER_SEPARATION_FAILED');
  const enrollment = snapshot.state.receipts.find(r => r.payload.enrollmentId === principal.enrollmentId);
  if (!enrollment || enrollment.payload.principalId !== principalId ||
      !same(enrollment.payload.roles,[ROLE]) || !same(enrollment.payload.scopes,[SCOPE]) ||
      !same(enrollment.payload.roleBindings,principal.roleBindings)) fail('AUTHOR_ENROLLMENT_BINDING_MISMATCH');
  return {principal,key,enrollment};
}

/** Trust is always independently loaded and replayed by BootstrapAdmin; receipt keys are never trust inputs. */
export class AuthorProvenance {
  constructor({admin = new BootstrapAdmin(), signerFactory = keyId => new KeychainSigner(keyId), now = () => new Date().toISOString()} = {}) {
    this.admin = admin; this.signerFactory = signerFactory; this.now = now;
  }

  async verify(receipt, bindings, {evaluationAt = this.now(), context = 'REVIEW'} = {}) {
    if (!['REVIEW','HISTORICAL_PROOF'].includes(context)) fail('AUTHOR_CONTEXT_INVALID');
    validateBindings(bindings); time(evaluationAt);
    exact(receipt,['payload','canonicalPayloadHash','signature']); exact(receipt.payload,KEYS);
    const p = receipt.payload; time(p.authoredAt);
    if (p.receiptType !== 'PROVIDER_QUALIFICATION_FIXTURE_AUTHORING_1.0' || p.receiptVersion !== '1.0' ||
        time(p.authoredAt) > time(evaluationAt) ||
        !/^horizon-principal:[a-z0-9][a-z0-9._-]*$/.test(p.fixtureAuthorPrincipalId) ||
        !/^horizon-author:[a-z0-9][a-z0-9._-]*$/.test(p.fixtureAuthorId) ||
        !/^horizon-principal-key:[a-z0-9][a-z0-9._-]*$/.test(p.authorKeyId) ||
        !/^[a-f0-9]{64}$/.test(p.authorEnrollmentHash) ||
        !/^principal-enrollment:sha256:[a-f0-9]{64}$/.test(p.authorEnrollmentId) ||
        ![p.authoringOperationId,p.authoringOperationNonce].every(v => typeof v === 'string' && /^[a-z0-9][a-z0-9:._-]{1,200}$/.test(v))) fail('AUTHOR_PROVENANCE_FAILURE');
    if (BINDINGS.some(k => p[k] !== bindings[k])) fail('AUTHOR_FIXTURE_BINDING_MISMATCH');
    const snapshot = await this.admin.load();
    const resolved = resolveAuthor(snapshot,p.fixtureAuthorPrincipalId,p.authorKeyId,p.authoredAt,false);
    if (context === 'REVIEW') {
      // Current role/principal authorization is mandatory; a retired historical signing key remains verifiable.
      lifecycle(resolved.principal,evaluationAt,{current:true});
    }
    if (p.fixtureAuthorId !== resolved.principal.roleBindings.fixtureAuthorId ||
        p.authorEnrollmentId !== resolved.principal.enrollmentId ||
        p.authorEnrollmentHash !== sha256(canonical(resolved.enrollment))) fail('AUTHOR_ENROLLMENT_BINDING_MISMATCH');
    verifySeal(receipt,'authoringId','fixture-authoring',resolved.key.publicKey,KEYS);
    return {status:'VERIFIED',authorAuthentication:'PASS',authorAuthorization:'PASS',context,
      authoringId:p.authoringId,authorProvenanceHash:sha256(canonical(receipt)),authorityHead:snapshot.head};
  }

  async sign(bindings, {principalId,keyId} = {}) {
    validateBindings(bindings);
    const authoredAt = this.now(); time(authoredAt);
    const snapshot = await this.admin.load();
    const {principal,key,enrollment} = resolveAuthor(snapshot,principalId,keyId,authoredAt,true);
    const signer = this.signerFactory(keyId);
    if (await signer.public() !== key.publicKey) fail('AUTHOR_SIGNER_BINDING_MISMATCH');
    const receipt = await seal({receiptType:'PROVIDER_QUALIFICATION_FIXTURE_AUTHORING_1.0',receiptVersion:'1.0',
      fixtureAuthorId:principal.roleBindings.fixtureAuthorId,fixtureAuthorPrincipalId:principalId,
      authorKeyId:keyId,authoredAt,...bindings,authoringOperationId:randomUUID(),authoringOperationNonce:randomUUID(),
      authorEnrollmentId:principal.enrollmentId,authorEnrollmentHash:sha256(canonical(enrollment))},
      'authoringId','fixture-authoring',signer);
    // Reload authority after external signing; a stale snapshot never permits REVIEW.
    const verified = await this.verify(receipt,bindings);
    if (verified.authorityHead !== snapshot.head) fail('AUTHOR_AUTHORITY_CHANGED_DURING_SIGNING');
    return {receipt,verification:verified};
  }
}
