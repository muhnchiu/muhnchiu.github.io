import { getCollection, type CollectionEntry } from 'astro:content';
import { formatRadarDate } from '../data/radar';
import { getCanonicalTopicSlugs, isCanonicalTopic, topicSlugsForRadar } from '../data/topics';

type RadarEntry = CollectionEntry<'radar'>;
type ResearchEntry = CollectionEntry<'research'>;

export interface RelationContext {
  radars: RadarEntry[];
  research: ResearchEntry[];
}

export interface IntelligenceRelation {
  kind: 'radar' | 'research';
  href: string;
  title: string;
  summary: string;
  date: Date;
  source: string;
  sharedTopics: string[];
}

const radarName: Record<RadarEntry['data']['radar'], string> = {
  ai: 'AI Radar',
  dev: 'Developer Radar',
  app: 'App Radar',
  security: 'Security Radar',
  skill: 'Skill Radar',
};

const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const distance = (left: Date, right: Date) => Math.abs(left.getTime() - right.getTime());
const overlap = (left: string[], right: string[]) => {
  const rightSet = new Set(getCanonicalTopicSlugs(right));
  return getCanonicalTopicSlugs(left).filter((topic) => rightSet.has(topic));
};
const radarKey = (entry: RadarEntry) => `${entry.data.radar}/${formatRadarDate(entry.data.date)}`;

export async function loadRelationContext(): Promise<RelationContext> {
  const [radars, research] = await Promise.all([
    getCollection('radar', ({ data }) => data.publish),
    getCollection('research', ({ data }) => data.publish),
  ]);
  return { radars, research };
}

function radarRelation(entry: RadarEntry, sharedTopics: string[]): IntelligenceRelation {
  const matchingHighlights = entry.data.highlights
    .filter((highlight) => highlight.topic && sharedTopics.includes(highlight.topic));
  return {
    kind: 'radar',
    href: `/radar/${radarKey(entry)}/`,
    title: entry.data.title,
    summary: matchingHighlights.length
      ? matchingHighlights.slice(0, 2).map((highlight) => highlight.title).join(' · ')
      : entry.data.verdict,
    date: entry.data.date,
    source: radarName[entry.data.radar],
    sharedTopics,
  };
}

function researchRelation(entry: ResearchEntry, sharedTopics: string[]): IntelligenceRelation {
  return {
    kind: 'research',
    href: `/research/${entry.data.slug}/`,
    title: entry.data.title,
    summary: entry.data.subtitle,
    date: entry.data.updated,
    source: entry.data.source,
    sharedTopics,
  };
}

export function getRelatedRadars(entry: ResearchEntry, context: RelationContext, limit = 3): IntelligenceRelation[] {
  if (!entry.data.publish) return [];
  const candidates = new Map<string, { entry: RadarEntry; sharedTopics: string[] }>();
  for (const radar of context.radars.filter(({ data }) => data.publish)) {
    const sharedTopics = overlap(entry.data.topics, topicSlugsForRadar(radar));
    if (sharedTopics.length) candidates.set(radarKey(radar), { entry: radar, sharedTopics });
  }
  return [...candidates.values()]
    .sort((a, b) => Number(dayKey(b.entry.data.date) === dayKey(entry.data.created))
      - Number(dayKey(a.entry.data.date) === dayKey(entry.data.created))
      || b.sharedTopics.length - a.sharedTopics.length
      || distance(a.entry.data.date, entry.data.created) - distance(b.entry.data.date, entry.data.created)
      || b.entry.data.date.getTime() - a.entry.data.date.getTime()
      || radarKey(a.entry).localeCompare(radarKey(b.entry)))
    .slice(0, limit)
    .map(({ entry: radar, sharedTopics }) => radarRelation(radar, sharedTopics));
}

// A declared source may keep its header link, but only after the same topic rule verifies it.
export function getDeclaredSourceRadarHref(entry: ResearchEntry, context: RelationContext): string | undefined {
  if (!entry.data.publish) return undefined;
  const declared = entry.data.source.trim().toLowerCase();
  const radar = context.radars.find((candidate) => candidate.data.publish
    && `${radarName[candidate.data.radar]} ${dayKey(candidate.data.date)}`.toLowerCase() === declared
    && overlap(entry.data.topics, topicSlugsForRadar(candidate)).length > 0);
  return radar && radarRelation(radar, overlap(entry.data.topics, topicSlugsForRadar(radar))).href;
}

export function getRelatedResearch(entry: RadarEntry, context: RelationContext, limit = 3): IntelligenceRelation[] {
  if (!entry.data.publish) return [];
  const candidates = new Map<string, { entry: ResearchEntry; sharedTopics: string[] }>();
  const radarTopics = topicSlugsForRadar(entry);
  for (const research of context.research.filter(({ data }) => data.publish)) {
    const sharedTopics = overlap(radarTopics, research.data.topics);
    if (sharedTopics.length) candidates.set(research.data.slug, { entry: research, sharedTopics });
  }
  return [...candidates.values()]
    .sort((a, b) => b.sharedTopics.length - a.sharedTopics.length
      || distance(a.entry.data.created, entry.data.date) - distance(b.entry.data.created, entry.data.date)
      || b.entry.data.created.getTime() - a.entry.data.created.getTime()
      || a.entry.data.slug.localeCompare(b.entry.data.slug))
    .slice(0, limit)
    .map(({ entry: research, sharedTopics }) => researchRelation(research, sharedTopics));
}

export function getRelatedResearchByTopics(entry: ResearchEntry, context: RelationContext, limit = 3): IntelligenceRelation[] {
  if (!entry.data.publish) return [];
  const candidates = new Map<string, { entry: ResearchEntry; sharedTopics: string[] }>();
  for (const research of context.research.filter(({ data }) => data.publish && data.slug !== entry.data.slug)) {
    const sharedTopics = overlap(entry.data.topics, research.data.topics);
    if (sharedTopics.length) candidates.set(research.data.slug, { entry: research, sharedTopics });
  }
  return [...candidates.values()]
    .sort((a, b) => b.sharedTopics.length - a.sharedTopics.length
      || b.entry.data.updated.getTime() - a.entry.data.updated.getTime()
      || a.entry.data.slug.localeCompare(b.entry.data.slug))
    .slice(0, limit)
    .map(({ entry: research, sharedTopics }) => researchRelation(research, sharedTopics));
}

export function getTopicTimeline(topic: string, context: RelationContext, limit = 12): IntelligenceRelation[] {
  if (!isCanonicalTopic(topic)) return [];
  const entries = new Map<string, IntelligenceRelation>();
  for (const radar of context.radars.filter(({ data }) => data.publish)) {
    if (topicSlugsForRadar(radar).includes(topic)) {
      entries.set(`radar:${radarKey(radar)}`, radarRelation(radar, [topic]));
    }
  }
  for (const research of context.research.filter(({ data }) => data.publish)) {
    if (research.data.topics.includes(topic)) {
      entries.set(`research:${research.data.slug}`, researchRelation(research, [topic]));
    }
  }
  return [...entries.values()]
    .sort((a, b) => b.date.getTime() - a.date.getTime()
      || (a.kind === b.kind ? 0 : a.kind === 'research' ? -1 : 1)
      || a.href.localeCompare(b.href))
    .slice(0, limit);
}
