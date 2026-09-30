import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { policyArtifactPath } from '../scripts/policy-artifact-path.mjs';
import { buildObservationIdentity, canonicalizeSourceUrl, resolveObservationTimes } from '../src/lib/radar-observation-identity.mjs';

const fixture = JSON.parse(await readFile(policyArtifactPath('radar-observation-fixtures-v1.json'), 'utf8'));

function actualError(observation) {
  try { buildObservationIdentity(observation); return null; } catch (error) { return error.message; }
}

test('Observation Fixture 1.0 exact-matches all 19 valid cases and 9 identity assertions', () => {
  assert.equal(fixture.cases.valid.length + fixture.cases.invalid.length, 29);
  const actualIds = new Map();
  for (const row of fixture.cases.valid) {
    const result = buildObservationIdentity(row);
    assert.equal(result.canonicalSourceUrl, row.canonicalSourceUrl, row.case);
    assert.equal(result.observationId, row.expectedObservationId, row.case);
    actualIds.set(row.case, result.observationId);
  }
  assert.equal(actualIds.size, 19);
  assert.equal(fixture.identityExpectations.length, 9);
  for (const assertion of fixture.identityExpectations) {
    const ids = assertion.members.map((name) => actualIds.get(name));
    assert.deepEqual(ids, assertion.expectedIds, assertion.case);
    if (assertion.expected.startsWith('same ')) assert.equal(new Set(ids).size, 1, assertion.case);
    if (assertion.expected.startsWith('different ')) assert.equal(new Set(ids).size, ids.length, assertion.case);
  }
  const ordering = fixture.timeOrderingFixture;
  const orderedRows = ordering.members.map((name) => fixture.cases.valid.find((row) => row.case === name));
  assert.deepEqual(resolveObservationTimes(orderedRows), {
    firstSeen: ordering.expectedFirstSeen,
    lastSeen: ordering.expectedLastSeen,
  });
  assert.equal(createHash('sha256').update(`${orderedRows[0].eventKey}\n${canonicalizeSourceUrl(orderedRows[0].sourceUrl)}\n${orderedRows[0].radar}`).digest('hex').slice(0, 16), ordering.expectedObservationId);
});

test('Observation Fixture 1.0 rejects all 10 invalid cases with frozen reasons', () => {
  assert.equal(fixture.cases.invalid.length, 10);
  for (const row of fixture.cases.invalid) {
    assert.equal(row.expected, 'FAIL', row.case);
    assert.equal(actualError(row.observation), row.error, row.case);
  }
});

test('URL normalization preserves path and query while applying only frozen canonicalization', () => {
  assert.equal(canonicalizeSourceUrl('HTTPS://EXAMPLE.com:443/a///?b=2&a=1#frag'), 'https://example.com/a?b=2&a=1');
  assert.equal(canonicalizeSourceUrl('http://example.com:80/'), 'http://example.com/');
  assert.equal(canonicalizeSourceUrl('https://example.com/?utm_source=x'), 'https://example.com/?utm_source=x');
});
