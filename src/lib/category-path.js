/**
 * Helpers for the category taxonomy's URLs.
 *
 * Plain JavaScript rather than part of CategoryManager.jsx so a test runner
 * can import it -- Node cannot load a .jsx file.
 *
 * The naming convention here is read off the existing catalogue rather than
 * invented: a subcategory of T-Shirts has segment `oversized` and slug
 * `t-shirts-oversized`. The segment is the short piece that appears in the URL
 * and only has to be unique under its parent; the slug is globally unique
 * because `categories.slug` carries a UNIQUE constraint and "Printed T-Shirts"
 * and "Printed Shirts" must not collide.
 */

/** A URL-safe segment: lowercase, digits, single hyphens, no leading or trailing one. */
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A short segment for `name` under `parentName`.
 *
 * "Oversized T-Shirts" under "T-Shirts" becomes `oversized`, because repeating
 * the parent in the child's URL gives /shop/t-shirts/oversized-t-shirts. The
 * parent's words are removed wherever they appear, not just as a prefix, so
 * "Half Sleeve T-Shirts" also reduces to `half-sleeve`.
 *
 * Falls back to the full slug when stripping would leave nothing -- a child
 * actually named "T-Shirts" under "T-Shirts" keeps its own name rather than
 * ending up with an empty segment.
 */
export function suggestSegment(name, parentName) {
  const full = slugify(name);
  if (!parentName) return full;
  const parentWords = new Set(slugify(parentName).split('-').filter(Boolean));
  if (!parentWords.size) return full;
  const kept = full.split('-').filter((word) => word && !parentWords.has(word));
  return kept.length ? kept.join('-') : full;
}

/**
 * A globally unique slug for `name` under `parentSlug`.
 *
 * Prefixed with the parent's slug, matching every existing row. Top-level
 * categories just use their own name.
 */
export function suggestSlug(name, parentSlug, parentName) {
  const segment = suggestSegment(name, parentName);
  if (!parentSlug) return slugify(name);
  return `${parentSlug}-${segment}`;
}

/**
 * The storefront path a category will be served at.
 *
 * Mirrors hrefFor() and resolveCategory() in server/catalog.mjs: two levels,
 * /shop/<parent>/<child> or /shop/<segment>. An empty segment falls back to
 * the slug because that is what the server does -- `segment=$3` is written as
 * `v.segment || v.slug`.
 */
export function categoryHref({ segment, slug, parentSegment }) {
  const own = segment || slug;
  if (!own) return null;
  return parentSegment ? `/shop/${parentSegment}/${own}` : `/shop/${own}`;
}
