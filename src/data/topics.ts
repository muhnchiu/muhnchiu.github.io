import { getCollection, type CollectionEntry } from 'astro:content';
import { formatRadarDate, signalPriority } from './radar';

type RadarEntry = CollectionEntry<'radar'>;
type ResearchEntry = CollectionEntry<'research'>;
type TopicEntry = CollectionEntry<'topics'>;

export interface RelatedRadarSignal {
  title: string;
  radar: RadarEntry['data']['radar'];
  radarLabel: string;
  date: Date;
  signal: RadarEntry['data']['highlights'][number]['signal'];
  action: RadarEntry['data']['highlights'][number]['action'];
  topic: string;
  href: string;
}

export interface TopicAggregate {
  slug: string;
  label: string;
  description?: string;
  researchCount: number;
  radarSignalCount: number;
  latestActivity?: Date;
  relatedResearch: ResearchEntry[];
  relatedRadarSignals: RelatedRadarSignal[];
  relatedTopics: Array<{ slug: string; label: string; coOccurrenceCount: number }>;
}

const topicLabels: Record<string, string> = {
  'local-ai': '本地 AI',
  'open-models': '开放模型',
  'frontier-models': '前沿模型',
  inference: '推理优化',
  'ai-coding': 'AI 编程',
  'agent-systems': 'Agent 系统',
  'agent-skills': 'Agent Skills',
  mcp: 'MCP',
  'developer-tools': '开发者工具',
  security: '安全',
  'ai-models': 'AI 模型',
  'edge-ai': '边缘 AI',
  'ai-training-data': 'AI 训练数据',
  'free-api': '免费 API',
  'openai-models': 'OpenAI 模型',
  'anthropic-models': 'Anthropic 模型',
  azure: 'Azure',
  'code-review': '代码审查',
  cicd: 'CI/CD',
};

const radarLabels: Record<RadarEntry['data']['radar'], string> = {
  ai: 'AI Radar',
  dev: 'Developer Radar',
  security: 'Security Radar',
  app: 'App Radar',
  skill: 'Skill Radar',
};

function humanize(slug: string): string {
  return slug.split('-').filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') || slug;
}

export function getTopicLabel(slug: string): string {
  return topicLabels[slug] ?? humanize(slug);
}

export function aggregateTopics(
  radarEntries: RadarEntry[],
  researchEntries: ResearchEntry[],
  topicEntries: TopicEntry[],
): TopicAggregate[] {
  const radars = radarEntries.filter(({ data }) => data.publish);
  const research = researchEntries.filter(({ data }) => data.publish);
  const descriptions = new Map(topicEntries.map((entry) => [entry.id, entry.data.description]));
  const signalsByTopic = new Map<string, Map<string, RelatedRadarSignal>>();
  const researchByTopic = new Map<string, Map<string, ResearchEntry>>();
  const latestActivityByTopic = new Map<string, Date>();
  const coOccurrences = new Map<string, Map<string, number>>();

  const recordActivity = (slug: string, date: Date) => {
    const latest = latestActivityByTopic.get(slug);
    if (!latest || date > latest) latestActivityByTopic.set(slug, date);
  };

  const recordCoOccurrences = (slugs: string[]) => {
    const unique = [...new Set(slugs)];
    for (const slug of unique) {
      const related = coOccurrences.get(slug) ?? new Map<string, number>();
      for (const other of unique) {
        if (other !== slug) related.set(other, (related.get(other) ?? 0) + 1);
      }
      coOccurrences.set(slug, related);
    }
  };

  for (const entry of radars) {
    const { radar, date } = entry.data;
    const reportTopics = new Set<string>();
    for (const highlight of entry.data.highlights) {
      if (!highlight.topic) continue;
      const slug = highlight.topic;
      reportTopics.add(slug);
      const key = `${radar}|${formatRadarDate(date)}|${highlight.title.trim().toLocaleLowerCase()}`;
      const signals = signalsByTopic.get(slug) ?? new Map<string, RelatedRadarSignal>();
      signals.set(key, {
        title: highlight.title,
        radar,
        radarLabel: radarLabels[radar],
        date,
        signal: highlight.signal,
        action: highlight.action,
        topic: slug,
        href: `/radar/${radar}/${formatRadarDate(date)}`,
      });
      signalsByTopic.set(slug, signals);
      recordActivity(slug, date);
    }
    recordCoOccurrences([...reportTopics]);
  }

  for (const entry of research) {
    const uniqueTopics = [...new Set(entry.data.topics)];
    recordCoOccurrences(uniqueTopics);
    for (const slug of uniqueTopics) {
      const entries = researchByTopic.get(slug) ?? new Map<string, ResearchEntry>();
      entries.set(entry.data.slug, entry);
      researchByTopic.set(slug, entries);
      recordActivity(slug, entry.data.updated);
    }
  }

  const slugs = new Set([...signalsByTopic.keys(), ...researchByTopic.keys()]);
  return [...slugs].map((slug): TopicAggregate => {
    const relatedRadarSignals = [...(signalsByTopic.get(slug)?.values() ?? [])]
      .sort((a, b) => b.date.getTime() - a.date.getTime()
        || signalPriority[a.signal] - signalPriority[b.signal]
        || a.title.localeCompare(b.title));
    const relatedResearch = [...(researchByTopic.get(slug)?.values() ?? [])]
      .sort((a, b) => b.data.updated.getTime() - a.data.updated.getTime()
        || b.data.created.getTime() - a.data.created.getTime());
    const relatedTopics = [...(coOccurrences.get(slug) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([relatedSlug, coOccurrenceCount]) => ({
        slug: relatedSlug,
        label: getTopicLabel(relatedSlug),
        coOccurrenceCount,
      }));

    return {
      slug,
      label: getTopicLabel(slug),
      description: descriptions.get(slug),
      researchCount: relatedResearch.length,
      radarSignalCount: relatedRadarSignals.length,
      latestActivity: latestActivityByTopic.get(slug),
      relatedResearch,
      relatedRadarSignals,
      relatedTopics,
    };
  }).sort((a, b) => (b.latestActivity?.getTime() ?? 0) - (a.latestActivity?.getTime() ?? 0)
    || (b.researchCount + b.radarSignalCount) - (a.researchCount + a.radarSignalCount)
    || a.slug.localeCompare(b.slug));
}

export async function loadTopicRegistry() {
  const [radars, research, topicEntries] = await Promise.all([
    getCollection('radar', ({ data }) => data.publish),
    getCollection('research', ({ data }) => data.publish),
    getCollection('topics'),
  ]);
  return aggregateTopics(radars, research, topicEntries);
}
