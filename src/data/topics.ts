import { getCollection, type CollectionEntry } from 'astro:content';
import { formatRadarDate } from './radar';

type RadarEntry = CollectionEntry<'radar'>;
type ResearchEntry = CollectionEntry<'research'>;
type TopicEntry = CollectionEntry<'topics'>;

const registry: Record<string, { displayName: string; description?: string }> = {
  'agent-systems': { displayName: 'Agent Systems', description: '智能体架构、工具调用、多智能体协作与自主执行系统。' },
  'local-ai': { displayName: 'Local AI', description: '本地模型、推理部署与个人 AI 基础设施。' },
  'ai-coding': { displayName: 'AI Coding', description: 'AI 编程工具、代码代理与软件开发工作流。' },
  'frontier-models': { displayName: 'Frontier Models' },
  'open-models': { displayName: 'Open Models' },
  inference: { displayName: 'Inference' },
  mcp: { displayName: 'MCP', description: '模型上下文协议及其工具连接生态。' },
  'ai-models': { displayName: 'AI Models' },
  'edge-computing': { displayName: 'Edge Computing' },
  python: { displayName: 'Python' },
  serverless: { displayName: 'Serverless' },
  security: { displayName: 'Security' },
  'developer-tools': { displayName: 'Developer Tools' },
  'mac-apps': { displayName: 'Mac Apps' },
  workflow: { displayName: 'Workflow' },
  'openai-models': { displayName: 'OpenAI Models' },
  'anthropic-models': { displayName: 'Anthropic Models' },
  'free-api': { displayName: 'Free API' },
  'ai-training-data': { displayName: 'AI Training Data' },
  'supply-chain': { displayName: 'Supply Chain' },
  infrastructure: { displayName: 'Infrastructure' },
};

const radarNames: Record<string, string> = {
  ai: 'AI', dev: 'Developer', security: 'Security', app: 'App', skill: 'Skill',
};

const dayMs = 24 * 60 * 60 * 1000;
const thresholds = {
  hotSignals7d: 5,
  activeSignals30d: 2,
  activeResearch30d: 1,
};

function humanize(slug: string): string {
  return slug.split('-').filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') || slug;
}

export function getTopicLabel(slug: string): string {
  return registry[slug]?.displayName ?? humanize(slug);
}

function getStatus(signals7d: number, signals30d: number, research30d: number, hasHistory: boolean) {
  if (signals7d >= thresholds.hotSignals7d) return { id: 'hot', label: '快速升温' };
  if (signals30d >= thresholds.activeSignals30d || research30d >= thresholds.activeResearch30d) {
    return { id: 'active', label: '持续活跃' };
  }
  if (hasHistory) return { id: 'stable', label: '稳定追踪' };
  return { id: 'quiet', label: '低频观察' };
}

export function aggregateTopics(
  radarEntries: RadarEntry[],
  researchEntries: ResearchEntry[],
  topicEntries: TopicEntry[],
) {
  const radars = radarEntries.filter(({ data }) => data.publish);
  const research = researchEntries.filter(({ data }) => data.publish);
  const metadata = new Map(topicEntries.map((entry) => [entry.id, entry.data]));
  const slugs = new Set<string>();

  for (const report of radars) {
    report.data.topics.forEach((slug) => slugs.add(slug));
    report.data.highlights.forEach((highlight) => highlight.topic && slugs.add(highlight.topic));
  }
  for (const entry of research) entry.data.topics.forEach((slug) => slugs.add(slug));
  for (const slug of metadata.keys()) slugs.add(slug);

  const maxDate = [...radars.map((entry) => entry.data.date), ...research.map((entry) => entry.data.updated)]
    .reduce<Date | undefined>((latest, date) => !latest || date > latest ? date : latest, undefined);
  const asOf = maxDate ?? new Date(0);
  const firstSeen = new Map<string, Date>();
  const lastActivity = new Map<string, Date>();
  const signalByTopic = new Map<string, Map<string, { title: string; radar: string; date: Date; topic: string }>>();
  const researchByTopic = new Map<string, Map<string, ResearchEntry>>();
  const coOccurrence = new Map<string, Map<string, number>>();

  const recordActivity = (slug: string, date: Date) => {
    const first = firstSeen.get(slug);
    const last = lastActivity.get(slug);
    if (!first || date < first) firstSeen.set(slug, date);
    if (!last || date > last) lastActivity.set(slug, date);
  };

  const recordCoOccurrence = (topics: string[], weight: number) => {
    const uniqueTopics = [...new Set(topics)];
    for (const slug of uniqueTopics) {
      for (const other of uniqueTopics) {
        if (slug === other) continue;
        const related = coOccurrence.get(slug) ?? new Map<string, number>();
        related.set(other, (related.get(other) ?? 0) + weight);
        coOccurrence.set(slug, related);
      }
    }
  };

  for (const report of radars) {
    const { radar, date, topics } = report.data;
    topics.forEach((slug) => recordActivity(slug, date));
    recordCoOccurrence([
      ...topics,
      ...report.data.highlights.flatMap((highlight) => highlight.topic ? [highlight.topic] : []),
    ], 1);

    for (const highlight of report.data.highlights) {
      if (!highlight.topic) continue;
      const key = `${radar}|${formatRadarDate(date)}|${highlight.title.trim().toLocaleLowerCase()}`;
      const signals = signalByTopic.get(highlight.topic) ?? new Map();
      signals.set(key, { title: highlight.title, radar, date, topic: highlight.topic });
      signalByTopic.set(highlight.topic, signals);
      recordActivity(highlight.topic, date);
    }
  }

  for (const entry of research) {
    const topics = [...new Set(entry.data.topics)];
    recordCoOccurrence(topics, 2);
    for (const slug of topics) {
      const entries = researchByTopic.get(slug) ?? new Map();
      entries.set(entry.data.slug, entry);
      researchByTopic.set(slug, entries);
      recordActivity(slug, entry.data.created);
      recordActivity(slug, entry.data.updated);
    }
  }

  const daysSince = (date: Date | undefined) => date ? (asOf.getTime() - date.getTime()) / dayMs : Infinity;
  const topics = [...slugs].map((slug) => {
    const signals = [...(signalByTopic.get(slug)?.values() ?? [])];
    const radarCounts = new Map<string, number>();
    signals.forEach(({ radar }) => radarCounts.set(radar, (radarCounts.get(radar) ?? 0) + 1));
    const articles = [...(researchByTopic.get(slug)?.values() ?? [])];
    const signals7d = signals.filter(({ date }) => daysSince(date) < 7).length;
    const signals30d = signals.filter(({ date }) => daysSince(date) < 30).length;
    const research30d = articles.filter(({ data }) => daysSince(data.updated) < 30).length;
    const totalSignals = signals.length;
    const totalResearch = articles.length;
    const activityScore = signals30d + research30d * 4 + totalResearch * 0.5;
    const status = getStatus(signals7d, signals30d, research30d, totalSignals > 0 || totalResearch > 0);
    const coverage = totalResearch > 1
      ? { id: 'established', label: '已形成积累' }
      : totalResearch === 1
        ? { id: 'researching', label: '研究中' }
        : { id: 'discovering', label: '发现阶段' };
    const meta = metadata.get(slug);
    const configured = registry[slug];
    const relatedTopics = [...(coOccurrence.get(slug) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || (lastActivity.get(b[0])?.getTime() ?? 0) - (lastActivity.get(a[0])?.getTime() ?? 0) || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([relatedSlug, count]) => ({ slug: relatedSlug, name: getTopicLabel(relatedSlug), coOccurrenceCount: count }));
    const distribution = [...radarCounts.entries()]
      .map(([radar, count]) => ({ radar, name: radarNames[radar] ?? humanize(radar), count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const totalRadarSignals = distribution.reduce((sum, item) => sum + item.count, 0);

    return {
      slug,
      name: meta?.title ?? configured?.displayName ?? humanize(slug),
      description: meta?.description ?? configured?.description,
      totalSignals,
      signals7d,
      signals30d,
      totalResearch,
      research30d,
      firstSeen: firstSeen.get(slug),
      lastActivity: lastActivity.get(slug),
      activityScore,
      status,
      coverage,
      signals,
      research: articles,
      timeline: [
        ...signals.map((signal) => ({ ...signal, kind: 'signal' as const })),
        ...articles.map((entry) => ({ kind: 'research' as const, title: entry.data.title, date: entry.data.updated, slug: entry.data.slug })),
      ].sort((a, b) => b.date.getTime() - a.date.getTime() || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title)),
      relatedTopics,
      radarDistribution: distribution.map((item) => ({ ...item, percent: totalRadarSignals ? item.count / totalRadarSignals * 100 : 0 })),
      lastActivityLabel: lastActivity.has(slug) ? lastActivity.get(slug)!.toISOString().slice(0, 10).replaceAll('-', '.') : undefined,
      firstSeenLabel: firstSeen.has(slug) ? firstSeen.get(slug)!.toISOString().slice(0, 10).replaceAll('-', '.') : undefined,
    };
  }).sort((a, b) => b.activityScore - a.activityScore
    || (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0)
    || a.slug.localeCompare(b.slug));

  return { topics, asOf };
}

export async function loadTopicRegistry() {
  const [radars, research, topicEntries] = await Promise.all([
    getCollection('radar', ({ data }) => data.publish),
    getCollection('research', ({ data }) => data.publish),
    getCollection('topics'),
  ]);
  return aggregateTopics(radars, research, topicEntries);
}

export function topicStatusLabel(id: string): string {
  return ({ hot: '快速升温', active: '持续活跃', stable: '稳定追踪', quiet: '低频观察' } as Record<string, string>)[id] ?? '低频观察';
}
