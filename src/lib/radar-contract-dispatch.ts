import { normalizeRadarV1, normalizeRadarV2 } from '../../vendor/horizon-contracts/radar/v2/normalize.mjs';
import { normalizeRadarV21 } from '../../vendor/horizon-contracts/radar/v2/2.1.1/normalize.mjs';
import { normalizeRadarV21 as normalizeRadarV212 } from '../../vendor/horizon-contracts/radar/v2/2.1.2/normalize.mjs';

export type RadarContractPackage = 'v1' | '2.0.0' | '2.1.1' | '2.1.2';

/**
 * Normalize using the package/collection context selected by the caller.
 * schemaVersion 2 is intentionally insufficient to choose between 2.0 and 2.1.
 */
export function normalizeRadarForContract(report: unknown, contractPackage: RadarContractPackage) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new TypeError('Radar report must be an object');
  }

  const schemaVersion = (report as Record<string, unknown>).schemaVersion;
  switch (contractPackage) {
    case 'v1':
      if (schemaVersion !== undefined) throw new TypeError('V1 package context requires a versionless V1 report');
      return normalizeRadarV1(report);
    case '2.0.0':
      if (schemaVersion !== 2) throw new TypeError('Contract 2.0.0 package context requires schemaVersion: 2');
      return normalizeRadarV2(report);
    case '2.1.1':
      if (schemaVersion !== 2) throw new TypeError('Contract 2.1.1 package context requires schemaVersion: 2');
      return normalizeRadarV21(report);
    case '2.1.2':
      if (schemaVersion !== 2) throw new TypeError('Contract 2.1.2 package context requires schemaVersion: 2');
      return normalizeRadarV212(report);
    default: {
      const exhaustive: never = contractPackage;
      throw new TypeError(`Unsupported Radar contract package: ${exhaustive}`);
    }
  }
}
