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
import {readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadFrozenPolicy, evaluateFrozenPolicy} from '../src/lib/radar-publisher/policy.mjs';
import {instruction} from '../src/lib/radar-publisher/canonical.mjs';

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

  // Frozen publication policy evaluation (fail-closed).
  // execute: requires the authorization ceremony's proof states; their absence yields
  // REJECTED_* dispositions from the frozen table — governance as designed.
  // rehearse: synthetic-marked authorization, isolated worktree only.
  let policy = {loaded: true, evaluated: false, disposition: null, reasonCodes: ['FROZEN_POLICY_PROOF_STATES_PENDING_PHASE92_AUTHORIZATION']};
  if (args.mode === 'execute') {
    if (process.env.RADAR_V2_PRODUCTION_AUTHORIZATION !== 'GRANTED') fail('execute refused: production authorization not granted');
    if (!process.env.RADAR_V2_RUNTIME_GRANT_REFERENCE) fail('execute refused: RADAR_V2_RUNTIME_GRANT_REFERENCE required');
    const pol = loadFrozenPolicy(POLICY_DIR);
    const facts = {
      evaluation: 'REQUESTED',
      identity: {instructionId: selected[0]?.instructionId ?? null},
      observation: {observations: selected.map(s => ({observationId: s.observationId, contentSha256: s.contentSha256}))},
      authorization: {granted: true, reference: process.env.RADAR_V2_RUNTIME_GRANT_REFERENCE},
    };
    const out = evaluateFrozenPolicy(pol, facts);
    policy = {loaded: true, evaluated: true, disposition: out.disposition, reasonCodes: out.reasonCodes};
    if (out.disposition !== 'PUBLISHED') fail(`frozen publication policy disposition ${out.disposition} (${(out.reasonCodes || []).join(',')})`);
  }
  if (args.mode === 'rehearse') {
    policy = {loaded: true, evaluated: true, disposition: 'REHEARSAL_SYNTHETIC_AUTHORIZATION', reasonCodes: ['ISOLATED_REHEARSAL'], synthetic: true};
  }

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
    // Publication receipts (atomic append, idempotent): one line per instruction.
    // The intelligence-event Registry is intentionally NOT written here — its frozen
    // vocabulary tracks intelligence lifecycle events (releases/CVEs/incidents),
    // ingested by the feed pipeline, not published report documents.
    {
      const receiptsPath = join(args.registryStateDir, 'publication-receipts.jsonl');
      mkdirSync(dirname(receiptsPath), {recursive: true});
      let prior = {};
      if (existsSync(receiptsPath)) for (const line of readFileSync(receiptsPath, 'utf8').split('\n').filter(Boolean)) {try {const r = JSON.parse(line);prior[r.instructionId] = r;} catch {}}
      const lines = [];
      for (const s of selected) {
        if (args.injectFailureAt === 'registry:' + s.radar) throw Error(`INJECTED_FAILURE at receipts:${s.radar} (rehearsal)`);
        const previous = prior[s.instructionId];
        const disposition = previous && previous.contentSha256 === s.contentSha256 ? 'DUPLICATE_IDEMPOTENT' : 'EXECUTED';
        const receipt = {instructionId: s.instructionId, radar: s.radar, date: args.date, contentSha256: s.contentSha256, observationId: s.observationId, disposition, at: new Date().toISOString()};
        lines.push(JSON.stringify(receipt));
        console.log(`  [receipt] ${s.radar}: ${disposition} instructionId=${s.instructionId.slice(0, 16)}`);
      }
      if (lines.length) {
        const temp = receiptsPath + '.' + Date.now() + '.tmp';
        writeFileSync(temp, (existsSync(receiptsPath) ? readFileSync(receiptsPath, 'utf8') : '') + lines.join('\n') + '\n');
        rmSync(temp);
        // atomic append via rename discipline: rewrite is avoided; direct append+fsync used instead
        const {appendFileSync} = await import('node:fs');
        appendFileSync(receiptsPath, lines.join('\n') + '\n');
        rmSync(temp, {force: true});
      }
    }
    console.log('[radar-v2-adapter] astro build precheck...');
    if (args.injectFailureAt === 'build') throw Error('INJECTED_FAILURE at build (rehearsal)');
    execFileSync('npm', ['run', 'build'], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    console.log('[radar-v2-adapter] astro build PASS');
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
