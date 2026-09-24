import { getCollection, type CollectionEntry } from 'astro:content';
import { formatRadarDate } from '../data/radar';
import { getCanonicalTopicSlugs, getTopicDefinition, isCanonicalTopic, topicSlugsForRadar } from '../data/topics';

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

export interface TopicFlowStep {
  stage: string;
  date?: Date;
  title: string;
  href?: string;
  source?: string;
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
const signalWeight = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const matchingSignalWeight = (entry: RadarEntry, topics: string[]) => Math.max(0,
  ...entry.data.highlights
    .filter((highlight) => highlight.topic && topics.includes(highlight.topic))
    .map((highlight) => signalWeight[highlight.signal]));

export function getRelatedTopics(entry: RadarEntry | ResearchEntry, limit = 3): string[] {
  return getCanonicalTopicSlugs(entry.collection === 'radar' ? topicSlugsForRadar(entry) : entry.data.topics)
    .slice(0, limit);
}

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

export function getRelatedRadars(entry: ResearchEntry, context: RelationContext, limit = 5): IntelligenceRelation[] {
  if (!entry.data.publish) return [];
  const candidates = new Map<string, { entry: RadarEntry; sharedTopics: string[] }>();
  for (const radar of context.radars.filter(({ data }) => data.publish)) {
    const sharedTopics = overlap(entry.data.topics, topicSlugsForRadar(radar));
    if (sharedTopics.length) candidates.set(radarKey(radar), { entry: radar, sharedTopics });
  }
  return [...candidates.values()]
    .sort((a, b) => b.sharedTopics.length - a.sharedTopics.length
      || matchingSignalWeight(b.entry, b.sharedTopics) - matchingSignalWeight(a.entry, a.sharedTopics)
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
      || Number(b.entry.data.featured) - Number(a.entry.data.featured)
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
      || Number(b.entry.data.featured) - Number(a.entry.data.featured)
      || b.entry.data.updated.getTime() - a.entry.data.updated.getTime()
      || a.entry.data.slug.localeCompare(b.entry.data.slug))
    .slice(0, limit)
    .map(({ entry: research, sharedTopics }) => researchRelation(research, sharedTopics));
}

export function getTopicFlow(topic: string, context: RelationContext): TopicFlowStep[] {
  if (!isCanonicalTopic(topic)) return [];
  const radars = context.radars.filter((entry) => entry.data.publish && getRelatedTopics(entry, Infinity).includes(topic))
    .sort((a, b) => a.data.date.getTime() - b.data.date.getTime() || radarKey(a).localeCompare(radarKey(b)));
  const research = context.research.filter((entry) => entry.data.publish && getCanonicalTopicSlugs(entry.data.topics).includes(topic))
    .sort((a, b) => b.data.created.getTime() - a.data.created.getTime() || a.data.slug.localeCompare(b.data.slug));
  if (!radars.length && !research.length) return [];

  const steps: TopicFlowStep[] = [];
  const first = radars[0];
  if (first) steps.push({ stage: '最早记录', date: first.data.date, title: first.data.title,
    href: `/radar/${radarKey(first)}/`, source: '首次进入 Radar' });

  const latestHigh = [...radars].reverse().find((entry) => matchingSignalWeight(entry, [topic]) >= signalWeight.high
    && radarKey(entry) !== (first && radarKey(first)));
  if (latestHigh) {
    const highlight = latestHigh.data.highlights.find((item) => item.topic === topic
      && signalWeight[item.signal] >= signalWeight.high);
    steps.push({ stage: '近期信号', date: latestHigh.data.date, title: highlight?.title ?? latestHigh.data.title,
      href: `/radar/${radarKey(latestHigh)}/`, source: radarName[latestHigh.data.radar] });
  }

  const deepDive = research[0];
  if (deepDive) steps.push({ stage: '深度研究', date: deepDive.data.created, title: deepDive.data.title,
    href: `/research/${deepDive.data.slug}/`, source: 'Research' });

  const status = getTopicDefinition(topic)?.status;
  if (status) steps.push({ stage: '当前状态', title: status.toUpperCase(), source: 'Topic Registry' });
  return steps;
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
