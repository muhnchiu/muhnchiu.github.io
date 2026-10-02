import { mapSourceEvidence } from '../radar-evidence-pipeline.mjs';

export const RECEIPT_REASON_CODES = Object.freeze([
  'MISSING_ITEM_URL', 'MISSING_OBSERVED_AT', 'UNKNOWN_SOURCE', 'UNSUPPORTED_SOURCE_RECORD',
  'EVENT_IDENTITY_INCOMPLETE', 'EVIDENCE_INCOMPLETE', 'SCORE_INPUT_INCOMPLETE',
  'INVALID_PROVENANCE', 'SKILL_STRUCTURED_INPUT_UNAVAILABLE', 'INVALID_TIMESTAMP',
  'INVALID_ITEM_URL', 'AGGREGATOR_URL_NOT_ITEM', 'ADAPTER_EXCEPTION', 'MISSING_GENERATED_AT',
] as const);

export type RadarId = 'AI' | 'DEV' | 'APP' | 'SEC' | 'SKILL';
export type JsonRecord = Record<string, unknown>;

/** One candidate envelope shared by every Radar. Source-specific facts stay in rawSourceMetadata. */
export type ProductionStructuredCandidate = {
  radar: RadarId;
  sourceIdentifier?: string;
  sourceName: string;
  sourceLevel?: string;
  sourceAuthority?: string;
  itemIdentifier?: string;
  itemUrl?: string;
  publishedAt?: string;
  observedAt?: string;
  title?: string;
  summary?: string;
  description?: string;
  entityEvidence?: unknown;
  eventTypeEvidence?: unknown;
  eventIdentifierEvidence?: unknown;
  scoreInputEvidence?: JsonRecord;
  rawSourceMetadata: { recordShape: string; record: JsonRecord };
};

export type AdapterInput = { radar: string; sourceName: string; record: unknown };
export type AdapterContext = { observedAt?: string };
export type AdapterResult = {
  status: 'CANDIDATE_READY' | 'RECEIPT_ONLY';
  candidate?: ProductionStructuredCandidate;
  receiptReasons: Array<(typeof RECEIPT_REASON_CODES)[number]>;
  downstreamGaps: Array<'EVENT_IDENTITY_INCOMPLETE' | 'SCORE_INPUT_INCOMPLETE'>;
  provenance: { adapterVersion: '1.0'; sourceName: string; mappingAuthority?: string; mappingVersion: 'runtime-parser-audit-2026-10-01'; observedAtSource: 'EXPLICIT_CALLER' | 'MISSING'; urlRule?: string };
};

type Projection = { title?: unknown; itemIdentifier?: unknown; itemUrl?: unknown; publishedAt?: unknown; summary?: unknown; description?: unknown; recordShape: string; urlRule?: string };
type SourceSpec = { radar: RadarId; evidenceSourceName?: string; project(record: JsonRecord): Projection | null };

const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v : undefined;
const obj = (v: unknown): v is JsonRecord => !!v && typeof v === 'object' && !Array.isArray(v);

// These projections mirror fields actually read by the enabled mac-env-sync collectors.
// Fields dropped before Markdown output remain unavailable to the production handoff.
const sources: Record<string, SourceSpec> = {
  'HuggingFace Papers': { radar: 'AI', project: r => Array.isArray(r.authors) || 'title' in r ? { title: r.title, recordShape: 'hf-paper-parser-row' } : null },
  'HuggingFace 热门模型': { radar: 'AI', project: r => 'modelId' in r || 'id' in r ? { title: r.modelId ?? r.id, itemIdentifier: r.modelId ?? r.id, recordShape: 'hf-model-parser-row' } : null },
  'GitHub AI Trending': { radar: 'AI', project: r => 'full_name' in r ? { title: r.full_name, itemIdentifier: r.full_name, description: r.description, recordShape: 'github-ai-repository-parser-row' } : null },
  'OpenRouter 免费模型': { radar: 'AI', project: r => typeof r.id === 'string' && r.id.includes(':free') ? { title: r.name ?? r.id, itemIdentifier: r.id, recordShape: 'openrouter-model-parser-row' } : null },
  'TechCrunch AI': { radar: 'AI', project: r => 'title' in r ? { title: r.title, recordShape: 'techcrunch-rss-renderer-row' } : null },
  'arXiv cs.LG': { radar: 'AI', project: r => 'title' in r ? { title: r.title, recordShape: 'arxiv-rss-renderer-row' } : null },

  'GitHub Trending': { radar: 'DEV', project: r => 'full_name' in r ? { title: r.full_name, itemIdentifier: r.full_name, description: r.description, recordShape: 'github-trending-parser-row' } : null },
  'Hacker News developer stories': { radar: 'DEV', evidenceSourceName: 'Hacker News', project: r => 'title' in r && ('objectID' in r || 'url' in r) ? { title: r.title, itemIdentifier: r.objectID, itemUrl: r.url ?? hnUrl(r.objectID), urlRule: r.url ? undefined : 'mac-env-sync/scripts/dev-radar.sh HN objectID permalink fallback', recordShape: 'hn-developer-parser-row' } : null },
  'Show HN': { radar: 'DEV', evidenceSourceName: 'Hacker News Show HN', project: r => 'title' in r && 'points' in r ? { title: r.title, itemIdentifier: r.objectID, recordShape: 'show-hn-parser-row' } : null },
  'npm Downloads': { radar: 'DEV', project: r => 'downloads' in r || 'package' in r ? { title: r.package, itemIdentifier: r.package, recordShape: 'npm-aggregate-metric' } : null },
  'VS Code Marketplace': { radar: 'DEV', project: r => 'displayName' in r || 'extensionName' in r ? { title: r.displayName ?? r.extensionName, itemIdentifier: r.extensionName, description: r.shortDescription, recordShape: 'vscode-marketplace-parser-row' } : null },
  'Claude Code Changelog': { radar: 'DEV', project: r => 'tag_name' in r ? { title: r.name ?? r.tag_name, itemIdentifier: r.tag_name, recordShape: 'github-release-renderer-row' } : null },

  'Hacker News 首页': { radar: 'APP', project: r => 'title' in r && ('objectID' in r || 'url' in r) ? { title: r.title, itemIdentifier: r.objectID, itemUrl: r.url ?? hnUrl(r.objectID), urlRule: r.url ? undefined : 'mac-env-sync/scripts/app-radar.sh HN objectID permalink fallback', recordShape: 'hn-front-page-parser-row' } : null },
  'Hacker News Show HN': { radar: 'APP', project: r => 'title' in r && ('objectID' in r || 'url' in r) ? { title: r.title, itemIdentifier: r.objectID, itemUrl: r.url ?? hnUrl(r.objectID), urlRule: r.url ? undefined : 'mac-env-sync/scripts/app-radar.sh HN objectID permalink fallback', recordShape: 'hn-show-parser-row' } : null },
  'Product Hunt': { radar: 'APP', project: r => 'title' in r && 'link' in r ? { title: r.title, itemUrl: r.link, description: r.description, recordShape: 'rss-markdown-renderer-row' } : null },
  '少数派': { radar: 'APP', project: r => 'title' in r && 'link' in r ? { title: r.title, itemUrl: r.link, description: r.description, recordShape: 'rss-markdown-renderer-row' } : null },
  '小众软件': { radar: 'APP', project: r => 'title' in r && 'link' in r ? { title: r.title, itemUrl: r.link, description: r.description, recordShape: 'rss-markdown-renderer-row' } : null },

  'NVD': { radar: 'SEC', project: r => 'id' in r && ('score' in r || 'desc' in r) ? { title: r.desc, itemIdentifier: r.id, recordShape: 'nvd-renderer-row' } : null },
  'GitHub Security Advisories': { radar: 'SEC', project: r => 'ghsa_id' in r ? { title: r.summary, itemIdentifier: r.ghsa_id, recordShape: 'ghsa-renderer-row' } : null },
  'CISA KEV': { radar: 'SEC', project: r => 'cveID' in r ? { title: r.vulnerabilityName, itemIdentifier: r.cveID, description: r.vendorProject && r.product ? `${String(r.vendorProject)}/${String(r.product)}` : undefined, recordShape: 'cisa-kev-renderer-row' } : null },
  'Hacker News Security': { radar: 'SEC', project: r => 'title' in r && ('objectID' in r || 'url' in r) ? { title: r.title, itemIdentifier: r.objectID, itemUrl: r.url ?? hnUrl(r.objectID), urlRule: r.url ? undefined : 'mac-env-sync/scripts/sec-radar.sh HN objectID permalink fallback', recordShape: 'hn-security-parser-row' } : null },
};

const runtimeAliases: Record<string, { target: string; evidenceSourceName?: string }> = {
  'AI|Hugging Face Papers': { target: 'HuggingFace Papers', evidenceSourceName: 'HuggingFace Papers' },
  'AI|Hugging Face 热门模型': { target: 'HuggingFace 热门模型', evidenceSourceName: 'HuggingFace 热门模型' },
  'AI|GitHub AI repositories': { target: 'GitHub AI Trending', evidenceSourceName: 'GitHub AI Trending' },
  'DEV|GitHub developer-tool trending': { target: 'GitHub Trending', evidenceSourceName: 'GitHub Trending' },
  'DEV|Hacker News': { target: 'Hacker News developer stories', evidenceSourceName: 'Hacker News' },
  'DEV|Hacker News Show HN': { target: 'Show HN', evidenceSourceName: 'Hacker News Show HN' },
  'DEV|npm downloads': { target: 'npm Downloads', evidenceSourceName: 'npm Downloads' },
  'DEV|AI coding-tool GitHub releases': { target: 'Claude Code Changelog', evidenceSourceName: 'Claude Code Changelog' },
  'APP|Hacker News Home': { target: 'Hacker News 首页', evidenceSourceName: 'Hacker News 首页' },
  'APP|Hacker News Show HN': { target: 'Hacker News Show HN', evidenceSourceName: 'Hacker News Show HN' },
};

function getSpec(input: Pick<AdapterInput, 'radar' | 'sourceName'>): SourceSpec | undefined {
  const alias = runtimeAliases[`${input.radar}|${input.sourceName}`];
  if (alias) {
    const target = sources[alias.target];
    return target ? { ...target, radar: input.radar as RadarId, ...(alias.evidenceSourceName ? { evidenceSourceName: alias.evidenceSourceName } : {}) } : undefined;
  }
  const direct = sources[input.sourceName];
  return direct?.radar === input.radar ? direct : undefined;
}

function hnUrl(id: unknown): string | undefined {
  const value = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  return /^\d+$/.test(value) ? `https://news.ycombinator.com/item?id=${value}` : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}

function blockedAggregatorUrl(sourceName: string, value: string): boolean {
  const url = value.toLowerCase().replace(/\/$/, '');
  if (sourceName === 'Product Hunt' && /producthunt\.com\/(feed|topics\/.*)$/.test(url)) return true;
  if (sourceName === '少数派' && /sspai\.com\/feed$/.test(url)) return true;
  if (sourceName === '小众软件' && /appinn\.com\/feed$/.test(url)) return true;
  if (sourceName.startsWith('Hacker News') && /news\.ycombinator\.com\/?$/.test(url)) return true;
  return false;
}

function makeResult(input: AdapterInput, context: AdapterContext, projection: Projection | null, code?: (typeof RECEIPT_REASON_CODES)[number]): AdapterResult {
  const spec = getSpec(input);
  const reasons: AdapterResult['receiptReasons'] = [];
  if (code) reasons.push(code);
  const mapped = mapSourceEvidence(spec?.evidenceSourceName ?? input.sourceName);
  const record = obj(input.record) ? input.record : {};
  const observedAt = context.observedAt;
  if (!code && !projection) reasons.push('UNSUPPORTED_SOURCE_RECORD');
  if (!code && projection) {
    if (!str(projection.itemUrl)) reasons.push('MISSING_ITEM_URL');
    else if (blockedAggregatorUrl(input.sourceName, projection.itemUrl)) reasons.push('AGGREGATOR_URL_NOT_ITEM');
    else if (!/^https:\/\//i.test(projection.itemUrl) || !URL.canParse(projection.itemUrl)) reasons.push('INVALID_ITEM_URL');
    if (!str(projection.title)) reasons.push('EVIDENCE_INCOMPLETE');
    if (!observedAt) reasons.push('MISSING_OBSERVED_AT');
    else if (!validTimestamp(observedAt)) reasons.push('INVALID_TIMESTAMP');
    if (record.sourcePublishedAt !== undefined && record.sourcePublishedAt !== null && !validTimestamp(record.sourcePublishedAt)) reasons.push('INVALID_TIMESTAMP');
    if (record.sourceAuthority !== undefined && record.sourceAuthority !== mapped.sourceAuthority) reasons.push('INVALID_PROVENANCE');
    if (record.sourceLevel !== undefined && record.sourceLevel !== mapped.sourceLevel) reasons.push('INVALID_PROVENANCE');
    if (mapped.errors.length || !mapped.sourceAuthority || !mapped.sourceLevel) reasons.push('INVALID_PROVENANCE');
  }
  const ready = reasons.length === 0 && !!projection && !!spec;
  const identityComplete = !!str(record.entity) && !!str(record.canonicalEventType) && !!str(record.eventIdentifier);
  const candidate: ProductionStructuredCandidate | undefined = projection && spec ? {
    radar: spec.radar,
    ...(str(record.sourceIdentifier) ? { sourceIdentifier: str(record.sourceIdentifier) } : {}),
    sourceName: spec?.evidenceSourceName ?? input.sourceName,
    ...(mapped.sourceLevel ? { sourceLevel: mapped.sourceLevel } : {}),
    ...(mapped.sourceAuthority ? { sourceAuthority: mapped.sourceAuthority } : {}),
    ...(str(projection.itemIdentifier) ? { itemIdentifier: str(projection.itemIdentifier) } : {}),
    ...(str(projection.itemUrl) ? { itemUrl: str(projection.itemUrl) } : {}),
    ...(str(record.sourcePublishedAt) ? { publishedAt: str(record.sourcePublishedAt) } : str(projection.publishedAt) ? { publishedAt: str(projection.publishedAt) } : {}),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(str(projection.title) ? { title: str(projection.title) } : {}),
    ...(str(projection.summary) ? { summary: str(projection.summary) } : {}),
    ...(str(projection.description) ? { description: str(projection.description) } : {}),
    ...(record.entityEvidence === undefined ? {} : { entityEvidence: record.entityEvidence }),
    ...(record.eventTypeEvidence === undefined ? {} : { eventTypeEvidence: record.eventTypeEvidence }),
    ...(record.eventIdentifierEvidence === undefined ? {} : { eventIdentifierEvidence: record.eventIdentifierEvidence }),
    ...(obj(record.scoreInputEvidence) ? { scoreInputEvidence: { ...record.scoreInputEvidence } } : {}),
    rawSourceMetadata: { recordShape: projection.recordShape, record: structuredClone(record) },
  } : undefined;
  const downstreamGaps: AdapterResult['downstreamGaps'] = [];
  if (candidate && !identityComplete) downstreamGaps.push('EVENT_IDENTITY_INCOMPLETE');
  if (candidate && (!obj(record.scoreInputEvidence) || Object.keys(record.scoreInputEvidence).length < 19)) downstreamGaps.push('SCORE_INPUT_INCOMPLETE');
  if (candidate && !str(projection?.itemUrl)) downstreamGaps.push('EVIDENCE_INCOMPLETE');
  return {
    status: ready ? 'CANDIDATE_READY' : 'RECEIPT_ONLY',
    ...(candidate ? { candidate } : {}),
    receiptReasons: [...new Set(reasons)],
    downstreamGaps,
    provenance: { adapterVersion: '1.0', sourceName: input.sourceName, ...(mapped.sourceAuthority ? { mappingAuthority: mapped.sourceAuthority } : {}), mappingVersion: 'runtime-parser-audit-2026-10-01', observedAtSource: observedAt === undefined ? 'MISSING' : 'EXPLICIT_CALLER', ...(projection?.urlRule ? { urlRule: projection.urlRule } : {}) },
  };
}

/** Pure adapter for a record emitted at a verified parser boundary; never fetches or writes. */
export function adaptProductionCandidate(input: AdapterInput, context: AdapterContext): AdapterResult {
  try {
    if (!input || typeof input !== 'object' || !obj(input)) return makeResult({ radar: '', sourceName: '', record: null }, context ?? {}, null, 'UNSUPPORTED_SOURCE_RECORD');
    if (input.radar === 'SKILL' || input.sourceName === 'ClawHub' || input.radar === 'skill') {
      return { status: 'RECEIPT_ONLY', receiptReasons: ['SKILL_STRUCTURED_INPUT_UNAVAILABLE'], downstreamGaps: ['EVENT_IDENTITY_INCOMPLETE', 'SCORE_INPUT_INCOMPLETE'], provenance: { adapterVersion: '1.0', sourceName: input.sourceName, mappingVersion: 'runtime-parser-audit-2026-10-01', observedAtSource: context?.observedAt === undefined ? 'MISSING' : 'EXPLICIT_CALLER' } };
    }
    const spec = getSpec(input);
    if (!spec) return makeResult(input, context ?? {}, null, 'UNKNOWN_SOURCE');
    if (!obj(input.record)) return makeResult(input, context ?? {}, null, 'UNSUPPORTED_SOURCE_RECORD');
    const projection = spec.project(input.record);
    return makeResult(input, context ?? {}, projection);
  } catch {
    return makeResult({ radar: input?.radar ?? '', sourceName: input?.sourceName ?? '', record: null }, context ?? {}, null, 'ADAPTER_EXCEPTION');
  }
}

/** Each candidate is isolated: one malformed input cannot abort its siblings. */
export function adaptProductionCandidateBatch(inputs: AdapterInput[], context: AdapterContext): AdapterResult[] {
  return inputs.map((input) => {
    try { return adaptProductionCandidate(input, context); }
    catch { return makeResult({ radar: input?.radar ?? '', sourceName: input?.sourceName ?? '', record: null }, context ?? {}, null, 'ADAPTER_EXCEPTION'); }
  });
}

export function getProductionAdapterSourceNames(): string[] { return [...Object.keys(sources), ...Object.keys(runtimeAliases)]; }
