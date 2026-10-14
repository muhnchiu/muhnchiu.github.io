export const REPORTS_PER_PAGE = 12;
export function paginateReports(reports, page = 1) {
  const totalPages = Math.max(1, Math.ceil(reports.length / REPORTS_PER_PAGE));
  if (!Number.isInteger(page) || page < 1 || page > totalPages) throw new RangeError('Invalid report page');
  return { entries: reports.slice((page - 1) * REPORTS_PER_PAGE, page * REPORTS_PER_PAGE), page, totalPages, total: reports.length };
}
export function reportPageHref(radar, page) {
  return page === 1 ? `/radar/${radar}/#report-archive` : `/radar/${radar}/archive/${page}/#report-archive`;
}
