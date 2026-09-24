import { getCollection, type CollectionEntry } from 'astro:content';
import { formatRadarDate } from './radar';

type RadarEntry = CollectionEntry<'radar'>;
type ResearchEntry = CollectionEntry<'research'>;

export type TopicGroup = 'models' | 'systems' | 'tools' | 'security';
export type TopicStatus = 'active' | 'watch' | 'archived';

export interface TopicDefinition {
  slug: string;
  name: string;
  description: string;
  group: TopicGroup;
  status: TopicStatus;
  order: number;
}

export const topicGroups: Array<{ id: TopicGroup; name: string; eyebrow: string }> = [
  { id: 'models', name: '模型与智能', eyebrow: 'AI / MODELS' },
  { id: 'systems', name: '智能系统', eyebrow: 'AI / SYSTEMS' },
  { id: 'tools', name: '工具与工程', eyebrow: 'DEVELOPMENT' },
  { id: 'security', name: '安全与前沿', eyebrow: 'SECURITY / RESEARCH' },
];

// Canonical Topic Governance V2. Content relations are derived from published Markdown.
export const topicRegistry: TopicDefinition[] = [
  { slug: 'frontier-models', name: '前沿模型', description: '追踪前沿模型的能力演进、发布节奏与竞争格局。', group: 'models', status: 'active', order: 1 },
  { slug: 'open-models', name: '开放模型', description: '观察开放权重模型的能力、生态与应用边界。', group: 'models', status: 'active', order: 2 },
  { slug: 'local-ai', name: '本地智能', description: '研究模型在个人设备与本地环境中的运行和应用。', group: 'models', status: 'active', order: 3 },
  { slug: 'multimodal', name: '多模态', description: '观察文字、图像、语音与视频能力的融合。', group: 'models', status: 'active', order: 4 },
  { slug: 'agent-systems', name: '智能体系统', description: '研究智能体的工具使用、协作方式与系统架构。', group: 'systems', status: 'active', order: 5 },
  { slug: 'ai-coding', name: '智能编程', description: '追踪 AI 辅助编程与软件开发工作流的变化。', group: 'systems', status: 'active', order: 6 },
  { slug: 'inference', name: '推理与基础设施', description: '研究模型推理效率、部署方式与基础设施。', group: 'systems', status: 'active', order: 7 },
  { slug: 'rag-knowledge', name: '知识与检索', description: '观察知识组织、检索增强与可信回答系统。', group: 'systems', status: 'active', order: 8 },
  { slug: 'model-economics', name: '模型经济', description: '追踪模型定价、成本结构与商业化路径。', group: 'systems', status: 'active', order: 9 },
  { slug: 'developer-tools', name: '开发者工具', description: '观察开发工具、平台与工程工作方式的演进。', group: 'tools', status: 'active', order: 10 },
  { slug: 'engineering-productivity', name: '工程效率', description: '研究工程实践、自动化与团队交付效率。', group: 'tools', status: 'active', order: 11 },
  { slug: 'software-productivity', name: '数字生产力', description: '关注数字工具如何改变个人与团队的工作方式。', group: 'tools', status: 'active', order: 12 },
  { slug: 'ai-security', name: '智能安全', description: '追踪 AI 系统的安全边界、风险与防护实践。', group: 'security', status: 'active', order: 13 },
  { slug: 'software-supply-chain', name: '软件供应链', description: '观察软件依赖、构建与交付链路中的安全风险。', group: 'security', status: 'active', order: 14 },
  { slug: 'frontier-research', name: '前沿研究', description: '记录可能改变未来技术方向的早期研究信号。', group: 'security', status: 'active', order: 15 },
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
