import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createArxivCandidate, createArxivFeedCapture, parseArxivAtomFeed, verifyArxivFeedCapture } from '../src/lib/radar-production-registry/arxiv-feed-capture.mjs';
import { createNvdCandidate, createNvdCveCapture, verifyNvdCveCapture } from '../src/lib/radar-production-registry/nvd-cve-capture.mjs';
import { buildObservationIdentity } from '../src/lib/radar-observation-identity.mjs';
import { adaptProductionCandidate } from '../src/lib/radar-candidate-adapter/adapters.ts';

const arxivXml = await readFile(new URL('../fixtures/radar-phase6-3/arxiv-cs-lg-page1.atom', import.meta.url), 'utf8');
const nvdPayload = JSON.parse(await readFile(new URL('../fixtures/radar-phase6-3/nvd-cve-page1.json', import.meta.url), 'utf8'));
const nvdRequestUrl = 'https://services.nvd.nist.gov/rest/json/cves/2.0?pubStartDate=2026-10-01T00%3A00%3A00.000&pubEndDate=2026-10-03T23%3A59%3A59.000&resultsPerPage=5&startIndex=0';
const fetchedAt = '2026-10-03T10:25:16.000Z';
const arxivCapture = createArxivFeedCapture({ xml: arxivXml, fetchedAt, observedAt: fetchedAt, startIndex: 0, totalResults: 289945 });
const nvdCapture = createNvdCveCapture({ payload: nvdPayload, fetchedAt, observedAt: fetchedAt, requestUrl: nvdRequestUrl });

test('official arXiv capture parses five current cs.LG records and verifies its immutable hash', () => {
  assert.equal(parseArxivAtomFeed(arxivXml).length, 5);
  assert.equal(verifyArxivFeedCapture(arxivCapture).valid, true);
  assert.equal(arxivCapture.source.startIndex, 0);
  assert.equal(arxivCapture.source.totalResults, 289945);
  assert.equal(new Set(arxivCapture.sourceRecords.map((r) => r.id)).size, 5);
  assert.throws(() => parseArxivAtomFeed('<!DOCTYPE feed><feed/>'), { code: 'ARXIV_XML_SHAPE_INVALID' });
});

test('five real arXiv records are 10-run deterministic with complete source-owned identity provenance', () => {
  const eventKeys = new Set(); const observationIds = new Set();
  for (const record of arxivCapture.sourceRecords) {
    const runs = Array.from({ length: 10 }, () => createArxivCandidate(record, { observedAt: fetchedAt }));
    assert.ok(runs.every(({ candidateResult, identity }) => candidateResult.status === 'CANDIDATE_READY' && identity?.status === 'IDENTITY_READY'));
    assert.equal(new Set(runs.map(({ identity }) => identity.eventKey)).size, 1);
    assert.equal(new Set(runs.map(({ candidateResult }) => buildObservationIdentity({
      eventKey: runs[0].identity.eventKey, radar: 'ai', sourceName: candidateResult.candidate.sourceName,
      sourceUrl: candidateResult.candidate.itemUrl, sourceLevel: candidateResult.candidate.sourceLevel,
      sourceAuthority: candidateResult.candidate.sourceAuthority, observedAt: candidateResult.candidate.observedAt,
    }).observationId)).size, 1);
    eventKeys.add(runs[0].identity.eventKey); observationIds.add(buildObservationIdentity({
      eventKey: runs[0].identity.eventKey, radar: 'ai', sourceName: 'arXiv cs.LG', sourceUrl: record.itemUrl,
      sourceLevel: 'research', sourceAuthority: 'primary', observedAt: fetchedAt,
    }).observationId);
    assert.deepEqual(Object.keys(runs[0].identity.identityProvenance), ['entity', 'canonicalEventType', 'eventIdentifier']);
  }
  assert.equal(eventKeys.size, 5);
  assert.equal(observationIds.size, 5);
});

test('arXiv paper revisions preserve Event identity and create version-specific Observations; re-fetch/category changes do not', () => {
  const original = arxivCapture.sourceRecords[0];
  const initial = createArxivCandidate(original, { observedAt: fetchedAt });
  const revisionRecord = { ...original, id: original.id.replace(/v\d+$/, 'v2'), itemUrl: original.itemUrl.replace(/v\d+$/, 'v2'), updated: '2026-10-04T00:00:00Z' };
  const revision = createArxivCandidate(revisionRecord, { observedAt: '2026-10-04T00:00:00Z' });
  const recategorized = createArxivCandidate({ ...original, categories: ['cs.LG', 'stat.ML'] }, { observedAt: fetchedAt });
  const reobserved = createArxivCandidate(original, { observedAt: '2026-10-05T00:00:00Z' });
  assert.equal(revision.identity.eventKey, initial.identity.eventKey);
  assert.notEqual(revision.candidateResult.candidate.itemUrl, initial.candidateResult.candidate.itemUrl);
  const obs = (row) => buildObservationIdentity({ eventKey: row.identity.eventKey, radar: 'ai', sourceName: 'arXiv cs.LG', sourceUrl: row.candidateResult.candidate.itemUrl, sourceLevel: 'research', sourceAuthority: 'primary', observedAt: fetchedAt }).observationId;
  assert.notEqual(obs(revision), obs(initial));
  assert.equal(reobserved.identity.eventKey, initial.identity.eventKey);
  assert.equal(obs(reobserved), obs(initial));
  assert.equal(recategorized.identity.eventKey, initial.identity.eventKey);
});

test('arXiv missing ID, malformed ID, evidence URL, partial row and adapter failure never fall back silently', () => {
  const base = arxivCapture.sourceRecords[0];
  for (const record of [
    { ...base, id: '' }, { ...base, id: 'not-an-arxiv-id' }, { ...base, itemUrl: 'https://arxiv.org/list/cs.LG/recent' },
    { title: base.title },
  ]) {
    const result = createArxivCandidate(record, { observedAt: fetchedAt });
    assert.ok(result.candidateResult.status === 'RECEIPT_ONLY' || result.identity?.status !== 'IDENTITY_READY');
  }
  const adapterFailure = adaptProductionCandidate({ radar: 'AI', sourceName: 'arXiv cs.LG', record: null }, { observedAt: fetchedAt });
  assert.equal(adapterFailure.status, 'RECEIPT_ONLY');
});

test('official NVD capture preserves pagination, item URL, revision metadata and hash', () => {
  assert.equal(verifyNvdCveCapture(nvdCapture).valid, true);
  assert.equal(nvdCapture.source.totalResults, 892);
  assert.equal(nvdCapture.source.startIndex, 0);
  assert.equal(nvdCapture.source.itemCount, 5);
  assert.ok(nvdCapture.sourceRecords.every((row) => row.itemUrl === `https://nvd.nist.gov/vuln/detail/${row.id}`));
  assert.ok(nvdCapture.sourceRecords.some((row) => row.lastModified > row.published));
  assert.throws(() => createNvdCveCapture({ payload: { vulnerabilities: [] }, fetchedAt, requestUrl: nvdRequestUrl }), { code: 'NVD_CAPTURE_SOURCE_INVALID' });
});

test('five real NVD CVEs have deterministic CVE Event and Observation identities', () => {
  const itemIds = new Set(); const canonicalUrls = new Set();
  for (const record of nvdCapture.sourceRecords) {
    const runs = Array.from({ length: 10 }, () => createNvdCandidate(record, { observedAt: fetchedAt }));
    assert.ok(runs.every(({ candidateResult, identity }) => candidateResult.status === 'CANDIDATE_READY' && identity?.status === 'IDENTITY_READY'));
    assert.equal(new Set(runs.map(({ identity }) => identity.eventKey)).size, 1);
    assert.equal(new Set(runs.map((row) => nvdObservation(row))).size, 1);
    assert.equal(runs[0].identity.eventKey, `${record.id.toLowerCase()}:security-cve:${record.id.toLowerCase()}`);
    const first = runs[0];
    const revision = createNvdCandidate({ ...record, lastModified: '2026-10-04T12:00:00.000', desc: `${record.desc} revised`, references: [...record.references, { url: 'https://third-party.example/advisory', source: 'third party', tags: [] }] }, { observedAt: '2026-10-04T12:00:00Z' });
    assert.equal(revision.candidateResult.status, 'CANDIDATE_READY');
    assert.equal(revision.candidateResult.candidate.itemIdentifier, first.candidateResult.candidate.itemIdentifier);
    assert.equal(revision.candidateResult.candidate.itemUrl, first.candidateResult.candidate.itemUrl);
    assert.equal(revision.identity.eventKey, first.identity.eventKey);
    assert.equal(nvdObservation(revision), nvdObservation(first));
    itemIds.add(first.candidateResult.candidate.itemIdentifier); canonicalUrls.add(first.candidateResult.candidate.itemUrl);
  }
  assert.equal(itemIds.size, 5);
  assert.equal(canonicalUrls.size, 5);
});

test('NVD invalid identifier and absent canonical item evidence fail closed; references never resolve the entity', () => {
  const base = nvdCapture.sourceRecords[0];
  for (const record of [{ ...base, id: '' }, { ...base, id: 'CVE-ABC' }, { ...base, itemUrl: 'https://third-party.example/advisory' }, { id: base.id, desc: base.desc }]) {
    const result = createNvdCandidate(record, { observedAt: fetchedAt });
    assert.ok(result.candidateResult.status === 'RECEIPT_ONLY' || result.identity?.status !== 'IDENTITY_READY');
  }
  const original = createNvdCandidate(base, { observedAt: fetchedAt });
  const withExternalReference = createNvdCandidate({ ...base, references: [{ url: 'https://third-party.example/advisory' }] }, { observedAt: fetchedAt });
  assert.equal(original.identity.status, 'IDENTITY_READY');
  assert.deepEqual(withExternalReference.identity, original.identity);
  assert.equal(withExternalReference.candidateResult.candidate.itemUrl, base.itemUrl);
});

test('partial arXiv capture cannot pass the all-record production readiness gate', () => {
  const records = [...arxivCapture.sourceRecords];
  records[2] = { ...records[2], id: 'broken-id' };
  const readiness = records.map((record) => createArxivCandidate(record, { observedAt: fetchedAt }));
  assert.equal(readiness.filter((row) => row.candidateResult.status === 'CANDIDATE_READY' && row.identity.status === 'IDENTITY_READY').length, 4);
  assert.equal(readiness.some((row) => row.candidateResult.status !== 'CANDIDATE_READY' || row.identity?.status !== 'IDENTITY_READY'), true);
});

function nvdObservation(row, radar = 'security') {
  return buildObservationIdentity({ eventKey: row.identity.eventKey, radar, sourceName: 'NVD',
    sourceUrl: row.candidateResult.candidate.itemUrl, sourceLevel: 'official', sourceAuthority: 'official',
    observedAt: row.candidateResult.candidate.observedAt }).observationId;
}

test('CVE identity ignores description, CPE, status, rejection, product multiplicity and environment changes', () => {
  const base = nvdCapture.sourceRecords[0];
  const original = createNvdCandidate(base, { observedAt: fetchedAt });
  const variations = [
    { desc: 'Changed description' }, { configurations: [{ nodes: [{ cpeMatch: [{ criteria: 'product-a' }] }] }] },
    { configurations: [] }, { configurations: null }, { configurations: 'malformed' },
    { vulnStatus: 'Modified' }, { vulnStatus: 'Rejected' },
    { configurations: [{ nodes: [{ cpeMatch: [{ criteria: 'product-a' }, { criteria: 'product-b' }] }] }] },
    { trackedEnvironment: ['product-a'] }, { trackedEnvironment: [] },
  ];
  for (const delta of variations) {
    const revised = createNvdCandidate({ ...base, ...delta, lastModified: '2026-10-04T12:00:00.000' }, { observedAt: '2026-10-04T12:00:00Z' });
    assert.equal(revised.identity.status, 'IDENTITY_READY');
    assert.equal(revised.identity.entity, original.identity.entity);
    assert.equal(revised.identity.eventIdentifier, original.identity.eventIdentifier);
    assert.equal(revised.identity.eventKey, original.identity.eventKey);
    assert.equal(nvdObservation(revised), nvdObservation(original));
    assert.deepEqual(revised.identity.eventFacts, original.identity.eventFacts);
    assert.equal(Object.hasOwn(revised.identity, 'securityGate'), false);
    assert.equal(Object.hasOwn(revised.identity, 'score'), false);
  }
  assert.notEqual(nvdObservation(original, 'dev'), nvdObservation(original));
  const other = createNvdCandidate({ ...base, id: 'CVE-2026-999999', itemUrl: 'https://nvd.nist.gov/vuln/detail/CVE-2026-999999' }, { observedAt: fetchedAt });
  assert.notEqual(other.identity.eventKey, original.identity.eventKey);
});
