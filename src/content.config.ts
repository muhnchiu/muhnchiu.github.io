import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
const date = z.coerce.date();
const confidence = z.enum(['high', 'medium', 'low']);
const signalLevel = z.enum(['critical', 'high', 'medium', 'low']);
const signalAction = z.enum(['action', 'test', 'watch', 'read', 'explore', 'ignore']);

const radarV1 = z.object({
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    date,
    updated: date.optional(),
    radar: z.enum(['ai', 'dev', 'app', 'security', 'skill']),
    signalCount: z.number().int().nonnegative(),
    highSignalCount: z.number().int().nonnegative(),
    actionableCount: z.number().int().nonnegative(),
    actionRequired: z.number().int().nonnegative(),
    verdict: z.string().min(1),
    highlights: z.array(z.object({
      title: z.string().min(1),
      type: z.string().min(1),
      signal: signalLevel,
      action: signalAction,
      topic: z.string().min(1).optional(),
      sourceLevel: z.enum(['official', 'ecosystem', 'community', 'media', 'research']),
      sourceName: z.string().min(1).optional(),
      sourceUrl: z.string().url().optional(),
    }).strict()).max(5),
    topics: z.array(z.string().min(1)),
    tags: z.array(z.string().min(1)).optional(),
    events: z.array(z.string().min(1)).optional(),
    topicCandidate: z.object({ slug: z.string().min(1), reason: z.string().min(1) }).optional(),
    confidence,
    publish: z.boolean(),
  }).strict();

const radar = defineCollection({
  loader: glob({ base: './src/content/radar', pattern: '**/*.md' }),
  // This path contains the historical V1 Markdown corpus. Contract 2.0/2.1
  // inputs must explicitly select normalizeRadarForContract by package context.
  schema: radarV1,
});

const research = defineCollection({
  loader: glob({ base: './src/content/research', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string().min(1),
    subtitle: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use a lowercase, hyphenated URL slug.'),
    type: z.literal('research'),
    category: z.array(z.string().min(1)).min(1),
    topics: z.array(z.string().min(1)),
    tags: z.array(z.string().min(1)),
    events: z.array(z.string().min(1)).optional(),
    topicCandidate: z.object({ slug: z.string().min(1), reason: z.string().min(1) }).optional(),
    source: z.string().min(1),
    created: date,
    updated: date,
    status: z.enum(['evolving', 'stable', 'archived']),
    confidence,
    featured: z.boolean(),
    publish: z.boolean(),
    radar: z.array(z.enum(['ai', 'dev', 'app', 'security', 'skill'])).optional(),
    related: z.array(z.string().min(1)).optional(),
  }).strict(),
});

const topics = defineCollection({
  loader: glob({ base: './src/content/topics', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    type: z.literal('topic'),
    status: z.enum(['emerging', 'evolving', 'stable', 'archived']),
    firstTracked: date,
    lastUpdated: date,
    related: z.array(z.string().min(1)),
  }).strict(),
});

const stack = defineCollection({
  loader: glob({ base: './src/content/stack', pattern: '**/*.md' }),
  schema: z.object({
    name: z.string().min(1),
    category: z.string().min(1),
    type: z.literal('stack'),
    status: z.enum(['using', 'testing', 'watching', 'retired']),
    description: z.string().min(1),
    url: z.string().url().optional(),
  }).strict(),
});

export const collections = { radar, research, topics, stack };
