import { createContinuousProductionIngestion } from '../src/lib/radar-production-registry/continuous-ingestion.mjs';
import { createProductionIdentityRegistry, ARXIV_PRODUCTION_REGISTRY_NAMESPACE, NVD_PRODUCTION_REGISTRY_NAMESPACE } from '../src/lib/radar-production-registry/production-identity-registry.mjs';
import { createArxivFeedCapture, ARXIV_CS_LG_API_URL, createArxivCandidate } from '../src/lib/radar-production-registry/arxiv-feed-capture.mjs';
import { createNvdCveCapture, NVD_CVE_API_URL, createNvdCandidate } from '../src/lib/radar-production-registry/nvd-cve-capture.mjs';
import { setGlobalDispatcher, ProxyAgent } from 'undici';
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const prodDir = join(HOME, '.local', 'state', 'horizon-production');
const stateDir = join(HOME, '.local', 'state', 'horizon');
const phase8Dir = join(prodDir, 'phase8-operation');
const runId = randomUUID();
const startedAt = new Date().toISOString();
const day = startedAt.slice(0, 10);

const results = { runId, startedAt, schedulerJobId: 'com.muhnchiu.horizon.radar-v2-production', sources: {}, registryBefore: {}, registryAfter: {} };

async function countRecords(store) {
  const dir = join(prodDir, 'radar-v2-prod-identity-' + store);
  const events = (await readFile(join(dir, 'radar-event-registry.jsonl'), 'utf8')).split('\n').filter(Boolean).length;
  const obs = (await readFile(join(dir, 'radar-observation-registry.jsonl'), 'utf8')).split('\n').filter(Boolean).length;
  return { events, observations: obs };
}

results.registryBefore = {
  dev: await countRecords('dev-claude-code'),
  ai: await countRecords('ai-arxiv-cs-lg'),
  sec: await countRecords('sec-nvd'),
  total: { events: 0, observations: 0 }
};
results.registryBefore.total.events = results.registryBefore.dev.events + results.registryBefore.ai.events + results.registryBefore.sec.events;
results.registryBefore.total.observations = results.registryBefore.dev.observations + results.registryBefore.ai.observations + results.registryBefore.sec.observations;

console.log('Run ' + runId + ' started at ' + startedAt);
console.log('Registry before: ' + results.registryBefore.total.events + ' events / ' + results.registryBefore.total.observations + ' observations');

// Enable controls
const now = startedAt;
const storeNames = ['dev-claude-code', 'ai-arxiv-cs-lg', 'sec-nvd'];
for (const store of storeNames) {
  const ctrlPath = join(prodDir, 'radar-v2-prod-identity-' + store + '-ingestion-runtime', 'control.json');
  const ctrl = JSON.parse(await readFile(ctrlPath, 'utf8'));
  ctrl.ingestion = 'ENABLED';
  ctrl.scheduler = 'ENABLED';
  ctrl.schedulerEnabledAt = now;
  ctrl.changedAt = now;
  ctrl.reason = 'PHASE_8_2_DAY_1_ENABLE';
  writeFileSync(ctrlPath, JSON.stringify(ctrl, null, 2) + '\n');
}

const globalCtrl = { version: 1, state: 'ENABLED', generation: 2, authorizedMode: 'CONTROLLED_V2_IDENTITY_OPERATION', sourceAllowlist: ['DEV', 'AI', 'SEC'], expiresAt: '2026-10-06T11:30:00+08:00', operator: 'qiuwenbo', changedAt: now, reason: 'PHASE_8_2_DAY_1_ENABLED' };
writeFileSync(join(phase8Dir, 'control.json'), JSON.stringify(globalCtrl, null, 2) + '\n');

// DEV: Claude Code - use proxy
try {
  const devIngest = createContinuousProductionIngestion({
    fetchImpl: async (url, opts) => {
      const r = await fetch(url, opts);
      const buf = Buffer.from(await r.arrayBuffer());
      try { const decompressed = gunzipSync(buf).toString(); return new Response(decompressed, { status: r.status, headers: r.headers }); }
      catch { return new Response(buf.toString(), { status: r.status, headers: r.headers }); }
    }
  });
  const devResult = await devIngest.runOnce({
    trigger: 'SCHEDULER',
    schedulerContext: { schedulerId: 'horizon-radar-v2-production', scheduleVersion: '1', timezone: 'Asia/Shanghai', scheduledAt: startedAt },
    replayCount: 0
  });
  results.sources.DEV = {
    radar: 'DEV', sourceName: 'Claude Code Changelog',
    fetchResult: 'CONTENT_RETURNED', captureHash: devResult.captureHash,
    itemCount: devResult.itemCount, candidateCount: devResult.candidateReadyCount,
    evidenceReadyCount: devResult.candidateReadyCount, identityReadyCount: devResult.identityReadyCount,
    writeIntents: devResult.writeIntentCount, newEvents: devResult.newEvents, newObservations: devResult.newObservations,
    duplicates: devResult.duplicateCount, rejections: 0, failures: devResult.failureCount,
    failureDetails: devResult.failures, finalStatus: devResult.finalStatus,
    runId: devResult.runId, completedAt: devResult.completedAt
  };
  console.log('DEV: ' + devResult.finalStatus + ', items=' + devResult.itemCount + ', newEvents=' + devResult.newEvents + ', duplicates=' + devResult.duplicateCount);
} catch (error) {
  results.sources.DEV = { radar: 'DEV', fetchResult: 'FETCH_FAILED', error: error.message, failures: 1 };
  console.log('DEV: FAILED - ' + error.message);
}

// AI: arXiv
try {
  const aiStoreDir = join(prodDir, 'radar-v2-prod-identity-ai-arxiv-cs-lg');
  const aiRegistry = createProductionIdentityRegistry({
    stateDir: aiStoreDir, registryNamespace: ARXIV_PRODUCTION_REGISTRY_NAMESPACE,
    authorized: true, enabled: true
  });

  const response = await fetch(ARXIV_CS_LG_API_URL, { headers: { accept: 'application/atom+xml' }, signal: AbortSignal.timeout(20000) });
  const xml = await response.text();
  const fetchedAt = new Date().toISOString();

  const capture = createArxivFeedCapture({ xml, fetchedAt, observedAt: fetchedAt, httpStatus: response.status });
  const captureHash = capture.contentIntegrity.sha256;
  const itemCount = capture.sourceRecords.length;

  const capturePath = join(prodDir, 'radar-v2-prod-identity-ai-arxiv-cs-lg-ingestion-runtime', 'captures', day, runId + '.json');
  await mkdir(join(capturePath, '..'), { recursive: true });
  await writeFile(capturePath, JSON.stringify(capture, null, 2) + '\n');

  let candidateCount = 0, identityReadyCount = 0, writeIntents = 0, writeSuccess = 0, duplicates = 0, failures = 0;
  const failureDetails = [];
  const before = await countRecords('ai-arxiv-cs-lg');

  for (const record of capture.sourceRecords) {
    try {
      const candidate = createArxivCandidate(record, { observedAt: fetchedAt });
      if (candidate.candidateResult.status !== 'CANDIDATE_READY') { failures++; failureDetails.push({ item: record.id, reasonCode: 'CANDIDATE_NOT_READY' }); continue; }
      candidateCount++;
      if (candidate.identity && candidate.identity.status === 'IDENTITY_READY') {
        identityReadyCount++; writeIntents++;
        try {
          const result = await aiRegistry.commit({ candidateResult: candidate.candidateResult, identity: candidate.identity, runtimeMode: 'PRODUCTION_IDENTITY_REGISTRY', productionRegistryEnabled: true });
          if (result.registryDisposition === 'DUPLICATE_OBSERVATION') duplicates++; else writeSuccess++;
        } catch (e) { failures++; failureDetails.push({ item: record.id, reasonCode: e.code || 'WRITE_FAILED', message: e.message }); }
      } else { failures++; failureDetails.push({ item: record.id, reasonCode: candidate.identity?.reasonCode || 'IDENTITY_UNRESOLVED' }); }
    } catch (e) { failures++; failureDetails.push({ item: record.id, reasonCode: e.code || 'ITEM_FAILED' }); }
  }

  const after = await countRecords('ai-arxiv-cs-lg');
  results.sources.AI = {
    radar: 'AI', sourceName: 'arXiv cs.LG', fetchResult: 'CONTENT_RETURNED', httpStatus: response.status,
    captureHash, itemCount, candidateCount, evidenceReadyCount: candidateCount, identityReadyCount,
    writeIntents, newEvents: after.events - before.events, newObservations: after.observations - before.observations,
    duplicates, failures, failureDetails, finalStatus: failures === 0 ? 'SUCCESS' : writeSuccess > 0 ? 'PARTIAL' : 'FAILED',
    completedAt: new Date().toISOString()
  };
  console.log('AI: items=' + itemCount + ', candidates=' + candidateCount + ', newEvents=' + (after.events - before.events) + ', duplicates=' + duplicates + ', failures=' + failures);
} catch (error) {
  results.sources.AI = { radar: 'AI', fetchResult: 'FETCH_FAILED', error: error.message, failures: 1 };
  console.log('AI: FAILED - ' + error.message);
}

// SEC: NVD (needs proxy)
try {
  const secStoreDir = join(prodDir, 'radar-v2-prod-identity-sec-nvd');
  const secRegistry = createProductionIdentityRegistry({
    stateDir: secStoreDir, registryNamespace: NVD_PRODUCTION_REGISTRY_NAMESPACE,
    authorized: true, enabled: true
  });

  const nvdUrl = NVD_CVE_API_URL + '?resultsPerPage=5';
  const secResponse = await fetch(nvdUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const secBuf = Buffer.from(await secResponse.arrayBuffer());
  let secText;
  try { secText = gunzipSync(secBuf).toString(); } catch { secText = secBuf.toString(); }
  const payload = JSON.parse(secText);
  const fetchedAt = new Date().toISOString();

  const capture = createNvdCveCapture({ payload, fetchedAt, observedAt: fetchedAt, requestUrl: nvdUrl, httpStatus: secResponse.status });
  const captureHash = capture.contentIntegrity.sha256;
  const itemCount = capture.sourceRecords.length;

  const capturePath = join(prodDir, 'radar-v2-prod-identity-sec-nvd-ingestion-runtime', 'captures', day, runId + '.json');
  await mkdir(join(capturePath, '..'), { recursive: true });
  await writeFile(capturePath, JSON.stringify(capture, null, 2) + '\n');

  let candidateCount = 0, identityReadyCount = 0, writeIntents = 0, writeSuccess = 0, duplicates = 0, failures = 0;
  const failureDetails = [];
  const before = await countRecords('sec-nvd');

  for (const record of capture.sourceRecords) {
    try {
      const candidate = createNvdCandidate(record, { observedAt: fetchedAt });
      if (candidate.candidateResult.status !== 'CANDIDATE_READY') { failures++; failureDetails.push({ item: record.id, reasonCode: 'CANDIDATE_NOT_READY' }); continue; }
      candidateCount++;
      if (candidate.identity && candidate.identity.status === 'IDENTITY_READY') {
        identityReadyCount++; writeIntents++;
        try {
          const result = await secRegistry.commit({ candidateResult: candidate.candidateResult, identity: candidate.identity, runtimeMode: 'PRODUCTION_IDENTITY_REGISTRY', productionRegistryEnabled: true });
          if (result.registryDisposition === 'DUPLICATE_OBSERVATION') duplicates++; else writeSuccess++;
        } catch (e) { failures++; failureDetails.push({ item: record.id, reasonCode: e.code || 'WRITE_FAILED', message: e.message }); }
      } else { failures++; failureDetails.push({ item: record.id, reasonCode: candidate.identity?.reasonCode || 'IDENTITY_UNRESOLVED' }); }
    } catch (e) { failures++; failureDetails.push({ item: record.id, reasonCode: e.code || 'ITEM_FAILED' }); }
  }

  const after = await countRecords('sec-nvd');
  results.sources.SEC = {
    radar: 'SEC', sourceName: 'NVD CVE', fetchResult: 'CONTENT_RETURNED', httpStatus: secResponse.status,
    captureHash, itemCount, candidateCount, evidenceReadyCount: candidateCount, identityReadyCount,
    writeIntents, newEvents: after.events - before.events, newObservations: after.observations - before.observations,
    duplicates, failures, failureDetails, finalStatus: failures === 0 ? 'SUCCESS' : writeSuccess > 0 ? 'PARTIAL' : 'FAILED',
    completedAt: new Date().toISOString()
  };
  console.log('SEC: items=' + itemCount + ', candidates=' + candidateCount + ', newEvents=' + (after.events - before.events) + ', duplicates=' + duplicates + ', failures=' + failures);
} catch (error) {
  results.sources.SEC = { radar: 'SEC', fetchResult: 'FETCH_FAILED', error: error.message, failures: 1 };
  console.log('SEC: FAILED - ' + error.message);
}

// After counts
results.registryAfter = {
  dev: await countRecords('dev-claude-code'),
  ai: await countRecords('ai-arxiv-cs-lg'),
  sec: await countRecords('sec-nvd'),
  total: { events: 0, observations: 0 }
};
results.registryAfter.total.events = results.registryAfter.dev.events + results.registryAfter.ai.events + results.registryAfter.sec.events;
results.registryAfter.total.observations = results.registryAfter.dev.observations + results.registryAfter.ai.observations + results.registryAfter.sec.observations;

results.finishedAt = new Date().toISOString();
results.legitimateGrowth = {
  events: results.registryAfter.total.events - results.registryBefore.total.events,
  observations: results.registryAfter.total.observations - results.registryBefore.total.observations
};

const allSuccess = Object.values(results.sources).every(s => s.finalStatus === 'SUCCESS' || s.finalStatus === 'RUN_SUCCESS');
const anyFailure = Object.values(results.sources).some(s => s.failures > 0);
results.health = allSuccess ? 'HEALTHY' : anyFailure ? 'DEGRADED' : 'UNHEALTHY';

// Disable controls
for (const store of storeNames) {
  const ctrlPath = join(prodDir, 'radar-v2-prod-identity-' + store + '-ingestion-runtime', 'control.json');
  const ctrl = JSON.parse(await readFile(ctrlPath, 'utf8'));
  ctrl.ingestion = 'DISABLED'; ctrl.scheduler = 'DISABLED';
  ctrl.changedAt = new Date().toISOString(); ctrl.reason = 'DAY1_RUN_COMPLETE';
  writeFileSync(ctrlPath, JSON.stringify(ctrl, null, 2) + '\n');
}

const day1Path = join(stateDir, 'radar-phase8-day1-operation-v1.json');
await writeFile(day1Path, JSON.stringify(results, null, 2));
console.log('\n=== DAY 1 COMPLETE ===');
console.log('Registry: ' + results.registryBefore.total.events + '/' + results.registryBefore.total.observations + ' -> ' + results.registryAfter.total.events + '/' + results.registryAfter.total.observations);
console.log('Growth: +' + results.legitimateGrowth.events + ' events / +' + results.legitimateGrowth.observations + ' observations');
console.log('Health: ' + results.health);
