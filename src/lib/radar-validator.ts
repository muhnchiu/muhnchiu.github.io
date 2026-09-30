import { isIP } from 'node:net';
import type { NormalizedRadar, RadarId, RadarV2 } from '../../vendor/horizon-contracts/radar/v2/types';
import { validateRadarV21Semantics } from '../../vendor/horizon-contracts/radar/v2/2.1.2/validator.mjs';

export type RadarValidationSeverity = 'error' | 'warning';

export interface RadarValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: RadarValidationSeverity;
}

export interface RadarValidationResult {
  valid: boolean;
  skipped: boolean;
  errors: RadarValidationIssue[];
  warnings: RadarValidationIssue[];
}

/** Publishing errors block build; unpublished reports are diagnosed but do not expand the gate. */
export function shouldBlockRadarBuild(result: RadarValidationResult, publish: boolean): boolean {
  return publish && result.errors.length > 0;
}

type RadarDocument = RadarV2 | NormalizedRadar | Record<string, unknown>;
type PlainObject = Record<string, unknown>;

const radarIds = new Set<RadarId>(['skill', 'security', 'app', 'ai', 'dev']);
const eventKeyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'host.docker.internal') return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (ipVersion === 6) {
    return host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd');
  }
  return false;
}

function safeHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !isPrivateOrLocalHost(url.hostname);
  } catch {
    return false;
  }
}

function normalizedTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function titleSlug(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : '';
}

/**
 * Validate V2 document semantics after structural validation. Versionless V1
 * and normalized V1 are deliberately skipped to preserve historical meanings.
 */
export function validateRadarSemantics(
  input: RadarDocument,
  canonicalTopics: ReadonlySet<string>,
): RadarValidationResult {
  const errors: RadarValidationIssue[] = [];
  const warnings: RadarValidationIssue[] = [];
  const issue = (severity: RadarValidationSeverity, code: string, path: string, message: string) => {
    (severity === 'error' ? errors : warnings).push({ code, path, message, severity });
  };

  if (!isObject(input)) {
    issue('error', 'RADAR_DOCUMENT_INVALID', '', 'Radar document must be an object.');
    return { valid: false, skipped: false, errors, warnings };
  }
  if (input.sourceSchemaVersion === 1 || (input.sourceSchemaVersion === undefined && input.schemaVersion === undefined)) {
    return { valid: true, skipped: true, errors, warnings };
  }
  if (input.sourceSchemaVersion !== 2 && input.schemaVersion !== 2) {
    issue('error', 'RADAR_SCHEMA_VERSION_UNSUPPORTED', '/schemaVersion', 'Semantic validation supports Radar V2 only.');
    return { valid: false, skipped: false, errors, warnings };
  }

  const highlights = Array.isArray(input.highlights) ? input.highlights : [];
  const contractVersion = (input as PlainObject).contractVersion;
  const contractV21 = contractVersion === '2.1.1' || contractVersion === '2.1.2';
  const reportDate = input.date;
  const reportRadar = input.radar;
  const count = (predicate: (highlight: PlainObject) => boolean) => highlights.filter((highlight) => isObject(highlight) && predicate(highlight)).length;

  if (input.signalCount !== highlights.length) {
    issue('error', 'RADAR_COUNT_MISMATCH', '/signalCount', `signalCount must equal highlights.length (${highlights.length}).`);
  }
  const highCount = count((highlight) => highlight.signal === 'high');
  if (input.highSignalCount !== highCount) {
    issue('error', 'HIGH_SIGNAL_COUNT_MISMATCH', '/highSignalCount', `highSignalCount must equal the number of high signals (${highCount}).`);
  }
  const actionableCount = count((highlight) => highlight.action === 'adopt' || highlight.action === 'test');
  if (input.actionableCount !== actionableCount) {
    issue('error', 'ACTIONABLE_COUNT_MISMATCH', '/actionableCount', `actionableCount must equal adopt + test highlights (${actionableCount}).`);
  }

  // The canonical V2 schema describes actionRequired as a temporary alias for count(adopt).
  if (input.actionRequired !== undefined) {
    const adoptCount = count((highlight) => highlight.action === 'adopt');
    if (input.actionRequired !== adoptCount) {
      issue('error', 'ACTION_REQUIRED_MISMATCH', '/actionRequired', `actionRequired must equal adopt highlights (${adoptCount}).`);
    }
  }

  if (!Array.isArray(input.topics)) {
    issue('error', 'TOPICS_INVALID', '/topics', 'topics must be an array.');
  } else {
    input.topics.forEach((topic, index) => {
      if (typeof topic === 'string' && !canonicalTopics.has(topic)) {
        issue('error', 'UNKNOWN_CANONICAL_TOPIC', `/topics/${index}`, `Unknown canonical topic: ${topic}.`);
      }
    });
  }

  const scoreVersion = input.scoreVersion;
  if (typeof scoreVersion !== 'string' || scoreVersion.trim() === '') {
    issue('error', 'SCORE_VERSION_MISSING', '/scoreVersion', 'V2 requires a non-empty scoreVersion.');
  }
  if (contractV21) {
    const eventResult = validateRadarV21Semantics(input);
    for (const error of eventResult.errors) issue('error', error.code, error.path, error.message);
  }

  highlights.forEach((rawHighlight, index) => {
    const path = `/highlights/${index}`;
    if (!isObject(rawHighlight)) {
      issue('error', 'HIGHLIGHT_INVALID', path, 'Highlight must be an object.');
      return;
    }
    const highlight = rawHighlight;

    if (typeof highlight.topic === 'string' && !canonicalTopics.has(highlight.topic)) {
      issue('error', 'UNKNOWN_CANONICAL_TOPIC', `${path}/topic`, `Unknown canonical topic: ${highlight.topic}.`);
    }
    if (!contractV21) {
      if (highlight.primaryRadar !== reportRadar) {
        issue('error', 'PRIMARY_RADAR_MISMATCH', `${path}/primaryRadar`, 'primaryRadar must match the containing Radar type.');
      }
      if (!radarIds.has(highlight.primaryRadar as RadarId)) {
        issue('error', 'PRIMARY_RADAR_INVALID', `${path}/primaryRadar`, 'primaryRadar is not a supported Radar type.');
      }
    }

    if (!contractV21 && Array.isArray(highlight.relatedRadars)) {
      const seen = new Set<unknown>();
      highlight.relatedRadars.forEach((related, relatedIndex) => {
        const relatedPath = `${path}/relatedRadars/${relatedIndex}`;
        if (!radarIds.has(related as RadarId)) {
          issue('error', 'RELATED_RADAR_INVALID', relatedPath, 'relatedRadar is not a supported Radar type.');
        }
        if (related === highlight.primaryRadar) {
          issue('error', 'RELATED_RADAR_SELF_REFERENCE', relatedPath, 'relatedRadars must not include primaryRadar.');
        }
        if (seen.has(related)) {
          issue('error', 'RELATED_RADAR_DUPLICATE', relatedPath, `Duplicate relatedRadar: ${String(related)}.`);
        }
        seen.add(related);
      });
    }

    if (highlight.score !== undefined) {
      if (!Number.isInteger(highlight.score) || (highlight.score as number) < 0 || (highlight.score as number) > 100) {
        issue('error', 'SCORE_OUT_OF_RANGE', `${path}/score`, 'score must be an integer from 0 to 100.');
      }
      issue('warning', 'SCORE_POLICY_UNDEFINED', `${path}/score`, 'The contract defines the score range but does not freeze score-to-signal thresholds.');
    }

    if (highlight.signal === 'high' && highlight.action === 'ignore') {
      issue('warning', 'HIGH_SIGNAL_IGNORED', `${path}/action`, 'A high signal marked ignore may need an explicit decision review.');
    }

    if (highlight.signal === 'high' || highlight.signal === 'medium') {
      if (typeof highlight.whyItMatters !== 'string' || highlight.whyItMatters.trim() === '') {
        issue('error', 'WHY_IT_MATTERS_EMPTY', `${path}/whyItMatters`, 'High and medium signals require non-empty whyItMatters.');
      } else if (normalizedTitle(highlight.whyItMatters) === normalizedTitle(highlight.title)) {
        issue('error', 'WHY_IT_MATTERS_DUPLICATE', `${path}/whyItMatters`, 'whyItMatters must not simply repeat the highlight title.');
      }
    }

    if (!contractV21) {
      if (typeof highlight.eventKey !== 'string' || !eventKeyPattern.test(highlight.eventKey)) {
        issue('error', 'EVENT_KEY_INVALID', `${path}/eventKey`, 'eventKey must be a non-empty lowercase hyphenated identifier.');
      } else if (titleSlug(highlight.title) && titleSlug(highlight.title) === highlight.eventKey) {
        issue('error', 'EVENT_KEY_TITLE_DERIVED', `${path}/eventKey`, 'eventKey must identify the event, not be copied from its display title.');
      }

      const firstSeen = highlight.firstSeen;
      const lastSeen = highlight.lastSeen;
      if (!isCalendarDate(firstSeen) || !isCalendarDate(lastSeen) || !isCalendarDate(reportDate)) {
        issue('error', 'EVENT_DATE_INVALID', `${path}/firstSeen`, 'firstSeen, lastSeen, and report date must be valid calendar dates.');
      } else {
        if (firstSeen > lastSeen) {
          issue('error', 'EVENT_DATE_INVALID', `${path}/lastSeen`, 'firstSeen must not be later than lastSeen.');
        }
        if (firstSeen > reportDate) {
          issue('error', 'EVENT_DATE_INVALID', `${path}/firstSeen`, 'firstSeen must not be later than the report date.');
        }
        if (lastSeen > reportDate) {
          issue('error', 'EVENT_DATE_INVALID', `${path}/lastSeen`, 'lastSeen must not be later than the report date.');
        }
      }
    }

    const sources = Array.isArray(highlight.sources)
      ? highlight.sources
      : (highlight.source === undefined ? [] : [highlight.source]);
    if (sources.length === 0) {
      issue('error', 'SOURCE_MISSING', `${path}/source`, 'Each formal highlight must have at least one source.');
    }
    sources.forEach((rawSource, sourceIndex) => {
      if (!isObject(rawSource)) return;
      if (rawSource.url !== undefined && !safeHttpUrl(rawSource.url)) {
        issue('error', 'SOURCE_URL_UNSAFE', `${path}/source${sources.length > 1 ? `/${sourceIndex}` : ''}/url`, 'Source URL must be a public HTTP(S) URL, not a local or private endpoint.');
      }
    });
  });

  return { valid: errors.length === 0, skipped: false, errors, warnings };
}
