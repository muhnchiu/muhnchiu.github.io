import { createHash } from 'node:crypto';
import { adaptProductionCandidate } from '../radar-candidate-adapter/adapters.ts';
import { resolveArxivCsLgIdentity, ARXIV_SOURCE_IDENTIFIER } from '../radar-canary/arxiv-identity.mjs';

export const ARXIV_CS_LG_API_URL = 'https://export.arxiv.org/api/query?search_query=cat%3Acs.LG&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => Object.assign(new Error(code), { code });

function xmlText(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, value) => {
    if (value === 'amp') return '&'; if (value === 'lt') return '<'; if (value === 'gt') return '>';
    if (value === 'quot') return '"'; if (value === 'apos') return "'";
    const code = value[1].toLowerCase() === 'x' ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10);
    if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw fail('ARXIV_XML_ENTITY_INVALID');
    return String.fromCodePoint(code);
  });
}
function tag(body, name, required = true) {
  const matches = [...body.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi'))];
  if (matches.length !== 1) { if (!required && matches.length === 0) return undefined; throw fail('ARXIV_XML_SHAPE_INVALID'); }
  return xmlText(matches[0][1].replace(/<[^>]*>/g, '').trim());
}

/** Narrow parser for the official arXiv Atom API. It retains official versioned item permalinks. */
export function parseArxivAtomFeed(xml) {
  if (typeof xml !== 'string' || !xml.trim() || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw fail('ARXIV_XML_SHAPE_INVALID');
  const root = xml.replace(/^\uFEFF/, '').trim().match(/^<\?xml\s+[^?]*\?>\s*<feed\b[^>]*>([\s\S]*)<\/feed>\s*$/i);
  if (!root) throw fail('ARXIV_XML_SHAPE_INVALID');
  const records = [...root[1].matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map(([, body]) => {
    const atomId = tag(body, 'id');
    const id = atomId.match(/^https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5}v[1-9]\d*)$/)?.[1];
    const link = [...body.matchAll(/<link\b([^>]*)\/?\s*>/gi)].map(([, attrs]) => ({
      rel: attrs.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] ?? 'alternate',
      href: attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1],
    })).find((item) => item.rel === 'alternate');
    if (!id || !link?.href) throw fail('ARXIV_ATOM_ID_OR_LINK_INVALID');
    const url = new URL(link.href);
    if (url.protocol !== 'https:' || url.hostname !== 'arxiv.org' || url.pathname !== `/abs/${id}` || url.search || url.hash) throw fail('ARXIV_ATOM_ITEM_URL_INVALID');
    const categoryIds = [...body.matchAll(/<category\b[^>]*\bterm\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi)].map(([, term]) => term);
    return {
      id,
      itemUrl: url.href,
      title: tag(body, 'title').replace(/\s+/g, ' '),
      published: tag(body, 'published'),
      updated: tag(body, 'updated'),
      summary: tag(body, 'summary', false),
      categories: categoryIds,
      sourceIdentifier: ARXIV_SOURCE_IDENTIFIER,
    };
  });
  if (!records.length) throw fail('ARXIV_ATOM_ENTRIES_EMPTY');
  return records;
}

export function createArxivFeedCapture({ xml, fetchedAt, observedAt = fetchedAt, startIndex = 0, totalResults = null, httpStatus = 200 }) {
  const sourceRecords = parseArxivAtomFeed(xml);
  const capture = {
    captureVersion: 1,
    captureTimestamp: fetchedAt,
    observedAt,
    source: { radar: 'AI', sourceName: 'arXiv cs.LG', sourceIdentifier: ARXIV_SOURCE_IDENTIFIER, endpoint: ARXIV_CS_LG_API_URL, retrievalResult: 'CONTENT_RETURNED', httpStatus, rawSha256: sha256(xml), startIndex, itemCount: sourceRecords.length, totalResults },
    sourceRecords,
  };
  capture.contentIntegrity = { algorithm: 'SHA-256', sha256: sha256(JSON.stringify(capture)) };
  return capture;
}

export function verifyArxivFeedCapture(capture) {
  if (!capture || capture.captureVersion !== 1 || capture.source?.sourceName !== 'arXiv cs.LG'
    || capture.source?.radar !== 'AI' || capture.source?.sourceIdentifier !== ARXIV_SOURCE_IDENTIFIER
    || capture.source?.endpoint !== ARXIV_CS_LG_API_URL || capture.source?.retrievalResult !== 'CONTENT_RETURNED'
    || capture.source?.httpStatus !== 200 || !Array.isArray(capture.sourceRecords) || capture.sourceRecords.length === 0) throw fail('ARXIV_CAPTURE_SOURCE_INVALID');
  const { contentIntegrity, ...payload } = capture;
  if (contentIntegrity?.algorithm !== 'SHA-256' || contentIntegrity.sha256 !== sha256(JSON.stringify(payload))) throw fail('ARXIV_CAPTURE_HASH_MISMATCH');
  for (const record of capture.sourceRecords) {
    if (!record || record.sourceIdentifier !== ARXIV_SOURCE_IDENTIFIER || !record.id || !record.itemUrl) throw fail('ARXIV_CAPTURE_RECORD_INVALID');
  }
  return { valid: true, sha256: contentIntegrity.sha256, recordCount: capture.sourceRecords.length };
}

export function createArxivCandidate(record, { observedAt } = {}) {
  const candidateResult = adaptProductionCandidate({ radar: 'AI', sourceName: 'arXiv cs.LG', record }, { observedAt });
  const identity = candidateResult.candidate ? resolveArxivCsLgIdentity(candidateResult.candidate) : null;
  return { candidateResult, identity };
}
