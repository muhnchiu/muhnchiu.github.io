import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { policyArtifactPath } from '../scripts/policy-artifact-path.mjs';

const projectRoot = new URL('../', import.meta.url);
const replayBytes = await readFile(policyArtifactPath('radar-event-replay-v1.json'));
const replay = JSON.parse(replayBytes);
const eventManifest = JSON.parse(await readFile(policyArtifactPath('radar-event-policy-v1-manifest.json'), 'utf8'));
const schema = JSON.parse(await readFile(new URL('vendor/horizon-contracts/radar/v2/2.1.2/radar-v2.schema.json', projectRoot), 'utf8'));
const eventKeyPattern = new RegExp(schema.$defs.eventKey.pattern);

test('Contract 2.1.2 accepts every frozen Event Replay key without changing its baseline', () => {
  assert.equal(createHash('sha256').update(replayBytes).digest('hex'), eventManifest.replayJsonSha256);
  assert.deepEqual(replay.summary, { candidates: 50, uniqueEvents: 39, NEW: 39, DUPLICATE: 11, UPDATE: 0 });
  assert.equal(replay.fixtures.length, 50);
  assert.equal(new Set(replay.fixtures.map(({ eventKey }) => eventKey)).size, 39);

  const counts = { NEW: 0, DUPLICATE: 0, UPDATE: 0 };
  for (const fixture of replay.fixtures) {
    assert.match(fixture.eventKey, eventKeyPattern, `F${fixture.id}: ${fixture.eventKey}`);
    assert.equal(fixture.eventKey.split(':').length, 3, `F${fixture.id}`);
    assert.equal(fixture.eventKey.split(':')[1], fixture.canonicalEventType, `F${fixture.id}`);
    counts[fixture.eventState] += 1;
  }
  assert.deepEqual(counts, { NEW: 39, DUPLICATE: 11, UPDATE: 0 });

  for (const [id, key] of [
    [3, 'deepseek-v4.1:model-release:initial'],
    [7, 'deepseek-v4.1:model-release:initial'],
    [10, 'glm-5.2-openrouter:pricing-change:pricing'],
  ]) {
    assert.equal(replay.fixtures.find(({ id: fixtureId }) => fixtureId === id)?.eventKey, key, `F${id}`);
    assert.match(key, eventKeyPattern, `F${id}`);
  }
});
