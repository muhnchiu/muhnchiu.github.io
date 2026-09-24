import type { APIRoute } from 'astro';
import { buildSearchIndex } from '../lib/search-index';

export const prerender = true;

export const GET: APIRoute = async () => {
  const documents = await buildSearchIndex();
  const body = JSON.stringify(documents);
  const counts = documents.reduce<Record<string, number>>((result, document) => {
    result[document.type] = (result[document.type] ?? 0) + 1;
    return result;
  }, {});
  console.log(`Search index: Radar ${counts.radar ?? 0}, Research ${counts.research ?? 0}, Topics ${counts.topic ?? 0}, Stack ${counts.stack ?? 0}; ${documents.length} documents, ${Buffer.byteLength(body)} bytes.`);
  return new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
};
