import {canonical,sha256} from '../radar-judgment/provider.mjs';
import {KeychainSigner,signatureValid,publicKey,fail} from '../radar-bootstrap/index.mjs';
const tags={HUMAN_VALIDATOR:'hv',DOMAIN_REVIEWER:'dr'};
export function testKeyBinding({subjectType,principalId,keyId}){
 if(!tags[subjectType]||!/^horizon-principal:[a-z0-9][a-z0-9._-]*$/.test(principalId)||!/^horizon-principal-key:[a-z0-9][a-z0-9._-]*$/.test(keyId))fail('REJECTED_KEY_BINDING');
 const tuple={namespaceVersion:'1.0',phase:'9.2',environment:'NON_PRODUCTION_TEST',subjectType,principalId,keyId};
 return {tuple,service:'horizon.authority.ed25519',account:`horizon:p92:npt:${tags[subjectType]}:${sha256(canonical(tuple))}`};
}
/** Never exposes private bytes. Authorization and trusted metadata must precede each helper call. */
export class TestSubjectKey {
 constructor(metadata,{signerFactory=ref=>new KeychainSigner(ref),authorize}={}){this.metadata=metadata;this.authorize=authorize;const binding=testKeyBinding(metadata);if(metadata.account&&metadata.account!==binding.account)fail('REJECTED_KEY_BINDING');this.binding=binding;this.signer=signerFactory(binding.account);}
 async checkedPublic(){if(await this.authorize?.('LOOKUP',this.metadata)!==true)fail('REJECTED_SIGNING_AUTHORITY');const key=await this.signer.public();publicKey(key);if(key!==this.metadata.publicKey||sha256(Buffer.from(key,'base64'))!==this.metadata.fingerprint)fail('REJECTED_KEY_BINDING');return key;}
 async activation(){if(await this.authorize?.('ACTIVATION_POP',this.metadata)!==true)fail('KEY_NOT_ACTIVATED');const key=await this.signer.create();publicKey(key);const retrieved=await this.signer.public();if(key!==retrieved)fail('KEY_NOT_ACTIVATED');const fingerprint=sha256(Buffer.from(key,'base64')),challenge={operation:'ACTIVATION_POP',...this.binding.tuple,keyKind:this.metadata.keyKind,publicKey:key,fingerprint};const signature=await this.signer.sign(Buffer.from(canonical(challenge)));if(!signatureValid(challenge,signature,key))fail('KEY_NOT_ACTIVATED');this.metadata={...this.metadata,...this.binding,publicKey:key,fingerprint,activationProof:{payload:challenge,signature},storageBackend:'MACOS_KEYCHAIN_ONLY'};return this.metadata;}
 async sign(payload,{operation,environment}={}){if(environment!=='NON_PRODUCTION_TEST'||!['ENROLLMENT_POP','ROTATION_POP','BUSINESS_SIGNING'].includes(operation))fail('REJECTED_PRODUCTION_USE');if(await this.authorize?.(operation,this.metadata,payload)!==true)fail('REJECTED_SIGNING_AUTHORITY');await this.checkedPublic();return this.signer.sign(Buffer.from(canonical(payload)));}
 async teardown(){if(await this.authorize?.('TEARDOWN',this.metadata)!==true)fail('TEST_KEY_TEARDOWN_TARGET_INVALID');const result=await this.signer.call('delete');if(result.result!=='TEST_KEY_ENTRY_ABSENT')fail('TEST_KEY_TEARDOWN_INCOMPLETE');return {result:'TEST_KEY_TEARDOWN_COMPLETE',principalId:this.metadata.principalId,keyId:this.metadata.keyId,account:this.binding.account};}
}
