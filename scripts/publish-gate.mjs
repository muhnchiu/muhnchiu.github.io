#!/usr/bin/env node
/**
 * publish-gate.mjs — CI 增量发布门禁
 *
 * 职责边界（重要）：
 *   本脚本只执行【确定性、机器可可靠完成】的检查：
 *     - 变更范围确定（git push 事件 before→sha 完整 diff）
 *     - 仅对本次新增/变更且 publish:true 的研究文章要求 Gate 记录
 *     - 记录存在性 + content_sha256 匹配 + G1–G5 无 FAIL/N-A无证据
 *     - 结构规则：frontmatter 可解析、必填字段、章节编号连续、无空必选项
 *   本脚本【不】执行 G1/G3/G4 的语义事实核查，也不做数字语义一致性判断
 *   （那些由 Research/Verification/Agent 层负责）。CI 只能证明"记录与内容一致"，
 *   不能证明"语义检查真的执行过"。见 publish-gate/NOTES.md 的边界说明。
 *
 * 退出码：0 = 全部通过（或全部为历史豁免的未变更文章）
 *         1 = 任一受检文章 FAIL（记录缺失/哈希不匹配/G项FAIL/结构违规）
 *         2 = 基准不可用等环境错误（不得静默放行）
 *
 * 输入（环境变量）：
 *   GATE_BASELINE  显式 git 基准（workflow_dispatch 或基准不可用时必填）
 *   GATE_HEAD      待检查的 head commit（默认 git rev-parse HEAD）
 *   GATE_MODE      "incremental"（默认，按 before→head 增量）
 *   GATE_ALL       "true" 时检查全部 publish:true 文章（仅人工明确要求时）
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const REPO = process.env.GATE_REPO || process.cwd();
const researchDir = path.join(REPO, 'src/content/research');
const gateDir = path.join(REPO, 'publish-gate');

function sh(cmd) {
  return execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GATE_REPO: REPO } }).trim();
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function parseFrontmatter(file) {
  const t = readFileSync(file, 'utf8');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { ok: false, error: 'no frontmatter block' };
  const fm = {};
  // 最小 YAML 解析：只取我们关心的标量/列表字段，避免引入 js-yaml 依赖到 CI gate
  // 字段缺失/类型由后续检查捕获
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [rawKey, rawVal] = [kv[1], kv[2]];
    const val = rawVal.replace(/^"|"$/g, '').replace(/^'('|')/g, '');
    fm[rawKey] = rawVal.trim() === '' ? null : (rawVal.startsWith('[') ? rawVal : val);
  }
  return { ok: true, fm, body: t };
}

/** 检查章节编号连续性：找出所有 "## N." 编号，验证是否连续无跳号 */
function checkSectionContinuity(body) {
  const nums = [...body.matchAll(/^##\s+(\d+)\./gm)].map(m => Number(m[1]));
  if (nums.length < 2) return { ok: true, detail: 'less than 2 numbered sections' };
  const gaps = [];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) gaps.push(`${nums[i - 1]}→${nums[i]}`);
  }
  return { ok: gaps.length === 0, detail: gaps.length ? `gaps: ${gaps.join(', ')}` : `contiguous ${nums[0]}..${nums[nums.length - 1]}` };
}

/** 空必选项检查：tags/events 为空数组且字段存在 → 违规（Astro schema 拒绝空值） */
function checkEmptyOptional(body) {
  const problems = [];
  // 匹配 "field:\n" 后紧跟空白或 "[]" 的空列表
  for (const f of ['tags', 'events']) {
    const m = body.match(new RegExp(`^${f}:\\s*\\n((?:\\s+.*\\n)*)`, 'm'));
    if (m) {
      const items = m[1].split('\n').filter(l => l.trim().startsWith('- '));
      if (items.length === 0) problems.push(`${f}: empty list`);
    }
  }
  const topicCandEmpty = body.match(/topicCandidate:\s*\n\s*slug:\s*["']?["']?\s*\n\s*reason:\s*["']?["']?\s*\n/);
  if (topicCandEmpty) problems.push('topicCandidate: empty block');
  return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'clean' };
}

function loadGateRecord(slug) {
  const p = path.join(gateDir, `${slug}.json`);
  if (!existsSync(p)) return { exists: false };
  let rec;
  try { rec = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { return { exists: true, malformed: true, error: e.message }; }
  return { exists: true, rec };
}

/** 校验一条 Gate 记录：格式、状态、哈希、G项 */
function validateRecord(slug, fileSha) {
  const { exists, malformed, error, rec } = loadGateRecord(slug);
  if (!exists) return { pass: false, reason: 'record-missing' };
  if (malformed) return { pass: false, reason: 'record-malformed', detail: error };
  const problems = [];
  if (rec.article !== slug) problems.push(`article field "${rec.article}" != slug "${slug}"`);
  if (rec.content_sha256 !== fileSha) problems.push('sha-mismatch (article changed after record)');
  if (rec.status !== 'PASSED') problems.push(`status=${rec.status} (must be PASSED)`);
  if (!rec.checked_at) problems.push('missing checked_at');
  const checks = rec.checks || {};
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5']) {
    const v = checks[g];
    if (v === undefined) { problems.push(`checks.${g} missing`); }
    else if (v === 'FAIL') { problems.push(`${g}=FAIL`); }
    else if (v === 'N/A') {
      const ev = rec.evidence?.[g];
      if (!ev) problems.push(`${g}=N/A without evidence (must justify why not applicable)`);
    }
  }
  return problems.length ? { pass: false, reason: problems[0], problems } : { pass: true };
}

/** 确定本次变更的 research 文件列表 */
function changedResearchFiles() {
  const mode = process.env.GATE_MODE || 'incremental';
  if (mode === 'all') {
    return sh(`git ls-files src/content/research/*.md`).split('\n').filter(Boolean);
  }
  const head = process.env.GATE_HEAD || sh('git rev-parse HEAD');
  let baseline = process.env.GATE_BASELINE;
  if (!baseline) {
    // push 事件：before → sha
    const evBefore = process.env.GITHUB_EVENT_BEFORE;
    const evSha = process.env.GITHUB_SHA;
    if (evBefore && evSha && evBefore !== '0000000000000000000000000000000000000000') {
      baseline = evBefore;
    }
  }
  if (!baseline) {
    // 基准不可用：不静默放行，报错退出 2
    console.error('[publish-gate] BLOCK: cannot determine baseline (first commit / force push / shallow clone).');
    console.error('[publish-gate] Set GATE_BASELINE explicitly, or provide GITHUB_EVENT_BEFORE. Refusing to skip the gate.');
    process.exit(2);
  }
  // 验证 baseline 可解析
  try { sh(`git rev-parse --verify ${baseline}`); }
  catch {
    console.error(`[publish-gate] BLOCK: baseline ${baseline} not reachable (shallow clone?). Refusing to skip.`);
    process.exit(2);
  }
  // 完整 diff 范围：新增/修改/重命名/删除
  const out = sh(`git diff --name-status ${baseline}..${head} -- src/content/research/`);
  // 也加入 baseline 侧已存在但本次未触碰的不动；只处理 A/M/R 的行
  const files = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parts[0];
    if (status === 'D') continue; // 删除的文件不发布，不检查
    const target = parts.length >= 3 ? parts[parts.length - 1] : parts[1]; // 重命名取新名
    if (target && target.endsWith('.md') && target.startsWith('src/content/research/')) files.push(target);
  }
  return files;
}

function main() {
  if (!existsSync(researchDir)) {
    console.error(`[publish-gate] BLOCK: ${researchDir} not found.`);
    process.exit(2);
  }
  const changed = changedResearchFiles();
  console.log(`[publish-gate] mode=${process.env.GATE_MODE || 'incremental'} changed research files: ${changed.length}`);
  const results = [];
  let blocked = false;
  for (const rel of changed) {
    const abs = path.join(REPO, rel);
    const slug = path.basename(rel, '.md');
    const { ok, fm, body } = parseFrontmatter(abs);
    const r = { file: rel, slug };
    if (!ok) { r.pass = false; r.reason = 'frontmatter-parse-failed'; blocked = true; results.push(r); continue; }
    // 只门禁 publish:true 的文章（publish:false 是草稿，不进 Pages）
    if (fm.publish !== 'true') { r.pass = true; r.exempt = true; r.reason = 'publish-false (not deployed)'; results.push(r); continue; }
    const fileSha = sha256(abs);
    // 结构检查（确定性）
    const struct = [
      ['section-continuity', checkSectionContinuity(body)],
      ['empty-optional', checkEmptyOptional(body)],
      ['required-fields', { ok: ['title', 'subtitle', 'slug', 'type', 'created', 'updated', 'status', 'confidence', 'publish'].every(k => fm[k] !== undefined && fm[k] !== null), detail: 'required fields present' }],
    ];
    r.struct = struct.map(([n, c]) => ({ name: n, ...c }));
    if (struct.some(s => !s[1].ok)) { r.pass = false; r.reason = 'structure-violation'; blocked = true; results.push(r); continue; }
    // Gate 记录校验
    const rec = validateRecord(slug, fileSha);
    r.record = rec;
    if (!rec.pass) { r.pass = false; r.reason = rec.reason; blocked = true; results.push(r); continue; }
    r.pass = true;
    results.push(r);
  }
  // 输出
  for (const r of results) {
    const tag = r.exempt ? 'EXEMPT' : (r.pass ? 'PASS' : 'BLOCK');
    const extra = r.reason && r.reason !== 'publish-false (not deployed)' ? ` (${r.reason}${r.problems ? ': ' + r.problems.join(', ') : ''})` : '';
    console.log(`  ${tag} ${r.slug}${extra}`);
  }
  if (blocked) {
    console.error(`\n[publish-gate] BLOCKED: ${results.filter(r => !r.pass).length} file(s) failed. Refusing to build/deploy.`);
    console.error('[publish-gate] Fix the failing claims / regenerate the gate record (matching current content hash), then re-run.');
    process.exit(1);
  }
  console.log(`\n[publish-gate] PASSED: ${results.length} file(s) checked (${results.filter(r => r.exempt).length} exempt), build may proceed.`);
  process.exit(0);
}

main();
