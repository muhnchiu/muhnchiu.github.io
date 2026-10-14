import { getCollection } from 'astro:content';
export async function loadResearchIndex() {
 return (await getCollection('research', ({data}) => data.publish)).sort((a,b) => Number(Boolean(b.data.featured)) - Number(Boolean(a.data.featured)) || b.data.updated.getTime() - a.data.updated.getTime() || b.data.created.getTime() - a.data.created.getTime());
}
