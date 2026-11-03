import {z} from 'zod';
import {categories, products, variants} from './mongo.mjs';
import {config} from './config.mjs';

/**
 * Catalogue browsing: the category tree behind the navigation, and the
 * filtered product listing behind every category page.
 *
 * This lives apart from routes.mjs because the listing carries a category
 * subtree match, six filters and a facet pass, and none of that is readable
 * inlined into a route handler.
 */

/** Comma-separated multi-select, trimmed and de-duplicated, capped. */
const list = (max = 24) => z.string().max(400).default('').transform((value) => [
  ...new Set(value.split(',').map((part) => part.trim()).filter(Boolean)),
].slice(0, max));

export const listingQuery = z.object({
  q: z.string().max(160).default(''),
  category: z.string().max(80).default(''),
  audience: z.string().max(20).default(''),
  brand: z.string().max(80).default(''),
  // Multi-select filters.
  size: list(),
  color: list(),
  fit: list(),
  fabric: list(),
  // Prices are minor units throughout this API, as products.price is.
  minPrice: z.coerce.number().int().min(0).max(100000000).optional(),
  maxPrice: z.coerce.number().int().min(0).max(100000000).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'price-low', 'price-high', 'name']).default('newest'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
  featured: z.string().optional(),
});

/** `_id` is the tiebreaker in every sort, so paging is a total order. */
const SORTS = {
  newest: {display_order: 1, created_at: -1, _id: 1},
  'price-low': {price: 1, _id: 1},
  'price-high': {price: -1, _id: 1},
  name: {name: 1, _id: 1},
};

/** A literal substring match, case-insensitive. Replaces SQL ILIKE '%x%'. */
const contains = (value) => ({
  $regex: value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  $options: 'i',
});

/**
 * The navigation tree.
 *
 * Only categories flagged `in_nav` are returned, so a category left over from
 * an earlier catalogue keeps resolving for the products that still point at it
 * without appearing in the menu.
 *
 * The SQL did this with a self-join for the parent and a correlated subquery
 * for the product count. Here it is three reads and an in-memory assembly:
 * the navigable categories, every category keyed by id so a parent's segment
 * can be resolved even when the parent itself is hidden, and one grouped count
 * of published products.
 */
export async function categoryTree() {
  const visible = await categories()
    .find({in_nav: true})
    .sort({display_order: 1, name: 1})
    .toArray();
  if (!visible.length) return [];

  const all = await categories()
    .find({}, {projection: {_id: 1, slug: 1, segment: 1, parent_id: 1}})
    .toArray();
  const lookup = new Map(all.map((row) => [row._id, row]));

  const counted = await products().aggregate([
    {$match: {published: true, ...(config.production ? {is_demo: false} : {})}},
    {$group: {_id: '$category_id', count: {$sum: 1}}},
  ]).toArray();
  const countOf = new Map(counted.map((row) => [row._id, row.count]));

  const byId = new Map(visible.map((row) => {
    const parent = row.parent_id ? lookup.get(row.parent_id) : null;
    const shaped = {
      id: row.id ?? row._id,
      name: row.name,
      slug: row.slug,
      segment: row.segment,
      parent_id: row.parent_id ?? null,
      display_order: row.display_order,
      parent_slug: parent?.slug ?? null,
      parent_segment: parent?.segment ?? null,
      product_count: countOf.get(row._id) ?? 0,
      children: [],
    };
    shaped.href = hrefFor(shaped);
    return [row._id, shaped];
  }));

  const roots = [];
  for (const row of byId.values()) {
    if (row.parent_id && byId.has(row.parent_id)) byId.get(row.parent_id).children.push(row);
    else if (!row.parent_id) roots.push(row);
  }
  return roots;
}

/** Category URLs are /shop/<parent>/<child>, or /shop/<segment> at the top. */
function hrefFor(row) {
  return row.parent_segment
    ? `/shop/${row.parent_segment}/${row.segment}`
    : `/shop/${row.segment}`;
}

/** Resolves a /shop path to a category document, or null. */
export async function resolveCategory(segments) {
  if (!segments?.length) return null;
  if (segments.length === 1) {
    // `parent_id: null` is an exact match in MongoDB, where the SQL needed
    // `IS NULL`. The compound unique index on (parent_id, segment) covers it.
    return categories().findOne({segment: segments[0], parent_id: null});
  }
  const [parentSegment, childSegment] = segments;
  const parent = await categories().findOne(
    {segment: parentSegment, parent_id: null},
    {projection: {_id: 1}},
  );
  if (!parent) return null;
  return categories().findOne({segment: childSegment, parent_id: parent._id});
}

/**
 * Every category id in a slug's subtree, including the slug's own.
 *
 * Replaces the `WITH RECURSIVE` term, so /shop/t-shirts still lists everything
 * filed under its children rather than only products on the parent itself.
 * `$graphLookup` is MongoDB's recursive traversal and, like the CTE it
 * replaces, keeps working if the taxonomy is ever nested deeper than two
 * levels.
 */
async function subtreeIds(slug) {
  const row = await categories().aggregate([
    {$match: {slug}},
    {$graphLookup: {
      from: 'categories',
      startWith: '$_id',
      connectFromField: '_id',
      connectToField: 'parent_id',
      as: 'descendants',
      depthField: 'depth',
    }},
    {$project: {ids: {$concatArrays: [['$_id'], '$descendants._id']}}},
  ]).next();
  // An unknown slug matches nothing, rather than silently matching everything.
  return row?.ids ?? [];
}

/**
 * The product filter, as a MongoDB match document.
 *
 * Variant-derived filters (size, colour, availability) are resolved separately
 * because they live in another collection; `variantMatch` below turns them
 * into a set of product ids.
 */
async function productMatch(v) {
  const match = {published: true};
  if (config.production) match.is_demo = false;

  if (v.q) match.$or = [
    {name: contains(v.q)},
    {brand: contains(v.q)},
    {description: contains(v.q)},
  ];
  if (v.category) match.category_id = {$in: await subtreeIds(v.category)};
  if (v.audience) match.audience = v.audience;
  if (v.brand) match.brand = v.brand;
  if (v.fit.length) match.fit = {$in: v.fit};
  if (v.fabric.length) match.fabric = {$in: v.fabric};
  if (v.minPrice !== undefined || v.maxPrice !== undefined) {
    match.price = {
      ...(v.minPrice !== undefined ? {$gte: v.minPrice} : {}),
      ...(v.maxPrice !== undefined ? {$lte: v.maxPrice} : {}),
    };
  }
  if (v.featured === 'true') match.featured = true;
  return match;
}

/**
 * Product ids satisfying the variant-level filters, or null when none apply.
 *
 * The SQL expressed these as `EXISTS (SELECT 1 FROM variants ...)`. Resolving
 * them to an id set first keeps the product query a plain find rather than
 * forcing a `$lookup` before the match, which would have to scan the whole
 * collection before filtering.
 */
async function variantMatch(v) {
  const clauses = [];
  if (v.size.length) clauses.push({size: {$in: v.size}});
  if (v.color.length) clauses.push({color: {$in: v.color}});
  // stock - reserved > 0 is a comparison between two fields, so it needs $expr.
  if (v.inStock === 'true') clauses.push({$expr: {$gt: [{$subtract: ['$stock', '$reserved']}, 0]}});
  if (!clauses.length) return null;
  return variants().distinct('product_id', clauses.length === 1 ? clauses[0] : {$and: clauses});
}

/**
 * Facet options for the filter panel.
 *
 * Computed over the category and search scope only, deliberately ignoring the
 * other active filters: options therefore stay put while a customer ticks
 * boxes instead of disappearing underneath them. Every option comes from the
 * catalogue, so a dimension the data does not carry — fit and fabric, on the
 * reference products — returns an empty list and the panel omits it rather
 * than offering choices that match nothing.
 */
async function facets(v) {
  const base = await productMatch({
    ...v,
    size: [], color: [], fit: [], fabric: [],
    minPrice: undefined, maxPrice: undefined, inStock: undefined,
  });

  // The scope resolved to ids once, then reused by every facet below. The
  // variant facets need it because they query the other collection, and
  // sharing it keeps all six counts over exactly the same scope.
  const scoped = await products().find(base, {projection: {_id: 1, colorways: 1}}).toArray();
  const ids = scoped.map((row) => row._id);
  if (!ids.length) {
    return {
      sizes: [], colors: [], fits: [], fabrics: [],
      price: {min: null, max: null},
      availability: {inStock: 0, total: 0},
    };
  }

  const [sizes, colors, fits, fabrics, money, stock] = await Promise.all([
    variants().aggregate([
      {$match: {product_id: {$in: ids}}},
      {$group: {_id: '$size', products: {$addToSet: '$product_id'}}},
      {$project: {_id: 0, value: '$_id', count: {$size: '$products'}}},
      // Shortest first, as `ORDER BY length(size), size` did, so S/M/L/XL/XXL
      // comes out in wearable order rather than alphabetically.
      {$sort: {value: 1}},
    ]).toArray().then((rows) => rows
      .sort((a, b) => a.value.length - b.value.length || a.value.localeCompare(b.value))),

    variants().aggregate([
      {$match: {product_id: {$in: ids}}},
      {$group: {_id: '$color', products: {$addToSet: '$product_id'}}},
      {$project: {_id: 0, value: '$_id', count: {$size: '$products'}}},
      {$sort: {value: 1}},
    ]).toArray(),

    products().aggregate([
      {$match: {...base, fit: {$ne: null, $exists: true}}},
      {$group: {_id: '$fit', count: {$sum: 1}}},
      {$project: {_id: 0, value: '$_id', count: 1}},
      {$sort: {value: 1}},
    ]).toArray(),

    products().aggregate([
      {$match: {...base, fabric: {$ne: null, $exists: true}}},
      {$group: {_id: '$fabric', count: {$sum: 1}}},
      {$project: {_id: 0, value: '$_id', count: 1}},
      {$sort: {value: 1}},
    ]).toArray(),

    products().aggregate([
      {$match: base},
      {$group: {_id: null, min: {$min: '$price'}, max: {$max: '$price'}}},
    ]).next(),

    variants().distinct('product_id', {
      product_id: {$in: ids},
      $expr: {$gt: [{$subtract: ['$stock', '$reserved']}, 0]},
    }),
  ]);

  // The swatch colour for each colourway name, which the SQL pulled with a
  // LATERAL join over the product's jsonb. Here the colourways travelled with
  // the scoped products, so it is a lookup rather than a query.
  const hexFor = new Map();
  for (const product of scoped) {
    for (const way of product.colorways ?? []) {
      if (way?.name && way?.hex && !hexFor.has(way.name)) hexFor.set(way.name, way.hex);
    }
  }

  return {
    sizes,
    colors: colors.map((row) => ({...row, hex: hexFor.get(row.value) ?? null})),
    fits,
    fabrics,
    price: {min: money?.min ?? null, max: money?.max ?? null},
    availability: {inStock: stock.length, total: ids.length},
  };
}

export async function listProducts(query) {
  const v = listingQuery.parse(query);
  const match = await productMatch(v);
  const variantIds = await variantMatch(v);
  if (variantIds) {
    // Intersected with any category filter already on `category_id` by using a
    // separate key, so one does not overwrite the other.
    match._id = {$in: variantIds};
  }

  const [rows, total, available] = await Promise.all([
    products().aggregate([
      {$match: match},
      {$sort: SORTS[v.sort]},
      {$skip: (v.page - 1) * v.limit},
      {$limit: v.limit},
      // Available stock, which the SQL computed with a correlated sum.
      {$lookup: {
        from: 'variants',
        localField: '_id',
        foreignField: 'product_id',
        as: '_variants',
        pipeline: [{$project: {stock: 1, reserved: 1}}],
      }},
      {$lookup: {from: 'categories', localField: 'category_id', foreignField: '_id', as: '_category'}},
      {$addFields: {
        available: {$sum: {$map: {
          input: '$_variants', as: 'v', in: {$subtract: ['$$v.stock', '$$v.reserved']},
        }}},
        _cat: {$first: '$_category'},
      }},
      {$lookup: {from: 'categories', localField: '_cat.parent_id', foreignField: '_id', as: '_parent'}},
      {$addFields: {
        category: '$_cat.name',
        category_slug: '$_cat.slug',
        category_segment: '$_cat.segment',
        category_parent_segment: {$first: '$_parent.segment'},
      }},
      {$project: {_variants: 0, _category: 0, _parent: 0, _cat: 0}},
    ]).toArray(),
    products().countDocuments(match),
    facets(v),
  ]);

  return {
    products: rows,
    total,
    page: v.page,
    pages: Math.ceil(total / v.limit),
    facets: available,
  };
}
