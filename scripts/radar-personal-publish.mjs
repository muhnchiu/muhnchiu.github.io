#!/usr/bin/env node
// Horizon Radar V2 — Personal Mode publisher (simplified single-user path).
// Commands: plan | check | publish | status
//   --radar=dev|ai|app|skill|security   --date=YYYY-MM-DD
//   [--commit] publish with git commit (no push by default; --push to push)
//
// Design (PERSONAL MODE):
//  - No production Ed25519 signers, no owner-approval envelopes, no multi-role authorization.
//  - Reuses: archive report validation (frontmatter/schema/count-consistency), PP2 DAILY_DIGEST gate,
//    exact-path containment, V1/V2 dual-publish guard, research exclusion, scoped git staging.
//  - Single source of truth for radar-level publication ownership: radar-publish-ownership.json
//    (V1 owns by default; a radar switched to V2_PERSONAL is SKIPPED by V1 publisher and accepted by V2).
//  - Publication record: ~/.local/state/horizon/radar-personal-publications.jsonl (dedup + retry safety).
//  - Success is verified by file + git + (optional) remote status, never by JSONL alone.
import {readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync, copyFileSync, openSync, closeSync, fsyncSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join, resolve, basename, dirname} from 'node:path';
import {createHash} from 'node:crypto';
const SITE_ROOT = process.env.RADAR_SITE_ROOT ?? process.env.HOME + '/workspace/explore/github-page/muhnchiu.github.io';
const SITE = () => SITE_ROOT;
// Top-level await: load the pure policy modules (digest gate + sha) from the site root.
const {evaluateDailyDigestGate} = await import('file://' + SITE_ROOT + '/src/lib/radar-publisher/policy-v2-daily-digest.mjs');
const {sha} = await import('file://' + SITE_ROOT + '/src/lib/radar-publisher/canonical.mjs');

export const RADARS = [
  {archive: 'ai', id: 'ai'},
  {archive: 'app', id: 'app'},
  {archive: 'dev', id: 'dev'},
  {archive: 'sec', id: 'security'},
  {archive: 'skill', id: 'skill'},
];
export const REQUIRED_FIELDS = ['title','date','radar','signalCount','highSignalCount','actionableCount','actionRequired','verdict','highlights','topics','confidence','publish'];
export const TOPIC_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESEARCH_EXCLUDED = true; // personal mode only touches src/content/radar/<radar>/

const STATE = () => process.env.HOME + '/.local/state/horizon';
const OWNERSHIP_FILE = () => process.env.RADAR_OWNERSHIP_FILE ?? STATE() + '/radar-publish-ownership.json';
const RECORD_FILE = () => process.env.RADAR_PERSONAL_RECORDS_FILE ?? STATE() + '/radar-personal-publications.jsonl';
export const OWNERSHIP = {V1: 'V1', V2: 'V2_PERSONAL'};

// ---- ownership (single source of truth; default: all V1) ----
// Single-source ownership: the shared guard module is the ONLY reader of the ownership file,
// so V1 and V2 can never diverge. (OWNERSHIP_FILE const below kept for record-path clarity.)
import {loadOwnership as _guardLoad, isV2Owned} from './radar-ownership-guard.mjs';
export function loadOwnership() {
  const g = _guardLoad();
  // map guard's flat {ai,dev,...} into this module's RADARS-keyed shape
  const out = {};
  for (const r of RADARS) out[r.id] = g[r.id];
  return out;
}
export function ownershipAllowsV2(radarId) {
  return isV2Owned(radarId);
}

// ---- frontmatter (reuse the same simple parser as the adapter) ----
// Minimal YAML frontmatter parser that mirrors the site's published radar files.
// - scalar:   key: value        (strip surrounding quotes; true/false/integers coerced)
// - list of scalars:
//     key:
//       - "a"
//       - "b"
// - list of objects (highlights):
//     key:
//       - title: "x"
//         type: "y"
//         ...
// each "- k: v" starts a new object item; subsequent indented "k: v" lines fill it.
function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const block = text.slice(4, end);
  const unq = (x) => String(x).replace(/^["']/, '').replace(/["']\s*$/, '');
  const fm = {};
  let curKey = null;          // the key whose list items we are collecting
  let curItem = null;         // current object item within a list-of-objects
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const scalar = line.match(/^([A-Za-z]+):\s*(.*)$/);
    const bullet = line.match(/^\s+-\s+(.*)$/);
    const subkey = line.match(/^\s+([A-Za-z]+):\s*(.*)$/);
    if (bullet) {
      const v = bullet[1].trim();
      const kv = v.match(/^([A-Za-z]+):\s*(.*)$/);
      if (kv && curKey) {
        // start of a new object item in list-of-objects
        curItem = {};
        curItem[unq(kv[1])] = unq(kv[2]);
        fm[curKey].push(curItem);
      } else if (curKey) {
        // scalar list item
        const arr = Array.isArray(fm[curKey]) ? fm[curKey] : (fm[curKey] = []);
        arr.push(unq(v));
        curItem = null;
      }
      continue;
    }
    if (subkey && curItem && !bullet) {
      // continuation key of the current object item
      curItem[unq(subkey[1])] = unq(subkey[2]);
      continue;
    }
    if (scalar) {
      curKey = scalar[1];
      const raw = scalar[2].trim();
      if (raw === '') { fm[curKey] = []; curItem = null; }
      else {
        const val = unq(raw);
        fm[curKey] = (val === 'true') ? true : (val === 'false') ? false : (/^-?\d+$/.test(val) ? Number(val) : val);
        curItem = null;
      }
    }
  }
  return fm;
}

export function validateReport(text, radarId, date) {
  const errors = [];
  const fm = parseFrontmatter(text);
  if (!fm) return {fm: null, errors: ['missing YAML frontmatter']};
  for (const f of REQUIRED_FIELDS) if (!(f in fm)) errors.push(`missing field ${f}`);
  if (fm.date !== date) errors.push(`frontmatter date ${fm.date} != ${date}`);
  if (fm.radar !== radarId) errors.push(`frontmatter radar ${fm.radar} != ${radarId}`);
  if (typeof fm.publish !== 'boolean') errors.push('publish must be boolean');
  if (!Array.isArray(fm.highlights) || fm.highlights.length > 5) errors.push(`highlights ${fm.highlights?.length} > 5`);
  // topic slug validation against registry pattern
  for (const t of (fm.topics ?? [])) if (!TOPIC_SLUG_RE.test(String(t).replace(/^"|"$/g, ''))) errors.push(`invalid topic slug ${t}`);
  const hs = Number(fm.highSignalCount), ac = Number(fm.actionableCount), ar = Number(fm.actionRequired), sc = Number(fm.signalCount);
  if (![hs, ac, ar, sc].every(Number.isInteger)) errors.push('count fields must be integers');
  else {
    if (hs > sc || ac > sc || ar > sc || ar > ac) errors.push('count consistency violated');
    if (fm.highlights.length > sc) errors.push('highlights > signalCount');
  }
  return {fm, errors};
}

// ---- path containment: target must live under site/src/content/radar/<radarId>/ ----
export function targetPath(siteRoot, radarId, date) {
  // research and any non-radar identifier are hard-refused (V2 personal only touches the five radars)
  if (String(radarId).toLowerCase() === 'research') throw new Error('TARGET_PATH_ESCAPE: research is excluded from V2 personal mode');
  if (!RADARS.some(r => r.id === radarId || r.archive === radarId)) throw new Error('TARGET_PATH_ESCAPE: unknown radar ' + radarId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) throw new Error('TARGET_PATH_ESCAPE: bad date ' + date);
  const target = join(siteRoot, 'src', 'content', 'radar', radarId, date + '.md');
  const allowed = join(siteRoot, 'src', 'content', 'radar', radarId);
  const rel = relativeSafe(allowed, target);
  if (rel === null || rel.startsWith('..') || target.includes('research') || target.includes('..')) throw new Error('TARGET_PATH_ESCAPE');
  return target;
}
function relativeSafe(base, target) {
  const b = resolve(base), t = resolve(target);
  if (t !== b && !t.startsWith(b + '/')) return null;
  return t === b ? '' : t.slice(b.length + 1);
}

// ---- publication records (JSONL, minimal concurrency safety via atomic temp+rename) ----
export function readRecords() {
  const p = RECORD_FILE();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function appendRecord(rec) {
  const p = RECORD_FILE();
  mkdirSync(dirname(p), {recursive: true});
  const tmp = p + '.tmp-' + process.pid;
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const line = JSON.stringify(rec) + '\n';
  writeFileSync(tmp, cur + line);
  const fd = openSync(tmp, 'r'); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, p); // atomic replace (no torn writes); single-writer personal context
}
// dedup: same radar+date. PUBLISHED + same contentHash => SKIPPED_DUPLICATE; PUBLISHED + different hash => REJECT_OVERWRITE
export function priorRecord(radar, date, contentHash) {
  const rows = readRecords().filter(r => r.radar === radar && r.date === date && r.status === OWN_STATUS.PUBLISHED);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return {record: last, sameContent: last.contentHash === contentHash};
}
export const OWN_STATUS = {PREPARED: 'PREPARED', PUBLISHED: 'PUBLISHED', FAILED: 'FAILED', SKIPPED_DUPLICATE: 'SKIPPED_DUPLICATE'};

// ---- main pipeline ----
export function plan({radar, date, siteRoot = SITE(), archiveRoot}) {
  const arch = archiveRoot ?? process.env.HOME + '/workspace/mac-env-sync/docs/radar-reports';
  const r = RADARS.find(x => x.id === radar) ?? RADARS.find(x => x.archive === radar);
  if (!r) throw new Error('UNKNOWN_RADAR');
  const source = join(arch, r.archive, date + '.md');
  const out = {radar: r.id, date, source, sourceExists: existsSync(source)};
  if (!out.sourceExists) return out;
  const text = readFileSync(source, 'utf8');
  const {fm, errors} = validateReport(text, r.id, date);
  out.contentSha256 = sha(Buffer.from(text));
  out.gate = evaluateDailyDigestGate({radar: r.id, date, contentSha256: out.contentSha256});
  out.errors = errors;
  out.publishFlag = fm?.publish;
  out.target = targetPath(siteRoot, r.id, date);
  out.targetExists = existsSync(out.target);
  out.ownership = loadOwnership()[r.id];
  out.v2Allowed = out.ownership === OWNERSHIP.V2;
  out.duplicate = priorRecord(r.id, date, out.contentSha256);
  out.planOk = !errors.length && out.gate.pass && out.publishFlag === true && out.v2Allowed
    && !(out.duplicate && out.duplicate.record) ;
  return out;
}

function git(siteRoot, ...args) { return execFileSync('git', ['-C', siteRoot, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim(); }

export function publish({radar, date, siteRoot = SITE(), archiveRoot, commit = true, push = false}) {
  const p = plan({radar, date, siteRoot, archiveRoot});
  if (!p.sourceExists) {
    const rec = {radar, date, contentHash: null, sourceArchive: p.source, sourceHash: null, targetPath: p.target ?? null, status: OWN_STATUS.FAILED, timestamp: new Date().toISOString(), error: 'MISSING_SOURCE: archive report not found'};
    appendRecord(rec); return {...rec, ok: false};
  }
  const base = {radar, date, contentHash: p.contentSha256, sourceArchive: p.source, sourceHash: p.contentSha256, targetPath: p.target, timestamp: new Date().toISOString()};
  // gate re-checks
  if (p.errors.length) { const rec = {...base, status: OWN_STATUS.FAILED, error: 'VALIDATION: ' + p.errors.join('; ')}; appendRecord(rec); return {...rec, ok: false}; }
  if (!p.gate.pass) { const rec = {...base, status: OWN_STATUS.FAILED, error: 'GATE: ' + p.gate.reason}; appendRecord(rec); return {...rec, ok: false}; }
  if (p.publishFlag !== true) { const rec = {...base, status: OWN_STATUS.SKIPPED_DUPLICATE, error: 'publish=false'}; appendRecord(rec); return {...rec, ok: false, skipped: true}; }
  if (!p.v2Allowed) { const rec = {...base, status: OWN_STATUS.FAILED, error: 'OWNERSHIP: radar owned by V1 — V2 refused'}; appendRecord(rec); return {...rec, ok: false}; }
  if (p.duplicate?.sameContent) { const rec = {...base, status: OWN_STATUS.SKIPPED_DUPLICATE, note: 'already published, identical content'}; appendRecord(rec); return {...rec, ok: false, skipped: true}; }
  if (p.duplicate && !p.duplicate.sameContent) { const rec = {...base, status: OWN_STATUS.FAILED, error: 'CONTENT_CHANGED: previously published with different hash — manual handling required'}; appendRecord(rec); return {...rec, ok: false}; }
  // write with temp + atomic replace; record pre-state for rollback
  const text = readFileSync(p.source, 'utf8');
  const target = p.target;
  mkdirSync(dirname(target), {recursive: true});
  const preState = {targetExisted: existsSync(target), targetHash: existsSync(target) ? sha(readFileSync(target)) : null};
  const tmp = target + '.tmp-' + process.pid;
  writeFileSync(tmp, text);
  renameSync(tmp, target);
  // git scope: only this file
  let commitSha = null, remoteStatus = commit ? 'COMMITTED_LOCAL' : 'NO_COMMIT';
  if (commit) {
    git(siteRoot, 'add', '--', target);
    try {
      git(siteRoot, 'commit', '--only', '--', target, '-m', `content: publish ${radar} ${date} (V2 personal)`);
      commitSha = git(siteRoot, 'log', '-1', '--format=%H', '--', target) || null;
    } catch (e) { commitSha = null; remoteStatus = 'COMMIT_FAILED: ' + String(e.message || e).slice(0, 120); }
  }
  if (push) { try { git(siteRoot, 'push'); remoteStatus = 'PUSHED'; } catch (e) { remoteStatus = 'PUSH_FAILED: ' + String(e.message || e).slice(0, 120); } }
  // verify: file present + git state consistent. Remote Pages deploy result is NOT observable from here -> 'UNCONFIRMED'.
  const fileNow = existsSync(target) && sha(readFileSync(target)) === p.contentSha256;
  const gitCleanForTarget = git(siteRoot, 'status', '--porcelain', '--', target) === '';
  const rec = {...base, status: OWN_STATUS.PUBLISHED, commitSha, remoteStatus, verified: {fileNow, gitCleanForTarget}, pages: 'UNCONFIRMED (no remote deploy check in personal mode)'};
  appendRecord(rec);
  return {...rec, ok: true, preState};
}

export function status({radar, date}) {
  const rows = readRecords().filter(r => (!radar || r.radar === radar) && (!date || r.date === date));
  const recent = rows.slice(-10).reverse();
  const lastFailed = recent.find(r => r.status === OWN_STATUS.FAILED) ?? null;
  return {radar, date, recent, lastFailed};
}

// ---- CLI ----
function parseArgs(argv) {
  const a = {commit: false, push: false};
  for (const x of argv) {
    if (x.startsWith('--radar=')) a.radar = x.slice(8);
    else if (x.startsWith('--date=')) a.date = x.slice(7);
    else if (x === '--commit') a.commit = true;
    else if (x === '--push') a.push = true;
    else if (x.startsWith('--archive-root=')) a.archiveRoot = x.slice(15);
  }
  return a;
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('radar-personal-publish.mjs')) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  if (!a.radar || !a.date) { console.error('Usage: node radar-personal-publish.mjs <plan|check|publish|status> --radar=<r> --date=YYYY-MM-DD [--commit] [--push]'); process.exit(2); }
  const out = cmd === 'plan' ? plan(a)
    : cmd === 'check' ? (() => { const p = plan(a); return {...p, checkOk: p.planOk, error: p.errors.length ? p.errors.join('; ') : (p.gate.pass ? null : p.gate.reason)}; })()
    : cmd === 'publish' ? publish(a)
    : cmd === 'status' ? status(a)
    : {error: 'unknown command ' + cmd};
  console.log(JSON.stringify(out, null, 2));
  if (out.error || out.ok === false) process.exitCode = out.ok === true ? 0 : 1;
}
