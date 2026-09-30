import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareEvidenceCommit, normalizeEvidence, mapSourceEvidence, rssItemToCandidate, nvdCveToCandidate, githubAdvisoryToCandidate, SOURCE_EVIDENCE_MAP } from '../src/lib/radar-evidence-pipeline.mjs';

const observedAt = '2026-09-30T03:00:00.000Z';
const base = { entity: 'deepseek-v4.1', canonicalEventType: 'model-release', eventIdentifier: 'initial', eventFacts: { version: '4.1' } };

test('static source classifications cover all frozen authority and level enum members', () => {
  const pairs = Object.values(SOURCE_EVIDENCE_MAP);
  assert.deepEqual(new Set(pairs.map(([level]) => level)), new Set(['official', 'research', 'ecosystem', 'media', 'community']));
  assert.deepEqual(new Set(pairs.map(([, authority]) => authority)), new Set(['official', 'primary', 'secondary', 'community']));
  for (const name of Object.keys(SOURCE_EVIDENCE_MAP)) assert.equal(mapSourceEvidence(name).errors.length, 0);
  assert.equal(mapSourceEvidence('Unreviewed feed').errors[0].code, 'SOURCE_AUTHORITY_UNDEFINED');
});

test('RSS, NVD and GitHub Advisory adapters preserve only source-owned item URL fields and publication times', () => {
  const rss = rssItemToCandidate('OpenAI News', { title: 'Release', link: 'https://openai.com/news/release/', published: '2026-09-29T00:00:00Z' });
  const nvd = nvdCveToCandidate({ descriptions: [{ lang: 'en', value: 'CVE' }], references: [{ url: 'https://vendor.example/advisory' }], published: '2026-09-28T00:00:00.000' });
  const ghsa = githubAdvisoryToCandidate({ summary: 'GHSA', html_url: 'https://github.com/advisories/GHSA-test', published_at: '2026-09-27T00:00:00Z' });
  assert.equal(rss.sourceUrl, 'https://openai.com/news/release/');
  assert.equal(rss.sourcePublishedAt, '2026-09-29T00:00:00Z');
  assert.equal(nvd.sourceUrl, undefined, 'third-party references are not misattributed as the NVD item permalink');
  assert.equal(nvd.sourcePublishedAt, '2026-09-28T00:00:00.000');
  assert.equal(ghsa.sourceUrl, 'https://github.com/advisories/GHSA-test');
  assert.equal(ghsa.sourcePublishedAt, '2026-09-27T00:00:00Z');
});

test('normalizer requires explicit observedAt and propagates it byte-for-byte; published time is optional', () => {
  const source = { sourceName: 'OpenAI News', sourceUrl: 'https://openai.com/news/release/' };
  const withoutPublished = normalizeEvidence(source, { observedAt });
  assert.equal(withoutPublished.registryEligible, true);
  assert.equal(withoutPublished.normalized.observedAt, observedAt);
  assert.equal(Object.hasOwn(withoutPublished.normalized, 'sourcePublishedAt'), false);
  const withPublished = normalizeEvidence({ ...source, sourcePublishedAt: '2026-09-29T00:00:00Z' }, { observedAt });
  assert.equal(withPublished.normalized.sourcePublishedAt, '2026-09-29T00:00:00Z');
  assert.equal(normalizeEvidence(source).errors[0].code, 'OBSERVED_AT_REQUIRED');
});

test('invalid HTTPS URL, missing URL and unknown authority stay receipt-only without fabrication', () => {
  for (const sourceUrl of [undefined, 'http://example.com/item', 'file:///tmp/item', 'not-a-url']) {
    const result = normalizeEvidence({ sourceName: 'OpenAI News', ...(sourceUrl ? { sourceUrl } : {}) }, { observedAt });
    assert.equal(result.receiptEligible, true);
    assert.equal(result.registryEligible, false);
    assert.equal(result.normalized.sourceUrl, sourceUrl);
    assert.ok(result.errors.some(({ code }) => code.startsWith('SOURCE_URL_')));
  }
  const unknown = normalizeEvidence({ sourceName: 'Mystery Source', sourceUrl: 'https://example.com/item' }, { observedAt });
  assert.equal(unknown.registryEligible, false);
  assert.ok(unknown.errors.some(({ code }) => code === 'SOURCE_AUTHORITY_UNDEFINED'));
  assert.equal(unknown.normalized.sourceUrl, 'https://example.com/item');
});

test('future sourcePublishedAt is surfaced as undefined policy but does not invent a blocking rule', () => {
  const result = normalizeEvidence({ sourceName: 'OpenAI News', sourceUrl: 'https://openai.com/news/x', sourcePublishedAt: '2026-10-01T00:00:00Z' }, { observedAt });
  assert.equal(result.registryEligible, true);
  assert.ok(result.errors.some(({ code }) => code === 'TIME_ORDER_POLICY_UNDEFINED'));
});

test('regression: raw RSS permalink survives parsed candidate through normalization into ObservationInput', () => {
  const raw = rssItemToCandidate('OpenAI News', { title: 'Release', link: 'https://openai.com/news/release/?id=1', published: '2026-09-29T00:00:00Z' });
  const prepared = prepareEvidenceCommit({ ...base, ...raw }, { radar: 'ai', observedAt });
  assert.equal(prepared.registryEligible, true);
  assert.equal(prepared.observationInput.sourceUrl, 'https://openai.com/news/release/?id=1');
  assert.equal(prepared.observationInput.observedAt, observedAt);
  assert.ok(prepared.observationId);
  assert.equal(prepared.commitRequest.observation.sourceUrl, raw.sourceUrl);
});

test('dry integration returns atomic commit input and never commits; retrieval time cannot change identity', () => {
  const item = { ...base, sourceName: 'OpenAI News', sourceUrl: 'https://openai.com/news/release/' };
  const first = prepareEvidenceCommit(item, { radar: 'ai', observedAt, retrievedAt: '2026-09-30T03:00:01.000Z' });
  const refetched = prepareEvidenceCommit(item, { radar: 'ai', observedAt, retrievedAt: '2026-09-30T04:00:01.000Z' });
  assert.deepEqual(first.commitRequest.eventFacts, { entity: base.entity, canonicalEventType: base.canonicalEventType, eventIdentifier: base.eventIdentifier });
  assert.equal(first.observationId, refetched.observationId);
  assert.equal(first.commitRequest.observation.observedAt, observedAt);
  assert.equal(first.commitRequest.observation.retrievedAt, '2026-09-30T03:00:01.000Z');
  assert.equal(typeof first.commitRequest, 'object');
  assert.equal(Object.hasOwn(first, 'registryWriteStatus'), false);
});
