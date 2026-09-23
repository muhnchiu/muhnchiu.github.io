import { getCollection } from 'astro:content';
import { displayRadarDate, formatRadarDate, radarCatalog, signalPriority } from './radar';

const actionPriority = { action: 0, test: 1, explore: 2, watch: 3, read: 4, ignore: 5 } as const;

const topicLabel = (slug: string, titles: Map<string, string>) => titles.get(slug)
  ?? slug.split('-').map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join(' ');

export async function loadHomeData() {
  const [radarEntries, researchEntries, topicEntries] = await Promise.all([
    getCollection('radar', ({ data }) => data.publish),
    getCollection('research', ({ data }) => data.publish),
    getCollection('topics'),
  ]);
  const radars = radarEntries.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
  const latestRadarDate = radars.at(0)?.data.date;
  const latestRadarKey = latestRadarDate && formatRadarDate(latestRadarDate);
  const latestRadarReports = latestRadarKey
    ? radars.filter((entry) => formatRadarDate(entry.data.date) === latestRadarKey)
    : [];
  const radarCards = radarCatalog.map((radar, index) => {
    const report = latestRadarReports.find((entry) => entry.data.radar === radar.id);
    return {
      ...radar,
      accent: ['blue', 'green', 'red', 'purple', 'orange'][index],
      signalCount: report?.data.signalCount,
      highSignalCount: report?.data.highSignalCount,
      actionRequired: report?.data.actionRequired,
    };
  });

  const seenHighlights = new Set<string>();
  const briefs = latestRadarReports.flatMap((report) => report.data.highlights.map((highlight) => ({
    ...highlight,
    radar: report.data.radar,
    date: report.data.date,
  }))).sort((a, b) => signalPriority[a.signal] - signalPriority[b.signal]
    || actionPriority[a.action] - actionPriority[b.action]
    || b.date.getTime() - a.date.getTime())
    .filter((highlight) => {
      const key = highlight.title.trim().toLocaleLowerCase();
      if (seenHighlights.has(key)) return false;
      seenHighlights.add(key);
      return true;
    }).slice(0, 5).map((highlight) => ({
      ...highlight,
      radarName: radarCatalog.find((radar) => radar.id === highlight.radar)?.name ?? highlight.radar,
      dateLabel: displayRadarDate(highlight.date),
      href: `/radar/${highlight.radar}/${formatRadarDate(highlight.date)}`,
    }));

  const research = researchEntries.sort((a, b) => Number(b.data.featured) - Number(a.data.featured)
    || b.data.updated.getTime() - a.data.updated.getTime()
    || b.data.created.getTime() - a.data.created.getTime());
  const featuredResearch = research.at(0);
  const recentResearch = research.slice(1, 6);

  const topicTitles = new Map(topicEntries.map((entry) => [entry.id, entry.data.title]));
  const topicStats = new Map<string, { research: number; signals: number; updated: Date }>();
  const updateTopic = (slug: string, kind: 'research' | 'signals', amount: number, updated: Date) => {
    const current = topicStats.get(slug) ?? { research: 0, signals: 0, updated };
    current[kind] += amount;
    if (updated.getTime() > current.updated.getTime()) current.updated = updated;
    topicStats.set(slug, current);
  };
  research.forEach((entry) => entry.data.topics.forEach((slug) => updateTopic(slug, 'research', 1, entry.data.updated)));
  radars.forEach((entry) => entry.data.topics.forEach((slug) => updateTopic(slug, 'signals', entry.data.signalCount, entry.data.date)));
  const topics = [...topicStats.entries()].map(([slug, stats]) => ({
    slug,
    name: topicLabel(slug, topicTitles),
    ...stats,
    updatedLabel: displayRadarDate(stats.updated),
  })).sort((a, b) => b.research - a.research || b.signals - a.signals || b.updated.getTime() - a.updated.getTime()).slice(0, 6);

  return {
    hero: { activeRadarCount: latestRadarReports.length, latestRadarDate: latestRadarDate ? displayRadarDate(latestRadarDate) : undefined },
    radarCards,
    briefs,
    featuredResearch,
    recentResearch,
    topics,
    latestRadarDate: latestRadarDate ? displayRadarDate(latestRadarDate) : undefined,
  };
}
