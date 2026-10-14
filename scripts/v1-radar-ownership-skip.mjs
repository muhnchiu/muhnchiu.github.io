#!/usr/bin/env node
// V1 publisher ownership-skip hook. The V1 daily automation invokes this per-radar BEFORE writing.
//   node scripts/v1-radar-ownership-skip.mjs <radarId>
// exit 0 = V1 may publish; exit 3 = V1 must SKIP (radar owned by V2_PERSONAL); exit 1 = unknown radar.
import {RADARS, v1ShouldSkip} from './radar-ownership-guard.mjs';
const radarId = process.argv[2];
if (!RADARS.includes(radarId)) { console.error('unknown radar ' + radarId); process.exit(1); }
if (v1ShouldSkip(radarId)) { console.log(JSON.stringify({radar: radarId, skip: true, reason: 'OWNED_BY_V2_PERSONAL'})); process.exit(3); }
console.log(JSON.stringify({radar: radarId, skip: false}));
process.exit(0);
