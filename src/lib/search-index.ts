import { getCollection } from 'astro:content';
import OpenCC from 'opencc-js';
import stack from '../data/stack.json';
import { radarCatalog } from '../data/radar';
import { aggregateTopics, getCanonicalTopicSlugs, getTopicName, topicRegistry, topicSlugsForRadar } from '../data/topics';

export type SearchType = 'radar' | 'research' | 'topic' | 'stack';
export type LocalizedText = { hans: string; hant: string };

export interface SearchDocument {
  id: string;
  type: SearchType;
  url: string;
  title: LocalizedText;
  description: LocalizedText;
  date?: string;
  topics: Array<{ slug: string; name: LocalizedText }>;
  tags: LocalizedText[];
  category?: LocalizedText;
  keywords: LocalizedText[];
  headings: LocalizedText[];
  excerpt?: LocalizedText;
  aliases: LocalizedText[];
  core?: boolean;
  radarType?: LocalizedText;
  radarCount?: number;
  researchCount?: number;
  toolType?: 'app' | 'cli' | 'service';
  management?: string[];
}

const toTraditional = OpenCC.Converter({ from: 'cn', to: 't' });
const localize = (value: string): LocalizedText => ({ hans: value, hant: toTraditional(value) });
const localizeAll = (values: string[]): LocalizedText[] => [...new Set(values)].map(localize);
const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const topicRefs = (slugs: string[]) => getCanonicalTopicSlugs(slugs).map((slug) => ({ slug, name: localize(getTopicName(slug)) }));

const stackCategories: Record<string, string> = {
  AI: 'AI', Coding: '开发', Terminal: '终端', Knowledge: '知识', Automation: '自动化',
  Infrastructure: '基础设施', Productivity: '生产力', Creative: '创意',
  Communication: '通信', Browser: '浏览器', Network: '网络', Utility: '工具',
  DevOps: '运维', Runtime: '运行时', Media: '影音', Other: '其他',
};

function plainText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function researchHeadings(body: string): string[] {
  return [...body.matchAll(/^#{2,3}\s+(.+)$/gm)]
    .map((match) => plainText(match[1]).slice(0, 120))
    .filter(Boolean)
    .slice(0, 16);
}

function researchExcerpt(body: string): string {
  const tldr = body.match(/^##\s+TL;DR\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1] ?? '';
  const firstPoint = tldr.split('\n').map((line) => line.trim()).find((line) => line.startsWith('- '));
  return plainText(firstPoint?.slice(2) ?? '').slice(0, 240);
}

export async function buildSearchIndex(): Promise<SearchDocument[]> {
  const [radars, research] = await Promise.all([
    getCollection('radar', ({ data }) => data.publish),
    getCollection('research', ({ data }) => data.publish),
  ]);
  const topicCounts = new Map(aggregateTopics(radars, research).filter((topic) => topic.canonical).map((topic) => [topic.slug, topic]));

  const radarDocuments: SearchDocument[] = radars.map((entry) => {
    const data = entry.data;
    const date = isoDate(data.date);
    const radarType = radarCatalog.find(({ id }) => id === data.radar)?.name ?? data.radar;
    return {
      id: `radar:${data.radar}:${date}`,
      type: 'radar',
      url: `/radar/${data.radar}/${date}/`,
      title: localize(data.title),
      description: localize(data.verdict),
      date,
      topics: topicRefs(topicSlugsForRadar(entry)),
      tags: localizeAll(data.tags ?? []),
      category: localize(radarType),
      keywords: localizeAll([data.radar, radarType, date]),
      headings: localizeAll(data.highlights.map((highlight) => highlight.title)),
      aliases: [],
      radarType: localize(radarType),
    };
  });

  const researchDocuments: SearchDocument[] = research.map((entry) => {
    const data = entry.data;
    const excerpt = researchExcerpt(entry.body);
    return {
      id: `research:${data.slug}`,
      type: 'research',
      url: `/research/${data.slug}/`,
      title: localize(data.title),
      description: localize(data.subtitle),
      date: isoDate(data.updated),
      topics: topicRefs(data.topics),
      tags: localizeAll(data.tags),
      category: localize(data.category.join(' · ')),
      keywords: localizeAll([data.slug, ...data.category]),
      headings: localizeAll(researchHeadings(entry.body)),
      ...(excerpt ? { excerpt: localize(excerpt) } : {}),
      aliases: [],
    };
  });

  const topicDocuments: SearchDocument[] = topicRegistry.map((topic) => {
    const counts = topicCounts.get(topic.slug);
    const aliases = 'aliases' in topic && Array.isArray(topic.aliases) ? topic.aliases as string[] : [];
    return {
      id: `topic:${topic.slug}`,
      type: 'topic',
      url: `/topics/${topic.slug}/`,
      title: localize(topic.name),
      description: localize(topic.description),
      topics: [],
      tags: [],
      category: localize(topic.group),
      keywords: localizeAll([topic.slug, topic.slug.replaceAll('-', ' ')]),
      headings: [],
      aliases: localizeAll(aliases),
      radarCount: counts?.radarCount ?? 0,
      researchCount: counts?.researchCount ?? 0,
    };
  });

  const stackDocuments: SearchDocument[] = [...stack.core.map((item) => ({ ...item, core: true })),
    ...stack.environment.map((item) => ({ ...item, core: false }))].map((item) => {
    const management = [item.installManagement === 'homebrew' ? 'Homebrew' : '',
      item.configManagement === 'chezmoi' ? 'chezmoi' : ''].filter(Boolean);
    const category = stackCategories[item.category] ?? item.category;
    const typeLabel = item.type === 'app' ? '桌面应用' : item.type === 'cli' ? '命令行工具' : '服务';
    return {
      id: `stack:${item.core ? 'core' : 'environment'}:${item.name.toLowerCase()}`,
      type: 'stack',
      url: '/stack/',
      title: localize(item.name),
      description: localize(`${category} · ${typeLabel}${management.length ? ` · ${management.join(' / ')}` : ''}`),
      topics: [],
      tags: [],
      category: localize(category),
      keywords: localizeAll([item.category, item.type, typeLabel, ...management]),
      headings: [],
      aliases: [],
      core: item.core,
      toolType: item.type as 'app' | 'cli' | 'service',
      management,
    };
  });

  return [...radarDocuments, ...researchDocuments, ...topicDocuments, ...stackDocuments];
}
