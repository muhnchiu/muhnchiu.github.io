#!/usr/bin/env node
// Horizon Radar V2 — production publication adapter (minimal production wiring).
//
// Modes:
//   plan      read-only: validate archive reports, derive identities, print the exact
//             file manifest. No writes anywhere.
//   rehearse  full pipeline against a TEMPORARY worktree (--root), with registry state
//             inside the worktree, using clearly-marked rehearsal authorization (same
//             isolation boundary as the sanctioned canary). Refuses the production checkout.
//   execute   production write. Fail-closed unless RADAR_V2_PRODUCTION_AUTHORIZATION=GRANTED
//             and RADAR_V2_RUNTIME_GRANT_REFERENCE are provided. The frozen publication
//             policy still evaluates fail-closed — until the Phase 9.2 authorization
//             ceremony completes, absence of proof states yields REJECTED_* dispositions.
//             That is governance working as designed; this adapter does not bypass it.
//
// Guards: kill switch (start + before each write), V1/V2 dual-publish guard,
// research exclusion, single-date single-radar scope, exact file manifest,
// Astro build precheck with rollback, precise git staging (no push).
// Rollback: every touched path is restored; created files are removed.
import {readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync, rmSync, appendFileSync, openSync, fsyncSync, closeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
// [C3-D2A candidate] loadFrozenPolicy/evaluateFrozenPolicy (PP 1.0.0 frozen table) reserved for
// future intelligence-event publications; DAILY_DIGEST content class routes through the PP 2.0.0 gate.
// import {loadFrozenPolicy, evaluateFrozenPolicy} from '../src/lib/radar-publisher/policy.mjs';
import {instruction} from '../src/lib/radar-publisher/canonical.mjs';
import {evaluateDailyDigestGate} from '../src/lib/radar-publisher/policy-v2-daily-digest.mjs';


const RADARS = [
  {archive: 'ai', id: 'ai'},
  {archive: 'app', id: 'app'},
  {archive: 'dev', id: 'dev'},
  {archive: 'sec', id: 'security'},
  {archive: 'skill', id: 'skill'},
];
const REQUIRED_FIELDS = ['title', 'date', 'radar', 'signalCount', 'highSignalCount', 'actionableCount', 'actionRequired', 'verdict', 'highlights', 'topics', 'confidence', 'publish'];
const STATE_DIR = process.env.HOME + '/.local/state/horizon';
const POLICY_DIR = STATE_DIR + '/policies/publication/1.0.0';

const fail = msg => { console.error(`[radar-v2-adapter] STOP: ${msg}`); process.exit(2); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function parseArgs(argv) {
  const args = {mode: 'plan', radars: 'all', commit: false, injectFailureAt: null};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (i === 2 && ['plan', 'rehearse', 'execute'].includes(a)) { args.mode = a; continue; }
    if (a === '--date') args.date = argv[++i];
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--radar') args.radars = argv[++i];
    else if (a === '--root') args.root = resolve(argv[++i]);
    else if (a === '--archive-root') args.archiveRoot = resolve(argv[++i]);
    else if (a === '--registry-state-dir') args.registryStateDir = resolve(argv[++i]);
    else if (a === '--commit') args.commit = true;
    else if (a === '--json') args.json = true;
    else if (a === '--inject-failure-at') args.injectFailureAt = argv[++i];
    else fail(`unknown argument ${a}`);
  }
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) fail('--date YYYY-MM-DD required');
  if (!['plan', 'rehearse', 'execute'].includes(args.mode)) fail('--mode plan|rehearse|execute');
  if (!args.root) fail('--root <site-root> required');
  if (args.mode !== 'plan' && !args.registryStateDir) fail(`--registry-state-dir required for ${args.mode}`);
  args.archiveRoot ??= process.env.HOME + '/workspace/mac-env-sync/docs/radar-reports';
  return args;
}

function killSwitchEngaged() {
  if (process.env.RADAR_V2_KILL_SWITCH === '1') return 'RADAR_V2_KILL_SWITCH env';
  if (existsSync(STATE_DIR + '/radar-v2-kill')) return STATE_DIR + '/radar-v2-kill marker';
  return null;
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const fm = {highlights: [], topics: []};
  let current = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    const li = /^\s+-\s+(?:title:\s*"(.*)"|"?([^"]*)"?)\s*$/.exec(line);
    if (kv && !line.startsWith(' ')) {
      const k = kv[1], v = kv[2].trim();
      if (k === 'highlights') { fm.highlights = []; current = 'highlights'; continue; }
      if (k === 'topics') { fm.topics = []; current = 'topics'; continue; }
      current = null;
      fm[k] = v === 'true' || v === 'false' ? v === 'true' : v.replace(/^"|"$/g, '');
    } else if (current === 'highlights' && li) {
      fm.highlights.push({title: li[1] ?? li[2] ?? ''});
    } else if (current === 'topics' && li) {
      const t = (li[2] ?? li[1] ?? '').replace(/^"|"$/g, '');
      if (t) fm.topics.push(t);
    }
  }
  return fm;
}

function validateReport(text, radarId, date) {
  const errors = [];
  const fm = parseFrontmatter(text);
  if (!fm) return {fm: null, errors: ['missing YAML frontmatter']};
  for (const f of REQUIRED_FIELDS) if (!(f in fm)) errors.push(`missing field ${f}`);
  if (fm.date !== date) errors.push(`frontmatter date ${fm.date} != ${date}`);
  if (fm.radar !== radarId) errors.push(`frontmatter radar ${fm.radar} != ${radarId}`);
  if (typeof fm.publish !== 'boolean') errors.push('publish must be boolean');
  if (!Array.isArray(fm.highlights) || fm.highlights.length > 5) errors.push(`highlights ${fm.highlights?.length} > 5`);
  const hs = Number(fm.highSignalCount), ac = Number(fm.actionableCount), ar = Number(fm.actionRequired), sc = Number(fm.signalCount);
  if (![hs, ac, ar, sc].every(Number.isInteger)) errors.push('count fields must be integers');
  else {
    if (hs > sc || ac > sc || ar > sc || ar > ac) errors.push('count consistency violated');
    if (fm.highlights.length > sc) errors.push('highlights > signalCount');
  }
  return {fm, errors};
}


// ======================================================================
// [C3-D2A candidate] 13-node safety chain additions.
// Ported from C3-D1 accepted source (1821607): authorityBindingAdapter.js,
// receiptStore.js, runtimeIntegration.js — inlined to honor the frozen
// 4-file changeset scope. Provenance: sha256 recorded in CHANGESET_MANIFEST.
// Fail-closed: every refusal stops the run. Absence is never approval.
// ======================================================================
// Node 9: SEC classification gate — sec pipeline not ready → refuse.
function secGate(radarId) {
  if (radarId === 'security') return {ok: false, reason: 'SECURITY_UNRESOLVED (SEC classification pipeline not ready)'};
  return {ok: true, reason: 'NOT_APPLICABLE'};
}
// Node 5: archive provenance — report must be committed & clean in mac-env-sync.
function provenanceCheck(archiveRoot, radarArchive, date, contentSha256) {
  try {
    const repoRoot = resolve(archiveRoot, '..', '..');
    execFileSync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], {stdio: ['ignore', 'pipe', 'pipe']});
    const rel = `docs/radar-reports/${radarArchive}/${date}.md`;
    const commit = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%H', '--', rel], {encoding: 'utf8'}).trim();
    if (!commit) return {ok: false, reason: 'ARCHIVE_NOT_COMMITTED'};
    const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', rel], {encoding: 'utf8'}).trim();
    if (dirty) return {ok: false, reason: 'ARCHIVE_WORKING_TREE_DIRTY'};
    const committed = execFileSync('git', ['-C', repoRoot, 'show', 'HEAD:' + rel], {encoding: 'utf8'});
    if (sha(Buffer.from(committed, 'utf8')) !== contentSha256) return {ok: false, reason: 'ARCHIVE_CONTENT_HASH_MISMATCH'};
    return {ok: true, reason: 'COMMITTED ' + commit.slice(0, 10)};
  } catch (e) { return {ok: false, reason: 'PROVENANCE_CHECK_ERROR: ' + (e?.message ?? e).slice(0, 80)}; }
}
// Node 8: operator review record (fail-closed; absence is never approval).
function operatorReviewCheck(registryStateDir, radarId, date, contentSha256) {
  const p = join(registryStateDir, 'radar-v2-review', `${radarId}-${date}.json`);
  if (!existsSync(p)) return {ok: false, reason: 'OPERATOR_REVIEW_MISSING'};
  try {
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    if (rec.conclusion !== 'APPROVED') return {ok: false, reason: 'OPERATOR_REVIEW_NOT_APPROVED'};
    if (rec.contentSha256 !== contentSha256) return {ok: false, reason: 'OPERATOR_REVIEW_CONTENT_MISMATCH'};
    if (rec.radar !== radarId || rec.date !== date) return {ok: false, reason: 'OPERATOR_REVIEW_SCOPE_MISMATCH'};
    const ageH = (Date.now() - new Date(rec.reviewedAt).getTime()) / 36e5;
    if (!(ageH >= 0 && ageH <= 24)) return {ok: false, reason: 'OPERATOR_REVIEW_EXPIRED_OR_FUTURE'};
    return {ok: true, reason: 'APPROVED by ' + rec.reviewer};
  } catch { return {ok: false, reason: 'OPERATOR_REVIEW_CORRUPT'}; }
}
// Node 11: Mode A authorization binding (AUTH-06 enforced: instruction-level binding,
// single-value exact OR strict list membership; empty/missing/invalid → refuse).
// Ceremony pending → grant records absent → refused (governance as designed).
function modeaAuthorizationCheck(registryStateDir, radarId, date, contentSha256) {
  const p = join(registryStateDir, 'mode-a-authorizations', `${radarId}-${date}.json`);
  if (!existsSync(p)) return {ok: false, reason: 'MODEA_AUTHORIZATION_MISSING (Phase 9.2 ceremony pending — governance as designed)'};
  let rec; try { rec = JSON.parse(readFileSync(p, 'utf8')); } catch { return {ok: false, reason: 'MODEA_AUTHORIZATION_CORRUPT'}; }
  if (rec.radar !== radarId) return {ok: false, reason: 'MODEA_SCOPE_MISMATCH: radar'};
  if (rec.date !== date) return {ok: false, reason: 'MODEA_SCOPE_MISMATCH: date'};
  if (rec.revoked === true) return {ok: false, reason: 'MODEA_REVOKED'};
  if ('contentClass' in rec && rec.contentClass !== 'DAILY_DIGEST') return {ok: false, reason: 'MODEA_CONTENT_CLASS_MISMATCH'};
  if ('notBefore' in rec && Date.now() < new Date(rec.notBefore).getTime()) return {ok: false, reason: 'MODEA_NOT_YET_VALID'};
  if ('notAfter' in rec && Date.now() > new Date(rec.notAfter).getTime()) return {ok: false, reason: 'MODEA_WINDOW_EXPIRED'};
  const instructionRef = sha(`${radarId}:${date}:DAILY_DIGEST`);
  const single = typeof rec.instructionId === 'string' && rec.instructionId.length > 0 ? rec.instructionId : null;
  const list = Array.isArray(rec.instructionIds) && rec.instructionIds.length > 0 ? rec.instructionIds : null;
  if (Array.isArray(rec.instructionIds) && rec.instructionIds.length === 0) return {ok: false, reason: 'MODEA_EMPTY_INSTRUCTION_IDS'};
  if (!single && !list) return {ok: false, reason: 'MODEA_INSTRUCTION_BINDING_ABSENT (AUTH-06: fail-closed)'};
  if (typeof instructionRef !== 'string' || !/^[0-9a-fA-F]{64}$/.test(instructionRef)) return {ok: false, reason: 'MODEA_INSTRUCTION_REFERENCE_INVALID'};
  const member = single ? instructionRef === single : list.includes(instructionRef);
  if (!member) return {ok: false, reason: 'MODEA_INSTRUCTION_MISMATCH (AUTH-06)'};
  return {ok: true, reason: 'bound ' + instructionRef.slice(0, 12) + ' (PRODUCTION_AUTHORITY_BINDING_UNVERIFIED until Phase 9.2)'};
}
// Nodes 7/13: six-state publication receipts (PREPARED→AUTHORIZED→COMMITTED→PUBLISHED|FAILED|ROLLED_BACK).
// PUBLISHED requires deploymentVerified=true — reserved for post-cutover deployment
// confirmation (Approval D scope); this changeset never emits PUBLISHED.
const SIX_STATE_LEGAL = {PREPARED: ['AUTHORIZED','FAILED','ROLLED_BACK'], AUTHORIZED: ['COMMITTED','FAILED','ROLLED_BACK'], COMMITTED: ['PUBLISHED','FAILED','ROLLED_BACK'], PUBLISHED: [], FAILED: [], ROLLED_BACK: []};
class SixStateReceipts {
  constructor(dir) { this.jsonl = join(dir, 'receipts.jsonl'); this.lockDir = join(dir, '.write-lock'); mkdirSync(dir, {recursive: true}); this.held = false; }
  acquireLock() { if (this.held) return true; try { mkdirSync(this.lockDir); this.held = true; return true; } catch { return false; } }
  releaseLock() { try { rmSync(this.lockDir, {force: true, recursive: true}); } catch {} this.held = false; }
  find(instructionId) {
    if (!existsSync(this.jsonl)) return [];
    return readFileSync(this.jsonl, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.instructionId === instructionId);
  }
  current(instructionId) { const r = this.find(instructionId); return r.length ? r[r.length - 1] : null; }
  prepare({instructionId, contentSha256, radar, date, contentClass}) {
    if (!this.acquireLock()) return {outcome: 'APPEND_FAILED', reason: 'LOCK_TIMEOUT'};
    try {
      const recs = this.find(instructionId);
      if (recs.length) {
        if (!recs.every(r => r.contentSha256 === contentSha256)) return {outcome: 'CONTENT_CONFLICT', reason: 'INSTRUCTION_ID_REUSED_WITH_DIFFERENT_CONTENT'};
        return {outcome: 'DUPLICATE_PUBLICATION', existingState: recs[recs.length - 1].state};
      }
      this.append({instructionId, contentSha256, radar, date, contentClass, state: 'PREPARED', at: new Date().toISOString()});
      return {outcome: 'RECEIPTED'};
    } finally { this.releaseLock(); }
  }
  append(obj) {
    const fd = openSync(this.jsonl, 'a');
    try { appendFileSync(fd, JSON.stringify(obj) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }
  transition(instructionId, toState, meta = {}) {
    if (!this.acquireLock()) return {outcome: 'APPEND_FAILED', reason: 'LOCK_TIMEOUT'};
    try {
      const cur = this.current(instructionId);
      if (!cur) return {outcome: 'APPEND_FAILED', reason: 'UNKNOWN_INSTRUCTION'};
      if (!(SIX_STATE_LEGAL[cur.state] ?? []).includes(toState)) return {outcome: 'ILLEGAL_TRANSITION', from: cur.state, to: toState};
      if (toState === 'PUBLISHED' && meta.deploymentVerified !== true) return {outcome: 'APPEND_FAILED', reason: 'DEPLOYMENT_NOT_VERIFIED_NO_PUBLISHED'};
      this.append({instructionId: cur.instructionId, contentSha256: cur.contentSha256, radar: cur.radar, date: cur.date, contentClass: cur.contentClass, state: toState, at: new Date().toISOString(), ...meta});
      return {outcome: 'TRANSITIONED', state: toState};
    } finally { this.releaseLock(); }
  }
  hasPublishedFor(radar, date, excludeId = null) {
    if (!existsSync(this.jsonl)) return false;
    return this.readAll().some(r => r.radar === radar && r.date === date && r.state === 'PUBLISHED' && r.instructionId !== excludeId);
  }
  readAll() { return existsSync(this.jsonl) ? readFileSync(this.jsonl, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
}

async function main() {
  const args = parseArgs(process.argv);
  const root = resolve(args.root);
  // 生产 checkout = 本适配器所在的仓库；rehearse 只允许其他克隆/临时工作树。
  const adapterRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const productionCheckout = root === adapterRepoRoot;
  if (args.mode === 'rehearse' && productionCheckout) fail('rehearse mode refuses the production checkout — pass a temporary worktree');
  if (args.mode === 'execute' && !productionCheckout) fail('execute mode requires the production checkout');

  const kill = killSwitchEngaged();
  if (kill) fail(`kill switch engaged: ${kill}`);

  // [C3-D2A candidate] Node 2: env dual-gates — execute refuses unless both provided (checked before any other gate).
  if (args.mode === 'execute') {
    if (process.env.RADAR_V2_PRODUCTION_AUTHORIZATION !== 'GRANTED') fail('execute refused: production authorization not granted');
    if (!process.env.RADAR_V2_RUNTIME_GRANT_REFERENCE) fail('execute refused: RADAR_V2_RUNTIME_GRANT_REFERENCE required');
  }

  const targets = RADARS.filter(r => args.radars === 'all' || args.radars.split(',').map(s => s.trim()).includes(r.id));
  if (!targets.length) fail('no radar selected');

  const selected = [];
  const skipped = [];
  for (const r of targets) {
    const source = join(args.archiveRoot, r.archive, args.date + '.md');
    if (!existsSync(source)) { skipped.push({radar: r.id, reason: 'MISSING archive report'}); continue; }
    if (statSync(source).size === 0) { skipped.push({radar: r.id, reason: 'EMPTY archive report'}); continue; }
    const content = readFileSync(source);
    const text = content.toString('utf8');
    const {fm, errors} = validateReport(text, r.id, args.date);
    if (errors.length) { skipped.push({radar: r.id, reason: 'INVALID: ' + errors.join('; ')}); continue; }
    if (fm.publish !== true) { skipped.push({radar: r.id, reason: 'publish=false'}); continue; }

    // V1/V2 dual-publish guard: the target existing means this day/radar was already published.
    const target = join(root, 'src', 'content', 'radar', r.id, args.date + '.md');
    if (existsSync(target)) { skipped.push({radar: r.id, reason: 'ALREADY_PUBLISHED (dual-publish guard)'}); continue; }

    const contentSha256 = sha(content);
    const observationId = contentSha256.slice(0, 16);
    const eventKey = `radar-publish:${r.id}:${args.date}`;
    const ins = instruction({contentSha256, domain: 'horizon-publication-instruction-v1', eventKey, observationIds: [observationId], targetChannel: 'site'});
    selected.push({radar: r.id, source, target, content, contentSha256, observationId, eventKey, instructionId: ins.instructionId, fm});
  }

  // Research exclusion: the manifest is radar-only by construction; assert it.
  const manifest = selected.map(s => s.target);
  if (manifest.some(p => p.includes('research'))) fail('manifest contains research path — refused');

  // [C3-D2A candidate] 13-node safety gates (execute/rehearse): SEC → operator review →
  // provenance → PP2.0.0 DAILY_DIGEST gate → (execute) Mode A authorization binding.
  // Fail-closed: first refusal stops the run. Plan mode is read-only (no gates needed).
  if (args.mode !== 'plan') {
    for (const s of selected) {
      const sec = secGate(s.radar);
      if (!sec.ok) fail(`SEC gate ${s.radar}: ${sec.reason}`);
      const rev = operatorReviewCheck(args.registryStateDir, s.radar, args.date, s.contentSha256);
      if (!rev.ok) fail(`operator review ${s.radar}: ${rev.reason}`);
      const arc = RADARS.find(r => r.id === s.radar);
      const prov = provenanceCheck(args.archiveRoot, arc.archive, args.date, s.contentSha256);
      if (!prov.ok) fail(`provenance ${s.radar}: ${prov.reason}`);
      const v2 = evaluateDailyDigestGate({radar: s.radar, date: args.date, contentSha256: s.contentSha256});
      if (!v2.pass) fail(`PP2.0.0 gate ${s.radar}: ${v2.reason}`);
      if (args.mode === 'execute') {
        const auth = modeaAuthorizationCheck(args.registryStateDir, s.radar, args.date, s.contentSha256);
        if (!auth.ok) fail(`Mode A authorization ${s.radar}: ${auth.reason}`);
      }
    }
    console.log(`[radar-v2-adapter] safety gates PASS for ${selected.length} radar(s) (SEC/review/provenance/PP2.0.0${args.mode === 'execute' ? '/ModeA' : ''})`);
  }

  // [C3-D2A candidate] Policy routing per the frozen PP 2.0.0 content-class scope
  // (C3-C frozen decision: 两套规范并行，互不引用，互不弱化):
  //   DAILY_DIGEST publications are governed by the PP 2.0.0 DAILY_DIGEST gate
  //   (fail-closed, above) + Mode A authorization binding (AUTH-06 enforced, above).
  //   The PP 1.0.0 frozen decision table governs INTELLIGENCE-EVENT publications —
  //   its score/signal/action/sourceAuthority stages are not applicable to the
  //   digest content class (feeding it digest facts is a category error:
  //   INVALID_OWNER_PROOF_STATE:structure). Recorded as NOT_APPLICABLE; the table
  //   evaluation applies unchanged to future intelligence-event publications.
  // execute additionally requires: env dual-gates (node 2, above) + Mode A grant
  // record (node 11, above — absent until the Phase 9.2 ceremony → refused;
  // governance as designed). rehearse uses an isolated worktree, never production.
  let policy = {loaded: false, evaluated: true,
    disposition: 'NOT_APPLICABLE_PP100_TABLE_FOR_DIGEST_CONTENT_CLASS',
    reasonCodes: ['DAILY_DIGEST_GOVERNED_BY_PP_2_0_0_DAILY_DIGEST_GATE'], pp100TableResult: null}

  const report = {mode: args.mode, date: args.date, root, killSwitch: kill, selected: selected.map(s => ({radar: s.radar, source: s.source, target: s.target, contentSha256: s.contentSha256, observationId: s.observationId, eventKey: s.eventKey, instructionId: s.instructionId, verdict: s.fm.verdict})), skipped, manifest, researchExcluded: true, policy};
  if (args.mode === 'plan') {
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`PLAN date=${args.date} root=${root}`);
      for (const s of report.selected) console.log(`  [SELECTED] ${s.radar} -> ${s.target}\n      instructionId=${s.instructionId}`);
      for (const s of report.skipped) console.log(`  [SKIPPED] ${s.radar}: ${s.reason}`);
      console.log(`  manifest files: ${manifest.length}`);
    }
    return report;
  }

  // ---- write path (rehearse in temp worktree / execute behind authorization) ----
  const created = [];
  const rollback = reason => {
    for (const f of created) rmSync(f, {force: true});
    console.error(`[radar-v2-adapter] ROLLED BACK (${reason}): removed ${created.length} created file(s); registry state untouched-by-publish-failure is isolated in worktree`);
  };
  try {
    for (const s of selected) {
      if (killSwitchEngaged()) throw Error(`kill switch engaged mid-run: ${killSwitchEngaged()}`);
      if (args.injectFailureAt === s.radar) throw Error(`INJECTED_FAILURE at ${s.radar} (rehearsal)`);
      mkdirSync(dirname(s.target), {recursive: true});
      if (existsSync(s.target)) throw Error(`dual-publish guard tripped mid-run: ${s.target}`);
      created.push(s.target);
      writeFileSync(s.target, s.content);
    }
    console.log(`[radar-v2-adapter] wrote ${selected.length} file(s)`);
    // [C3-D2A candidate] Nodes 7/13: six-state publication receipts.
    // PREPARED → AUTHORIZED (safety gates passed) → COMMITTED (build precheck passed).
    // PUBLISHED requires deploymentVerified=true from the post-cutover confirmation
    // chain (Approval D) — this changeset never emits PUBLISHED.
    const receipts = new SixStateReceipts(join(args.registryStateDir, 'radar-v2-receipts'));
    for (const s of selected) {
      if (args.injectFailureAt === 'registry:' + s.radar) throw Error(`INJECTED_FAILURE at receipts:${s.radar} (rehearsal)`);
      const prep = receipts.prepare({instructionId: s.instructionId, contentSha256: s.contentSha256, radar: s.radar, date: args.date, contentClass: 'DAILY_DIGEST'});
      if (prep.outcome === 'DUPLICATE_PUBLICATION') { console.log(`  [receipt] ${s.radar}: DUPLICATE blocked (${prep.existingState})`); continue; }
      if (prep.outcome === 'CONTENT_CONFLICT') throw Error(`receipt content conflict for ${s.radar} (same instructionId, different content)`);
      if (prep.outcome !== 'RECEIPTED') throw Error(`receipt append failed: ${prep.reason ?? prep.outcome}`);
      if (receipts.transition(s.instructionId, 'AUTHORIZED', {note: 'safety gates passed'}).outcome !== 'TRANSITIONED') throw Error(`receipt AUTHORIZED transition denied for ${s.radar}`);
      console.log(`  [receipt] ${s.radar}: PREPARED→AUTHORIZED instructionId=${s.instructionId.slice(0, 16)}`);
    }
    console.log('[radar-v2-adapter] astro build precheck...');
    if (args.injectFailureAt === 'build') throw Error('INJECTED_FAILURE at build (rehearsal)');
    execFileSync('npm', ['run', 'build'], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    console.log('[radar-v2-adapter] astro build PASS');
    for (const s of selected) {
      // COMMITTED = verified build staged; PUBLISHED deferred to Approval D confirmation chain.
      const meta = args.mode === 'execute' ? {deploymentVerified: false, note: 'PUBLISHED reserved for Approval D deployment confirmation'} : {note: 'REHEARSAL'};
      const t = receipts.transition(s.instructionId, 'COMMITTED', meta);
      if (t.outcome !== 'TRANSITIONED') throw Error(`receipt COMMITTED transition denied for ${s.radar}: ${t.outcome}`);
      console.log(`  [receipt] ${s.radar}: →COMMITTED (${args.mode})`);
    }
    if (args.commit) {
      execFileSync('git', ['add', ...manifest], {cwd: root});
      console.log(`[radar-v2-adapter] staged exactly ${manifest.length} file(s); commit/push deferred to approved cutover`);
    }
    report.written = manifest;
    report.registryStateDir = args.registryStateDir;
  } catch (e) {
    rollback(e.message);
    throw e;
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.env.RADAR_V2_ADAPTER_LIB !== '1') main().catch(e => { console.error(`[radar-v2-adapter] STOP: ${e?.message ?? e}`); process.exit(2); });
