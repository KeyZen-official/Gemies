import {Router} from 'express';
import multer from 'multer';
import sharp from 'sharp';
import {z} from 'zod';
import {
  users, categories, products, variants, cartItems, wishlist, orders, orderItems,
  payments, refunds, shipments, shippingEvents, storeSettings, coupons, jobs,
  emailNotifications, auditLogs, contactMessages, exchangeRequests, exchangeItems,
  walletAccounts, walletTransactions, walletReservations, transaction,
} from './mongo.mjs';
import {config} from './config.mjs';
import {auth,admin,id,assert,audit,limit} from './security.mjs';
import {productSchema} from './validation.mjs';
import {storeImage} from './media.mjs';
import {enqueue} from './queue.mjs';
import {razorpay,shiprocket} from './providers.mjs';
import {
  syncTracking,requestRefund,syncRefund,refundableBalance,
  createShipment,assignCourier,schedulePickup,shippingLabel,shippingManifest,
  cancelShipment,courierOptionsForOrder,shipmentFor,
} from './fulfillment.mjs';
import {STAGES} from './shiprocket.mjs';
import {attemptsForOrder} from './payments.mjs';
import {walletSummary,history,reconcile,adminAdjust,walletSettings,postStandalone,expireCoinsSweep,TRANSACTION_KINDS} from './wallet.mjs';
import {exchangeDetails,transition,computeCredit,TRANSITIONS} from './exchanges.mjs';
export const adminRoutes=Router();adminRoutes.use(auth,admin);

/**
 * `ILIKE '%term%'`, as a MongoDB predicate.
 *
 * The term is escaped before it reaches the regex, so a search box containing
 * `.*` or `(` cannot change the shape of the query or make it scan the
 * catalogue. Every admin search below goes through this.
 */
const contains = (term) => ({$regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i'});

/** `COALESCE(sum(...),0)` over one numeric field, which Mongo needs a pipeline for. */
async function sumOf(collection, match, field) {
  const [row] = await collection.aggregate([
    {$match: match},
    {$group: {_id: null, total: {$sum: `$${field}`}}},
  ]).toArray();
  return row?.total ?? 0;
}

/**
 * Shared reader for the list endpoints.
 *
 * Every admin list was previously either unbounded (/products) or a hard
 * LIMIT 100 with no way to see row 101 (/orders, /customers, /audit). Both are
 * fine on a seed catalogue and useless on a real one, so the lists below all
 * take ?page= and ?limit= and report the total.
 */
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().max(160).default(''),
});

/** The envelope every paginated list returns, so one client component serves all of them. */
const paged = (rows, total, {page, limit}) => ({
  rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
});
/**
 * The overview screen's data, all of it derived from real rows.
 *
 * `?days=7|30|90` selects the window. Three things are new, and each one is
 * computed rather than decorative:
 *
 *  - `series`: captured revenue per day across the window, built from paid
 *    orders. A day with no paid orders is present with a zero, so the chart
 *    draws a continuous line instead of skipping dates. An all-zero series is
 *    reported honestly as `hasRevenue: false` and the client shows an empty
 *    state rather than a flat line pretending to be data.
 *
 *  - `deltas`: the same counts for the window and the window before it, so the
 *    percentage is a real period-over-period change. Every metric used here
 *    has a created_at, so the comparison means the same thing for all of them.
 *    Going from zero to something is reported as `fresh` rather than as a
 *    division by zero dressed up as +100%.
 *
 *  - `integrations[].health`: presence of credentials is still reported, but it
 *    is no longer conflated with working. A configured integration with failed
 *    jobs against it in the window comes back as 'error' with the count, which
 *    is a real signal from the queue rather than an assumption.
 */
const DASHBOARD_WINDOWS = [7, 30, 90];

const DAY_MS = 86400000;
/** Midnight UTC for a date. Replaces `date_trunc('day', ...)`. */
const startOfDay = (date) => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

adminRoutes.get('/dashboard', async (req, res) => {
  const v = z.object({days: z.coerce.number().int().refine((n) => DASHBOARD_WINDOWS.includes(n), 'days must be 7, 30 or 90').default(7)}).parse(req.query);
  const days = v.days;
  const now = Date.now();
  const since = new Date(now - days * DAY_MS);
  const priorStart = new Date(now - 2 * days * DAY_MS);
  // The series starts at midnight on the first day of the window, which is
  // what generate_series produced. UTC, stated explicitly: date_trunc used the
  // session timezone, and leaving it implicit here would shift bucket edges
  // with the server's locale.
  const seriesStart = new Date(startOfDay(now).getTime() - (days - 1) * DAY_MS);

  /** The five windowed metrics, for one time range. */
  const windowCounts = async (range) => {
    const [revenue, orderCount, productCount, customerCount, enquiryCount] = await Promise.all([
      sumOf(orders(), {payment_status: 'paid', created_at: range}, 'total'),
      orders().countDocuments({created_at: range}),
      products().countDocuments({created_at: range}),
      users().countDocuments({created_at: range}),
      contactMessages().countDocuments({created_at: range}),
    ]);
    return {revenue, orders: orderCount, products: productCount, customers: customerCount, open_enquiries: enquiryCount};
  };

  const [stats, productTotal, customerTotal, openEnquiries, jobRows, seriesRows, current, previous, failureRows, emailFailures] = await Promise.all([
    orders().aggregate([
      {$group: {
        _id: null,
        orders: {$sum: 1},
        revenue: {$sum: {$cond: [{$eq: ['$payment_status', 'paid']}, '$total', 0]}},
        awaiting_fulfillment: {$sum: {$cond: [{$eq: ['$status', 'confirmed']}, 1, 0]}},
      }},
      {$project: {_id: 0}},
    ]).toArray(),
    products().countDocuments({}),
    users().countDocuments({}),
    contactMessages().countDocuments({handled_at: null}),
    jobs().find({status: {$ne: 'done'}}, {projection: {
      _id: 0, id: 1, kind: 1, status: 1, attempts: 1, last_error: 1, created_at: 1, available_at: 1, ran_at: 1,
    }}).sort({created_at: -1}).limit(50).toArray(),
    // generate_series gave every day in the window a row. MongoDB groups only
    // the days that have orders, so the gaps are filled below instead -- days
    // with no orders must still appear as zero or the line skips dates.
    orders().aggregate([
      {$match: {created_at: {$gte: seriesStart}}},
      {$group: {
        _id: {$dateTrunc: {date: '$created_at', unit: 'day', timezone: 'UTC'}},
        revenue: {$sum: {$cond: [{$eq: ['$payment_status', 'paid']}, '$total', 0]}},
        orders: {$sum: {$cond: [{$eq: ['$payment_status', 'paid']}, 1, 0]}},
      }},
    ]).toArray(),
    windowCounts({$gte: since}),
    windowCounts({$gte: priorStart, $lt: since}),
    jobs().aggregate([
      {$match: {status: 'failed', created_at: {$gte: since}}},
      {$group: {_id: '$kind', count: {$sum: 1}}},
    ]).toArray(),
    emailNotifications().countDocuments({status: 'failed', created_at: {$gte: since}}),
  ]);

  const totals = stats[0] ?? {orders: 0, revenue: 0, awaiting_fulfillment: 0};
  const failedByKind = Object.fromEntries(failureRows.map((r) => [r._id, r.count]));
  /** Credentials present, plus any real failure the queue has recorded against it. */
  const integration = (name, configured, failedCount) => ({
    name,
    configured,
    failures: configured ? failedCount : 0,
    health: !configured ? 'unconfigured' : failedCount > 0 ? 'error' : 'configured',
  });

  const delta = (key) => {
    const now_ = current[key] ?? 0;
    const before = previous[key] ?? 0;
    if (before === 0) return {current: now_, previous: 0, percent: null, direction: now_ > 0 ? 'fresh' : 'flat'};
    const percent = Math.round(((now_ - before) / before) * 100);
    return {current: now_, previous: before, percent, direction: percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat'};
  };

  const byDay = new Map(seriesRows.map((r) => [r._id.getTime(), r]));
  const revenueSeries = Array.from({length: days}, (unused, offset) => {
    const day = new Date(seriesStart.getTime() + offset * DAY_MS);
    const row = byDay.get(day.getTime());
    return {day, revenue: row?.revenue ?? 0, orders: row?.orders ?? 0};
  });

  res.json({
    orders: totals.orders,
    revenue: totals.revenue,
    awaiting_fulfillment: totals.awaiting_fulfillment,
    products: productTotal,
    customers: customerTotal,
    open_enquiries: openEnquiries,
    jobs: jobRows,
    days,
    windows: DASHBOARD_WINDOWS,
    series: revenueSeries,
    // Lets the client choose an empty state over a flat line through zero.
    hasRevenue: revenueSeries.some((point) => point.revenue > 0),
    deltas: {
      revenue: delta('revenue'), orders: delta('orders'), products: delta('products'),
      customers: delta('customers'), open_enquiries: delta('open_enquiries'),
    },
    // Kept as the original boolean map so nothing reading the old shape breaks.
    integrations: {
      payments: !!process.env.RAZORPAY_KEY_ID,
      shipping: !!process.env.SHIPROCKET_EMAIL,
      email: !!process.env.RESEND_API_KEY,
      invoices: !!(process.env.BUSINESS_NAME && process.env.BUSINESS_ADDRESS && process.env.BUSINESS_EMAIL),
    },
    integrationHealth: [
      integration('payments', !!process.env.RAZORPAY_KEY_ID, (failedByKind.payment_sync ?? 0) + (failedByKind.refund ?? 0) + (failedByKind.refund_sync ?? 0)),
      integration('shipping', !!process.env.SHIPROCKET_EMAIL, (failedByKind.shipment ?? 0) + (failedByKind.tracking ?? 0)),
      integration('email', !!process.env.RESEND_API_KEY, (failedByKind.email ?? 0) + emailFailures),
      integration('invoices', !!(process.env.BUSINESS_NAME && process.env.BUSINESS_ADDRESS && process.env.BUSINESS_EMAIL), failedByKind.invoice ?? 0),
    ],
  });
});

/**
 * `(SELECT json_agg(v ORDER BY v.size,v.color) FROM variants v WHERE v.product_id=p.id)`.
 *
 * A $lookup with its own sort pipeline. The empty array for a product with no
 * variants comes for free; in SQL that needed a COALESCE.
 */
const WITH_VARIANTS = {
  $lookup: {
    from: 'variants', localField: '_id', foreignField: 'product_id', as: 'variants',
    pipeline: [{$sort: {size: 1, color: 1}}],
  },
};

/**
 * Units the shop could actually sell right now.
 *
 * `stock - reserved`, not `stock`: reserved units are held by a checkout in
 * progress and are not available to the next customer. A product with five in
 * stock and five reserved is out of stock, and the stock filter and the
 * out-of-stock count both have to agree about that. A product with no variants
 * sums to zero, which is right -- it cannot be bought either.
 */
const WITH_AVAILABLE = {
  $addFields: {
    available: {$sum: {$map: {
      input: '$variants', as: 'v', in: {$subtract: ['$$v.stock', '$$v.reserved']},
    }}},
  },
};

/**
 * The product list filter.
 *
 * SKU is in the search because an operator holding a garment reads the label,
 * not the slug. SKUs live on variants, so the matching product ids are
 * resolved from there first and folded into the $or -- which also means a
 * partial SKU matches the whole family, and typing the family shown in the
 * table finds the row again. That replaces the SQL `EXISTS (SELECT 1 FROM
 * variants ...)`; see the note in catalog.mjs on why it is not a $lookup.
 *
 * The stock filter is NOT here. It is a predicate on `stock - reserved`
 * summed across variants, so it can only be applied after the $lookup, which
 * is why the page and its count share one $facet pipeline below rather than a
 * find() and a countDocuments().
 */
async function productFilter(v) {
  const and = [];
  if (v.q) {
    const term = contains(v.q);
    const skuProductIds = await variants().distinct('product_id', {sku: term});
    and.push({$or: [
      {name: term}, {slug: term}, {brand: term},
      ...(skuProductIds.length ? [{_id: {$in: skuProductIds}}] : []),
    ]});
  }
  if (v.category) and.push({category_id: v.category});
  if (v.status !== 'all') and.push({published: v.status === 'published'});
  return and.length ? {$and: and} : {};
}

const productQuery = pageQuery.extend({
  category: z.union([z.literal(''), z.string().uuid()]).default(''),
  status: z.enum(['all', 'published', 'draft']).default('all'),
  stock: z.enum(['all', 'in', 'out']).default('all'),
});

adminRoutes.get('/products', async (req, res) => {
  const v = productQuery.parse(req.query);
  const match = await productFilter(v);
  const stockMatch = v.stock === 'in' ? {available: {$gt: 0}}
    : v.stock === 'out' ? {available: {$lte: 0}} : null;

  const [page, summaryRows] = await Promise.all([
    products().aggregate([
      {$match: match},
      WITH_VARIANTS,
      WITH_AVAILABLE,
      ...(stockMatch ? [{$match: stockMatch}] : []),
      // One pass for the rows and the total, because both depend on the
      // computed `available` and running the $lookup twice to get a count
      // would double the work.
      {$facet: {
        rows: [
          // created_at alone is not a total order -- the seed inserts the whole
          // catalogue in one transaction, so timestamps tie and a tied row can
          // appear on two pages or on neither. id breaks the tie deterministically.
          {$sort: {created_at: -1, _id: 1}},
          {$skip: (v.page - 1) * v.limit},
          {$limit: v.limit},
          {$lookup: {from: 'categories', localField: 'category_id', foreignField: '_id', as: '_category'}},
          {$addFields: {category: {$first: '$_category.name'}}},
          // `available` is working state, not part of the response the SQL gave.
          {$project: {_category: 0, available: 0}},
        ],
        total: [{$count: 'count'}],
      }},
    ]).toArray(),
    // Catalogue-wide and deliberately unfiltered. These four counts are what
    // the summary cards show, and the cards double as filter shortcuts: if
    // they counted only the filtered rows, clicking "Drafts" would rewrite the
    // very number that told you there were drafts to look at.
    products().aggregate([
      {$lookup: {from: 'variants', localField: '_id', foreignField: 'product_id', as: 'variants',
        pipeline: [{$project: {stock: 1, reserved: 1}}]}},
      WITH_AVAILABLE,
      {$group: {
        _id: null,
        total: {$sum: 1},
        published: {$sum: {$cond: ['$published', 1, 0]}},
        drafts: {$sum: {$cond: ['$published', 0, 1]}},
        out_of_stock: {$sum: {$cond: [{$lte: ['$available', 0]}, 1, 0]}},
      }},
      {$project: {_id: 0}},
    ]).toArray(),
  ]);

  const rows = page[0]?.rows ?? [];
  const total = page[0]?.total?.[0]?.count ?? 0;
  const summary = summaryRows[0] ?? {total: 0, published: 0, drafts: 0, out_of_stock: 0};
  res.json({...paged(rows, total, v), summary});
});
// One product with its variants. The editor used to re-fetch the entire
// catalogue and find() the row it wanted after saving a variant, which is now
// a paginated response and would have found nothing beyond page one.
adminRoutes.get('/products/:id', async (req, res) => {
  const [product] = await products().aggregate([
    {$match: {_id: req.params.id}},
    WITH_VARIANTS,
  ]).toArray();
  assert(product, 404, 'Product not found.');
  res.json(product);
});
/**
 * Deleting a product is refused once it has been ordered.
 *
 * An ordered product must stay for the invoice and the order history to remain
 * truthful -- unpublishing is the right tool for retiring it, and the message
 * says so. In PostgreSQL the foreign key from order_items would have refused
 * this anyway and the check only made the reason legible; MongoDB has no such
 * backstop, so here the check IS the constraint.
 */
adminRoutes.delete('/products/:id', async (req, res) => {
  const product = await products().findOne({_id: req.params.id}, {projection: {id: 1, name: 1}});
  assert(product, 404, 'Product not found.');
  const variantIds = await variants().distinct('_id', {product_id: req.params.id});
  const sold = variantIds.length ? await orderItems().countDocuments({variant_id: {$in: variantIds}}) : 0;
  assert(sold === 0, 409, `This product appears on ${sold} order line(s) and cannot be deleted without rewriting order history. Untick Published to retire it instead.`);
  await transaction(async (session) => {
    // In SQL variants cascaded from products, and cart and wishlist rows
    // cascaded from both. MongoDB has no ON DELETE CASCADE, so the cascade is
    // spelled out -- and it is in the transaction with the parent delete, so a
    // half-removed product cannot be left behind.
    await products().deleteOne({_id: req.params.id}, {session});
    await variants().deleteMany({product_id: req.params.id}, {session});
    if (variantIds.length) await cartItems().deleteMany({variant_id: {$in: variantIds}}, {session});
    await wishlist().deleteMany({product_id: req.params.id}, {session});
    await audit(req.user.id, 'product.delete', req.params.id, session);
  });
  res.json({ok: true});
});
/** A variant can go while nothing is reserved against it and it has never sold. */
adminRoutes.delete('/products/:id/variants/:variantId', async (req, res) => {
  const variant = await variants().findOne(
    {_id: req.params.variantId, product_id: req.params.id},
    {projection: {id: 1, reserved: 1}},
  );
  assert(variant, 404, 'Variant not found on this product.');
  assert(variant.reserved === 0, 409, `${variant.reserved} unit(s) are reserved by a checkout in progress. Try again once those orders settle or expire.`);
  const sold = await orderItems().countDocuments({variant_id: req.params.variantId});
  assert(sold === 0, 409, `This variant appears on ${sold} order line(s) and cannot be deleted. Set its stock to 0 instead.`);
  await transaction(async (session) => {
    await variants().deleteOne({_id: req.params.variantId}, {session});
    // cart_items cascaded from variants in SQL.
    await cartItems().deleteMany({variant_id: req.params.variantId}, {session});
    await audit(req.user.id, 'inventory.delete', req.params.variantId, session);
  });
  res.json({ok: true});
});
adminRoutes.post('/products',async(req,res)=>{
  const v=productSchema.parse(req.body),productId=id();
  await transaction(async session=>{
    // Columns the SQL INSERT left to their defaults are written explicitly,
    // because a document has no schema to default them for it.
    await products().insertOne({
      _id:productId,id:productId,slug:v.slug,name:v.name,description:v.description,
      brand:v.brand,category_id:v.category_id,audience:v.audience,price:v.price,
      compare_price:v.compare_price,images:v.images,published:v.published,featured:v.featured,
      rail_enabled:v.rail_enabled,rail_front:v.rail_front,rail_back:v.rail_back,rail_tag:v.rail_tag,
      is_demo:false,display_order:0,swatches:[],colorways:[],fit:null,fabric:null,
      created_at:new Date(),
    },{session});
    await audit(req.user.id,'product.create',productId,session);
  });
  res.status(201).json({id:productId});
});
adminRoutes.put('/products/:id',async(req,res)=>{
  const v=productSchema.parse(req.body);
  await transaction(async session=>{
    const result=await products().updateOne({_id:req.params.id},{$set:{
      slug:v.slug,name:v.name,description:v.description,brand:v.brand,
      category_id:v.category_id,audience:v.audience,price:v.price,
      compare_price:v.compare_price,images:v.images,published:v.published,featured:v.featured,
      rail_enabled:v.rail_enabled,rail_front:v.rail_front,rail_back:v.rail_back,rail_tag:v.rail_tag,
    }},{session});
    assert(result.matchedCount,404,'Product not found.');
    await audit(req.user.id,'product.update',req.params.id,session);
  });
  res.json({ok:true});
});
adminRoutes.put('/products/:id/variants',async(req,res)=>{
  const v=z.object({id:z.string().uuid().optional(),sku:z.string().trim().min(2).max(80),size:z.string().trim().min(1).max(30),color:z.string().trim().min(1).max(60),stock:z.number().int().min(0).max(100000)}).strict().parse(req.body);
  await transaction(async session=>{
    if(v.id){
      // `reserved<=$4` was the CHECK(reserved<=stock) guard expressed as part
      // of the WHERE clause, so lowering stock below what a checkout already
      // holds fails rather than corrupting the invariant. It stays in the
      // filter here for the same reason: MongoDB has no CHECK constraint.
      const result=await variants().updateOne(
        {_id:v.id,product_id:req.params.id,reserved:{$lte:v.stock}},
        {$set:{sku:v.sku,size:v.size,color:v.color,stock:v.stock}},
        {session},
      );
      assert(result.matchedCount,409,'Stock cannot be lower than reserved units, or variant was not found.');
    }else{
      const variantId=id();
      await variants().insertOne({
        _id:variantId,id:variantId,product_id:req.params.id,
        sku:v.sku,size:v.size,color:v.color,stock:v.stock,reserved:0,
      },{session});
    }
    await audit(req.user.id,'inventory.update',req.params.id,session);
  });
  res.json({ok:true});
});
// ------------------------------------------------------------------ categories
//
// These two routes used to insert and update `name` and `slug` only, which
// produced a category no customer could ever reach. `segment` was left NULL, so
// resolveCategory (catalog.mjs) never matched it and /shop/<slug> returned 404;
// `in_nav` defaulted to false, so categoryTree never listed it in the menu.
// Products filed under it were reachable only by direct URL, and the editor had
// no field to repair any of it.
//
// So the whole taxonomy is editable here now: the URL segment, the parent, the
// navigation flag and the ordering.
const categoryBody = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug may contain lowercase letters, digits and hyphens only.').max(80),
  // Defaults to the slug when left blank, which is what the migration did for
  // every pre-existing row. A top-level category almost always wants them
  // equal; a child needs its own short segment so /shop/t-shirts/printed and
  // /shop/shirts/printed can coexist while slugs stay globally unique.
  segment: z.union([z.literal(''), z.string().regex(/^[a-z0-9-]+$/, 'Segment may contain lowercase letters, digits and hyphens only.').max(80)]).optional(),
  parent_id: z.union([z.literal(''), z.string().uuid()]).nullable().optional(),
  in_nav: z.boolean().default(false),
  display_order: z.number().int().min(0).max(10000).default(0),
}).strict();

/**
 * Resolves and checks the requested parent.
 *
 * The navigation is two levels deep by design -- hrefFor in catalog.mjs builds
 * /shop/<parent>/<child> and has nowhere to put a third segment -- so a parent
 * must itself be top-level, and a category that already has children cannot
 * become someone else's child.
 */
async function checkParent(parentId, selfId) {
  if (!parentId) return null;
  assert(parentId !== selfId, 400, 'A category cannot be its own parent.');
  const parent = await categories().findOne({_id: parentId}, {projection: {parent_id: 1}});
  assert(parent, 400, 'That parent category does not exist.');
  assert(!parent.parent_id, 400, 'Categories nest one level deep, so the parent must be a top-level category.');
  if (selfId) {
    const children = await categories().countDocuments({parent_id: selfId});
    assert(children === 0, 409, 'This category has subcategories, so it cannot become a subcategory itself.');
  }
  return parentId;
}

/**
 * The unique indexes on slug and on (parent_id, segment); turn a violation
 * into a 409.
 *
 * The code to look for is MongoDB's 11000, where it used to be PostgreSQL's
 * 23505. The message check stays as a belt-and-braces fallback.
 */
function categoryConflict(error) {
  if (error?.code === 11000 || /duplicate key|unique/i.test(error?.message ?? '')) {
    assert(false, 409, 'Another category already uses that slug, or that URL segment under the same parent.');
  }
  throw error;
}

/**
 * The admin category list: the taxonomy as a tree, with the counts that make
 * it worth looking at.
 *
 * The admin screen previously read the public GET /categories, a flat array
 * with no product counts, no child counts and no paging. Those counts are the
 * whole point of the screen -- whether a category can be deleted depends on
 * them -- so they are computed here rather than guessed in the browser from a
 * page of products that may not contain the relevant ones.
 *
 * Two counts per row, deliberately both:
 *
 *   product_count  products filed directly against this category. This is the
 *                  number DELETE checks, so it is the number the delete dialog
 *                  must show.
 *   subtree_count  direct products plus those of its children. This is what an
 *                  operator means by "how many products are in T-Shirts", where
 *                  the parent itself holds none and its seven children hold
 *                  all nine.
 *
 * Paging is over top-level groups, not rows, so a parent is never separated
 * from its children -- half a family across a page boundary would make the
 * indentation lie. `total` is therefore a count of groups.
 *
 * The whole taxonomy is read and then grouped, filtered and paged in here
 * rather than in the database. That is a considered choice: navigation is two
 * levels deep by design (hrefFor has nowhere to put a third segment), so this
 * table is bounded by the size of a shop's menu -- twenty rows here, and a few
 * hundred in the worst realistic case. It also means the two correlated
 * subqueries the SQL used become one grouped read of products plus arithmetic
 * on an array already in memory.
 */
const categoryQuery = pageQuery.extend({
  // Paging is over groups, so the default is small: 10 groups is already most
  // of a real menu.
  limit: z.coerce.number().int().min(1).max(100).default(10),
  scope: z.enum(['all', 'top', 'child']).default('all'),
  nav: z.enum(['all', 'visible', 'hidden']).default('all'),
});

adminRoutes.get('/categories', async (req, res) => {
  const v = categoryQuery.parse(req.query);
  const term = v.q.trim().toLowerCase();

  const [raw, productCounts] = await Promise.all([
    categories().find({}, {projection: {
      _id: 0, id: 1, name: 1, slug: 1, segment: 1, parent_id: 1, in_nav: 1, display_order: 1,
    }}).sort({display_order: 1, name: 1}).toArray(),
    // `(SELECT count(*) FROM products x WHERE x.category_id=c.id)` for every
    // category at once, rather than once per row.
    products().aggregate([{$group: {_id: '$category_id', count: {$sum: 1}}}]).toArray(),
  ]);

  const productsPer = new Map(productCounts.map((r) => [r._id, r.count]));
  const childCounts = new Map();
  for (const row of raw) {
    if (row.parent_id) childCounts.set(row.parent_id, (childCounts.get(row.parent_id) ?? 0) + 1);
  }
  const byId = new Map(raw.map((row) => [row.id, row]));
  // parent_name and parent_segment came from the SQL's LEFT JOIN on itself.
  const rows = raw.map((row) => {
    const parent = row.parent_id ? byId.get(row.parent_id) : null;
    return {
      ...row,
      parent_name: parent?.name ?? null,
      parent_segment: parent?.segment ?? null,
      product_count: productsPer.get(row.id) ?? 0,
      child_count: childCounts.get(row.id) ?? 0,
    };
  });

  const summary = {
    total: raw.length,
    top_level: raw.filter((r) => !r.parent_id).length,
    subcategories: raw.filter((r) => r.parent_id).length,
    in_nav: raw.filter((r) => r.in_nav).length,
    missing_segment: raw.filter((r) => !r.segment).length,
  };

  /** Search covers the three things a category is addressed by. */
  const hits = (row) => !term
    || row.name.toLowerCase().includes(term)
    || (row.slug ?? '').toLowerCase().includes(term)
    || (row.segment ?? '').toLowerCase().includes(term);

  const navOk = (row) => v.nav === 'all' || (v.nav === 'visible' ? row.in_nav : !row.in_nav);
  const scopeOk = (row) => v.scope === 'all'
    || (v.scope === 'top' ? !row.parent_id : Boolean(row.parent_id));

  /** A row satisfies the filters in its own right, as opposed to being context. */
  const selected = (row) => hits(row) && navOk(row) && scopeOk(row);

  // The path shown in the table, and the one the storefront actually serves.
  const href = (row) => (row.parent_segment
    ? `/shop/${row.parent_segment}/${row.segment}`
    : `/shop/${row.segment}`);

  const tops = rows.filter((row) => !row.parent_id);
  const childrenOf = (parentId) => rows.filter((row) => row.parent_id === parentId);

  const groups = [];
  for (const top of tops) {
    const children = childrenOf(top.id);
    const topSelected = selected(top);
    const selectedChildren = children.filter(selected);
    // The group survives if the parent matched or any child did. A child that
    // matched is never shown without its parent, because an indented row with
    // nothing above it reads as a top-level category.
    if (!topSelected && !selectedChildren.length) continue;
    groups.push({
      ...top,
      href: href(top),
      // Present only to give a matching child its parent, so the UI can say so
      // instead of implying the parent matched too.
      context: !topSelected,
      subtree_count: top.product_count + children.reduce((n, c) => n + c.product_count, 0),
      children: (v.scope === 'top'
        ? []
        // When the parent itself matched, the whole family is relevant; when
        // only children did, showing the rest would bury the matches.
        : (topSelected ? children : selectedChildren)
      ).map((child) => ({
        ...child,
        href: href(child),
        context: !selected(child),
        subtree_count: child.product_count,
      })),
    });
  }

  // Orphans were nearly impossible in SQL -- parent_id was ON DELETE CASCADE --
  // and are merely unlikely now that the cascade is application code. Either
  // way a row pointing at a missing parent would otherwise vanish from this
  // screen entirely, which is the worst way to find out about it.
  const orphans = rows
    .filter((row) => row.parent_id && !byId.has(row.parent_id) && selected(row))
    .map((row) => ({...row, href: href(row), context: false, subtree_count: row.product_count, orphan: true, children: []}));

  const all_groups = [...groups, ...orphans];
  const total = all_groups.length;
  const pages = Math.max(1, Math.ceil(total / v.limit));
  const page = all_groups.slice((v.page - 1) * v.limit, (v.page - 1) * v.limit + v.limit);

  res.json({
    rows: page,
    total,
    page: v.page,
    limit: v.limit,
    pages,
    // Category rows on this page, and matching rows overall. `total` counts
    // groups, so neither can be derived from it.
    rowsOnPage: page.reduce((n, group) => n + 1 + group.children.length, 0),
    matchedRows: all_groups.reduce((n, group) => n + (group.context ? 0 : 1) + group.children.filter((c) => !c.context).length, 0),
    summary,
  });
});

adminRoutes.post('/categories', async (req, res) => {
  const v = categoryBody.parse(req.body);
  const parentId = await checkParent(v.parent_id || null, null);
  const categoryId = id();
  try {
    await transaction(async (session) => {
      await categories().insertOne({
        _id: categoryId, id: categoryId, name: v.name, slug: v.slug,
        segment: v.segment || v.slug, parent_id: parentId,
        in_nav: v.in_nav, display_order: v.display_order,
      }, {session});
      await audit(req.user.id, 'category.create', categoryId, session);
    });
  } catch (error) { categoryConflict(error); }
  res.status(201).json({id: categoryId});
});

adminRoutes.put('/categories/:id', async (req, res) => {
  const v = categoryBody.parse(req.body);
  const existing = await categories().findOne({_id: req.params.id}, {projection: {_id: 1}});
  assert(existing, 404, 'Category not found.');
  const parentId = await checkParent(v.parent_id || null, req.params.id);
  try {
    await transaction(async (session) => {
      await categories().updateOne({_id: req.params.id}, {$set: {
        name: v.name, slug: v.slug, segment: v.segment || v.slug,
        parent_id: parentId, in_nav: v.in_nav, display_order: v.display_order,
      }}, {session});
      await audit(req.user.id, 'category.update', req.params.id, session);
    });
  } catch (error) { categoryConflict(error); }
  res.json({ok: true});
});

/**
 * Deleting a category is refused while anything still points at it.
 *
 * In PostgreSQL `products.category_id` had no ON DELETE clause so the database
 * would have rejected this anyway, and subcategories WOULD have cascaded --
 * which is exactly why both are checked: deleting a parent must not silently
 * take its children with it. MongoDB enforces neither, so these two checks are
 * now the only thing standing between a delete and an orphaned catalogue.
 */
adminRoutes.delete('/categories/:id', async (req, res) => {
  const [filed, children] = await Promise.all([
    products().countDocuments({category_id: req.params.id}),
    categories().countDocuments({parent_id: req.params.id}),
  ]);
  assert(filed === 0, 409, `${filed} product(s) are filed under this category. Move them first.`);
  assert(children === 0, 409, `This category has ${children} subcategory(ies). Delete or re-parent them first.`);
  const removed = await categories().findOneAndDelete({_id: req.params.id});
  assert(removed, 404, 'Category not found.');
  await audit(req.user.id, 'category.delete', req.params.id);
  res.json({ok: true});
});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1},fileFilter:(req,file,cb)=>cb(null,['image/png','image/jpeg','image/webp'].includes(file.mimetype))});
adminRoutes.post('/images',limit('upload',30),upload.single('image'),async(req,res)=>{assert(req.file,400,'Upload a PNG, JPEG, or WebP image up to 5 MB.');let content;try{content=await sharp(req.file.buffer,{limitInputPixels:24000000}).rotate().resize({width:1800,height:1800,fit:'inside',withoutEnlargement:true}).webp({quality:88}).toBuffer();}catch{assert(false,400,'Image content is invalid or too large.');}const stored=await storeImage(content,`${id()}.webp`);await audit(req.user.id,'image.upload',stored.location);res.status(201).json({url:stored.url});});

/**
 * Orders, searchable by email or by exact order number.
 *
 * `CAST(o.number AS TEXT)=$1` was an exact match on the number, so a search of
 * "12" finds order 12 and not orders 120-129. Preserved: the term is only
 * compared as a number when it is entirely digits.
 */
const orderFilter = (q) => {
  if (!q) return {};
  const or = [{email: contains(q)}];
  if (/^\d+$/.test(q)) or.push({number: Number(q)});
  return {$or: or};
};

adminRoutes.get('/orders', async (req, res) => {
  const v = pageQuery.parse(req.query);
  const match = orderFilter(v.q);
  const [rows, total] = await Promise.all([
    orders().find(match, {projection: {
      _id: 0, id: 1, number: 1, email: 1, address: 1, status: 1,
      payment_status: 1, total: 1, currency: 1, created_at: 1,
    }}).sort({created_at: -1}).skip((v.page - 1) * v.limit).limit(v.limit).toArray(),
    orders().countDocuments(match),
  ]);
  // `o.address->>'name' AS customer`. The whole address is not part of this
  // response, so only the name is lifted out of it.
  res.json(paged(rows.map(({address, ...row}) => ({...row, customer: address?.name ?? null})), total, v));
});
// Customers, searchable by name or email, with their order count and lifetime
// captured spend -- the two things that make the list worth opening at all.
adminRoutes.get('/customers', async (req, res) => {
  const v = pageQuery.parse(req.query);
  const match = v.q ? {$or: [{email: contains(v.q)}, {name: contains(v.q)}]} : {};
  const [page, total] = await Promise.all([
    users().find(match, {projection: {_id: 0, id: 1, name: 1, email: 1, role: 1, verified: 1, created_at: 1}})
      .sort({created_at: -1}).skip((v.page - 1) * v.limit).limit(v.limit).toArray(),
    users().countDocuments(match),
  ]);
  // The two correlated subqueries, resolved for one page of customers in a
  // single grouped read rather than two reads per row.
  const ids = page.map((u) => u.id);
  const totals = ids.length ? await orders().aggregate([
    {$match: {user_id: {$in: ids}}},
    {$group: {
      _id: '$user_id',
      orders: {$sum: 1},
      spend: {$sum: {$cond: [{$eq: ['$payment_status', 'paid']}, '$total', 0]}},
    }},
  ]).toArray() : [];
  const byUser = new Map(totals.map((r) => [r._id, r]));
  const rows = page.map((u) => ({
    ...u,
    orders: byUser.get(u.id)?.orders ?? 0,
    spend: byUser.get(u.id)?.spend ?? 0,
  }));
  res.json(paged(rows, total, v));
});

// -------------------------------------------------------------- enquiry inbox
//
// contact_messages had no admin endpoint at all. server/contact.mjs writes
// every Contact Us submission to it and nothing read it back, so enquiries were
// visible only as a copy in the business mailbox -- and invisible entirely if
// that email failed. This is the inbox.
adminRoutes.get('/contact', async (req, res) => {
  const v = pageQuery.extend({status: z.enum(['all', 'open', 'handled']).default('open')}).parse(req.query);
  const and = [];
  if (v.q) {
    const term = contains(v.q);
    and.push({$or: [{email: term}, {name: term}, {subject: term}, {order_number: term}]});
  }
  // handled_at is null while open, so 'handled' is "has a date".
  if (v.status === 'open') and.push({handled_at: null});
  if (v.status === 'handled') and.push({handled_at: {$ne: null}});
  const match = and.length ? {$and: and} : {};

  const [page, total, open] = await Promise.all([
    contactMessages().find(match, {projection: {
      _id: 0, id: 1, name: 1, email: 1, subject: 1, message: 1, order_number: 1,
      created_at: 1, handled_at: 1, handled_by: 1, user_id: 1,
    }}).sort({created_at: -1}).skip((v.page - 1) * v.limit).limit(v.limit).toArray(),
    contactMessages().countDocuments(match),
    contactMessages().countDocuments({handled_at: null}),
  ]);

  // `LEFT JOIN users u ON u.id=m.handled_by`, for the handlers on this page.
  const handlerIds = [...new Set(page.map((m) => m.handled_by).filter(Boolean))];
  const handlers = handlerIds.length
    ? await users().find({_id: {$in: handlerIds}}, {projection: {email: 1}}).toArray()
    : [];
  const rows = page.map(({handled_by, user_id, ...row}) => ({
    ...row,
    handled_by_email: handlers.find((u) => u._id === handled_by)?.email ?? null,
    // `m.user_id IS NOT NULL AS from_account`
    from_account: user_id != null,
  }));
  res.json({...paged(rows, total, v), open});
});
adminRoutes.post('/contact/:id/handled', async (req, res) => {
  const v = z.object({handled: z.boolean()}).strict().parse(req.body);
  const result = await contactMessages().updateOne({_id: req.params.id}, {$set: {
    handled_at: v.handled ? new Date() : null,
    handled_by: v.handled ? req.user.id : null,
  }});
  assert(result.matchedCount, 404, 'Enquiry not found.');
  await audit(req.user.id, v.handled ? 'enquiry.handled' : 'enquiry.reopened', req.params.id);
  res.json({ok: true});
});
adminRoutes.post('/orders/:id/fulfill',async(req,res)=>{const o=await orders().findOne({_id:req.params.id});assert(o?.payment_status==='paid'&&['confirmed','processing'].includes(o.status),409,'Only confirmed paid orders can be fulfilled.');await enqueue('shipment',`shipment:${o.id}`,{orderId:o.id});await audit(req.user.id,'shipment.request',o.id);res.status(202).json({message:'Fulfillment queued. Check background job status for provider errors.'});});
adminRoutes.post('/orders/:id/track',async(req,res)=>{const result=await syncTracking(req.params.id);await audit(req.user.id,'shipment.track',req.params.id);res.json({ok:true,...result});});

/* ------------------------------------------------------------- shiprocket */
//
// The shipping panel. Each route is one Shiprocket operation, guarded by the
// shipment's own state so a button that cannot work is refused with a reason
// rather than producing a provider error. Every one is audited.
//
// `GET /shipment` is what the panel renders from: the stored shipment plus the
// actions its current state allows, computed on the server so the client never
// decides what is permitted.

/** The shipment, its history, and which operations are currently valid. */
adminRoutes.get('/orders/:id/shipment', async (req, res) => {
  const order = await orders().findOne({_id: req.params.id},
    {projection: {_id: 0, id: 1, number: 1, status: 1, payment_status: 1, currency: 1, address: 1, total: 1}});
  assert(order, 404, 'Order not found.');
  const shipment = await shipmentFor(req.params.id);
  const events = shipment
    ? await shippingEvents().find({shipment_id: shipment._id},
      {projection: {_id: 0, stage: 1, status: 1, details: 1, created_at: 1}})
      .sort({created_at: -1}).limit(50).toArray()
    : [];

  const eligible = order.payment_status === 'paid' && ['confirmed', 'processing'].includes(order.status);
  const stageRank = shipment ? (STAGES[shipment.stage]?.rank ?? 0) : 0;
  const cancelled = shipment?.status === 'cancelled';

  res.json({
    order,
    shipment: shipment ? {...shipment, _id: undefined} : null,
    stages: Object.fromEntries(Object.entries(STAGES).map(([key, value]) => [key, value.label])),
    history: events.map((event) => ({
      stage: event.stage,
      label: STAGES[event.stage]?.label ?? event.stage,
      status: event.status,
      location: event.details?.location ?? null,
      detail: event.details?.detail ?? null,
      at: event.details?.occurred_at ?? event.created_at,
    })),
    // Computed here, not in the browser: the client renders buttons from this
    // and the server refuses anything else anyway.
    can: {
      create: eligible && !shipment?.provider_order_id && !cancelled,
      couriers: eligible && !cancelled,
      assign: Boolean(shipment?.provider_shipment_id) && !shipment?.awb && !cancelled,
      pickup: Boolean(shipment?.awb) && !cancelled && stageRank < STAGES.picked_up.rank,
      label: Boolean(shipment?.awb),
      manifest: Boolean(shipment?.awb) && Boolean(shipment?.pickup_scheduled_at),
      track: Boolean(shipment?.provider_shipment_id || shipment?.awb),
      cancel: Boolean(shipment) && !cancelled && stageRank < STAGES.picked_up.rank,
      reconcile: Boolean(shipment) && ['reconciliation_required', 'assignment_review', 'creating', 'assigning'].includes(shipment.status),
    },
    shippingConfigured: config.shippingEnabled,
    webhookConfigured: Boolean(config.shiprocketWebhookSecret),
  });
});

/** Courier options for the destination. A quote; it books nothing. */
adminRoutes.get('/orders/:id/couriers', async (req, res) => {
  res.json(await courierOptionsForOrder(req.params.id));
});

/**
 * Creates the shipment, optionally with a chosen courier.
 *
 * Synchronous, unlike POST /fulfill which queues the same work: an operator
 * clicking Create Shipment wants the provider's answer, including its error,
 * rather than a job id. /fulfill is kept for the automated path.
 */
adminRoutes.post('/orders/:id/shipment', async (req, res) => {
  const v = z.object({courierId: z.union([z.literal(''), z.string().regex(/^\d{1,10}$/)]).optional()})
    .strict().parse(req.body ?? {});
  await audit(req.user.id, 'shipment.create', req.params.id);
  const shipment = await createShipment(req.params.id, {courierId: v.courierId || null});
  res.status(201).json({awb: shipment.awb, courier: shipment.courier, status: shipment.status, stage: shipment.stage});
});

/** Assigns an AWB to an already-created shipment. */
adminRoutes.post('/orders/:id/awb', async (req, res) => {
  const v = z.object({courierId: z.union([z.literal(''), z.string().regex(/^\d{1,10}$/)]).optional()})
    .strict().parse(req.body ?? {});
  await audit(req.user.id, 'shipment.awb', req.params.id);
  const shipment = await assignCourier(req.params.id, {courierId: v.courierId || null});
  res.json({awb: shipment.awb, courier: shipment.courier, status: shipment.status});
});

adminRoutes.post('/orders/:id/pickup', async (req, res) => {
  await audit(req.user.id, 'shipment.pickup', req.params.id);
  res.json(await schedulePickup(req.params.id));
});

adminRoutes.post('/orders/:id/manifest', async (req, res) => {
  await audit(req.user.id, 'shipment.manifest', req.params.id);
  res.json({url: await shippingManifest(req.params.id)});
});

adminRoutes.post('/orders/:id/cancel-shipment', async (req, res) => {
  await audit(req.user.id, 'shipment.cancel', req.params.id);
  res.json(await cancelShipment(req.params.id));
});
/**
 * Transaction detail for one order: the payment, every attempt against it, and
 * every refund.
 *
 * This is the refund panel. It read `refunds` over SQL while fulfillment.mjs
 * had already moved to MongoDB, so from tranche 3 until now it showed an empty
 * list beside a refundable balance that came from the migrated code -- the two
 * halves of the same screen disagreeing. Both sides now read MongoDB.
 *
 * Still deliberately a named projection so no credential or secret can reach
 * an admin screen through a future field addition. Nothing here decides a
 * refund's status: it reports what reconciliation against Razorpay already
 * stored.
 */
adminRoutes.get('/orders/:id/payment',async(req,res)=>{
  const o=await orders().findOne({_id:req.params.id},{projection:{
    _id:0,id:1,number:1,email:1,total:1,currency:1,status:1,payment_status:1,created_at:1,
  }});
  assert(o,404,'Order not found.');
  const payment=await payments().findOne({order_id:req.params.id},{projection:{
    _id:0,gateway_order_id:1,gateway_payment_id:1,status:1,method:1,amount:1,
    currency:1,refunded_amount:1,authorized_at:1,captured_at:1,created_at:1,
  }});
  const [attempts,refundRows,balance]=await Promise.all([
    attemptsForOrder(req.params.id),
    refunds().find({order_id:req.params.id},{projection:{
      _id:0,refund_key:1,provider_id:1,status:1,amount:1,reason:1,created_at:1,
    }}).sort({created_at:-1}).toArray(),
    refundableBalance(req.params.id),
  ]);
  res.json({order:o,payment,attempts,refunds:refundRows,refundable:balance.balance,mode:config.paymentMode});
});
// Full refund when `amount` is omitted; a partial refund must carry a
// refundKey so a repeated request cannot issue a second one.
adminRoutes.post('/orders/:id/refund',async(req,res)=>{const v=z.object({reason:z.string().trim().min(5).max(500),amount:z.coerce.number().int().positive().max(100000000).optional(),refundKey:z.string().regex(/^[a-zA-Z0-9:_-]{8,80}$/).optional()}).strict().parse(req.body);await audit(req.user.id,'refund.request',req.params.id);const result=await requestRefund(req.params.id,v.reason,{amount:v.amount??null,refundKey:v.refundKey??null});res.json({status:result.status,amount:result.amount});});
adminRoutes.post('/orders/:id/sync-refund',async(req,res)=>{const result=await syncRefund(req.params.id);res.json({status:result.status});});
adminRoutes.post('/orders/:id/status',async(req,res)=>{
  assert(req.body.status==='processing',400,'Only confirmed → processing can be set manually. Delivery is synchronized from the provider.');
  // The whole WHERE clause is the guard: only a confirmed, paid order moves.
  const result=await orders().updateOne(
    {_id:req.params.id,status:'confirmed',payment_status:'paid'},
    {$set:{status:'processing'}},
  );
  assert(result.matchedCount,409,'Invalid order transition.');
  await audit(req.user.id,'order.processing',req.params.id);
  res.json({ok:true});
});
adminRoutes.post('/orders/:id/reconcile-payment',async(req,res)=>{
  const gatewayId=z.string().regex(/^order_[a-zA-Z0-9]+$/).parse(req.body.gatewayOrderId);
  const remote=await razorpay(`/orders/${gatewayId}`);
  const o=await orders().findOne({_id:req.params.id});
  assert(o&&remote.receipt===o.id&&remote.amount===o.total&&remote.currency===o.currency,400,'Provider order does not match this order.');
  // `AND gateway_order_id IS NULL`: a payment that already has a gateway order
  // is not re-pointed at another one.
  await payments().updateOne(
    {order_id:o.id,gateway_order_id:null},
    {$set:{gateway_order_id:gatewayId,status:'pending'}},
  );
  await audit(req.user.id,'payment.reconcile',o.id);
  res.json({ok:true});
});
adminRoutes.post('/orders/:id/reconcile-shipment',async(req,res)=>{
  const providerId=z.string().regex(/^\d+$/).parse(req.body.providerOrderId);
  const remote=await shiprocket(`/orders/show/${providerId}`);
  const data=remote.data;
  assert(data&&String(data.channel_order_id)===req.params.id,400,'Provider order does not match this order.');
  const shipment=Array.isArray(data.shipments)?data.shipments[0]:data.shipments;
  assert(shipment?.id,400,'The provider order has no shipment.');
  await shipments().updateOne({order_id:req.params.id},{$set:{
    provider_order_id:providerId,
    provider_shipment_id:String(shipment.id),
    awb:shipment.awb||null,
    courier:shipment.courier||null,
    status:shipment.awb?'awb_assigned':'created',
  }});
  await audit(req.user.id,'shipment.reconcile',req.params.id);
  res.json({ok:true});
});
adminRoutes.post('/orders/:id/label',async(req,res)=>{
  await audit(req.user.id,'shipment.label',req.params.id);
  res.json({url:await shippingLabel(req.params.id)});
});
adminRoutes.post('/jobs/:id/retry',async(req,res)=>{
  const job=await jobs().findOne({_id:req.params.id});
  assert(job&&job.status==='failed',409,'Only failed jobs can be retried.');
  await jobs().updateOne({_id:job._id},{$set:{status:'pending',attempts:0,available_at:new Date(),locked_until:null}});
  await audit(req.user.id,'job.retry',job.id);
  res.json({ok:true});
});
adminRoutes.get('/settings',async(req,res)=>res.json(await storeSettings().findOne({_id:1})));
// Social profiles are optional, but must be a real https URL when provided.
const socialUrl=z.union([z.literal(''),z.string().url().max(300).refine(u=>u.startsWith('https://'),'Social links must start with https://')]);
/**
 * Wallet and exchange policy.
 *
 * Split into its own schema and its own update rather than widened into the
 * storefront settings below. That one is `.strict()` with a positional
 * UPDATE, so adding twelve columns to it would mean every existing caller had
 * to send all twelve or be rejected -- including the settings screen as it
 * stands today. Two endpoints keep the existing contract intact.
 *
 * Defaults in the schema are all off or zero, so the wallet stays inert until
 * an operator fills this in. No eligibility window is assumed.
 */
const walletSettingsBody = z.object({
  wallet_enabled: z.boolean(),
  // Paise per coin. 100 = ₹1 per coin.
  wallet_paise_per_coin: z.number().int().min(1).max(1000000),
  wallet_min_redeem_coins: z.number().int().min(0).max(10000000),
  wallet_max_order_percent: z.number().int().min(0).max(100),
  wallet_min_order_value: z.number().int().min(0).max(100000000),
  wallet_partial_redemption: z.boolean(),
  wallet_coins_expire: z.boolean(),
  wallet_expiry_days: z.number().int().min(0).max(3650),
  wallet_promo_enabled: z.boolean(),
  exchange_enabled: z.boolean(),
  exchange_window_days: z.number().int().min(0).max(365),
  exchange_credit_shipping: z.boolean(),
}).strict().refine((v) => !v.wallet_coins_expire || v.wallet_expiry_days > 0, {
  message: 'Set an expiry duration, or turn expiry off.',
  path: ['wallet_expiry_days'],
}).refine((v) => !v.exchange_enabled || v.exchange_window_days > 0, {
  message: 'Set an exchange window, or turn exchanges off.',
  path: ['exchange_window_days'],
});

adminRoutes.put('/settings/wallet', async (req, res) => {
  const v = walletSettingsBody.parse(req.body);
  // The schema is strict, so `v` holds exactly the twelve policy fields and
  // nothing else can be written through here.
  await storeSettings().updateOne({_id: 1}, {$set: {...v}});
  await audit(req.user.id, 'settings.wallet.update', '1');
  res.json({ok: true});
});

/* --------------------------------------------------------- exchange admin */

/**
 * The exchange queue.
 *
 * `eligible_coins` is shown on the list so an operator can see the financial
 * exposure of the queue without opening each request.
 *
 * The SQL joined orders and users to filter on them. Here the two sides of the
 * search are resolved to id sets first and the filter is applied to
 * exchange_requests, which is also what makes the count honest -- it counts the
 * same documents the page is taken from.
 */
adminRoutes.get('/exchanges', async (req, res) => {
  const v = pageQuery.extend({
    status: z.union([z.literal(''), z.enum(Object.keys(TRANSITIONS))]).default(''),
  }).parse(req.query);

  const and = [];
  if (v.status) and.push({status: v.status});
  if (v.q) {
    const term = contains(v.q);
    const [userIds, orderIds] = await Promise.all([
      users().distinct('_id', {$or: [{email: term}, {name: term}]}),
      // `CAST(o.number AS TEXT)=$2` was an exact match on the order number.
      /^\d+$/.test(v.q) ? orders().distinct('_id', {number: Number(v.q)}) : [],
    ]);
    and.push({$or: [
      ...(userIds.length ? [{user_id: {$in: userIds}}] : []),
      ...(orderIds.length ? [{order_id: {$in: orderIds}}] : []),
      // Nothing matched, so nothing should come back.
      ...(userIds.length || orderIds.length ? [] : [{_id: null}]),
    ]});
  }
  const match = and.length ? {$and: and} : {};

  const [page, total, statusCounts] = await Promise.all([
    exchangeRequests().find(match, {projection: {
      _id: 0, id: 1, number: 1, status: 1, reason: 1, eligible_coins: 1,
      eligible_inr: 1, created_at: 1, updated_at: 1, order_id: 1, user_id: 1,
    }}).sort({created_at: -1, id: 1}).skip((v.page - 1) * v.limit).limit(v.limit).toArray(),
    exchangeRequests().countDocuments(match),
    // Unfiltered, as the SQL had it: the status tabs must keep showing the
    // whole queue's shape while one status is being looked at.
    exchangeRequests().aggregate([{$group: {_id: '$status', count: {$sum: 1}}}]).toArray(),
  ]);

  const [orderRows, userRows, lineCounts] = await Promise.all([
    page.length ? orders().find({_id: {$in: page.map((r) => r.order_id)}},
      {projection: {number: 1, total: 1, currency: 1}}).toArray() : [],
    page.length ? users().find({_id: {$in: page.map((r) => r.user_id)}},
      {projection: {name: 1, email: 1}}).toArray() : [],
    page.length ? exchangeItems().aggregate([
      {$match: {exchange_id: {$in: page.map((r) => r.id)}}},
      {$group: {_id: '$exchange_id', count: {$sum: 1}}},
    ]).toArray() : [],
  ]);
  const linesPer = new Map(lineCounts.map((r) => [r._id, r.count]));

  const rows = page.map(({user_id, ...row}) => {
    const order = orderRows.find((o) => o._id === row.order_id);
    const customer = userRows.find((u) => u._id === user_id);
    return {
      ...row,
      order_number: order?.number ?? null,
      order_total: order?.total ?? null,
      currency: order?.currency ?? null,
      customer_name: customer?.name ?? null,
      customer_email: customer?.email ?? null,
      line_count: linesPer.get(row.id) ?? 0,
    };
  });

  res.json({
    ...paged(rows, total, v),
    byStatus: Object.fromEntries(statusCounts.map((r) => [r._id, r.count])),
    statuses: Object.keys(TRANSITIONS),
  });
});

adminRoutes.get('/exchanges/:id', async (req, res) => {
  const detail = await exchangeDetails(req.params.id);
  assert(detail, 404, 'Exchange request not found.');
  // The live recomputation, so an operator approving a credit sees the figure
  // that will actually be posted rather than the one stored at request time.
  const credit = await computeCredit(req.params.id);
  res.json({...detail, credit});
});

/**
 * Moves a request through the workflow.
 *
 * The valid next states come from the server, and an invalid move is a 409.
 * `coins_credited` is the only transition that touches the wallet.
 */
adminRoutes.post('/exchanges/:id/transition', async (req, res) => {
  const v = z.object({
    status: z.enum(Object.keys(TRANSITIONS)),
    note: z.string().trim().max(1000).default(''),
  }).strict().parse(req.body);
  res.json(await transition(req.params.id, v.status, {actor: req.user, note: v.note}));
});

/* ------------------------------------------------------------ wallet admin */

/**
 * Customer wallets, searchable, with their balances.
 *
 * Only accounts that exist are listed: a wallet row is created on first touch,
 * so a customer who has never earned or spent a coin has no account and
 * nothing to show.
 *
 * The SQL ordered by `a.balance_coins DESC, u.email` -- one field from each
 * side of the join -- so the sort cannot happen before the customer is
 * attached. Hence the $lookup pipeline rather than a find() on accounts.
 */
adminRoutes.get('/wallet/accounts', async (req, res) => {
  const v = pageQuery.parse(req.query);
  const userMatch = v.q ? {$or: [{'_user.email': contains(v.q)}, {'_user.name': contains(v.q)}]} : {};

  const [faceted, totalsRows] = await Promise.all([
    walletAccounts().aggregate([
      {$lookup: {from: 'users', localField: 'user_id', foreignField: '_id', as: '_user',
        pipeline: [{$project: {name: 1, email: 1}}]}},
      // An inner join: an account whose customer is gone is not listed.
      {$unwind: '$_user'},
      ...(v.q ? [{$match: userMatch}] : []),
      {$facet: {
        rows: [
          {$sort: {balance_coins: -1, '_user.email': 1}},
          {$skip: (v.page - 1) * v.limit},
          {$limit: v.limit},
          {$project: {
            _id: 0, user_id: 1, name: '$_user.name', email: '$_user.email',
            balance_coins: 1, lifetime_credited: 1, lifetime_debited: 1, updated_at: 1,
          }},
        ],
        total: [{$count: 'count'}],
      }},
    ]).toArray(),
    walletAccounts().aggregate([
      {$group: {
        _id: null,
        accounts: {$sum: 1},
        outstanding_coins: {$sum: '$balance_coins'},
        credited: {$sum: '$lifetime_credited'},
        debited: {$sum: '$lifetime_debited'},
      }},
      {$project: {_id: 0}},
    ]).toArray(),
  ]);

  const page = faceted[0]?.rows ?? [];
  const total = faceted[0]?.total?.[0]?.count ?? 0;

  // The two correlated subqueries, for one page of accounts.
  const ids = page.map((r) => r.user_id);
  const [heldRows, txRows] = await Promise.all([
    ids.length ? walletReservations().aggregate([
      {$match: {user_id: {$in: ids}, status: 'held', expires_at: {$gt: new Date()}}},
      {$group: {_id: '$user_id', coins: {$sum: '$coins'}}},
    ]).toArray() : [],
    ids.length ? walletTransactions().aggregate([
      {$match: {user_id: {$in: ids}}},
      {$group: {_id: '$user_id', count: {$sum: 1}}},
    ]).toArray() : [],
  ]);
  const heldPer = new Map(heldRows.map((r) => [r._id, r.coins]));
  const txPer = new Map(txRows.map((r) => [r._id, r.count]));
  const rows = page.map((r) => ({
    ...r,
    held_coins: heldPer.get(r.user_id) ?? 0,
    transactions: txPer.get(r.user_id) ?? 0,
  }));

  const summary = totalsRows[0] ?? {accounts: 0, outstanding_coins: 0, credited: 0, debited: 0};
  res.json({...paged(rows, total, v), summary});
});

/** One customer's wallet: balance, limits and a page of history. */
adminRoutes.get('/wallet/accounts/:userId', async (req, res) => {
  const user = await users().findOne({_id: req.params.userId}, {projection: {_id: 0, id: 1, name: 1, email: 1}});
  assert(user, 404, 'Customer not found.');
  const v = pageQuery.extend({
    kind: z.union([z.literal(''), z.enum(TRANSACTION_KINDS)]).default(''),
    direction: z.union([z.literal(''), z.enum(['credit', 'debit'])]).default(''),
  }).parse(req.query);
  const [summary, ledger, balanced] = await Promise.all([
    walletSummary(user.id),
    history(user.id, {page: v.page, limit: v.limit, kind: v.kind, direction: v.direction}),
    reconcile(user.id),
  ]);
  res.json({user, summary, ...ledger, integrity: balanced[0] ?? null});
});

/**
 * A manual adjustment.
 *
 * Appends a compensating ledger entry; it cannot edit or delete an existing
 * one. The reason is mandatory and is what appears in the customer's own
 * wallet history, so it has to be written for them to read.
 */
adminRoutes.post('/wallet/accounts/:userId/adjust', async (req, res) => {
  const v = z.object({
    coins: z.number().int().min(1).max(10000000),
    direction: z.enum(['credit', 'debit']),
    reason: z.string().trim().min(5).max(300),
    // Supplied by the client so a double-submitted form adjusts once.
    idempotencyKey: z.string().regex(/^[a-zA-Z0-9:_-]{8,120}$/),
  }).strict().parse(req.body);
  const user = await users().findOne({_id: req.params.userId}, {projection: {id: 1}});
  assert(user, 404, 'Customer not found.');

  const row = await adminAdjust({
    userId: user.id,
    coins: v.coins,
    direction: v.direction,
    reason: v.reason,
    actorId: req.user.id,
    idempotencyKey: `adjust:${req.params.userId}:${v.idempotencyKey}`,
  });
  if (!row.existing) await audit(req.user.id, 'wallet.adjust', row.id);
  res.json({transaction: row, existing: Boolean(row.existing)});
});

/**
 * A promotional credit — goodwill coins not tied to an exchange.
 *
 * Separate from an adjustment, and gated on `wallet_promo_enabled`, because
 * the two mean different things in the customer's history and in the store's
 * accounts: an adjustment corrects a mistake, a promotion is marketing spend.
 * Until this existed the setting was a toggle that controlled nothing.
 */
adminRoutes.post('/wallet/accounts/:userId/promo', async (req, res) => {
  const v = z.object({
    coins: z.number().int().min(1).max(10000000),
    reason: z.string().trim().min(5).max(300),
    idempotencyKey: z.string().regex(/^[a-zA-Z0-9:_-]{8,120}$/),
  }).strict().parse(req.body);

  const settings = await walletSettings();
  assert(settings.enabled, 409, 'The wallet is not enabled.');
  assert(settings.promoEnabled, 409, 'Promotional credits are switched off. Enable them in wallet settings first.');

  const user = await users().findOne({_id: req.params.userId}, {projection: {id: 1}});
  assert(user, 404, 'Customer not found.');

  const row = await postStandalone({
    userId: user.id,
    kind: 'promotional_credit',
    coins: v.coins,
    actorId: req.user.id,
    idempotencyKey: `promo:${user.id}:${v.idempotencyKey}`,
    description: v.reason.trim(),
  });
  if (!row.existing) await audit(req.user.id, 'wallet.promo', row.id);
  res.json({transaction: row, existing: Boolean(row.existing)});
});

/**
 * Runs the coin-expiry sweep now.
 *
 * The worker does this every minute anyway; this exists so an operator can
 * confirm the setting actually does something rather than having to wait and
 * wonder.
 */
adminRoutes.post('/wallet/expire-now', async (req, res) => {
  const settings = await walletSettings();
  assert(settings.coinsExpire && settings.expiryDays > 0, 409, 'Coin expiry is switched off.');
  const result = await expireCoinsSweep();
  await audit(req.user.id, 'wallet.expiry.run', '1');
  res.json(result);
});

/** The ledger-versus-cache check, across every account. */
adminRoutes.get('/wallet/integrity', async (req, res) => {
  const rows = await reconcile();
  res.json({accounts: rows.length, drifted: rows.filter((r) => !r.balanced), rows});
});

adminRoutes.put('/settings',async(req,res)=>{
  const v=z.object({shipping:z.number().int().min(0).max(1000000),free_shipping_threshold:z.number().int().min(0).max(100000000),tax_bps:z.number().int().min(0).max(10000),support_email:z.union([z.literal(''),z.string().email().max(254)]),returns_policy:z.string().max(10000),privacy_policy:z.string().max(10000),terms:z.string().max(10000),social_x:socialUrl,social_facebook:socialUrl,social_instagram:socialUrl,social_linkedin:socialUrl}).strict().parse(req.body);
  await storeSettings().updateOne({_id:1},{$set:{...v}});
  await audit(req.user.id,'settings.update','1');
  res.json({ok:true});
});
adminRoutes.get('/coupons',async(req,res)=>res.json(await coupons().find({}).sort({code:1}).toArray()));
adminRoutes.put('/coupons',async(req,res)=>{
  const v=z.object({code:z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,40}$/),percent:z.number().int().min(1).max(90),minimum:z.number().int().min(0),active:z.boolean(),expires_at:z.string().datetime().nullable()}).strict().parse(req.body);
  // `ON CONFLICT(code) DO UPDATE SET percent,minimum,active,expires_at`: an
  // upserting $set, with the code only written when the row is created.
  // expires_at is stored as a Date, as the timestamptz column was, so the
  // comparison in commerce.mjs stays a date comparison and not a string one.
  await coupons().updateOne(
    {code:v.code},
    {
      $set:{percent:v.percent,minimum:v.minimum,active:v.active,expires_at:v.expires_at?new Date(v.expires_at):null},
      $setOnInsert:{code:v.code},
    },
    {upsert:true},
  );
  await audit(req.user.id,'coupon.update',v.code);
  res.json({ok:true});
});
/** Retiring a discount code outright, rather than only being able to deactivate it. */
adminRoutes.delete('/coupons/:code', async (req, res) => {
  const code = z.string().regex(/^[A-Za-z0-9-]{3,40}$/).parse(req.params.code).toUpperCase();
  const removed = await coupons().findOneAndDelete({code});
  assert(removed, 404, 'Discount code not found.');
  await audit(req.user.id, 'coupon.delete', code);
  res.json({ok: true});
});

/**
 * The audit trail, joined to something readable.
 *
 * It used to be `SELECT *`, which rendered two raw UUIDs per row: the actor and
 * the entity. Neither tells you anything without a second query, so the log
 * existed but could not be read. The actor now resolves to a name and email,
 * and the entity to whatever it actually is -- a product name, an order number,
 * a coupon code, a category.
 *
 * `audit_logs.entity_id` is a bare string with no collection attached to it, so
 * the SQL tried four LEFT JOINs and took the first that hit with a COALESCE.
 * That becomes four keyed reads over the ids on this page and the same
 * precedence applied in order: product, category, order, variant.
 *
 * `actions` comes back alongside the rows so the client can offer a filter
 * listing only the actions this store has really recorded.
 */
adminRoutes.get('/audit', async (req, res) => {
  const v = pageQuery.extend({action: z.string().max(60).default('')}).parse(req.query);
  const match = v.action ? {action: v.action} : {};
  const [page, total, actions] = await Promise.all([
    auditLogs().find(match, {projection: {_id: 0, id: 1, action: 1, entity_id: 1, created_at: 1, actor_id: 1}})
      .sort({created_at: -1}).skip((v.page - 1) * v.limit).limit(v.limit).toArray(),
    auditLogs().countDocuments(match),
    auditLogs().distinct('action', {}),
  ]);

  const entityIds = [...new Set(page.map((r) => r.entity_id).filter(Boolean))];
  const actorIds = [...new Set(page.map((r) => r.actor_id).filter(Boolean))];
  const [actors, productRows, categoryRows, orderRows, variantRows] = await Promise.all([
    actorIds.length ? users().find({_id: {$in: actorIds}}, {projection: {name: 1, email: 1}}).toArray() : [],
    entityIds.length ? products().find({_id: {$in: entityIds}}, {projection: {name: 1}}).toArray() : [],
    entityIds.length ? categories().find({_id: {$in: entityIds}}, {projection: {name: 1}}).toArray() : [],
    entityIds.length ? orders().find({_id: {$in: entityIds}}, {projection: {number: 1}}).toArray() : [],
    entityIds.length ? variants().find({_id: {$in: entityIds}}, {projection: {sku: 1, product_id: 1}}).toArray() : [],
  ]);
  // The variant label needs its product's name, which was the fifth join.
  const variantProducts = variantRows.length
    ? await products().find({_id: {$in: variantRows.map((x) => x.product_id)}}, {projection: {name: 1}}).toArray()
    : [];

  const label = (entityId) => {
    const product = productRows.find((x) => x._id === entityId);
    if (product) return product.name;
    const category = categoryRows.find((x) => x._id === entityId);
    if (category) return category.name;
    const order = orderRows.find((x) => x._id === entityId);
    if (order) return `Order #${order.number}`;
    const variant = variantRows.find((x) => x._id === entityId);
    if (variant) {
      const parent = variantProducts.find((x) => x._id === variant.product_id);
      // The SQL concatenated sku with the product name; a NULL anywhere in a
      // SQL `||` yields NULL, so a variant whose product is missing produced
      // no label at all. Same outcome here, explicitly.
      return parent ? `${variant.sku} · ${parent.name}` : null;
    }
    // An entity deleted since the entry was written cannot be named by any
    // lookup, and the client shows the raw id in that case.
    return null;
  };

  const rows = page.map(({actor_id, ...row}) => {
    const actor = actors.find((u) => u._id === actor_id);
    return {
      ...row,
      actor_name: actor?.name ?? null,
      actor_email: actor?.email ?? null,
      entity_label: label(row.entity_id),
    };
  });

  res.json({...paged(rows, total, v), actions: actions.slice().sort()});
});
