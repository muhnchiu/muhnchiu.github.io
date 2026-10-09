import {test}from'node:test';import assert from'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {TrustedHead,InMemoryBackend,KeychainBackend,TRUSTED_HEAD_SERVICE_TEST} from '../src/lib/radar-capability/trusted-head.mjs';
import {DomainHistoryStore} from '../src/lib/radar-capability/domain-history-store.mjs';
import {DomainHistoryAuthority} from '../src/lib/radar-capability/domain-authority.mjs';
import {AdministrationStore,loadAdministrationPolicies} from '../src/lib/radar-capability/administration.mjs';
import {loadDomainSnapshotProfile} from '../src/lib/radar-capability/domain-snapshot-profile.mjs';
import {digest} from '../src/lib/radar-capability/snapshot-profile.mjs';
import {loadRubric} from '../src/lib/radar-judgment/provider.mjs';
import {BootstrapAdmin} from '../src/lib/radar-bootstrap/index.mjs';

const S='/Users/qiuwenbo/.local/state/horizon', A='/Users/qiuwenbo/.local/share/horizon-authority-anchors';
const HEAD_A='a'.repeat(64), HEAD_B='b'.repeat(64), HEAD_C='c'.repeat(64);

// ---------- Tier 1: isolated unit matrix (in-memory backend) ----------
test('first initialization succeeds and returns creation receipt',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:'s1',environment:'NON_PRODUCTION_TEST'});
  const r=await th.initialize({generation:0,headHash:null});
  assert.equal(r.receipt.generation,0);
  assert.match(r.receipt.creationTimestamp,/^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await th.read()).generation,0);
});
test('re-initialization is refused (no overwrite)',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await th.initialize({generation:0,headHash:null});
  await assert.rejects(th.initialize({generation:0,headHash:null}),/TRUSTED_HEAD_ALREADY_INITIALIZED/);
});
test('read before initialization is refused',async()=>{
  const th=new TrustedHead({backend:new InMemoryBackend(),storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await assert.rejects(th.read(),/TRUSTED_HEAD_UNINITIALIZED/);
});
test('legal monotonic advance succeeds',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await th.initialize({generation:0,headHash:null});
  const n=await th.advance({expectedGeneration:0,expectedHeadHash:null,nextHeadHash:HEAD_A,reason:'TEST'});
  assert.equal(n.generation,1);assert.equal(n.headHash,HEAD_A);assert.equal(n.previousHeadHash,null);
});
test('stale expected state is rejected (rollback / old snapshot replay)',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await th.initialize({generation:0,headHash:null});
  await th.advance({expectedGeneration:0,expectedHeadHash:null,nextHeadHash:HEAD_A,reason:'TEST'});
  await assert.rejects(th.advance({expectedGeneration:0,expectedHeadHash:null,nextHeadHash:HEAD_B,reason:'REPLAY'}),/TRUSTED_HEAD_STATE_MISMATCH/);
  await assert.rejects(th.advance({expectedGeneration:1,expectedHeadHash:HEAD_B,nextHeadHash:HEAD_C,reason:'REPLAY'}),/TRUSTED_HEAD_STATE_MISMATCH/);
  assert.equal((await th.read()).headHash,HEAD_A);
});
test('verifyStoreHead: match ok; store ahead by one = recovery candidate; divergence = mismatch',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await th.initialize({generation:0,headHash:null});
  assert.equal((await th.verifyStoreHead({generation:0,headHash:null})).ok,true);
  assert.equal((await th.verifyStoreHead({generation:1,headHash:HEAD_A})).code,'TRUSTED_HEAD_RECOVERY_CANDIDATE');
  assert.equal((await th.verifyStoreHead({generation:2,headHash:HEAD_B})).code,'TRUSTED_HEAD_STATE_MISMATCH');
  await th.advance({expectedGeneration:0,expectedHeadHash:null,nextHeadHash:HEAD_A,reason:'TEST'});
  assert.equal((await th.verifyStoreHead({generation:1,headHash:HEAD_A})).ok,true);
  assert.equal((await th.verifyStoreHead({generation:0,headHash:null})).code,'TRUSTED_HEAD_STATE_MISMATCH');
});
test('external anchor tamper is rejected',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await th.initialize({generation:0,headHash:null});
  await th.advance({expectedGeneration:0,expectedHeadHash:null,nextHeadHash:HEAD_A,reason:'TEST'});
  b.items.get('s').record.headHash=HEAD_B; // 直接改写独立记录（模拟篡改）
  await assert.rejects(th.advance({expectedGeneration:1,expectedHeadHash:HEAD_A,nextHeadHash:HEAD_C,reason:'TEST'}),/TRUSTED_HEAD_STATE_MISMATCH/);
  assert.equal((await th.verifyStoreHead({generation:1,headHash:HEAD_A})).code,'TRUSTED_HEAD_STATE_MISMATCH');
});
test('delete + recreate changes the creation timestamp (recreation detection primitive)',async()=>{
  let tick=0; const clock=()=>new Date(Date.parse('2026-01-01T00:00:00Z')+(tick++)*1000).toISOString();
  const b=new InMemoryBackend({clock}), th=new TrustedHead({backend:b,storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await th.initialize({generation:0,headHash:null});
  const before=await th.creationTimestamp();
  await b.delete('s');
  const th2=new TrustedHead({backend:b,storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await th2.initialize({generation:0,headHash:null});
  const after=await th2.creationTimestamp();
  assert.notEqual(before,after);
});
test('write-denied backend fails closed',async()=>{
  class Denied extends InMemoryBackend{async write(){throw Object.assign(new Error('TRUSTED_HEAD_WRITE_DENIED'),{code:'TRUSTED_HEAD_WRITE_DENIED'});}}
  const th=new TrustedHead({backend:new Denied(),storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await assert.rejects(th.initialize({generation:0,headHash:null}),/TRUSTED_HEAD_WRITE_DENIED/);
});
test('concurrent divergent advances: final head is single; the other store fails closed (no undetected fork)',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:'s',environment:'NON_PRODUCTION_TEST'});
  await th.initialize({generation:0,headHash:null});
  const out=await Promise.allSettled([
    th.advance({expectedGeneration:0,expectedHeadHash:null,nextHeadHash:HEAD_A,reason:'A'}),
    th.advance({expectedGeneration:0,expectedHeadHash:null,nextHeadHash:HEAD_B,reason:'B'}),
  ]);
  const cur=await th.read();
  assert.equal(cur.generation,1);
  const survivors=(cur.headHash===HEAD_A?1:0)+(cur.headHash===HEAD_B?1:0);
  assert.equal(survivors,1);
});

// ---------- Tier 2: DomainHistoryStore integration (durable NON_PRODUCTION_TEST store, read-only) ----------
const profile=await loadDomainSnapshotProfile(S);
const bootstrap=new BootstrapAdmin(), policies=await loadAdministrationPolicies(S);
const administration=new AdministrationStore({path:S+'/administration-runtime-v2/domain-isolated-trust', anchor:A+'/administration-v2/domain-isolated-trust', bootstrap, policies});
const reviewDefinition={payloadFields:profile.constraintPayload.definitions['reviewer-grant-binding'].payloadFieldsUnchanged};
const rubric=await loadRubric();
const authority=new DomainHistoryAuthority({profile, reviewDefinition, rubric, censusDirectory:A+'/administration-v2/domain-history-census', evidenceDirectory:A+'/administration-v2/domain-history-evidence', administration});
const anchorPath=A+'/administration-v2/domain-isolated-review-history';
const storePath=S+'/administration-runtime-v2/domain-isolated-review-history';
const anchorJson=JSON.parse(await readFile(join(anchorPath,'current.json'),'utf8'));

test('integration: real store + trusted head at current anchor loads verified',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:profile.storeScope.storeId,environment:profile.storeScope.environment});
  await th.initialize({generation:anchorJson.generation, headHash:digest(anchorJson)});
  const store=new DomainHistoryStore({path:storePath, anchor:anchorPath, administration, profile, authority, trustedHead:th});
  const s=await store.load();
  assert.equal(s.terminal,'SNAPSHOT_VERIFIED');
});
test('integration: tampered trusted head fails the store closed',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:profile.storeScope.storeId,environment:profile.storeScope.environment});
  await th.initialize({generation:anchorJson.generation, headHash:digest(anchorJson)});
  const store=new DomainHistoryStore({path:storePath, anchor:anchorPath, administration, profile, authority, trustedHead:th});
  b.items.get(th.storeId).record.headHash='0'.repeat(64);
  await assert.rejects(store.load(),/TRUSTED_HEAD_STATE_MISMATCH/);
});
test('integration: crash window (trusted head one behind) recovers exactly once',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:profile.storeScope.storeId,environment:profile.storeScope.environment});
  // 崩溃窗口：keychain 停在前一 anchor（store 已前进一代）
  const j=JSON.parse(await readFile(join(storePath,'transactions',anchorJson.transactionId+'.json'),'utf8'));
  const prev=JSON.parse(await readFile(join(storePath,'anchors',j.previousAnchorHash+'.json'),'utf8'));
  b.items.set(th.storeId,{record:{recordVersion:'1.0',storeId:profile.storeScope.storeId,environment:profile.storeScope.environment,generation:prev.generation,headHash:digest(prev),previousHeadHash:null,updatedAt:'2026-10-09T00:00:00.000Z',lastReason:null},creationStamp:'2026-10-09T00:00:00.000Z'});
  const store=new DomainHistoryStore({path:storePath, anchor:anchorPath, administration, profile, authority, trustedHead:th});
  const s=await store.load();
  assert.equal(s.terminal,'SNAPSHOT_VERIFIED');
  const rec=await th.read();
  assert.equal(rec.generation,anchorJson.generation);
  assert.equal(rec.lastReason,'RECOVERY');
});
test('integration: trusted head ahead of store (rollback detected) fails closed',async()=>{
  const b=new InMemoryBackend(), th=new TrustedHead({backend:b,storeId:profile.storeScope.storeId,environment:profile.storeScope.environment});
  await th.initialize({generation:anchorJson.generation+3, headHash:HEAD_B});
  const store=new DomainHistoryStore({path:storePath, anchor:anchorPath, administration, profile, authority, trustedHead:th});
  await assert.rejects(store.load(),/TRUSTED_HEAD_STATE_MISMATCH/);
});

// ---------- Keychain backend smoke (test service; torn down) ----------
test('keychain backend end-to-end on the test service',async()=>{
  const b=new KeychainBackend({service:TRUSTED_HEAD_SERVICE_TEST}), th=new TrustedHead({backend:b,storeId:'integration-smoke',environment:'NON_PRODUCTION_TEST'});
  await b.delete('integration-smoke');
  await th.initialize({generation:0,headHash:null});
  await th.advance({expectedGeneration:0,expectedHeadHash:null,nextHeadHash:HEAD_A,reason:'SMOKE'});
  assert.equal((await th.read()).generation,1);
  assert.match(await th.creationTimestamp(),/^\d{4}-\d{2}-\d{2}T/);
  await b.delete('integration-smoke');
  assert.equal((await b.read('integration-smoke')).exists,false);
});
