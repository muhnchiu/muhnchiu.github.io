import {mkdir,open,readFile,rename,unlink,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {BootstrapAdmin,KeychainSigner,canonical,sha256,exact,lifecycle,signatureValid,time,fail} from '../radar-bootstrap/index.mjs';

export const DEFAULT_QUALIFICATION_STORE=join(homedir(),'.local/state/horizon-provider-qualification');
export const DEFAULT_QUALIFICATION_ANCHOR=join(homedir(),'.local/share/horizon-qualification-anchors');
export const digest=v=>sha256(canonical(v));
export async function syncDirectory(path){const f=await open(path,'r');try{await f.sync();}finally{await f.close();}}
export async function durableNew(path,value){const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}await syncDirectory(resolve(path,'..'));}
async function replace(path,value){const temp=path+'.'+randomUUID()+'.tmp';await durableNew(temp,value);await rename(temp,path);await syncDirectory(resolve(path,'..'));}
async function dir(path){await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0)fail('QUALIFICATION_STORE_UNSAFE');}
async function read(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')throw e;fail('QUALIFICATION_STORE_CORRUPT');}}

/** Independent signed history and accepted head. PREPARED or mismatched pair never serves authority. */
export class QualificationStore {
  constructor({store=DEFAULT_QUALIFICATION_STORE,anchor=DEFAULT_QUALIFICATION_ANCHOR,admin=new BootstrapAdmin(),signerFactory=ref=>new KeychainSigner(ref),now=()=>new Date().toISOString(),fault=()=>{}}={}){
    this.store=resolve(store);this.anchor=resolve(anchor);this.admin=admin;this.signerFactory=signerFactory;this.now=now;this.fault=fault;this.held=false;
    if([join(homedir(),'.local/state/horizon-production'),join(homedir(),'.local/state/horizon-canary')].some(p=>this.store===p||this.store.startsWith(p+'/')||this.anchor===p||this.anchor.startsWith(p+'/')))fail('PRODUCTION_WRITE_NOT_AUTHORIZED');
  }
  async locked(operation,fn){
    await dir(this.store);await dir(this.anchor);await dir(join(this.store,'transactions'));await dir(join(this.store,'audit'));await dir(join(this.store,'journals'));
    const path=join(this.store,'authority.lock');let lock;
    try{lock=await open(path,'wx',0o600);}catch{fail('QUALIFICATION_LOCK_UNAVAILABLE');}
    const id=randomUUID();this.held=true;
    try{await lock.writeFile(canonical({pid:process.pid,startedAt:this.now(),transactionId:id,operation}));await lock.sync();
      this.fault('audit-start');await durableNew(join(this.store,'audit',id+'-start.json'),{id,operation,status:'STARTED',startedAt:this.now()});
      const result=await fn();this.fault('audit-result');await durableNew(join(this.store,'audit',id+'-result.json'),{id,operation,status:'COMPLETED',completedAt:this.now(),resultHash:digest(result??null)});return result;
    }catch(error){try{await durableNew(join(this.store,'audit',id+'-failure.json'),{id,operation,status:'FAILED',completedAt:this.now(),code:error.code??'SAFE_OPERATION_FAILURE'});}catch{}throw error;
    }finally{this.held=false;await lock.close();await unlink(path);await syncDirectory(this.store);}
  }
  async load({allowEmpty=false}={}){
    let pointer,anchor;
    try{pointer=await read(join(this.store,'current.json'));}catch(e){if(e.code==='ENOENT'&&allowEmpty){try{await lstat(join(this.anchor,'current.json'));}catch(a){if(a.code==='ENOENT')return {head:null,generation:0,state:{version:'1.0',fixtures:[],audits:[],control:{state:'DISABLED'},runs:[]}};}fail('QUALIFICATION_STORE_CORRUPT');}if(e.code==='QUALIFICATION_STORE_CORRUPT')throw e;fail('QUALIFICATION_STORE_UNAVAILABLE');}
    try{anchor=await read(join(this.anchor,'current.json'));}catch{fail('QUALIFICATION_STORE_UNAVAILABLE');}
    exact(pointer,['head','generation','transactionId']);exact(anchor,['head','generation','transactionId']);
    if(canonical(pointer)!==canonical(anchor)||!Number.isInteger(pointer.generation)||pointer.generation<1||!/^[a-f0-9]{64}$/.test(pointer.head))fail('QUALIFICATION_STORE_CORRUPT');
    const trust=await this.admin.load();let cursor=pointer,latest;
    for(let generation=pointer.generation;generation>=1;generation--){
      if(typeof cursor.transactionId!=='string'||!/^[a-z0-9-]+$/.test(cursor.transactionId))fail('QUALIFICATION_STORE_CORRUPT');
      let bundle,journal;try{bundle=await read(join(this.store,'transactions',cursor.transactionId+'.json'));journal=await read(join(this.store,'journals',cursor.transactionId+'.json'));}catch{fail('QUALIFICATION_STORE_CORRUPT');}
      exact(bundle,['state','manifest']);exact(bundle.manifest,['payload','canonicalPayloadHash','signature']);
      const p=bundle.manifest.payload;exact(p,['type','version','generation','transactionId','previousPointer','stateHash','principalId','keyId','signedAt','authorityHead']);time(p.signedAt);
      if(p.type!=='QUALIFICATION_AUTHORITY_SNAPSHOT'||p.version!=='1.0'||p.generation!==generation||p.transactionId!==cursor.transactionId||digest(bundle)!==cursor.head||digest(bundle.state)!==p.stateHash||digest(p)!==bundle.manifest.canonicalPayloadHash||journal.state!=='COMMITTED'||journal.head!==cursor.head)fail('QUALIFICATION_STORE_CORRUPT');
      let commitAudit;try{commitAudit=await read(join(this.store,'audit',cursor.transactionId+'-commit.json'));}catch{fail('QUALIFICATION_AUDIT_UNAVAILABLE');}
      if(commitAudit.transactionId!==cursor.transactionId||commitAudit.stateHash!==p.stateHash||commitAudit.signedManifestHash!==digest(bundle.manifest)||commitAudit.operationHash!==digest(bundle.state.audits.at(-1)))fail('QUALIFICATION_AUDIT_CORRUPT');
      const principal=trust.state.principals.find(r=>r.principalId===p.principalId),key=principal?.keys.find(k=>k.keyId===p.keyId);
      lifecycle(principal,p.signedAt);lifecycle(key,p.signedAt);
      if(!['PROVIDER_QUALIFICATION_FIXTURE_AUTHOR','HORIZON_RADAR_OWNER'].includes(principal.role)||!signatureValid(p,bundle.manifest.signature,key.publicKey))fail('QUALIFICATION_STORE_CORRUPT');
      if(!latest)latest={head:pointer.head,generation:pointer.generation,state:bundle.state};
      if(generation===1){if(p.previousPointer!==null)fail('QUALIFICATION_STORE_CORRUPT');}else{exact(p.previousPointer,['head','generation','transactionId']);if(p.previousPointer.generation!==generation-1)fail('QUALIFICATION_STORE_CORRUPT');cursor=p.previousPointer;}
    }
    return latest;
  }
  async commit(state,{principalId,keyId}){
    if(!this.held)fail('QUALIFICATION_LOCK_REQUIRED');
    const before=await this.load({allowEmpty:true});const trust=await this.admin.load(),signedAt=this.now();
    const principal=trust.state.principals.find(p=>p.principalId===principalId),key=principal?.keys.find(k=>k.keyId===keyId);lifecycle(principal,signedAt,{current:true});lifecycle(key,signedAt,{current:true});
    const signer=this.signerFactory(keyId);if(await signer.public()!==key.publicKey)fail('QUALIFICATION_SIGNER_MISMATCH');
    const transactionId=randomUUID();let previousPointer=null;if(before.head)previousPointer=await read(join(this.store,'current.json'));
    const payload={type:'QUALIFICATION_AUTHORITY_SNAPSHOT',version:'1.0',generation:before.generation+1,transactionId,previousPointer,stateHash:digest(state),principalId,keyId,signedAt,authorityHead:trust.head};
    const bundle={state,manifest:{payload,canonicalPayloadHash:digest(payload),signature:await signer.sign(Buffer.from(canonical(payload)))}};
    if((await this.admin.load()).head!==trust.head)fail('QUALIFICATION_AUTHORITY_CHANGED');
    this.fault('commit-audit');await durableNew(join(this.store,'audit',transactionId+'-commit.json'),{transactionId,stateHash:payload.stateHash,operationHash:digest(state.audits.at(-1)),signedManifestHash:digest(bundle.manifest),status:'PREPARED'});
    await durableNew(join(this.store,'transactions',transactionId+'.json'),bundle);
    const head=digest(bundle);await durableNew(join(this.store,'journals',transactionId+'.json'),{transactionId,head,state:'PREPARED'});
    this.fault('before-pointer');const pointer={head,generation:payload.generation,transactionId};await replace(join(this.store,'current.json'),pointer);await replace(join(this.anchor,'current.json'),pointer);
    await replace(join(this.store,'journals',transactionId+'.json'),{transactionId,head,state:'COMMITTED'});return this.load();
  }
}
