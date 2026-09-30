import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { policyArtifactPath } from '../scripts/policy-artifact-path.mjs';

const readState = async (file) => readFile(policyArtifactPath(file));
const [policyJsonBytes, policyMarkdownBytes, fixtureJsonBytes, fixtureMarkdownBytes] = await Promise.all([
  readState('radar-observation-policy-v1.json'),
  readState('radar-observation-policy-v1.md'),
  readState('radar-observation-fixtures-v1.json'),
  readState('radar-observation-fixtures-v1.md'),
]);
const policy = JSON.parse(policyJsonBytes);
const fixture = JSON.parse(fixtureJsonBytes);
const manifest = JSON.parse(await readFile(policyArtifactPath('radar-observation-fixtures-v1-manifest.json'), 'utf8'));
const policyManifest = JSON.parse(await readFile(policyArtifactPath('radar-observation-policy-v1-manifest.json'), 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonicalizeSourceUrl(value) {
  const url = new URL(value);
  const scheme = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const port = (scheme === 'https:' && url.port === '443') || (scheme === 'http:' && url.port === '80') ? '' : url.port;
  const pathname = url.pathname === '/' ? '/' : (url.pathname.replace(/\/+$/, '') || '/');
  return `${scheme}//${hostname}${port ? `:${port}` : ''}${pathname}${url.search}`;
}

function expectedObservationId(row) {
  const input = `${row.eventKey}\n${canonicalizeSourceUrl(row.sourceUrl)}\n${row.radar}`;
  return sha256(Buffer.from(input, 'utf8')).slice(0, 16);
}

test('frozen Observation Policy and Fixture artifacts retain their exact hashes and counts', () => {
  assert.equal(policy.policyVersion, '1.0');
  assert.equal(policy.status, 'FROZEN');
  assert.equal(fixture.fixtureVersion, '1.0');
  assert.equal(fixture.status, 'FROZEN');
  assert.deepEqual(manifest.counts, { total: 29, valid: 19, invalid: 10 });
  assert.equal(fixture.cases.valid.length, 19);
  assert.equal(fixture.cases.invalid.length, 10);
  assert.deepEqual([
    sha256(policyJsonBytes), sha256(policyMarkdownBytes), sha256(fixtureJsonBytes), sha256(fixtureMarkdownBytes),
  ], [
    'c7761cdeae712deb6096fce67b1324f5d1acac55ed3b0df6e91a1a49a8c9de51',
    'a9664ead4ef3288884b5b657851cd7868b5a37b70ccb4f89e0cac760a574fa3e',
    'b01e8f0c4e9c350df4cfce4b55a4f210c7447692caf6e6530cbd611c8b1e7cdc',
    '25ede34bcd64216527168c97f8d1218500eb851c09f94ca6d01910b79a9d2644',
  ]);
  assert.equal(manifest.policyArtifactHashes.json, sha256(policyJsonBytes));
  assert.equal(manifest.policyArtifactHashes.markdown, sha256(policyMarkdownBytes));
  assert.equal(policyManifest.status, 'FROZEN');
});

test('all frozen Observation identity pairs still match their expected IDs under Contract 2.1.2', () => {
  const rows = new Map(fixture.cases.valid.map((row) => [row.case, row]));
  const schemaPromise = readFile(new URL('../vendor/horizon-contracts/radar/v2/2.1.2/radar-v2.schema.json', import.meta.url), 'utf8');
  return schemaPromise.then((rawSchema) => {
    const pattern = new RegExp(JSON.parse(rawSchema).$defs.eventKey.pattern);
    for (const row of fixture.cases.valid) {
      for (const field of fixture.requiredFields) assert.ok(row[field], `${row.case} ${field}`);
      assert.equal(row.canonicalSourceUrl, canonicalizeSourceUrl(row.sourceUrl), row.case);
      assert.equal(row.expectedObservationId, expectedObservationId(row), row.case);
      assert.match(row.eventKey, pattern, row.case);
    }
    assert.equal(fixture.identityExpectations.length, 9);
    for (const assertion of fixture.identityExpectations) {
      const ids = assertion.members.map((name) => rows.get(name)?.expectedObservationId);
      assert.deepEqual(ids, assertion.expectedIds, assertion.case);
      if (assertion.expected.startsWith('same ')) assert.equal(new Set(ids).size, 1, assertion.case);
      if (assertion.expected.startsWith('different ')) assert.equal(new Set(ids).size, ids.length, assertion.case);
    }
  });
});

test('all frozen Observation invalid inputs retain explicit fail-closed reasons', () => {
  assert.equal(fixture.cases.invalid.length, 10);
  for (const row of fixture.cases.invalid) {
    assert.equal(row.expected, 'FAIL', row.case);
    assert.ok(typeof row.error === 'string' && row.error.length > 0, row.case);
  }
  for (const name of ['eventKey', 'radar', 'sourceName', 'sourceUrl', 'sourceLevel', 'observedAt']) {
    assert.ok(fixture.cases.invalid.some(({ case: nameCase }) => nameCase === `missing_${name}`), `missing ${name}`);
  }
  for (const name of ['invalid_observedAt', 'invalid_url', 'unsupported_scheme', 'malformed_eventKey']) {
    assert.ok(fixture.cases.invalid.some(({ case: nameCase }) => nameCase === name), name);
  }
});
