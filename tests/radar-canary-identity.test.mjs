import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { adaptProductionCandidate } from '../src/lib/radar-candidate-adapter/adapters.ts';
import { runProductionCandidateDryPipeline } from '../src/lib/radar-candidate-adapter/dry-pipeline.ts';
import { resolveClaudeCodeChangelogIdentity } from '../src/lib/radar-canary/claude-code-identity.mjs';

const capture = JSON.parse(readFileSync(new URL('../fixtures/radar-canary/claude-code-real-release-capture-v1.json', import.meta.url), 'utf8'));
const observedAt = '2026-10-03T01:00:00Z';
const generatedAt = '2026-10-03T01:01:00Z';

function candidateFor(item, overrides = {}, contextObservedAt = observedAt) {
  const record = {
    tag_name: item.tagName,
    name: item.title,
    html_url: item.itemUrl,
    ...overrides,
  };
  return adaptProductionCandidate(
    { radar: 'DEV', sourceName: 'Claude Code Changelog', record },
    { observedAt: contextObservedAt },
  );
}

test('five distinct official upstream release records pass Candidate Adapter → Identity → Evidence', async () => {
  assert.equal(capture.classification, 'REAL_UPSTREAM_CAPTURE');
  assert.equal(capture.items.length, 5);
  const keys = [];
  for (const item of capture.items) {
    const adapted = candidateFor(item);
    assert.equal(adapted.status, 'CANDIDATE_READY', item.tagName);
    assert.equal(adapted.candidate.itemUrl, item.itemUrl);
    const identity = resolveClaudeCodeChangelogIdentity(adapted.candidate);
    assert.equal(identity.status, 'IDENTITY_READY', item.tagName);
    assert.equal(identity.entity, 'claude-code');
    assert.equal(identity.canonicalEventType, 'version-update');
    assert.equal(identity.eventIdentifier, item.tagName.slice(1));
    assert.equal(identity.eventKey, `claude-code:version-update:${item.tagName.slice(1)}`);
    assert.deepEqual(Object.keys(identity.identityProvenance).sort(), ['canonicalEventType', 'entity', 'eventIdentifier']);
    assert.ok(Object.values(identity.identityProvenance).every((row) => row.evidenceRef === item.itemUrl && row.observedAtRelationship === 'OBSERVED_AT_EXCLUDED_FROM_IDENTITY'));

    const pipeline = await runProductionCandidateDryPipeline(
      { radar: 'DEV', sourceName: 'Claude Code Changelog', record: { tag_name: item.tagName, name: item.title, html_url: item.itemUrl } },
      { observedAt, generatedAt },
    );
    assert.equal(pipeline.adapterStatus, 'CANDIDATE_READY');
    assert.equal(pipeline.identityResolution.status, 'IDENTITY_READY');
    assert.equal(pipeline.eventIdentityResolvable, true);
    assert.equal(pipeline.evidenceValid, true);
    assert.equal(pipeline.securityGateResult.status, 'NOT_APPLICABLE');
    assert.equal(pipeline.status, 'RECEIPT_ONLY');
    assert.equal(pipeline.scoreGeneration.status, 'RECEIPT_ONLY');
    assert.equal(pipeline.scoreGeneration.eligibility.status, 'RECEIPT_ONLY');
    assert.equal(pipeline.scoreGeneration.missingRequiredInputs.includes('securityGate'), false, 'frozen non-SEC N/A must flow into the existing Score input resolver');
    assert.equal(pipeline.commitObservationCalled, false);
    assert.equal(pipeline.registryWrites, 0);
    assert.equal(pipeline.publisherCalls, 0);
    keys.push(identity.eventKey);
  }
  assert.equal(new Set(keys).size, 5, 'different upstream release records must not collide');
});

test('same item, retry, reordered fields, irrelevant metadata and duplicate delivery preserve exact Event identity', () => {
  const item = capture.items[0];
  const first = candidateFor(item);
  const retry = candidateFor(item, { irrelevant: { fetchedBy: 'retry-2' } }, '2026-10-03T02:00:00Z');
  const reorderedRecord = { html_url: item.itemUrl, name: item.title, tag_name: item.tagName };
  const reordered = adaptProductionCandidate({ radar: 'DEV', sourceName: 'Claude Code Changelog', record: reorderedRecord }, { observedAt });
  const outputs = [first, retry, reordered].map((row) => resolveClaudeCodeChangelogIdentity(row.candidate));
  assert.ok(outputs.every((row) => row.status === 'IDENTITY_READY'));
  assert.deepEqual(outputs[1], outputs[0]);
  assert.deepEqual(outputs[2], outputs[0]);
});

test('missing identifier, entity evidence, malformed URL or provenance fail closed without partial identity', () => {
  const item = capture.items[0];
  const cases = [
    candidateFor(item, { tag_name: '' }),
    candidateFor(item, { html_url: item.itemUrl.replace('/anthropics/claude-code/', '/some-owner/other-repo/') }),
    candidateFor(item, { html_url: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.288?ref=feed' }),
  ];
  const malformedUrl = structuredClone(candidateFor(item).candidate);
  malformedUrl.itemUrl = 'not-a-url';
  cases.push({ status: 'CANDIDATE_READY', candidate: malformedUrl });
  for (const adapted of cases) {
    assert.equal(adapted.status, 'CANDIDATE_READY');
    const result = resolveClaudeCodeChangelogIdentity(adapted.candidate);
    assert.equal(result.status, 'IDENTITY_UNRESOLVED');
    assert.equal(Object.hasOwn(result, 'eventKey'), false);
    assert.equal(Object.hasOwn(result, 'entity'), false);
  }

  const missingProvenance = structuredClone(candidateFor(item).candidate);
  missingProvenance.sourceAuthority = undefined;
  const provenanceResult = resolveClaudeCodeChangelogIdentity(missingProvenance);
  assert.equal(provenanceResult.status, 'IDENTITY_UNRESOLVED');
  assert.equal(provenanceResult.reasonCode, 'IDENTITY_PROVENANCE_INCOMPLETE');
  assert.equal(Object.hasOwn(provenanceResult, 'eventKey'), false);
});

test('tag/URL mismatch and unapproved source context have no silent fallback', () => {
  const item = capture.items[0];
  const mismatched = candidateFor(item, { tag_name: 'v2.1.289' });
  assert.equal(resolveClaudeCodeChangelogIdentity(mismatched.candidate).reasonCode, 'SOURCE_TAG_MISMATCH');

  const otherRadar = structuredClone(candidateFor(item).candidate);
  otherRadar.radar = 'AI';
  assert.equal(resolveClaudeCodeChangelogIdentity(otherRadar).reasonCode, 'SOURCE_NOT_ALLOWLISTED');

  const otherFamily = structuredClone(candidateFor(item).candidate);
  otherFamily.sourceName = 'GitHub Trending';
  assert.equal(resolveClaudeCodeChangelogIdentity(otherFamily).reasonCode, 'SOURCE_NOT_ALLOWLISTED');
});
