/**
 * The page numbers a pagination control should show: always the first and
 * last, plus a window around the current page, with any gap collapsed to an
 * ellipsis.
 *
 * Plain JavaScript rather than part of Pagination.jsx so it can be imported by
 * a test runner -- Node cannot load a .jsx file, and this is the only part of
 * the control with logic worth checking.
 *
 * `span` is how many neighbours to keep either side of the current page.
 *
 *   pageList(5, 9, 1) -> [1, 'gap', 4, 5, 6, 'gap', 9]
 *   pageList(2, 4, 1) -> [1, 2, 3, 4]        no gap: it would hide one page
 *
 * @param {number} page   current page, 1-based
 * @param {number} pages  total pages
 * @param {number} span   neighbours either side
 * @returns {Array<number|'gap'>}
 */
export function pageList(page, pages, span = 1) {
  const keep = new Set([1, pages]);
  for (let p = page - span; p <= page + span; p += 1) {
    if (p >= 1 && p <= pages) keep.add(p);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    // A gap of exactly one page is printed instead of elided: an ellipsis
    // standing in for a single number is both longer and less useful.
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push('gap');
    out.push(sorted[i]);
  }
  return out;
}
