import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { policyArtifactPath } from '../scripts/policy-artifact-path.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  buildEventFingerprint, buildEventKey, evaluateMaterialChange, inspectMaterialChange, resolveEventState,
} from '../src/lib/radar-event-identity.mjs';
import { validateRadarV21Semantics } from '../vendor/horizon-contracts/radar/v2/2.1.2/validator.mjs';

const replay = JSON.parse(await readFile(policyArtifactPath('radar-event-replay-v1.json'), 'utf8'));
const contractBase = new URL('../vendor/horizon-contracts/radar/v2/2.1.2/', import.meta.url);
const contractSchema = JSON.parse(await readFile(new URL('radar-v2.schema.json', contractBase), 'utf8'));
const validContractFixture = JSON.parse(await readFile(new URL('fixtures/v2.1/valid-events.json', contractBase), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
ajv.addKeyword('x-radar-count-semantics');
const validateContract = ajv.compile(contractSchema);

test('Event Replay 1.0 exact-matches every frozen event identity and state row', () => {
  assert.deepEqual(replay.summary, { candidates: 50, uniqueEvents: 39, NEW: 39, DUPLICATE: 11, UPDATE: 0 });
  const prior = [];
  const counts = { NEW: 0, DUPLICATE: 0, UPDATE: 0 };
  for (const row of replay.fixtures) {
    const [, canonicalEventType, eventIdentifier] = row.eventKey.split(':');
    const result = resolveEventState({
      entity: row.entity, canonicalEventType, eventIdentifier,
      // The frozen replay supplies its fingerprint oracle; it has no fact payload from which to re-hash.
      fingerprint: row.fingerprint,
      previousEvents: prior,
    });
    assert.deepEqual(result, {
      eventKey: row.eventKey,
      entity: row.entity,
      canonicalEventType: row.canonicalEventType,
      fingerprint: row.fingerprint,
      eventState: row.eventState,
      duplicate: row.eventState === 'DUPLICATE',
      materialChange: row.eventState === 'UPDATE',
    }, `F${row.id}`);
    assert.equal(buildEventKey({ entity: row.entity, canonicalEventType, eventIdentifier }), row.eventKey, `F${row.id} key`);
    counts[result.eventState] += 1;
    if (result.eventState === 'NEW') prior.push({ eventKey: result.eventKey, canonicalEventType, fingerprint: result.fingerprint });
    const contractResult = validateRadarV21Semantics({ highlights: [{
      eventKey: result.eventKey,
      canonicalEventType: result.canonicalEventType,
      eventState: result.eventState,
      materialChange: result.materialChange,
      duplicate: result.duplicate,
      observedAt: `${row.date}T00:00:00Z`,
      sources: [{ level: 'official', name: 'Frozen replay fixture' }],
    }] });
    assert.deepEqual(contractResult.errors, [], `F${row.id} Contract 2.1.2`);
    const report = structuredClone(validContractFixture);
    report.highlights[0] = {
      ...report.highlights[0],
      eventKey: result.eventKey,
      entity: result.entity,
      canonicalEventType: result.canonicalEventType,
      eventState: result.eventState,
      materialChange: result.materialChange,
      duplicate: result.duplicate,
      observedAt: `${row.date}T00:00:00Z`,
    };
    assert.equal(validateContract(report), true, `F${row.id} Contract 2.1.2 schema: ${JSON.stringify(validateContract.errors)}`);
  }
  assert.deepEqual(counts, { NEW: 39, DUPLICATE: 11, UPDATE: 0 });
  assert.equal(prior.length, 39);
  assert.equal(replay.fixtures.find(({ id }) => id === 3).eventKey, 'deepseek-v4.1:model-release:initial');
  assert.equal(replay.fixtures.find(({ id }) => id === 10).eventKey, 'glm-5.2-openrouter:pricing-change:pricing');
  assert.deepEqual([33, 38].map((id) => replay.fixtures.find((row) => row.id === id).eventState), ['NEW', 'NEW']);
});

test('Event key grammar and frozen event type registry fail closed', () => {
  assert.equal(buildEventKey({ entity: 'deepseek-v4.1', canonicalEventType: 'model-release', eventIdentifier: 'initial' }), 'deepseek-v4.1:model-release:initial');
  assert.equal(buildEventKey({ entity: 'glm-5.2-openrouter', canonicalEventType: 'pricing-change', eventIdentifier: 'pricing' }), 'glm-5.2-openrouter:pricing-change:pricing');
  assert.throws(() => buildEventKey({ entity: 'Upper Entity', canonicalEventType: 'release', eventIdentifier: 'initial' }), /INVALID_ENTITY/);
  assert.throws(() => buildEventKey({ entity: 'entity', canonicalEventType: 'unknown', eventIdentifier: 'initial' }), /INVALID_CANONICAL_EVENT_TYPE/);
});

test('fingerprint hashes only sorted non-null Frozen Event Policy 1.0 fact fields', () => {
  const facts = { activeExploitation: true, version: '2.1.0', title: 'ignored', pricingTerms: 'ignored', cveId: null };
  const canonical = JSON.stringify({ activeExploitation: true, version: '2.1.0' });
  assert.equal(buildEventFingerprint(facts), createHash('sha256').update(canonical).digest('hex').slice(0, 16));
  assert.equal(buildEventFingerprint({ version: '2.1.0', activeExploitation: true }), buildEventFingerprint(facts));
  assert.equal(buildEventFingerprint({}), buildEventFingerprint({ title: 'ignored', apiAvailability: false, license: 'MIT' }));
  for (const field of ['version', 'cveId', 'activeExploitation', 'supplyChainImpact', 'reachableDependency', 'officialEmergencyAdvisory']) {
    assert.notEqual(buildEventFingerprint({ [field]: field === 'version' || field === 'cveId' ? 'v2' : true }), buildEventFingerprint({}));
  }
});

test('synthetic UPDATE uses only frozen fact fields and never crosses canonical types', () => {
  const before = { version: '2.1.0', activeExploitation: false };
  const afterVersion = { version: '2.1.1', activeExploitation: false };
  const versionState = resolveEventState({
    entity: 'fixture-tool', canonicalEventType: 'version-update', eventIdentifier: '2.1.1',
    fingerprint: buildEventFingerprint(afterVersion),
    previousEvents: [{ eventKey: 'fixture-tool:version-update:2.1.1', canonicalEventType: 'version-update', fingerprint: buildEventFingerprint(before) }],
  });
  assert.equal(versionState.eventState, 'UPDATE');
  assert.equal(versionState.duplicate, false);
  assert.equal(versionState.materialChange, true);
  assert.equal(evaluateMaterialChange({ canonicalEventType: 'security-cve', previousCanonicalEventType: 'security-cisa-kev', previousFingerprint: 'a', fingerprint: 'b' }), false);
  // These requested examples are absent from the frozen fingerprint allowlist; differences cannot drive UPDATE.
  assert.equal(buildEventFingerprint({ pricingTerms: 'annual' }), buildEventFingerprint({ pricingTerms: 'monthly' }));
  assert.equal(buildEventFingerprint({ apiAvailability: true }), buildEventFingerprint({ apiAvailability: false }));
  assert.equal(buildEventFingerprint({ license: 'A' }), buildEventFingerprint({ license: 'B' }));
  assert.deepEqual(inspectMaterialChange({ canonicalEventType: 'pricing-change', previousFacts: { pricingTerms: 'annual' }, facts: { pricingTerms: 'monthly' } }), {
    materialChange: false, policyFieldNotFrozen: true,
  });
});
