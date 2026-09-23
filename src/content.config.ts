import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const date = z.coerce.date();
const confidence = z.enum(['high', 'medium', 'low']);

const radar = defineCollection({
  loader: glob({ base: './src/content/radar', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    type: z.literal('radar'),
    date,
    updated: date,
    radar: z.enum(['ai', 'dev', 'app', 'security', 'skill']),
    signals: z.number().int().nonnegative(),
    highSignals: z.number().int().nonnegative(),
    actionRequired: z.number().int().nonnegative(),
    topics: z.array(z.string().min(1)).min(1),
    confidence,
    publish: z.boolean(),
  }).strict().refine(
    ({ signals, highSignals, actionRequired }) => highSignals <= signals && actionRequired <= signals,
    'Signal counts cannot exceed the total number of signals.',
  ),
});

const research = defineCollection({
  loader: glob({ base: './src/content/research', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string().min(1),
    subtitle: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use a lowercase, hyphenated URL slug.'),
    type: z.literal('research'),
    category: z.array(z.string().min(1)).min(1),
    topics: z.array(z.string().min(1)).min(1),
    tags: z.array(z.string().min(1)).min(1),
    source: z.string().min(1),
    created: date,
    updated: date,
    status: z.enum(['evolving', 'stable', 'archived']),
    confidence,
    featured: z.boolean(),
    publish: z.boolean(),
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
