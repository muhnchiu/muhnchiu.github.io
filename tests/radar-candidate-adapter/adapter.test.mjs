import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeRadarV1 } from '../../vendor/horizon-contracts/radar/v2/normalize.mjs';
import { adaptProductionCandidate, adaptProductionCandidateBatch, getProductionAdapterSourceNames } from '../../src/lib/radar-candidate-adapter/adapters.ts';
import { runProductionCandidateDryPipeline, runProductionCandidateDryPipelineBatch } from '../../src/lib/radar-candidate-adapter/dry-pipeline.ts';

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/radar-candidate-adapter/adapter-cases-v1.json', import.meta.url), 'utf8'));
const contextAt = '2026-10-01T00:00:00Z';

test('adapter fixtures cover every Radar and declared case disposition', () => {
  assert.equal(fixtures.caseCount, 40);
  assert.deepEqual(fixtures.byRadar, { AI: 8, DEV: 8, APP: 8, SEC: 8, SKILL: 8 });
  const results = fixtures.cases.map((row) => adaptProductionCandidate({ radar: row.radar, sourceName: row.sourceName, record: row.record }, { ...(row.observedAt === null ? {} : { observedAt: row.observedAt }) }));
  for (let i = 0; i < results.length; i += 1) {
    assert.equal(results[i].status, fixtures.cases[i].expectedStatus, fixtures.cases[i].caseId);
    for (const reason of fixtures.cases[i].expectedReasons) assert.ok(results[i].receiptReasons.includes(reason), `${fixtures.cases[i].caseId}: ${reason}`);
    if (fixtures.cases[i].radar !== 'SKILL' && results[i].candidate) assert.ok(results[i].candidate.sourceAuthority, `${fixtures.cases[i].caseId}: frozen source authority must map`);
  }
});

test('canonical interface preserves source facts and observedAt byte-for-byte without identity or score inference', () => {
  const source = { objectID: '34567', title: 'HN story', url: 'https://example.com/item', signal: 'high', action: 'adopt', confidence: 'high' };
  const result = adaptProductionCandidate({ radar: 'APP', sourceName: 'Hacker News 首页', record: source }, { observedAt: contextAt });
  assert.equal(result.status, 'CANDIDATE_READY');
  assert.equal(result.candidate.observedAt, contextAt);
  assert.equal(result.candidate.itemIdentifier, '34567');
  assert.equal(result.candidate.itemUrl, source.url);
  assert.equal(result.candidate.entityEvidence, undefined);
  assert.equal(result.candidate.eventTypeEvidence, undefined);
  assert.equal(result.candidate.eventIdentifierEvidence, undefined);
  assert.equal(result.candidate.scoreInputEvidence, undefined);
  assert.equal(result.candidate.rawSourceMetadata.record.signal, 'high');
  assert.equal(result.candidate.rawSourceMetadata.record.action, 'adopt');
  assert.equal(result.candidate.rawSourceMetadata.record.confidence, 'high');
  assert.deepEqual(result.downstreamGaps, ['EVENT_IDENTITY_INCOMPLETE', 'SCORE_INPUT_INCOMPLETE']);
});

test('only the documented HN parser fallback derives a source-owned item permalink from objectID', () => {
  const result = adaptProductionCandidate({ radar: 'DEV', sourceName: 'Hacker News developer stories', record: { objectID: 12345, title: 'Story' } }, { observedAt: contextAt });
  assert.equal(result.status, 'CANDIDATE_READY');
  assert.equal(result.candidate.itemUrl, 'https://news.ycombinator.com/item?id=12345');
  assert.match(result.provenance.urlRule, /dev-radar\.sh HN objectID permalink fallback/);
});

test('NVD third-party references and aggregator pages never become item URLs', () => {
  const nvd = adaptProductionCandidate({ radar: 'SEC', sourceName: 'NVD', record: { id: 'CVE-2026-12345', score: 9.8, desc: 'CVE', references: [{ url: 'https://third-party.example/advisory' }] } }, { observedAt: contextAt });
  assert.equal(nvd.candidate.itemUrl, undefined);
  assert.ok(nvd.receiptReasons.includes('MISSING_ITEM_URL'));
  const aggregator = adaptProductionCandidate({ radar: 'APP', sourceName: 'Product Hunt', record: { title: 'Daily', link: 'https://www.producthunt.com/feed' } }, { observedAt: contextAt });
  assert.ok(aggregator.receiptReasons.includes('AGGREGATOR_URL_NOT_ITEM'));
});

test('unknown source, unsupported row, invalid provenance, and missing observedAt have stable reasons', () => {
  const unknown = adaptProductionCandidate({ radar: 'APP', sourceName: 'Unlisted', record: { title: 'x' } }, { observedAt: contextAt });
  assert.deepEqual(unknown.receiptReasons, ['UNKNOWN_SOURCE']);
  const unsupported = adaptProductionCandidate({ radar: 'AI', sourceName: 'GitHub AI Trending', record: { repositoryName: 'x' } }, { observedAt: contextAt });
  assert.ok(unsupported.receiptReasons.includes('UNSUPPORTED_SOURCE_RECORD'));
  const badProv = adaptProductionCandidate({ radar: 'SEC', sourceName: 'GitHub Security Advisories', record: { ghsa_id: 'GHSA-x', summary: 'x', sourceAuthority: 'community' } }, { observedAt: contextAt });
  assert.ok(badProv.receiptReasons.includes('INVALID_PROVENANCE'));
  const missing = adaptProductionCandidate({ radar: 'APP', sourceName: 'Product Hunt', record: { title: 'Launch', link: 'https://www.producthunt.com/products/demo' } }, {});
  assert.ok(missing.receiptReasons.includes('MISSING_OBSERVED_AT'));
});

test('SKILL never parses prose or unverified CLI output as structured production records', () => {
  for (const sourceName of ['Skills.sh Trending', 'Linkly Top 100', 'OfficialSkills.sh', 'ClawHub search', 'SkillsMP', 'LobeHub', 'GitHub Explore']) {
    const result = adaptProductionCandidate({ radar: 'SKILL', sourceName, record: { text: 'human report' } }, { observedAt: contextAt });
    assert.equal(result.status, 'RECEIPT_ONLY');
    assert.deepEqual(result.receiptReasons, ['SKILL_STRUCTURED_INPUT_UNAVAILABLE']);
    assert.equal(result.candidate, undefined);
  }
});

test('batch processing isolates malformed candidate exceptions', () => {
  const poisonous = new Proxy({}, { get() { throw new Error('fixture fault'); } });
  const rows = adaptProductionCandidateBatch([
    { radar: 'APP', sourceName: 'Product Hunt', record: { title: 'good', link: 'https://www.producthunt.com/products/good' } },
    { radar: 'APP', sourceName: 'Product Hunt', record: poisonous },
    { radar: 'DEV', sourceName: 'Hacker News developer stories', record: { objectID: '2233', title: 'also good' } },
  ], { observedAt: contextAt });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, 'CANDIDATE_READY');
  assert.equal(rows[1].status, 'RECEIPT_ONLY');
  assert.ok(rows[1].receiptReasons.includes('ADAPTER_EXCEPTION'));
  assert.equal(rows[2].status, 'CANDIDATE_READY');
});

test('dry pipeline reports candidate/evidence/identity/score diagnostics and stops before Registry', async () => {
  const result = await runProductionCandidateDryPipeline({ radar: 'APP', sourceName: 'Product Hunt', record: { title: 'Launch', link: 'https://www.producthunt.com/products/demo' } }, { observedAt: contextAt, generatedAt: '2026-10-01T00:01:00Z' });
  assert.equal(result.adapterStatus, 'CANDIDATE_READY');
  assert.equal(result.evidenceValid, true);
  assert.equal(result.eventIdentityResolvable, false);
  assert.equal(result.observationIdentityResolvable, false);
  assert.equal(result.generatedScoreInputCount, 0);
  assert.equal(result.provenanceValid, false);
  assert.equal(result.status, 'RECEIPT_ONLY');
  assert.equal(result.commitObservationCalled, false);
  assert.equal(result.registryWrites, 0);
  assert.equal(result.publisherCalls, 0);
});

test('V1 Markdown generation normalization is unaffected when shadow V2 is receipt-only', () => {
  const v1 = JSON.parse(readFileSync(new URL('../../vendor/horizon-contracts/radar/v2/fixtures/v1/v1-legacy-signals.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(v1);
  const shadow = adaptProductionCandidate({ radar: 'AI', sourceName: 'HuggingFace Papers', record: { title: 'paper', authors: [] } }, { observedAt: contextAt });
  assert.equal(shadow.status, 'RECEIPT_ONLY');
  assert.equal(normalizeRadarV1(v1).sourceSchemaVersion, 1);
  assert.equal(JSON.stringify(v1), before);
});

test('dry batch isolates individual pipeline exceptions and never reports write capability', async () => {
  const rows = await runProductionCandidateDryPipelineBatch([
    { radar: 'APP', sourceName: 'Product Hunt', record: { title: 'good', link: 'https://www.producthunt.com/products/good' } },
    { radar: 'SKILL', sourceName: 'ClawHub search', record: { text: 'not structured' } },
  ], { observedAt: contextAt, generatedAt: '2026-10-01T00:01:00Z' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.commitObservationCalled === false && row.registryWrites === 0 && row.publisherCalls === 0));
  assert.equal(getProductionAdapterSourceNames().length, 31);
  assert.ok(getProductionAdapterSourceNames().includes('DEV|Hacker News Show HN'));
});

test('every offline source fixture runs through dry integration and stays before Registry commit', async () => {
  const results = await Promise.all(fixtures.cases.map((row) => runProductionCandidateDryPipeline(
    { radar: row.radar, sourceName: row.sourceName, record: row.record },
    { ...(row.observedAt === null ? {} : { observedAt: row.observedAt }), generatedAt: '2026-10-01T00:01:00Z' },
  )));
  assert.equal(results.length, 40);
  assert.ok(results.every((row) => row.status === 'RECEIPT_ONLY'));
  assert.ok(results.every((row) => row.commitObservationCalled === false && row.registryWrites === 0 && row.publisherCalls === 0));
  assert.ok(results.some((row) => row.adapterStatus === 'CANDIDATE_READY' && row.evidenceValid));
});
