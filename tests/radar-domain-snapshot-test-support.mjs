// Phase 9.2 Domain Snapshot Runtime — test support.
// Restores the lost /private/tmp/phase92-domain-resume staging contract as an
// in-repo module: the domain runtime is wired against the durable
// domain-isolated stores, the frozen profile vocabulary (payloadFieldsUnchanged),
// the frozen score-input rubric loader, and the canonical digest/equality
// helpers, so tests run from a clean checkout without /tmp staging.
// Test data fixture: fixtures/phase92-domain-resume/review-objects.json —
// REVIEW objects recovered verbatim from the hash-anchored domain snapshot.
import {readFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BootstrapAdmin} from '../src/lib/radar-bootstrap/index.mjs';
import {AdministrationStore, loadAdministrationPolicies} from '../src/lib/radar-capability/administration.mjs';
import {DomainHistoryStore} from '../src/lib/radar-capability/domain-history-store.mjs';
import {DomainHistoryAuthority} from '../src/lib/radar-capability/domain-authority.mjs';
import {loadDomainSnapshotProfile} from '../src/lib/radar-capability/domain-snapshot-profile.mjs';
import {loadRubric} from '../src/lib/radar-judgment/provider.mjs';
import {digest, same} from '../src/lib/radar-capability/snapshot-profile.mjs';

const STATE='/Users/qiuwenbo/.local/state/horizon';
const ANCHORS='/Users/qiuwenbo/.local/share/horizon-authority-anchors';
const T=join(dirname(fileURLToPath(import.meta.url)),'fixtures','phase92-domain-resume');
const read=async p=>JSON.parse(await readFile(p));

async function context(){
  const bootstrap=new BootstrapAdmin(), policies=await loadAdministrationPolicies(STATE);
  const profile=await loadDomainSnapshotProfile(STATE);
  const administration=new AdministrationStore({path:STATE+'/administration-runtime-v2/domain-isolated-trust', anchor:ANCHORS+'/administration-v2/domain-isolated-trust', bootstrap, policies});
  const reviewDefinition={payloadFields:profile.constraintPayload.definitions['reviewer-grant-binding'].payloadFieldsUnchanged};
  const rubric=await loadRubric();
  const authority=new DomainHistoryAuthority({profile, reviewDefinition, rubric, censusDirectory:ANCHORS+'/administration-v2/domain-history-census', evidenceDirectory:ANCHORS+'/administration-v2/domain-history-evidence', administration});
  const store=new DomainHistoryStore({path:STATE+'/administration-runtime-v2/domain-isolated-review-history', anchor:ANCHORS+'/administration-v2/domain-isolated-review-history', administration, profile, authority});
  return {store, profile, administration, authority};
}

export {context, T, read, digest, same};
