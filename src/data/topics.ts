import { getCollection, type CollectionEntry } from 'astro:content';
import { formatRadarDate } from './radar';

type RadarEntry = CollectionEntry<'radar'>;
type ResearchEntry = CollectionEntry<'research'>;

interface TopicDefinition {
  name: string;
  description: string;
  category: string;
  weight?: number;
}

// Presentation metadata only. Relationships always come from published content.
export const topicRegistry: Record<string, TopicDefinition> = {
  'frontier-models': { name: '前沿模型', description: '追踪前沿模型的能力、定价与竞争格局。', category: 'AI', weight: 3 },
  'open-models': { name: '开放模型', description: '观察开放权重模型的能力、生态与应用边界。', category: 'AI', weight: 2 },
  'local-ai': { name: '本地 AI', description: '研究模型在本地设备上的运行、成本与实际可用性。', category: 'AI' },
  'ai-coding': { name: 'AI 编程', description: '追踪 AI 辅助开发工具与软件工程工作流。', category: '开发' },
  'agent-systems': { name: '智能体系统', description: '观察智能体的工具、协议与可组合能力。', category: 'AI' },
  inference: { name: '推理与基础设施', description: '研究模型推理效率、部署方式与基础设施。', category: 'AI' },
  'free-api': { name: '免费 API', description: '追踪开放和低成本 API 的可用性与边界。', category: '开发' },
  security: { name: '安全', description: '跟踪漏洞、风险与安全防护实践。', category: '安全' },
  'developer-tools': { name: '开发工具', description: '观察开发者工具与工程效率的变化。', category: '开发' },
  software: { name: '软件生态', description: '关注值得长期观察的软件产品与生态变化。', category: '软件' },
  'agent-skills': { name: 'Agent Skills', description: '追踪可复用的智能体技能与工具链。', category: '开发' },
  mcp: { name: 'MCP', description: '关注模型上下文协议及其工具生态。', category: '开发' },
  'ai-models': { name: 'AI 模型', description: '汇集模型发布、能力评估与应用信号。', category: 'AI' },
  'edge-ai': { name: '边缘 AI', description: '观察边缘设备上的模型部署与应用。', category: 'AI' },
  'ai-training-data': { name: 'AI 训练数据', description: '追踪训练数据、数据工具与相关市场变化。', category: 'AI' },
  'openai-models': { name: 'OpenAI 模型', description: '记录 OpenAI 模型与 API 的变化。', category: 'AI' },
  'anthropic-models': { name: 'Anthropic 模型', description: '记录 Anthropic 模型与 API 的变化。', category: 'AI' },
  azure: { name: 'Azure', description: '关注 Azure 平台与开发者服务。', category: '云服务' },
  'code-review': { name: '代码审查', description: '追踪代码审查方法、工具与自动化。', category: '开发' },
  cicd: { name: 'CI/CD', description: '关注持续集成与交付的工具和实践。', category: '开发' },
};

const radarLabels: Record<RadarEntry['data']['radar'], string> = {
  ai: 'AI Radar', dev: 'Developer Radar', security: 'Security Radar', app: 'App Radar', skill: 'Skill Radar',
};

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

export interface TopicPreview {
  title: string;
  date: Date;
  href: string;
  type: 'research' | 'radar';
}

export interface TopicAggregate {
  slug: string;
  name: string;
  description: string;
  category?: string;
  registered: boolean;
  sortWeight: number;
  radarCount: number;
  radarSignalCount: number;
  researchCount: number;
  latestActivity: Date;
  relatedResearch: ResearchEntry[];
  relatedRadarReports: RelatedRadarReport[];
  recentContent: TopicPreview[];
  relatedTopics: Array<{ slug: string; name: string; coOccurrenceCount: number }>;
}

export function getTopicName(slug: string): string {
  return getTopicDefinition(slug)?.name ?? slug;
}

export const getTopicLabel = getTopicName;

function getTopicDefinition(slug: string): TopicDefinition | undefined {
  return Object.hasOwn(topicRegistry, slug) ? topicRegistry[slug] : undefined;
}

export function topicSlugsForRadar(entry: RadarEntry): string[] {
  return [...new Set([
    ...entry.data.topics,
    ...entry.data.highlights.map((highlight) => highlight.topic).filter((topic): topic is string => Boolean(topic)),
  ])];
}

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
    for (const slug of slugs) {
      const related = coOccurrences.get(slug) ?? new Map<string, number>();
      for (const other of slugs) {
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
        href: `/radar/${radar}/${formatRadarDate(date)}`,
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

  const slugs = new Set([...radarByTopic.keys(), ...researchByTopic.keys()]);
  return [...slugs].map((slug): TopicAggregate => {
    const relatedRadarReports = [...(radarByTopic.get(slug)?.values() ?? [])]
      .sort((a, b) => b.date.getTime() - a.date.getTime() || a.radar.localeCompare(b.radar));
    const relatedResearch = [...(researchByTopic.get(slug)?.values() ?? [])]
      .sort((a, b) => b.data.updated.getTime() - a.data.updated.getTime()
        || b.data.created.getTime() - a.data.created.getTime());
    const recentContent: TopicPreview[] = [
      ...relatedResearch.map((entry) => ({ title: entry.data.title, date: entry.data.updated, href: `/research/${entry.data.slug}`, type: 'research' as const })),
      ...relatedRadarReports.map((report) => ({ title: report.title, date: report.date, href: report.href, type: 'radar' as const })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime() || (a.type === 'research' ? -1 : 1)).slice(0, 3);
    const relatedTopics = [...(coOccurrences.get(slug) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([relatedSlug, coOccurrenceCount]) => ({ slug: relatedSlug, name: getTopicName(relatedSlug), coOccurrenceCount }));
    const definition = getTopicDefinition(slug);
    return {
      slug,
      name: definition?.name ?? slug,
      description: definition?.description ?? '暂无主题说明',
      category: definition?.category,
      registered: Boolean(definition),
      sortWeight: definition?.weight ?? 0,
      radarCount: relatedRadarReports.length,
      radarSignalCount: relatedRadarReports.reduce((count, report) => count + report.matchedHighlights.length, 0),
      researchCount: relatedResearch.length,
      latestActivity: latestActivityByTopic.get(slug)!,
      relatedResearch,
      relatedRadarReports,
      recentContent,
      relatedTopics,
    };
  }).sort((a, b) => b.latestActivity.getTime() - a.latestActivity.getTime()
    || b.researchCount - a.researchCount
    || b.radarCount - a.radarCount
    || b.sortWeight - a.sortWeight
    || a.slug.localeCompare(b.slug));
}

export function mostActiveTopics(topics: TopicAggregate[], limit = 6): TopicAggregate[] {
  const newest = Math.max(0, ...topics.map((topic) => topic.latestActivity.getTime()));
  const score = (topic: TopicAggregate) => {
    const daysOld = Math.max(0, Math.floor((newest - topic.latestActivity.getTime()) / 86_400_000));
    return Math.max(0, 30 - daysOld) * 2
      + topic.radarSignalCount * 3 + topic.radarCount + topic.researchCount * 5 + topic.sortWeight;
  };
  return [...topics].sort((a, b) => score(b) - score(a)
    || b.latestActivity.getTime() - a.latestActivity.getTime()
    || a.slug.localeCompare(b.slug)).slice(0, limit);
}

export async function loadTopics(): Promise<TopicAggregate[]> {
  const [radars, research] = await Promise.all([
    getCollection('radar', ({ data }) => data.publish),
    getCollection('research', ({ data }) => data.publish),
  ]);
  return aggregateTopics(radars, research);
}
