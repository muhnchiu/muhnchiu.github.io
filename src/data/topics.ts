import { getCollection, type CollectionEntry } from 'astro:content';
import { formatRadarDate } from './radar';
import { topicRegistry } from './topic-registry';
import type { TopicDefinition, TopicGroup, TopicStatus } from './topic-types';

export { topicRegistry } from './topic-registry';
export type { TopicDefinition, TopicGroup, TopicStatus } from './topic-types';

type RadarEntry = CollectionEntry<'radar'>;
type ResearchEntry = CollectionEntry<'research'>;

export const topicGroups: Array<{ id: TopicGroup; name: string; eyebrow: string }> = [
  { id: 'models', name: '模型与智能', eyebrow: 'AI / MODELS' },
  { id: 'systems', name: '智能系统', eyebrow: 'AI / SYSTEMS' },
  { id: 'tools', name: '工具与工程', eyebrow: 'DEVELOPMENT' },
  { id: 'security', name: '安全与前沿', eyebrow: 'SECURITY / RESEARCH' },
];

const registryBySlug = new Map(topicRegistry.map((topic) => [topic.slug, topic]));

export function getTopicDefinition(slug: string): TopicDefinition | undefined {
  return registryBySlug.get(slug);
}

export function isCanonicalTopic(slug: string): boolean {
  return registryBySlug.has(slug);
}

export function getCanonicalTopicSlugs(slugs: string[]): string[] {
  return [...new Set(slugs)].filter(isCanonicalTopic);
}

export function getTopicName(slug: string): string {
  return getTopicDefinition(slug)?.name ?? slug;
}

export const getTopicLabel = getTopicName;

export function topicSlugsForRadar(entry: RadarEntry): string[] {
  return [...new Set([
    ...entry.data.topics,
    ...entry.data.highlights.map((highlight) => highlight.topic).filter((topic): topic is string => Boolean(topic)),
  ])];
}

export interface RelatedRadarReport {
  title: string;
  radar: RadarEntry['data']['radar'];
  radarLabel: string;
  date: Date;
  updated: Date;
  verdict: string;
  href: string;
  matchedHighlights: RadarEntry['data']['highlights'];
}

export interface TopicAggregate {
  slug: string;
  name: string;
  description: string;
  group?: TopicGroup;
  status: TopicStatus | 'historical';
  order: number;
  canonical: boolean;
  radarCount: number;
  researchCount: number;
  latestActivity?: Date;
  relatedResearch: ResearchEntry[];
  relatedRadarReports: RelatedRadarReport[];
  relatedTopics: Array<{ slug: string; name: string; coOccurrenceCount: number }>;
}

const radarLabels: Record<RadarEntry['data']['radar'], string> = {
  ai: 'AI Radar', dev: 'Developer Radar', security: 'Security Radar', app: 'App Radar', skill: 'Skill Radar',
};

export function aggregateTopics(radarEntries: RadarEntry[], researchEntries: ResearchEntry[]): TopicAggregate[] {
  const radarByTopic = new Map<string, Map<string, RelatedRadarReport>>();
  const researchByTopic = new Map<string, Map<string, ResearchEntry>>();
  const latestActivityByTopic = new Map<string, Date>();
  const coOccurrences = new Map<string, Map<string, number>>();

  const recordActivity = (slug: string, date: Date) => {
    const previous = latestActivityByTopic.get(slug);
    if (!previous || date > previous) latestActivityByTopic.set(slug, date);
  };

  const recordCoOccurrences = (slugs: string[]) => {
    const canonical = getCanonicalTopicSlugs(slugs);
    for (const slug of canonical) {
      const related = coOccurrences.get(slug) ?? new Map<string, number>();
      for (const other of canonical) {
        if (slug !== other) related.set(other, (related.get(other) ?? 0) + 1);
      }
      coOccurrences.set(slug, related);
    }
  };

  for (const entry of radarEntries.filter(({ data }) => data.publish)) {
    const { radar, date } = entry.data;
    const slugs = topicSlugsForRadar(entry);
    recordCoOccurrences(slugs);
    for (const slug of slugs) {
      const reports = radarByTopic.get(slug) ?? new Map<string, RelatedRadarReport>();
      reports.set(`${radar}|${formatRadarDate(date)}`, {
        title: entry.data.title,
        radar,
        radarLabel: radarLabels[radar],
        date,
        updated: entry.data.updated ?? date,
        verdict: entry.data.verdict,
        href: `/radar/${radar}/${formatRadarDate(date)}/`,
        matchedHighlights: entry.data.highlights.filter((highlight) => highlight.topic === slug),
      });
      radarByTopic.set(slug, reports);
      recordActivity(slug, entry.data.updated ?? date);
    }
  }

  for (const entry of researchEntries.filter(({ data }) => data.publish)) {
    const slugs = [...new Set(entry.data.topics)];
    recordCoOccurrences(slugs);
    for (const slug of slugs) {
      const research = researchByTopic.get(slug) ?? new Map<string, ResearchEntry>();
      research.set(entry.data.slug, entry);
      researchByTopic.set(slug, research);
      recordActivity(slug, entry.data.updated);
    }
  }

  const slugs = new Set([...topicRegistry.map((topic) => topic.slug), ...radarByTopic.keys(), ...researchByTopic.keys()]);
  return [...slugs].map((slug): TopicAggregate => {
    const relatedRadarReports = [...(radarByTopic.get(slug)?.values() ?? [])]
      .sort((a, b) => b.date.getTime() - a.date.getTime() || a.radar.localeCompare(b.radar));
    const relatedResearch = [...(researchByTopic.get(slug)?.values() ?? [])]
      .sort((a, b) => b.data.updated.getTime() - a.data.updated.getTime()
        || b.data.created.getTime() - a.data.created.getTime());
    const relatedTopics = [...(coOccurrences.get(slug) ?? new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([relatedSlug, coOccurrenceCount]) => ({ slug: relatedSlug, name: getTopicName(relatedSlug), coOccurrenceCount }));
    const definition = getTopicDefinition(slug);
    return {
      slug,
      name: definition?.name ?? slug,
      description: definition?.description ?? '历史内容中的主题标记，尚未纳入长期议题。',
      group: definition?.group,
      status: definition?.status ?? 'historical',
      order: definition?.order ?? Number.MAX_SAFE_INTEGER,
      canonical: Boolean(definition),
      radarCount: relatedRadarReports.length,
      researchCount: relatedResearch.length,
      latestActivity: latestActivityByTopic.get(slug),
      relatedResearch,
      relatedRadarReports,
      relatedTopics,
    };
  }).sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

export function mostActiveTopics(topics: TopicAggregate[], limit = 6, now = new Date()): TopicAggregate[] {
  const active = topics.filter((topic) => topic.status === 'active' && topic.canonical);
  const recentScore = (topic: TopicAggregate) => {
    const entries = [
      ...topic.relatedRadarReports.map((report) => ({ date: report.updated, weight: 2 })),
      ...topic.relatedResearch.map((research) => ({ date: research.data.updated, weight: 3 })),
    ];
    return entries.reduce((score, entry) => {
      const daysOld = Math.max(0, (now.getTime() - entry.date.getTime()) / 86_400_000);
      return score + (daysOld <= 7 ? entry.weight * 2 : daysOld <= 30 ? entry.weight : 0);
    }, 0);
  };
  return active.sort((a, b) => recentScore(b) - recentScore(a)
    || (b.latestActivity?.getTime() ?? 0) - (a.latestActivity?.getTime() ?? 0)
    || a.order - b.order).slice(0, limit);
}

export async function loadTopicRoutes(): Promise<TopicAggregate[]> {
  const [radars, research] = await Promise.all([
    getCollection('radar', ({ data }) => data.publish),
    getCollection('research', ({ data }) => data.publish),
  ]);
  return aggregateTopics(radars, research);
}

export async function loadTopics(): Promise<TopicAggregate[]> {
  return (await loadTopicRoutes()).filter((topic) => topic.status === 'active' && topic.canonical);
}
