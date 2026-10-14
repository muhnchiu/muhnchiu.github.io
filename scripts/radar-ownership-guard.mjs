// Radar publication ownership guard — SINGLE SOURCE OF TRUTH reader for V1/V2_PERSONAL.
// Ownership file: ~/.local/state/horizon/radar-publish-ownership.json
// Fail-closed: absent file, unreadable, or corrupt JSON => ALL V1 (never an uncertain V2 state).
// Both the V1 publisher hook and the V2 personal CLI import THIS module so they can never diverge.
import {readFileSync, existsSync} from 'node:fs';

export const OWNERSHIP_FILE = () => process.env.RADAR_OWNERSHIP_FILE ?? process.env.HOME + '/.local/state/horizon/radar-publish-ownership.json';
export const RADARS = ['ai','dev','app','skill','security'];
export const V1 = 'V1';
export const V2 = 'V2_PERSONAL';

// Returns {ai:V1,...} — always all five, default V1 on any failure.
export function loadOwnership() {
  const def = Object.fromEntries(RADARS.map(r => [r, V1]));
  const p = OWNERSHIP_FILE();
  if (!existsSync(p)) return def;
  let d;
  try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { return def; }
  const out = {};
  for (const r of RADARS) out[r] = d?.owners?.[r] === V2 ? V2 : V1;
  return out;
}
export function isV2Owned(radarId) {
  if (!RADARS.includes(radarId)) return false;
  return loadOwnership()[radarId] === V2;
}
// V1 publisher calls this BEFORE writing each radar's daily md:
//   const guard = await import('./radar-ownership-guard.mjs');
//   if (guard.isV2Owned(radarId)) { skip publishing this radar today; log reason OWNED_BY_V2_PERSONAL; continue; }
export function v1ShouldSkip(radarId) { return isV2Owned(radarId); }
// V2 personal publisher calls this: refuse unless V2-owned.
export function v2MayPublish(radarId) { return isV2Owned(radarId); }
