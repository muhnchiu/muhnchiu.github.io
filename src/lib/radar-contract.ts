import { normalizeRadar } from '../../vendor/horizon-contracts/radar/v2/normalize.mjs';
import type { NormalizedRadar, RadarV1, RadarV2 } from '../../vendor/horizon-contracts/radar/v2/types';

/** Shared Phase 1 normalizer seam. UI consumers can migrate here in Phase 5. */
export function normalizeRadarContract(report: RadarV1 | RadarV2): NormalizedRadar {
  return normalizeRadar(report) as NormalizedRadar;
}
