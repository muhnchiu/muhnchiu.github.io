export const RESEARCH_PER_PAGE = 12;
export const categorySlug = category => [...category.toLowerCase()].map(char => /^[a-z0-9]$/.test(char) ? char : `-${char.codePointAt(0).toString(16)}`).join('');
export function researchPageHref(category, page = 1) {
  const base = category ? `/research/category/${categorySlug(category)}/` : '/research/';
  return page === 1 ? base : `${base}page/${page}/`;
}
export function researchPage(all, category = '', page = 1) {
  const featured = category ? [] : all.filter(entry => entry.data.featured).slice(0, 3);
  const featuredSlugs = new Set(featured.map(entry => entry.data.slug));
  const matching = category ? all.filter(entry => entry.data.category.includes(category)) : all.filter(entry => !featuredSlugs.has(entry.data.slug));
  const totalPages = Math.max(1, Math.ceil(matching.length / RESEARCH_PER_PAGE));
  if (!Number.isInteger(page) || page < 1 || page > totalPages) throw new RangeError('Invalid research page');
  return { featured: page === 1 ? featured : [], entries: matching.slice((page - 1) * RESEARCH_PER_PAGE, page * RESEARCH_PER_PAGE), total: matching.length, totalPages };
}
