import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNvdCandidate } from '../src/lib/radar-production-registry/nvd-cve-capture.mjs';
import { createArxivCandidate } from '../src/lib/radar-production-registry/arxiv-feed-capture.mjs';
import {
  ARXIV_PRODUCTION_REGISTRY_NAMESPACE, NVD_PRODUCTION_REGISTRY_NAMESPACE,
  PRODUCTION_IDENTITY_MODE, ProductionIdentityRegistry,
} from '../src/lib/radar-production-registry/production-identity-registry.mjs';

const observedAt = '2026-10-03T10:25:16.000Z';

test('source-specific production authorization commits only the exact arXiv or NVD source namespace with auditable run IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phase63-prod-auth-'));
  try {
    const rows = [
      {
        namespace: ARXIV_PRODUCTION_REGISTRY_NAMESPACE,
        radar: 'AI', source: 'arXiv cs.LG',
        create: () => createArxivCandidate({
          id: '2610.02207v1', itemUrl: 'https://arxiv.org/abs/2610.02207v1', title: 'Research paper title',
          published: '2026-10-01T17:59:58Z', updated: '2026-10-01T17:59:58Z', categories: ['cs.LG'], sourceIdentifier: 'export.arxiv.org/api/query:cat:cs.LG',
        }, { observedAt }),
      },
      {
        namespace: NVD_PRODUCTION_REGISTRY_NAMESPACE, radar: 'SEC', source: 'NVD',
        create: () => createNvdCandidate({ id: 'CVE-2026-103530', desc: 'Official CVE description',
          itemUrl: 'https://nvd.nist.gov/vuln/detail/CVE-2026-103530',
          sourceIdentifier: 'services.nvd.nist.gov/rest/json/cves/2.0' }, { observedAt }),
      },
    ];
    for (const row of rows) {
      const stateDir = join(root, row.namespace);
      const registry = new ProductionIdentityRegistry({ stateDir, registryNamespace: row.namespace, authorized: true, enabled: false });
      const { candidateResult, identity } = row.create();
      assert.equal(candidateResult.status, 'CANDIDATE_READY');
      assert.equal(identity.status, 'IDENTITY_READY');
      await assert.rejects(registry.commit({ candidateResult, identity, runId: 'unauthorized', runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true }), { code: 'PRODUCTION_REGISTRY_DISABLED' });
      registry.enable();
      const committed = await registry.commit({ candidateResult, identity, runId: `phase6.3-${row.radar.toLowerCase()}-test`, runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true });
      assert.equal(committed.registryDisposition, 'NEW_EVENT');
      const pair = await registry.readPair();
      assert.equal(pair.events.length, 1); assert.equal(pair.observations.length, 1);
      const audit = (await readFile(join(stateDir, 'audit', 'registry-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const writeRows = audit.filter((entry) => entry.operation === 'WRITE_INTENT' || entry.operation === 'WRITE_RESULT');
      assert.equal(writeRows.filter((entry) => entry.operation === 'WRITE_INTENT').length, 1);
      assert.equal(writeRows.filter((entry) => entry.operation === 'WRITE_RESULT' && entry.success).length, 1);
      for (const entry of writeRows) {
        assert.equal(entry.runId, `phase6.3-${row.radar.toLowerCase()}-test`);
        assert.equal(entry.source.sourceName, row.source);
        assert.equal(entry.eventKey, committed.eventKey);
        assert.equal(entry.observationId, committed.observationId);
        assert.ok(entry.when);
      }
      const replayed = await registry.commit({ candidateResult, identity, runId: 'replay', runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true });
      assert.equal(replayed.registryDisposition, 'DUPLICATE_OBSERVATION');
      assert.equal(replayed.eventKey, committed.eventKey);
      assert.equal(replayed.observationId, committed.observationId);
      const after = await registry.readPair();
      assert.equal(after.events.length, 1); assert.equal(after.observations.length, 1);
      assert.equal(after.events[0].occurrences, 1);
      const otherNamespace = row.radar === 'SEC' ? ARXIV_PRODUCTION_REGISTRY_NAMESPACE : NVD_PRODUCTION_REGISTRY_NAMESPACE;
      const otherRegistry = new ProductionIdentityRegistry({ stateDir: join(root, otherNamespace), registryNamespace: otherNamespace, authorized: true, enabled: true });
      await assert.rejects(otherRegistry.commit({ candidateResult, identity, runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true }), { code: 'PRODUCTION_SOURCE_NOT_ALLOWLISTED' });
      registry.disable();
      await assert.rejects(registry.commit({ candidateResult, identity, runtimeMode: PRODUCTION_IDENTITY_MODE, productionRegistryEnabled: true }), { code: 'PRODUCTION_REGISTRY_DISABLED' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
