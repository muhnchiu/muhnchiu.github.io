import type { LocalizedText, SearchDocument, SearchType } from './search-index';

export type SearchFilter = SearchType | 'all';
export interface RankedResult { document: SearchDocument; score: number }

export function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\-_./·—–:：，,|()（）]+/gu, '');
}

const variants = (text: LocalizedText) => [...new Set([normalizeSearch(text.hans), normalizeSearch(text.hant)])];
const shortLatin = (query: string) => /^[a-z0-9]{2,4}$/u.test(query);
const contains = (value: string, query: string) => shortLatin(query)
  ? new RegExp(`(^|[^a-z0-9])${query}`, 'iu').test(value.normalize('NFKC').toLocaleLowerCase())
  : normalizeSearch(value).includes(query);
const includes = (text: LocalizedText, query: string) => [text.hans, text.hant].some((value) => contains(value, query));
const exact = (text: LocalizedText, query: string) => variants(text).some((variant) => variant === query);

export function scoreDocument(document: SearchDocument, rawQuery: string, now = new Date()): number {
  const query = normalizeSearch(rawQuery.trim());
  if (!query) return 0;

  const title = variants(document.title);
  let score = title.includes(query) ? 100
    : title.some((value) => value.startsWith(query)) ? 80
      : includes(document.title, query) ? 60 : 0;

  if (document.topics.some((topic) => normalizeSearch(topic.slug) === query || exact(topic.name, query))
    || (document.type === 'topic' && document.keywords.some((keyword) => exact(keyword, query)))) score = Math.max(score, 50);
  if (document.tags.some((tag) => exact(tag, query))) score = Math.max(score, 40);
  if (document.aliases.some((alias) => includes(alias, query))) score = Math.max(score, 35);
  if (includes(document.description, query)) score = Math.max(score, 25);
  if (document.headings.some((heading) => includes(heading, query))) score = Math.max(score, 20);
  if (document.category && includes(document.category, query)) score = Math.max(score, 18);
  if (document.keywords.some((keyword) => includes(keyword, query))) score = Math.max(score, 18);
  if (document.excerpt && includes(document.excerpt, query)) score = Math.max(score, 10);

  if (!score && /[\s\-_]/u.test(rawQuery.trim())) {
    const terms = rawQuery.trim().split(/[\s\-_]+/u).map(normalizeSearch).filter(Boolean);
    const corpus = [document.title, document.description, ...document.topics.map((topic) => topic.name),
      ...document.tags, ...document.keywords, ...document.headings,
      ...(document.category ? [document.category] : []), ...(document.excerpt ? [document.excerpt] : [])]
      .flatMap(variants).join(' ');
    if (terms.length > 1 && terms.every((term) => corpus.includes(term))) score = 10;
  }
  if (!score) return 0;

  if (document.type === 'research') score += 10;
  if (document.type === 'stack' && document.core) score += 8;
  if (document.type === 'radar' && document.date) {
    const age = (now.getTime() - new Date(`${document.date}T00:00:00Z`).getTime()) / 86_400_000;
    if (age >= 0 && age <= 30) score += age <= 7 ? 4 : 2;
  }
  return score;
}

export function rankSearch(documents: SearchDocument[], query: string, filter: SearchFilter = 'all', now = new Date()): RankedResult[] {
  return documents
    .filter((document) => filter === 'all' || document.type === filter)
    .map((document) => ({ document, score: scoreDocument(document, query, now) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score
      || (b.document.date ?? '').localeCompare(a.document.date ?? '')
      || a.document.id.localeCompare(b.document.id));
}
