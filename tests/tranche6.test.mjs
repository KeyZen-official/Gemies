// Tranche 6: the admin API on MongoDB.
//
// These go over HTTP against the real Express app, because half of what this
// tranche has to preserve lives in the middleware: a customer must not reach
// an admin route, a non-GET needs an origin and a CSRF token, and the error
// handler has to keep turning a duplicate key into a 409.
//
//   node --test tests/tranche6.test.mjs
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startMongo, stopMongo} from './mongo-harness.mjs';

process.env.NODE_ENV = 'test';
process.env.STORE_CURRENCY = 'INR';
process.env.APP_URL = 'http://localhost:3000';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture';
process.env.RAZORPAY_KEY_SECRET = 'fixture-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.RESEND_API_KEY = 'fixture';
process.env.EMAIL_FROM = 'fixture@example.invalid';
process.env.BUSINESS_NAME = 'SWAYAMSIDDHA FASHION AND LIFESTYLES';
process.env.BUSINESS_ADDRESS = 'Acropolis, Borivali West, Mumbai 400103';
process.env.BUSINESS_EMAIL = 'swayamsiddha20@gmail.com';
process.env.BUSINESS_TAX_ID = '27BSUPK4844B1ZH';
// Shipping is configured *completely* here, not just with credentials.
// "Configured" on the dashboard now means "could actually book a parcel",
// which includes the pickup PIN and the four parcel measurements -- the
// integration-health test below asserts that a configured integration with
// failed jobs reports `error`, and a half-configured fixture would make it
// pass for the wrong reason.
process.env.SHIPROCKET_EMAIL = 'ship@example.invalid';
process.env.SHIPROCKET_PASSWORD = 'fixture';
process.env.SHIPROCKET_PICKUP_LOCATION = 'Primary';
process.env.SHIPROCKET_PICKUP_PINCODE = '400103';
process.env.PACKAGE_WEIGHT_KG = '0.4';
process.env.PACKAGE_LENGTH_CM = '25';
process.env.PACKAGE_BREADTH_CM = '20';
process.env.PACKAGE_HEIGHT_CM = '4';
process.env.RUN_WORKER = 'false';

await startMongo();

const mongo = await import('../server/mongo.mjs');
const {id, passwordHash} = await import('../server/security.mjs');
const {app} = await import('../server/app.mjs');

const PASSWORD = 'a-very-secure-admin-password';
const ORIGIN = 'http://localhost:3000';

let server;
let base;
let adminAuth;
let customerAuth;
let adminUser;
let customerUser;
let categoryId;
let childCategoryId;

/* ------------------------------------------------------------------- client */

/** One request to the API, carrying whatever a browser would have to carry. */
async function call(path, {method = 'GET', body, auth: session = adminAuth} = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers.origin = ORIGIN;
  if (session) {
    headers.cookie = session.cookie;
    if (method !== 'GET') headers['x-csrf-token'] = session.csrf;
  }
  const response = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return {status: response.status, body: payload};
}

/** Asserts a 2xx and hands back the body, so a failure names the status. */
async function ok(path, options) {
  const result = await call(path, options);
  assert.ok(result.status >= 200 && result.status < 300,
    `${options?.method ?? 'GET'} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function signIn(email) {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: ORIGIN},
    body: JSON.stringify({email, password: PASSWORD}),
  });
  assert.equal(response.status, 200, `login for ${email}`);
  const payload = await response.json();
  const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  return {cookie, csrf: payload.user.csrf};
}

/* ------------------------------------------------------------------ fixtures */

async function makeUser({role = 'customer', name = 'Buyer', email} = {}) {
  const uid = id();
  const address = email ?? `u${uid}@example.invalid`;
  await mongo.users().insertOne({
    _id: uid, id: uid, name, email: address,
    password_hash: await passwordHash(PASSWORD),
    role, verified: true, created_at: new Date(),
  });
  return {id: uid, email: address, name, role};
}

let seq = 0;
async function makeProduct(patch = {}) {
  const pid = id();
  seq += 1;
  const doc = {
    _id: pid, id: pid, slug: `tee-${seq}-${pid.slice(0, 6)}`, name: `Tee ${seq}`,
    description: 'Seeded for admin tests.', brand: 'Gemies', category_id: categoryId,
    audience: 'Men', price: 100000, compare_price: null, images: ['/assets/products/a.webp'],
    published: true, featured: false, is_demo: false, display_order: 0,
    swatches: [], colorways: [], fit: null, fabric: null,
    created_at: new Date(Date.now() - seq * 1000),
    ...patch,
  };
  await mongo.products().insertOne(doc);
  return doc;
}

async function makeVariant(productId, patch = {}) {
  const vid = id();
  seq += 1;
  const doc = {
    _id: vid, id: vid, product_id: productId, sku: `SKU-${seq}-${vid.slice(0, 6)}`,
    size: 'M', color: `Black-${seq}`, stock: 10, reserved: 0, ...patch,
  };
  await mongo.variants().insertOne(doc);
  return doc;
}

/** A paid order with one line, a captured payment and optional refunds. */
async function makePaidOrder({user = customerUser, total = 100000, refundRows = []} = {}) {
  const orderId = id();
  seq += 1;
  const number = 5000 + seq;
  const product = await makeProduct();
  const variant = await makeVariant(product.id);
  await mongo.orders().insertOne({
    _id: orderId, id: orderId, number, user_id: user.id, email: user.email,
    address: {name: user.name, phone: '9876543210', line1: '1 Test street', line2: '',
      city: 'Mumbai', state: 'Maharashtra', postalCode: '400001', country: 'India'},
    subtotal: total, discount: 0, tax: 0, shipping: 0, total, tax_bps: 0,
    currency: 'INR', status: 'confirmed', payment_status: 'paid', reserved: false,
    wallet_applied: 0, wallet_coins: 0, checkout_key: `k-${randomUUID()}`,
    request_hash: 'x', expires_at: null, created_at: new Date(Date.now() - seq * 1000),
  });
  const itemId = id();
  await mongo.orderItems().insertOne({
    _id: itemId, id: itemId, order_id: orderId, variant_id: variant.id,
    name: product.name, sku: variant.sku, size: variant.size, color: variant.color,
    image: null, unit_price: total, quantity: 1,
  });
  const paymentId = id();
  await mongo.payments().insertOne({
    _id: paymentId, id: paymentId, order_id: orderId,
    gateway_order_id: `order_${randomUUID().replaceAll('-', '')}`,
    gateway_payment_id: `pay_${randomUUID().replaceAll('-', '')}`,
    status: 'captured', method: 'card', amount: total, currency: 'INR',
    refunded_amount: 0, authorized_at: new Date(), captured_at: new Date(),
    created_at: new Date(),
  });
  for (const row of refundRows) {
    const refundId = id();
    await mongo.refunds().insertOne({
      _id: refundId, id: refundId, order_id: orderId,
      refund_key: row.refund_key, provider_id: row.provider_id ?? null,
      status: row.status, amount: row.amount, reason: row.reason,
      created_at: row.created_at ?? new Date(),
    });
  }
  return {orderId, number, product, variant, itemId, user, total};
}

before(async () => {
  await mongo.connect();
  await mongo.ensureSchema();

  categoryId = id();
  childCategoryId = id();
  await mongo.categories().insertMany([
    {_id: categoryId, id: categoryId, name: 'T-Shirts', slug: 't-shirts', segment: 't-shirts', parent_id: null, in_nav: true, display_order: 0},
    {_id: childCategoryId, id: childCategoryId, name: 'Printed', slug: 'printed', segment: 'printed', parent_id: categoryId, in_nav: true, display_order: 1},
  ]);

  adminUser = await makeUser({role: 'admin', name: 'Site Admin', email: 'admin-t6@example.invalid'});
  customerUser = await makeUser({name: 'Asha Patel', email: 'asha-t6@example.invalid'});

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;

  adminAuth = await signIn(adminUser.email);
  customerAuth = await signIn(customerUser.email);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongo.close();
  await stopMongo();
});

/* ============================================ authentication & permissions */

test('an admin route is closed to anyone who is not an administrator', async () => {
  const anonymous = await call('/admin/dashboard', {auth: null});
  assert.equal(anonymous.status, 401, 'signed out is 401, not 403');

  const customer = await call('/admin/dashboard', {auth: customerAuth});
  assert.equal(customer.status, 403);
  assert.match(customer.body.error, /Administrator access/);

  const administrator = await call('/admin/dashboard');
  assert.equal(administrator.status, 200);
});

test('a customer cannot write through an admin route either', async () => {
  const product = await makeProduct();
  const attempt = await call(`/admin/products/${product.id}`, {method: 'DELETE', auth: customerAuth});
  assert.equal(attempt.status, 403);
  assert.ok(await mongo.products().findOne({_id: product.id}), 'nothing was deleted');
});

test('a write without an origin or a CSRF token is refused', async () => {
  const noOrigin = await fetch(`${base}/admin/settings`, {
    method: 'PUT',
    headers: {'content-type': 'application/json', cookie: adminAuth.cookie, 'x-csrf-token': adminAuth.csrf},
    body: JSON.stringify({}),
  });
  assert.equal(noOrigin.status, 403, 'the origin check runs before the route');

  const noCsrf = await fetch(`${base}/admin/settings`, {
    method: 'PUT',
    headers: {'content-type': 'application/json', origin: ORIGIN, cookie: adminAuth.cookie},
    body: JSON.stringify({}),
  });
  assert.equal(noCsrf.status, 403);
});

test('an admin role is read from the database, not from the session', async () => {
  // Demote the administrator mid-session. The next request must be refused,
  // because sessionMiddleware re-reads the role on every call.
  await mongo.users().updateOne({_id: adminUser.id}, {$set: {role: 'customer'}});
  const demoted = await call('/admin/dashboard');
  assert.equal(demoted.status, 403);
  await mongo.users().updateOne({_id: adminUser.id}, {$set: {role: 'admin'}});
  assert.equal((await call('/admin/dashboard')).status, 200);
});

/* ============================================================== dashboard */

test('the dashboard reports real counts and a gap-free series', async () => {
  await makePaidOrder({total: 250000});
  const data = await ok('/admin/dashboard?days=7');

  assert.equal(typeof data.orders, 'number');
  assert.ok(data.revenue >= 250000, 'captured revenue includes the paid order');
  assert.equal(data.products, await mongo.products().countDocuments({}));
  assert.equal(data.customers, await mongo.users().countDocuments({}));
  assert.equal(data.open_enquiries, await mongo.contactMessages().countDocuments({handled_at: null}));
  assert.ok(data.awaiting_fulfillment >= 1, 'confirmed orders are awaiting fulfillment');

  // generate_series filled every day; so must this.
  assert.equal(data.series.length, 7);
  for (const point of data.series) {
    assert.equal(typeof point.revenue, 'number');
    assert.equal(typeof point.orders, 'number');
    assert.ok(!Number.isNaN(new Date(point.day).getTime()));
  }
  const days = data.series.map((p) => new Date(p.day).getTime());
  assert.deepEqual(days, [...days].sort((a, b) => a - b), 'ascending by day');
  assert.equal(new Set(days).size, 7, 'one row per day, no duplicates');
  assert.equal(data.hasRevenue, data.series.some((p) => p.revenue > 0));

  assert.deepEqual(data.windows, [7, 30, 90]);
  for (const key of ['revenue', 'orders', 'products', 'customers', 'open_enquiries']) {
    const d = data.deltas[key];
    assert.ok(['up', 'down', 'flat', 'fresh'].includes(d.direction), `${key} direction`);
    // Zero before means no percentage is invented.
    if (d.previous === 0) assert.equal(d.percent, null);
  }
});

test('the dashboard window is validated and changes the series length', async () => {
  assert.equal((await call('/admin/dashboard?days=5')).status, 400);
  assert.equal((await ok('/admin/dashboard?days=30')).series.length, 30);
  assert.equal((await ok('/admin/dashboard?days=90')).series.length, 90);
});

test('integration health reports queue failures, not just credentials', async () => {
  const failedId = id();
  await mongo.jobs().insertOne({
    _id: failedId, id: failedId, kind: 'shipment', dedupe_key: `t6-fail-${randomUUID()}`,
    payload: {}, status: 'failed', attempts: 8, available_at: new Date(),
    locked_until: null, last_error: 'Job failed.', ran_at: new Date(), created_at: new Date(),
  });

  const data = await ok('/admin/dashboard?days=7');
  const shipping = data.integrationHealth.find((i) => i.name === 'shipping');
  assert.equal(shipping.configured, true);
  assert.ok(shipping.failures >= 1);
  assert.equal(shipping.health, 'error', 'configured but failing is not reported as healthy');

  const invoices = data.integrationHealth.find((i) => i.name === 'invoices');
  assert.equal(invoices.health, 'configured', 'configured with no failures');

  // The non-done job list is what the dashboard shows as the queue.
  assert.ok(data.jobs.some((j) => j.id === failedId));
  const listed = data.jobs.find((j) => j.id === failedId);
  assert.deepEqual(Object.keys(listed).sort(),
    ['attempts', 'available_at', 'created_at', 'id', 'kind', 'last_error', 'ran_at', 'status'],
    'the job projection is exactly the eight fields the SQL selected');

  await mongo.jobs().deleteOne({_id: failedId});
});

/* =============================================================== products */

test('the product list searches name, slug, brand and SKU', async () => {
  const target = await makeProduct({name: 'Needle Haystack Tee', slug: 'needle-haystack', brand: 'Needlecraft'});
  const variant = await makeVariant(target.id, {sku: 'NDL-9001-XL'});
  await makeProduct({name: 'Unrelated Tee'});

  for (const [label, term] of [
    ['name', 'Haystack'], ['slug', 'needle-hay'], ['brand', 'Needlecraft'],
    ['full SKU', 'NDL-9001-XL'], ['partial SKU', 'NDL-9001'],
  ]) {
    const data = await ok(`/admin/products?q=${encodeURIComponent(term)}`);
    assert.ok(data.rows.some((r) => r.id === target.id), `${label} search finds the product`);
  }
  assert.equal((await ok('/admin/products?q=NDL-9001')).rows[0].variants[0].sku, variant.sku,
    'a SKU search returns the product, not the variant');

  // A regex metacharacter in the box is a literal, not a pattern.
  assert.equal((await ok('/admin/products?q=.%2A')).total, 0, '".*" matches nothing');
});

test('product filters compose, and the summary stays catalogue-wide', async () => {
  const draft = await makeProduct({published: false, name: 'Draft Only Tee'});
  const soldOut = await makeProduct({name: 'Sold Out Tee'});
  await makeVariant(soldOut.id, {stock: 4, reserved: 4});
  const inStock = await makeProduct({name: 'In Stock Tee'});
  await makeVariant(inStock.id, {stock: 6, reserved: 1});

  const drafts = await ok('/admin/products?status=draft&limit=100');
  assert.ok(drafts.rows.some((r) => r.id === draft.id));
  assert.ok(drafts.rows.every((r) => r.published === false));

  const published = await ok('/admin/products?status=published&limit=100');
  assert.ok(published.rows.every((r) => r.published === true));

  // stock - reserved, not stock: fully reserved is out of stock.
  const out = await ok('/admin/products?stock=out&limit=100');
  assert.ok(out.rows.some((r) => r.id === soldOut.id), 'fully reserved counts as out of stock');
  assert.ok(out.rows.some((r) => r.id === draft.id), 'a product with no variants is out of stock too');
  assert.ok(!out.rows.some((r) => r.id === inStock.id));

  const inside = await ok('/admin/products?stock=in&limit=100');
  assert.ok(inside.rows.some((r) => r.id === inStock.id));
  assert.ok(!inside.rows.some((r) => r.id === soldOut.id));

  // Composed filters.
  const composed = await ok(`/admin/products?status=published&stock=in&category=${categoryId}&limit=100`);
  assert.ok(composed.rows.every((r) => r.published && r.category_id === categoryId));

  // The summary ignores the filters, because the cards are filter shortcuts.
  const filtered = await ok('/admin/products?status=draft&limit=1');
  const unfiltered = await ok('/admin/products?limit=1');
  assert.deepEqual(filtered.summary, unfiltered.summary);
  assert.equal(filtered.summary.total, await mongo.products().countDocuments({}));
  assert.equal(filtered.summary.published, await mongo.products().countDocuments({published: true}));
  assert.equal(filtered.summary.drafts, await mongo.products().countDocuments({published: false}));
  assert.equal(filtered.summary.total, filtered.summary.published + filtered.summary.drafts);
  assert.ok(filtered.summary.out_of_stock >= 2);
});

test('an unknown category filter is rejected, not silently ignored', async () => {
  assert.equal((await call('/admin/products?category=not-a-uuid')).status, 400);
});

test('product paging is stable and never repeats or drops a row', async () => {
  const total = (await ok('/admin/products?limit=1')).total;
  const seen = [];
  const perPage = 3;
  const pages = Math.ceil(total / perPage);
  for (let page = 1; page <= pages; page += 1) {
    const data = await ok(`/admin/products?page=${page}&limit=${perPage}`);
    assert.equal(data.pages, pages);
    assert.equal(data.limit, perPage);
    seen.push(...data.rows.map((r) => r.id));
  }
  assert.equal(seen.length, total, 'every row appeared exactly once across the pages');
  assert.equal(new Set(seen).size, total, 'no row appeared on two pages');

  // Descending by created_at, with id breaking ties.
  const first = await ok(`/admin/products?limit=${Math.min(total, 50)}`);
  const times = first.rows.map((r) => new Date(r.created_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('one product comes back with its variants sorted by size then colour', async () => {
  const product = await makeProduct();
  await makeVariant(product.id, {size: 'XL', color: 'Zinc'});
  await makeVariant(product.id, {size: 'S', color: 'White'});
  await makeVariant(product.id, {size: 'S', color: 'Black'});

  const data = await ok(`/admin/products/${product.id}`);
  assert.equal(data.id, product.id);
  assert.deepEqual(data.variants.map((v) => `${v.size}/${v.color}`), ['S/Black', 'S/White', 'XL/Zinc']);
  assert.equal((await call(`/admin/products/${id()}`)).status, 404);
});

test('creating and updating a product writes an audit entry with it', async () => {
  const slug = `created-${randomUUID().slice(0, 8)}`;
  const created = await ok('/admin/products', {method: 'POST', body: {
    name: 'Created Tee', slug, description: 'A product created through the admin API.',
    brand: 'Gemies', category_id: categoryId, audience: 'Men', price: 123400,
    compare_price: null, images: ['/assets/products/a.webp'], published: true, featured: false,
  }});
  assert.ok(created.id);

  const stored = await mongo.products().findOne({_id: created.id});
  assert.equal(stored.slug, slug);
  assert.equal(stored.price, 123400);
  // Fields the SQL left to column defaults are still present.
  assert.equal(stored.is_demo, false);
  assert.equal(stored.display_order, 0);
  assert.deepEqual(stored.colorways, []);
  assert.deepEqual(stored.swatches, []);
  assert.ok(stored.created_at instanceof Date);
  assert.equal(stored.id, stored._id, 'the document carries both id forms');

  assert.equal(await mongo.auditLogs().countDocuments({action: 'product.create', entity_id: created.id}), 1);

  await ok(`/admin/products/${created.id}`, {method: 'PUT', body: {
    name: 'Renamed Tee', slug, description: 'A product created through the admin API.',
    brand: 'Gemies', category_id: categoryId, audience: 'Men', price: 99900,
    compare_price: null, images: ['/assets/products/a.webp'], published: false, featured: true,
  }});
  const updated = await mongo.products().findOne({_id: created.id});
  assert.equal(updated.name, 'Renamed Tee');
  assert.equal(updated.price, 99900);
  assert.equal(updated.published, false);
  assert.equal(updated.featured, true);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'product.update', entity_id: created.id}), 1);

  const missing = await call(`/admin/products/${id()}`, {method: 'PUT', body: {
    name: 'Nope', slug: `nope-${randomUUID().slice(0, 8)}`, description: 'Ten characters.',
    brand: 'Gemies', category_id: categoryId, audience: 'Men', price: 1000,
    compare_price: null, images: ['/assets/products/a.webp'], published: false, featured: false,
  }});
  assert.equal(missing.status, 404);
});

test('a failed product update rolls the audit entry back with it', async () => {
  // Two products, then an update that tries to take the other one's slug. The
  // unique index refuses it, which aborts the transaction the audit write is
  // in. This is the property the asSession bridge used to break.
  const taken = await makeProduct({slug: `taken-${randomUUID().slice(0, 8)}`});
  const victim = await makeProduct({slug: `victim-${randomUUID().slice(0, 8)}`});
  const auditBefore = await mongo.auditLogs().countDocuments({entity_id: victim.id});

  const conflict = await call(`/admin/products/${victim.id}`, {method: 'PUT', body: {
    name: 'Trying to steal a slug', slug: taken.slug,
    description: 'Long enough to pass validation.', brand: 'Gemies',
    category_id: categoryId, audience: 'Men', price: 50000,
    compare_price: null, images: ['/assets/products/a.webp'], published: true, featured: false,
  }});
  assert.equal(conflict.status, 409, 'a duplicate key is still a 409, as it was under PostgreSQL');
  assert.match(conflict.body.error, /already exists/);

  const after = await mongo.products().findOne({_id: victim.id});
  assert.equal(after.slug, victim.slug, 'the product is unchanged');
  assert.equal(after.name, victim.name);
  assert.equal(await mongo.auditLogs().countDocuments({entity_id: victim.id}), auditBefore,
    'no audit entry claims an update that did not happen');
});

test('a variant is created and updated, and stock cannot drop below reserved', async () => {
  const product = await makeProduct();
  const sku = `VAR-${randomUUID().slice(0, 8)}`;
  await ok(`/admin/products/${product.id}/variants`, {method: 'PUT', body: {
    sku, size: 'L', color: 'Olive', stock: 12,
  }});
  const created = await mongo.variants().findOne({sku});
  assert.equal(created.product_id, product.id);
  assert.equal(created.stock, 12);
  assert.equal(created.reserved, 0, 'a new variant holds nothing');
  assert.equal(await mongo.auditLogs().countDocuments({action: 'inventory.update', entity_id: product.id}), 1);

  await ok(`/admin/products/${product.id}/variants`, {method: 'PUT', body: {
    id: created.id, sku, size: 'L', color: 'Olive', stock: 20,
  }});
  assert.equal((await mongo.variants().findOne({_id: created.id})).stock, 20);

  // Three units are held by a checkout in progress.
  await mongo.variants().updateOne({_id: created.id}, {$set: {reserved: 3}});
  const tooLow = await call(`/admin/products/${product.id}/variants`, {method: 'PUT', body: {
    id: created.id, sku, size: 'L', color: 'Olive', stock: 2,
  }});
  assert.equal(tooLow.status, 409);
  assert.match(tooLow.body.error, /lower than reserved/);
  assert.equal((await mongo.variants().findOne({_id: created.id})).stock, 20, 'unchanged');

  // Exactly equal to reserved is allowed, as `reserved<=$4` was.
  await ok(`/admin/products/${product.id}/variants`, {method: 'PUT', body: {
    id: created.id, sku, size: 'L', color: 'Olive', stock: 3,
  }});
  assert.equal((await mongo.variants().findOne({_id: created.id})).stock, 3);

  // A variant that is not on this product is not found.
  const other = await makeProduct();
  const strayed = await call(`/admin/products/${other.id}/variants`, {method: 'PUT', body: {
    id: created.id, sku, size: 'L', color: 'Olive', stock: 5,
  }});
  assert.equal(strayed.status, 409);
});

test('deleting a product cascades to variants, carts and wishlists', async () => {
  const product = await makeProduct();
  const first = await makeVariant(product.id);
  const second = await makeVariant(product.id);
  await mongo.cartItems().insertOne({user_id: customerUser.id, variant_id: first.id, quantity: 1});
  await mongo.wishlist().insertOne({user_id: customerUser.id, product_id: product.id});
  // A row that must survive, so the delete is not simply emptying collections.
  const bystander = await makeProduct();
  const bystanderVariant = await makeVariant(bystander.id);
  await mongo.cartItems().insertOne({user_id: customerUser.id, variant_id: bystanderVariant.id, quantity: 1});

  await ok(`/admin/products/${product.id}`, {method: 'DELETE'});

  assert.equal(await mongo.products().countDocuments({_id: product.id}), 0);
  // PostgreSQL cascaded these; MongoDB does not, so the route has to.
  assert.equal(await mongo.variants().countDocuments({product_id: product.id}), 0, 'variants went too');
  assert.equal(await mongo.cartItems().countDocuments({variant_id: {$in: [first.id, second.id]}}), 0, 'cart rows went too');
  assert.equal(await mongo.wishlist().countDocuments({product_id: product.id}), 0, 'wishlist rows went too');
  assert.equal(await mongo.auditLogs().countDocuments({action: 'product.delete', entity_id: product.id}), 1);

  assert.equal(await mongo.variants().countDocuments({_id: bystanderVariant.id}), 1, 'the bystander is untouched');
  assert.equal(await mongo.cartItems().countDocuments({variant_id: bystanderVariant.id}), 1);

  assert.equal((await call(`/admin/products/${product.id}`, {method: 'DELETE'})).status, 404);
});

test('an ordered product and an ordered variant cannot be deleted', async () => {
  const order = await makePaidOrder();
  const refused = await call(`/admin/products/${order.product.id}`, {method: 'DELETE'});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /order line\(s\)/);
  assert.match(refused.body.error, /Untick Published/);
  assert.ok(await mongo.products().findOne({_id: order.product.id}), 'still there');

  const variantRefused = await call(`/admin/products/${order.product.id}/variants/${order.variant.id}`, {method: 'DELETE'});
  assert.equal(variantRefused.status, 409);
  assert.match(variantRefused.body.error, /Set its stock to 0/);
});

test('a reserved variant cannot be deleted', async () => {
  const product = await makeProduct();
  const variant = await makeVariant(product.id, {stock: 5, reserved: 2});
  const refused = await call(`/admin/products/${product.id}/variants/${variant.id}`, {method: 'DELETE'});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /reserved by a checkout/);

  await mongo.variants().updateOne({_id: variant.id}, {$set: {reserved: 0}});
  await mongo.cartItems().insertOne({user_id: customerUser.id, variant_id: variant.id, quantity: 1});
  await ok(`/admin/products/${product.id}/variants/${variant.id}`, {method: 'DELETE'});
  assert.equal(await mongo.variants().countDocuments({_id: variant.id}), 0);
  assert.equal(await mongo.cartItems().countDocuments({variant_id: variant.id}), 0, 'cart rows cascade');
  assert.equal(await mongo.auditLogs().countDocuments({action: 'inventory.delete', entity_id: variant.id}), 1);
});

/* ============================================================= categories */

test('the category list is a tree with both product counts', async () => {
  const data = await ok('/admin/categories?limit=100');
  const tshirts = data.rows.find((r) => r.id === categoryId);
  assert.ok(tshirts, 'the top-level category is a group');
  assert.equal(tshirts.parent_id, null);
  assert.ok(tshirts.children.some((c) => c.id === childCategoryId), 'its child is nested inside it');
  assert.equal(tshirts.href, '/shop/t-shirts');
  assert.equal(tshirts.children.find((c) => c.id === childCategoryId).href, '/shop/t-shirts/printed');

  const direct = await mongo.products().countDocuments({category_id: categoryId});
  const childDirect = await mongo.products().countDocuments({category_id: childCategoryId});
  assert.equal(tshirts.product_count, direct, 'product_count is what DELETE checks');
  assert.equal(tshirts.subtree_count, direct + childDirect, 'subtree_count includes the children');
  assert.equal(tshirts.child_count, 1);

  assert.equal(data.summary.total, await mongo.categories().countDocuments({}));
  assert.equal(data.summary.top_level, await mongo.categories().countDocuments({parent_id: null}));
  assert.equal(data.summary.subcategories, data.summary.total - data.summary.top_level);
  assert.equal(data.summary.in_nav, await mongo.categories().countDocuments({in_nav: true}));
  assert.equal(typeof data.rowsOnPage, 'number');
  assert.equal(typeof data.matchedRows, 'number');
});

test('category search keeps a matching child with its parent', async () => {
  const data = await ok('/admin/categories?q=printed&limit=100');
  const group = data.rows.find((r) => r.id === categoryId);
  assert.ok(group, 'the parent is present as context');
  assert.equal(group.context, true, 'and is flagged as context, not as a match');
  assert.equal(group.children.length, 1);
  assert.equal(group.children[0].id, childCategoryId);
  assert.equal(group.children[0].context, false);
  assert.equal(data.matchedRows, 1, 'one real match, the parent not counted');

  // Matching the parent brings the whole family.
  const byParent = await ok('/admin/categories?q=t-shirts&limit=100');
  const full = byParent.rows.find((r) => r.id === categoryId);
  assert.equal(full.context, false);
  assert.equal(full.children.length, 1, 'the parent matched, so its children are relevant');

  assert.equal((await ok('/admin/categories?q=zzz-no-such-category')).total, 0);
});

test('category scope and nav filters work, and paging is over groups', async () => {
  const hidden = await ok('/admin/categories', {method: 'POST', body: {
    name: 'Hidden Group', slug: `hidden-${randomUUID().slice(0, 6)}`, in_nav: false, display_order: 50,
  }});

  const visible = await ok('/admin/categories?nav=visible&limit=100');
  assert.ok(!visible.rows.some((r) => r.id === hidden.id));
  const invisible = await ok('/admin/categories?nav=hidden&limit=100');
  assert.ok(invisible.rows.some((r) => r.id === hidden.id));

  const topOnly = await ok('/admin/categories?scope=top&limit=100');
  assert.ok(topOnly.rows.every((r) => r.children.length === 0), 'scope=top hides the children');
  assert.ok(topOnly.rows.every((r) => !r.parent_id));

  const childOnly = await ok('/admin/categories?scope=child&limit=100');
  const group = childOnly.rows.find((r) => r.id === categoryId);
  assert.equal(group.context, true, 'the parent is context when only children are in scope');
  assert.ok(group.children.some((c) => c.id === childCategoryId));

  // `total` counts groups, not rows.
  const paged1 = await ok('/admin/categories?limit=1&page=1');
  assert.equal(paged1.rows.length, 1);
  assert.equal(paged1.total, await mongo.categories().countDocuments({parent_id: null}));
  assert.ok(paged1.rowsOnPage >= 1);

  await ok(`/admin/categories/${hidden.id}`, {method: 'DELETE'});
});

test('a category is created, updated and audited, and nesting is one level', async () => {
  const slug = `cat-${randomUUID().slice(0, 8)}`;
  const created = await ok('/admin/categories', {method: 'POST', body: {
    name: `Category ${slug}`, slug, segment: '', in_nav: true, display_order: 5,
  }});
  const stored = await mongo.categories().findOne({_id: created.id});
  assert.equal(stored.segment, slug, 'a blank segment defaults to the slug');
  assert.equal(stored.in_nav, true);
  assert.equal(stored.display_order, 5);
  assert.equal(stored.parent_id, null);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'category.create', entity_id: created.id}), 1);

  await ok(`/admin/categories/${created.id}`, {method: 'PUT', body: {
    name: 'Reparented', slug, segment: 'reparented', parent_id: categoryId,
    in_nav: false, display_order: 7,
  }});
  const updated = await mongo.categories().findOne({_id: created.id});
  assert.equal(updated.parent_id, categoryId);
  assert.equal(updated.segment, 'reparented');
  assert.equal(updated.in_nav, false);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'category.update', entity_id: created.id}), 1);

  // A child cannot be a parent: navigation is two levels deep.
  const tooDeep = await call('/admin/categories', {method: 'POST', body: {
    name: 'Third Level', slug: `third-${randomUUID().slice(0, 6)}`, parent_id: created.id, in_nav: false, display_order: 0,
  }});
  assert.equal(tooDeep.status, 400);
  assert.match(tooDeep.body.error, /one level deep/);

  // A category cannot be its own parent.
  const selfParent = await call(`/admin/categories/${created.id}`, {method: 'PUT', body: {
    name: 'Reparented', slug, segment: 'reparented', parent_id: created.id, in_nav: false, display_order: 7,
  }});
  assert.equal(selfParent.status, 400);
  assert.match(selfParent.body.error, /its own parent/);

  // A category with children cannot become a child itself.
  const demote = await call(`/admin/categories/${categoryId}`, {method: 'PUT', body: {
    name: 'T-Shirts', slug: 't-shirts', segment: 't-shirts', parent_id: created.id, in_nav: true, display_order: 0,
  }});
  assert.equal(demote.status, 400, 'the proposed parent is itself a child');

  assert.equal((await call(`/admin/categories/${id()}`, {method: 'PUT', body: {
    name: 'Missing', slug: `missing-${randomUUID().slice(0, 6)}`, in_nav: false, display_order: 0,
  }})).status, 404);

  await ok(`/admin/categories/${created.id}`, {method: 'DELETE'});
});

test('a duplicate category slug is a 409 and writes no audit entry', async () => {
  const slug = `dupe-${randomUUID().slice(0, 8)}`;
  const first = await ok('/admin/categories', {method: 'POST', body: {
    name: `First ${slug}`, slug, in_nav: false, display_order: 0,
  }});
  const auditBefore = await mongo.auditLogs().countDocuments({action: 'category.create'});

  const clash = await call('/admin/categories', {method: 'POST', body: {
    name: `Second ${slug}`, slug, in_nav: false, display_order: 0,
  }});
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /already uses that slug/);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'category.create'}), auditBefore,
    'the rolled-back create left no audit entry');
  assert.equal(await mongo.categories().countDocuments({slug}), 1);

  await ok(`/admin/categories/${first.id}`, {method: 'DELETE'});
});

test('two concurrent creates of one slug leave exactly one category', async () => {
  const slug = `race-${randomUUID().slice(0, 8)}`;
  const body = {name: `Race ${slug}`, slug, in_nav: false, display_order: 0};
  const results = await Promise.all([
    call('/admin/categories', {method: 'POST', body}),
    call('/admin/categories', {method: 'POST', body}),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 1, 'one created');
  assert.equal(results.filter((r) => r.status === 409).length, 1, 'one refused');
  assert.equal(await mongo.categories().countDocuments({slug}), 1);

  const survivor = await mongo.categories().findOne({slug});
  assert.equal(await mongo.auditLogs().countDocuments({action: 'category.create', entity_id: survivor._id}), 1,
    'exactly one audit entry, for the one that committed');
  await ok(`/admin/categories/${survivor._id}`, {method: 'DELETE'});
});

test('a category in use cannot be deleted', async () => {
  const withProducts = await call(`/admin/categories/${categoryId}`, {method: 'DELETE'});
  assert.equal(withProducts.status, 409);
  assert.match(withProducts.body.error, /product\(s\) are filed/);

  // A parent with children, and no products of its own.
  const parent = await ok('/admin/categories', {method: 'POST', body: {
    name: `Parent ${randomUUID().slice(0, 6)}`, slug: `parent-${randomUUID().slice(0, 6)}`, in_nav: false, display_order: 0,
  }});
  const child = await ok('/admin/categories', {method: 'POST', body: {
    name: `Child ${randomUUID().slice(0, 6)}`, slug: `child-${randomUUID().slice(0, 6)}`, parent_id: parent.id, in_nav: false, display_order: 0,
  }});
  const withChildren = await call(`/admin/categories/${parent.id}`, {method: 'DELETE'});
  assert.equal(withChildren.status, 409);
  assert.match(withChildren.body.error, /subcategory\(ies\)/);
  assert.ok(await mongo.categories().findOne({_id: child.id}), 'the child was not silently cascaded away');

  await ok(`/admin/categories/${child.id}`, {method: 'DELETE'});
  await ok(`/admin/categories/${parent.id}`, {method: 'DELETE'});
  assert.equal(await mongo.auditLogs().countDocuments({action: 'category.delete', entity_id: parent.id}), 1);
  assert.equal((await call(`/admin/categories/${parent.id}`, {method: 'DELETE'})).status, 404);
});

/* ================================================= orders, customers, inbox */

test('the order list searches email and exact number, and lifts the customer name', async () => {
  const order = await makePaidOrder();
  const byEmail = await ok(`/admin/orders?q=${encodeURIComponent(order.user.email)}`);
  assert.ok(byEmail.rows.some((r) => r.id === order.orderId));

  const byNumber = await ok(`/admin/orders?q=${order.number}`);
  assert.ok(byNumber.rows.some((r) => r.id === order.orderId));
  // An exact match, so a prefix must not drag in neighbouring numbers.
  const prefix = await ok(`/admin/orders?q=${String(order.number).slice(0, 2)}`);
  assert.ok(prefix.rows.every((r) => String(r.number).startsWith(String(order.number).slice(0, 2))
    || r.email.includes(String(order.number).slice(0, 2))));

  const row = byNumber.rows.find((r) => r.id === order.orderId);
  assert.equal(row.customer, order.user.name, "address->>'name' became `customer`");
  assert.equal(row.address, undefined, 'the full address is not in this response');
  assert.deepEqual(Object.keys(row).sort(),
    ['created_at', 'currency', 'customer', 'email', 'id', 'number', 'payment_status', 'status', 'total'].sort());

  const all = await ok('/admin/orders?limit=100');
  const times = all.rows.map((r) => new Date(r.created_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
});

test('the customer list carries order counts and captured spend', async () => {
  const buyer = await makeUser({name: 'Spender Singh', email: `spender-${randomUUID().slice(0, 6)}@example.invalid`});
  await makePaidOrder({user: buyer, total: 150000});
  await makePaidOrder({user: buyer, total: 250000});
  // An unpaid order must count toward `orders` but not toward `spend`.
  const unpaidId = id();
  await mongo.orders().insertOne({
    _id: unpaidId, id: unpaidId, number: 99001, user_id: buyer.id, email: buyer.email,
    address: {name: buyer.name}, subtotal: 9999, discount: 0, tax: 0, shipping: 0,
    total: 9999, tax_bps: 0, currency: 'INR', status: 'pending', payment_status: 'pending',
    reserved: true, wallet_applied: 0, wallet_coins: 0, checkout_key: `k-${randomUUID()}`,
    request_hash: 'x', expires_at: new Date(Date.now() + 600000), created_at: new Date(),
  });

  const byName = await ok('/admin/customers?q=Spender');
  const row = byName.rows.find((r) => r.id === buyer.id);
  assert.ok(row, 'found by name');
  assert.equal(row.orders, 3, 'every order counts');
  assert.equal(row.spend, 400000, 'only captured payments count toward spend');
  assert.equal(row.password_hash, undefined, 'no credential reaches the admin screen');

  const byEmail = await ok(`/admin/customers?q=${encodeURIComponent(buyer.email)}`);
  assert.ok(byEmail.rows.some((r) => r.id === buyer.id), 'found by email');

  // A customer with no orders reports zeroes, not nulls.
  const fresh = await makeUser({name: 'No Orders', email: `none-${randomUUID().slice(0, 6)}@example.invalid`});
  const freshRow = (await ok('/admin/customers?q=No%20Orders')).rows.find((r) => r.id === fresh.id);
  assert.equal(freshRow.orders, 0);
  assert.equal(freshRow.spend, 0);
});

test('the enquiry inbox filters, searches and toggles handled', async () => {
  const mk = async (patch) => {
    const mid = id();
    await mongo.contactMessages().insertOne({
      _id: mid, id: mid, fingerprint: `fp-${randomUUID()}`, name: 'Asker',
      email: `asker-${randomUUID().slice(0, 6)}@example.invalid`, subject: 'Sizing question',
      message: 'Does the medium run small across the shoulders?', order_number: null,
      user_id: null, handled_at: null, handled_by: null, created_at: new Date(), ...patch,
    });
    return mid;
  };
  const open = await mk({subject: 'Unique Zebra Subject'});
  const handled = await mk({handled_at: new Date(), handled_by: adminUser.id});
  const fromAccount = await mk({user_id: customerUser.id, order_number: '4242'});

  // 'open' is the default.
  const defaulted = await ok('/admin/contact?limit=100');
  assert.ok(defaulted.rows.some((r) => r.id === open.toString()));
  assert.ok(!defaulted.rows.some((r) => r.id === handled.toString()), 'handled is excluded by default');
  assert.equal(defaulted.open, await mongo.contactMessages().countDocuments({handled_at: null}));

  const handledOnly = await ok('/admin/contact?status=handled&limit=100');
  const handledRow = handledOnly.rows.find((r) => r.id === handled.toString());
  assert.ok(handledRow);
  assert.equal(handledRow.handled_by_email, adminUser.email, 'the handler is resolved to an email');
  assert.equal(handledRow.handled_by, undefined, 'the raw id is not leaked');

  const all = await ok('/admin/contact?status=all&limit=100');
  assert.ok(all.total >= 3);

  // Search covers name, email, subject and order number.
  assert.ok((await ok('/admin/contact?q=Unique%20Zebra&limit=100')).rows.some((r) => r.id === open.toString()));
  assert.ok((await ok('/admin/contact?q=4242&status=all&limit=100')).rows.some((r) => r.id === fromAccount.toString()));

  const accountRow = (await ok('/admin/contact?status=all&q=4242&limit=100')).rows.find((r) => r.id === fromAccount.toString());
  assert.equal(accountRow.from_account, true, 'user_id IS NOT NULL became a boolean');
  assert.equal(accountRow.user_id, undefined);
  const anonRow = (await ok('/admin/contact?q=Unique%20Zebra&limit=100')).rows[0];
  assert.equal(anonRow.from_account, false);

  // Toggle.
  await ok(`/admin/contact/${open}/handled`, {method: 'POST', body: {handled: true}});
  let row = await mongo.contactMessages().findOne({_id: open});
  assert.ok(row.handled_at instanceof Date);
  assert.equal(row.handled_by, adminUser.id);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'enquiry.handled', entity_id: open}), 1);

  await ok(`/admin/contact/${open}/handled`, {method: 'POST', body: {handled: false}});
  row = await mongo.contactMessages().findOne({_id: open});
  assert.equal(row.handled_at, null);
  assert.equal(row.handled_by, null);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'enquiry.reopened', entity_id: open}), 1);

  assert.equal((await call(`/admin/contact/${id()}/handled`, {method: 'POST', body: {handled: true}})).status, 404);
});

/* ========================================================== refund panel */

test('the refund panel reads its refunds from MongoDB', async () => {
  // This is the regression tranche 3 introduced: refunds moved to MongoDB with
  // fulfillment.mjs while this screen still read them over SQL, so the list
  // came back empty next to a refundable balance that did not.
  const order = await makePaidOrder({total: 500000, refundRows: [
    {refund_key: 'full', provider_id: 'rfnd_older', status: 'failed', amount: 500000, reason: 'Bank declined.', created_at: new Date(Date.now() - 60000)},
    {refund_key: 'goodwill', provider_id: 'rfnd_newer', status: 'processed', amount: 25000, reason: 'Goodwill on shipping.', created_at: new Date()},
  ]});

  const data = await ok(`/admin/orders/${order.orderId}/payment`);

  assert.equal(data.refunds.length, 2, 'the refunds are visible again');
  assert.equal(data.refunds[0].refund_key, 'goodwill', 'newest first');
  assert.equal(data.refunds[1].refund_key, 'full');
  assert.equal(data.refunds[0].provider_id, 'rfnd_newer', 'the payment reference is preserved');
  assert.equal(data.refunds[0].status, 'processed', 'the status is preserved');
  assert.equal(data.refunds[0].amount, 25000, 'the amount is preserved');
  assert.equal(data.refunds[0].reason, 'Goodwill on shipping.');
  assert.ok(!Number.isNaN(new Date(data.refunds[0].created_at).getTime()), 'the timestamp is preserved');
  assert.deepEqual(Object.keys(data.refunds[0]).sort(),
    ['amount', 'created_at', 'provider_id', 'reason', 'refund_key', 'status'],
    'still a named projection, so no future field can leak through it');

  // The balance and the list now agree: the failed refund does not count
  // against the capture, the processed one does.
  assert.equal(data.refundable, 500000 - 25000);

  assert.equal(data.order.id, order.orderId);
  assert.equal(data.order.number, order.number);
  assert.equal(data.order.address, undefined, 'the order projection is the named columns only');
  assert.equal(data.payment.status, 'captured');
  assert.equal(data.payment.amount, 500000);
  assert.ok(data.payment.gateway_payment_id.startsWith('pay_'));
  assert.equal(data.payment.id, undefined, 'the payment projection is named columns only');
  assert.ok(Array.isArray(data.attempts));
  assert.equal(data.mode, 'test');

  assert.equal((await call(`/admin/orders/${id()}/payment`)).status, 404);
});

test('an order with no payment reports null rather than failing', async () => {
  const orderId = id();
  await mongo.orders().insertOne({
    _id: orderId, id: orderId, number: 98001, user_id: customerUser.id, email: customerUser.email,
    address: {name: 'Asha Patel'}, subtotal: 1000, discount: 0, tax: 0, shipping: 0, total: 1000,
    tax_bps: 0, currency: 'INR', status: 'pending', payment_status: 'pending', reserved: false,
    wallet_applied: 0, wallet_coins: 0, checkout_key: `k-${randomUUID()}`, request_hash: 'x',
    expires_at: null, created_at: new Date(),
  });
  const data = await ok(`/admin/orders/${orderId}/payment`);
  assert.equal(data.payment, null);
  assert.deepEqual(data.refunds, []);
  assert.equal(data.refundable, 0);
});

test('a refund request is audited before the gateway is called', async () => {
  const order = await makePaidOrder();
  // The gateway is not configured to answer in this suite, so the call fails.
  // The audit entry is written first, deliberately: an attempted refund is a
  // thing an operator did, whether or not Razorpay accepted it.
  await call(`/admin/orders/${order.orderId}/refund`, {method: 'POST', body: {reason: 'Customer changed their mind.'}});
  assert.equal(await mongo.auditLogs().countDocuments({action: 'refund.request', entity_id: order.orderId}), 1);
});

/* ================================================ order & shipment actions */

test('the manual order transition is guarded by the order state', async () => {
  const order = await makePaidOrder();
  assert.equal((await call(`/admin/orders/${order.orderId}/status`, {method: 'POST', body: {status: 'shipped'}})).status, 400);

  await ok(`/admin/orders/${order.orderId}/status`, {method: 'POST', body: {status: 'processing'}});
  assert.equal((await mongo.orders().findOne({_id: order.orderId})).status, 'processing');
  assert.equal(await mongo.auditLogs().countDocuments({action: 'order.processing', entity_id: order.orderId}), 1);

  // No longer confirmed, so the same call is now an invalid transition.
  const again = await call(`/admin/orders/${order.orderId}/status`, {method: 'POST', body: {status: 'processing'}});
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Invalid order transition/);

  // An unpaid order cannot be moved either.
  const unpaidId = id();
  await mongo.orders().insertOne({
    _id: unpaidId, id: unpaidId, number: 98002, user_id: customerUser.id, email: customerUser.email,
    address: {name: 'Asha'}, subtotal: 1, discount: 0, tax: 0, shipping: 0, total: 1, tax_bps: 0,
    currency: 'INR', status: 'confirmed', payment_status: 'pending', reserved: false,
    wallet_applied: 0, wallet_coins: 0, checkout_key: `k-${randomUUID()}`, request_hash: 'x',
    expires_at: null, created_at: new Date(),
  });
  assert.equal((await call(`/admin/orders/${unpaidId}/status`, {method: 'POST', body: {status: 'processing'}})).status, 409);
});

test('fulfillment is queued once and only for an eligible order', async () => {
  const order = await makePaidOrder();
  await ok(`/admin/orders/${order.orderId}/fulfill`, {method: 'POST', body: {}});
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: `shipment:${order.orderId}`}), 1);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'shipment.request', entity_id: order.orderId}), 1);

  // Queued again is still one job: the dedupe key holds.
  await ok(`/admin/orders/${order.orderId}/fulfill`, {method: 'POST', body: {}});
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: `shipment:${order.orderId}`}), 1);

  await mongo.orders().updateOne({_id: order.orderId}, {$set: {payment_status: 'pending'}});
  const refused = await call(`/admin/orders/${order.orderId}/fulfill`, {method: 'POST', body: {}});
  assert.equal(refused.status, 409);
});

test('a failed job can be retried, and a healthy one cannot', async () => {
  const failedId = id();
  await mongo.jobs().insertOne({
    _id: failedId, id: failedId, kind: 'invoice', dedupe_key: `t6-retry-${randomUUID()}`,
    payload: {orderId: 'x'}, status: 'failed', attempts: 8,
    available_at: new Date(Date.now() + 3600000), locked_until: null,
    last_error: 'Job failed.', ran_at: new Date(), created_at: new Date(),
  });

  await ok(`/admin/jobs/${failedId}/retry`, {method: 'POST', body: {}});
  const job = await mongo.jobs().findOne({_id: failedId});
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0, 'the attempt count is reset so the backoff starts over');
  assert.equal(job.locked_until, null);
  assert.ok(job.available_at.getTime() <= Date.now() + 1000, 'available immediately');
  assert.equal(await mongo.auditLogs().countDocuments({action: 'job.retry', entity_id: failedId}), 1);

  // Now pending, so it cannot be retried again.
  const again = await call(`/admin/jobs/${failedId}/retry`, {method: 'POST', body: {}});
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Only failed jobs/);
  assert.equal((await call(`/admin/jobs/${id()}/retry`, {method: 'POST', body: {}})).status, 409);
  await mongo.jobs().deleteOne({_id: failedId});
});

test('payment reconciliation refuses a provider order that does not match', async () => {
  const order = await makePaidOrder();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === 'api.razorpay.com') {
      // Deliberately the wrong amount.
      return new Response(JSON.stringify({id: 'order_mismatch', receipt: order.orderId, amount: 1, currency: 'INR'}),
        {status: 200, headers: {'content-type': 'application/json'}});
    }
    return nativeFetch(url, options);
  };
  try {
    const refused = await call(`/admin/orders/${order.orderId}/reconcile-payment`, {
      method: 'POST', body: {gatewayOrderId: 'order_mismatch'},
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /does not match/);
    assert.equal(await mongo.auditLogs().countDocuments({action: 'payment.reconcile', entity_id: order.orderId}), 0);
  } finally { globalThis.fetch = nativeFetch; }
});

test('payment reconciliation does not re-point a payment that already has one', async () => {
  const order = await makePaidOrder();
  const existing = (await mongo.payments().findOne({order_id: order.orderId})).gateway_order_id;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === 'api.razorpay.com') {
      return new Response(JSON.stringify({id: 'order_other', receipt: order.orderId, amount: order.total, currency: 'INR'}),
        {status: 200, headers: {'content-type': 'application/json'}});
    }
    return nativeFetch(url, options);
  };
  try {
    await ok(`/admin/orders/${order.orderId}/reconcile-payment`, {
      method: 'POST', body: {gatewayOrderId: 'order_other'},
    });
    assert.equal((await mongo.payments().findOne({order_id: order.orderId})).gateway_order_id, existing,
      'the `gateway_order_id IS NULL` guard held');
  } finally { globalThis.fetch = nativeFetch; }
});

/* ======================================================= settings, coupons */

test('store settings round-trip, and the wallet policy has its own endpoint', async () => {
  const before = await ok('/admin/settings');
  assert.equal(before.id, 1);

  await ok('/admin/settings', {method: 'PUT', body: {
    shipping: 4900, free_shipping_threshold: 200000, tax_bps: 500,
    support_email: 'help@example.invalid', returns_policy: 'Returns within 7 days.',
    privacy_policy: 'We keep your data.', terms: 'Be nice.',
    social_x: 'https://x.com/gemies', social_facebook: '', social_instagram: '', social_linkedin: '',
  }});
  const after = await ok('/admin/settings');
  assert.equal(after.shipping, 4900);
  assert.equal(after.tax_bps, 500);
  assert.equal(after.support_email, 'help@example.invalid');
  assert.equal(after.social_x, 'https://x.com/gemies');
  // The storefront schema must not have touched the wallet fields.
  assert.equal(after.wallet_paise_per_coin, before.wallet_paise_per_coin);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'settings.update'}), 1);

  // A non-https social link is refused.
  assert.equal((await call('/admin/settings', {method: 'PUT', body: {
    shipping: 0, free_shipping_threshold: 0, tax_bps: 0, support_email: '',
    returns_policy: '', privacy_policy: '', terms: '',
    social_x: 'http://insecure.example', social_facebook: '', social_instagram: '', social_linkedin: '',
  }})).status, 400);
  // And the schema is strict.
  assert.equal((await call('/admin/settings', {method: 'PUT', body: {shipping: 0}})).status, 400);

  await ok('/admin/settings/wallet', {method: 'PUT', body: {
    wallet_enabled: true, wallet_paise_per_coin: 100, wallet_min_redeem_coins: 10,
    wallet_max_order_percent: 50, wallet_min_order_value: 50000,
    wallet_partial_redemption: true, wallet_coins_expire: true, wallet_expiry_days: 180,
    wallet_promo_enabled: true, exchange_enabled: true, exchange_window_days: 30,
    exchange_credit_shipping: false,
  }});
  const walletOn = await ok('/admin/settings');
  assert.equal(walletOn.wallet_enabled, true);
  assert.equal(walletOn.wallet_max_order_percent, 50);
  assert.equal(walletOn.exchange_window_days, 30);
  // And the storefront settings it must not have widened into are intact.
  assert.equal(walletOn.shipping, 4900);
  assert.equal(walletOn.support_email, 'help@example.invalid');
  assert.equal(await mongo.auditLogs().countDocuments({action: 'settings.wallet.update'}), 1);

  // Expiry on with no duration is contradictory.
  assert.equal((await call('/admin/settings/wallet', {method: 'PUT', body: {
    wallet_enabled: true, wallet_paise_per_coin: 100, wallet_min_redeem_coins: 0,
    wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_partial_redemption: true,
    wallet_coins_expire: true, wallet_expiry_days: 0, wallet_promo_enabled: false,
    exchange_enabled: false, exchange_window_days: 0, exchange_credit_shipping: false,
  }})).status, 400);
});

test('coupons are listed, upserted and deleted', async () => {
  const code = `SAVE${randomUUID().slice(0, 4).toUpperCase()}`;
  await ok('/admin/coupons', {method: 'PUT', body: {
    code, percent: 15, minimum: 100000, active: true, expires_at: '2027-01-01T23:59:59.000Z',
  }});
  let stored = await mongo.coupons().findOne({code});
  assert.equal(stored.percent, 15);
  assert.equal(stored.minimum, 100000);
  assert.equal(stored.active, true);
  assert.ok(stored.expires_at instanceof Date, 'stored as a date, as the timestamptz column was');
  assert.equal(stored.expires_at.toISOString(), '2027-01-01T23:59:59.000Z');
  assert.equal(await mongo.auditLogs().countDocuments({action: 'coupon.update', entity_id: code}), 1);

  // Same code again updates in place rather than adding a second row.
  await ok('/admin/coupons', {method: 'PUT', body: {
    code, percent: 25, minimum: 0, active: false, expires_at: null,
  }});
  assert.equal(await mongo.coupons().countDocuments({code}), 1);
  stored = await mongo.coupons().findOne({code});
  assert.equal(stored.percent, 25);
  assert.equal(stored.active, false);
  assert.equal(stored.expires_at, null);

  const list = await ok('/admin/coupons');
  assert.ok(Array.isArray(list));
  assert.ok(list.some((c) => c.code === code));
  const codes = list.map((c) => c.code);
  assert.deepEqual(codes, [...codes].sort(), 'ORDER BY code');

  // A lowercase code is upper-cased before it is stored.
  await ok('/admin/coupons', {method: 'PUT', body: {
    code: code.toLowerCase(), percent: 5, minimum: 0, active: true, expires_at: null,
  }});
  assert.equal(await mongo.coupons().countDocuments({code}), 1, 'still one row, not a second lowercase one');

  await ok(`/admin/coupons/${code}`, {method: 'DELETE'});
  assert.equal(await mongo.coupons().countDocuments({code}), 0);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'coupon.delete', entity_id: code}), 1);
  assert.equal((await call(`/admin/coupons/${code}`, {method: 'DELETE'})).status, 404);
});

/* ============================================================== exchanges */

test('the exchange queue joins its order and customer, and counts by status', async () => {
  const order = await makePaidOrder();
  const exchangeId = id();
  await mongo.exchangeRequests().insertOne({
    _id: exchangeId, id: exchangeId, number: 4242, order_id: order.orderId,
    user_id: order.user.id, status: 'requested', reason: 'size_too_small',
    reason_note: '', images: [], eligible_coins: 900, eligible_inr: 90000,
    calculation: {paisePerCoin: 100}, decision_note: '', credited_transaction_id: null,
    created_at: new Date(), updated_at: new Date(),
  });
  const lineId = id();
  await mongo.exchangeItems().insertOne({
    _id: lineId, id: lineId, exchange_id: exchangeId, order_item_id: order.itemId,
    quantity: 1, replacement_variant_id: null, eligible_inr: 90000,
  });

  const data = await ok('/admin/exchanges?limit=100');
  const row = data.rows.find((r) => r.id === exchangeId);
  assert.ok(row);
  assert.equal(row.number, 4242);
  assert.equal(row.order_number, order.number, 'joined from orders');
  assert.equal(row.order_total, order.total);
  assert.equal(row.currency, 'INR');
  assert.equal(row.customer_email, order.user.email, 'joined from users');
  assert.equal(row.customer_name, order.user.name);
  assert.equal(row.line_count, 1, 'the correlated count');
  assert.equal(row.eligible_coins, 900);
  assert.equal(row.user_id, undefined, 'the raw user id is not part of the row');
  assert.deepEqual(data.statuses, Object.keys((await import('../server/exchanges.mjs')).TRANSITIONS));
  assert.equal(data.byStatus.requested >= 1, true);

  // Status filter.
  const filtered = await ok('/admin/exchanges?status=requested&limit=100');
  assert.ok(filtered.rows.every((r) => r.status === 'requested'));
  assert.deepEqual(filtered.byStatus, data.byStatus, 'byStatus stays unfiltered');
  assert.equal((await call('/admin/exchanges?status=not_a_status')).status, 400);

  // Search by customer email and by exact order number.
  assert.ok((await ok(`/admin/exchanges?q=${encodeURIComponent(order.user.email)}&limit=100`)).rows.some((r) => r.id === exchangeId));
  assert.ok((await ok(`/admin/exchanges?q=${order.number}&limit=100`)).rows.some((r) => r.id === exchangeId));
  // A search that matches nobody returns nothing rather than everything.
  const empty = await ok('/admin/exchanges?q=nobody-at-all@example.invalid&limit=100');
  assert.equal(empty.total, 0);
  assert.equal(empty.rows.length, 0);

  const detail = await ok(`/admin/exchanges/${exchangeId}`);
  assert.equal(detail.id, exchangeId);
  assert.equal(detail.order_number, order.number);
  assert.ok(detail.credit, 'the live recomputation is attached');
  assert.equal(typeof detail.credit.coins, 'number');
  assert.equal((await call(`/admin/exchanges/${id()}`)).status, 404);
});

/* ============================================================ wallet admin */

test('wallet accounts list with balances, holds and transaction counts', async () => {
  const rich = await makeUser({name: 'Rich Roy', email: `rich-${randomUUID().slice(0, 6)}@example.invalid`});
  const poor = await makeUser({name: 'Poor Pat', email: `poor-${randomUUID().slice(0, 6)}@example.invalid`});
  const wallet = await import('../server/wallet.mjs');
  await wallet.postStandalone({userId: rich.id, kind: 'promotional_credit', coins: 500, idempotencyKey: `seed:${id()}`, description: 'Seed'});
  await wallet.postStandalone({userId: poor.id, kind: 'promotional_credit', coins: 10, idempotencyKey: `seed:${id()}`, description: 'Seed'});
  // A live hold, and an elapsed one that must not count.
  await mongo.walletReservations().insertMany([
    {_id: id(), user_id: rich.id, order_id: id(), coins: 40, status: 'held', idempotency_key: `h:${id()}`, expires_at: new Date(Date.now() + 600000), created_at: new Date()},
    {_id: id(), user_id: rich.id, order_id: id(), coins: 99, status: 'held', idempotency_key: `h:${id()}`, expires_at: new Date(Date.now() - 600000), created_at: new Date()},
  ]);

  const data = await ok('/admin/wallet/accounts?limit=100');
  const richRow = data.rows.find((r) => r.user_id === rich.id);
  assert.ok(richRow);
  assert.equal(richRow.email, rich.email, 'joined from users');
  assert.equal(richRow.name, 'Rich Roy');
  assert.equal(richRow.balance_coins, 500);
  assert.equal(richRow.lifetime_credited, 500);
  assert.equal(richRow.held_coins, 40, 'an expired hold does not count');
  assert.equal(richRow.transactions, 1);

  // Ordered by balance descending.
  const balances = data.rows.map((r) => r.balance_coins);
  assert.deepEqual(balances, [...balances].sort((a, b) => b - a));
  assert.ok(data.rows.findIndex((r) => r.user_id === rich.id) < data.rows.findIndex((r) => r.user_id === poor.id));

  assert.equal(data.summary.accounts, await mongo.walletAccounts().countDocuments({}));
  assert.ok(data.summary.outstanding_coins >= 510);
  assert.ok(data.summary.credited >= 510);

  // Searchable on the customer, which is the other side of the join.
  const searched = await ok('/admin/wallet/accounts?q=Rich%20Roy');
  assert.equal(searched.total, 1);
  assert.equal(searched.rows[0].user_id, rich.id);

  // One account's detail.
  const detail = await ok(`/admin/wallet/accounts/${rich.id}`);
  assert.equal(detail.user.id, rich.id);
  assert.equal(detail.user.email, rich.email);
  assert.equal(detail.summary.availableCoins, 460, 'balance less the live hold');
  assert.ok(Array.isArray(detail.rows));
  assert.equal(detail.integrity.balanced, true, 'the ledger and the cache agree');
  assert.equal((await call(`/admin/wallet/accounts/${id()}`)).status, 404);

  const integrity = await ok('/admin/wallet/integrity');
  assert.equal(integrity.accounts, await mongo.walletAccounts().countDocuments({}));
  assert.deepEqual(integrity.drifted, [], 'nothing has drifted');
});

test('an adjustment is idempotent and audited once', async () => {
  const user = await makeUser({name: 'Adjust Me', email: `adj-${randomUUID().slice(0, 6)}@example.invalid`});
  const key = `k${randomUUID().replaceAll('-', '')}`;
  const body = {coins: 75, direction: 'credit', reason: 'Goodwill after a delay.', idempotencyKey: key};

  const first = await ok(`/admin/wallet/accounts/${user.id}/adjust`, {method: 'POST', body});
  assert.equal(first.existing, false);
  assert.equal(first.transaction.coins, 75);
  assert.equal(first.transaction.direction, 'credit');

  const second = await ok(`/admin/wallet/accounts/${user.id}/adjust`, {method: 'POST', body});
  assert.equal(second.existing, true, 'a double-submitted form adjusts once');
  assert.equal(second.transaction.id, first.transaction.id);

  assert.equal((await mongo.walletAccounts().findOne({user_id: user.id})).balance_coins, 75);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'wallet.adjust', entity_id: first.transaction.id}), 1,
    'the repeat wrote no second audit entry');

  // A debit beyond the balance is refused by the wallet, not by this route.
  const overdraw = await call(`/admin/wallet/accounts/${user.id}/adjust`, {method: 'POST', body: {
    coins: 1000, direction: 'debit', reason: 'Trying to overdraw the wallet.', idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
  }});
  assert.equal(overdraw.status, 409);
  assert.equal((await mongo.walletAccounts().findOne({user_id: user.id})).balance_coins, 75, 'unchanged');
  assert.equal((await call(`/admin/wallet/accounts/${id()}/adjust`, {method: 'POST', body})).status, 404);
});

test('a promotional credit is gated on the setting that controls it', async () => {
  const user = await makeUser({name: 'Promo Target', email: `promo-${randomUUID().slice(0, 6)}@example.invalid`});
  const body = {coins: 50, reason: 'Launch week promotion.', idempotencyKey: `k${randomUUID().replaceAll('-', '')}`};

  await mongo.storeSettings().updateOne({_id: 1}, {$set: {wallet_promo_enabled: false}});
  const off = await call(`/admin/wallet/accounts/${user.id}/promo`, {method: 'POST', body});
  assert.equal(off.status, 409);
  assert.match(off.body.error, /Promotional credits are switched off/);

  await mongo.storeSettings().updateOne({_id: 1}, {$set: {wallet_enabled: true, wallet_promo_enabled: true}});
  const granted = await ok(`/admin/wallet/accounts/${user.id}/promo`, {method: 'POST', body});
  assert.equal(granted.transaction.kind, 'promotional_credit');
  assert.equal(granted.transaction.coins, 50);
  assert.equal(await mongo.auditLogs().countDocuments({action: 'wallet.promo', entity_id: granted.transaction.id}), 1);

  const repeat = await ok(`/admin/wallet/accounts/${user.id}/promo`, {method: 'POST', body});
  assert.equal(repeat.existing, true);
  assert.equal((await mongo.walletAccounts().findOne({user_id: user.id})).balance_coins, 50);

  await mongo.storeSettings().updateOne({_id: 1}, {$set: {wallet_enabled: false}});
  const walletOff = await call(`/admin/wallet/accounts/${user.id}/promo`, {method: 'POST', body: {
    ...body, idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
  }});
  assert.equal(walletOff.status, 409);
  assert.match(walletOff.body.error, /wallet is not enabled/);
  await mongo.storeSettings().updateOne({_id: 1}, {$set: {wallet_enabled: true}});
});

test('the expiry sweep refuses to run while expiry is switched off', async () => {
  await mongo.storeSettings().updateOne({_id: 1}, {$set: {wallet_coins_expire: false}});
  const off = await call('/admin/wallet/expire-now', {method: 'POST', body: {}});
  assert.equal(off.status, 409);
  assert.match(off.body.error, /Coin expiry is switched off/);

  await mongo.storeSettings().updateOne({_id: 1}, {$set: {wallet_coins_expire: true, wallet_expiry_days: 30}});
  const result = await ok('/admin/wallet/expire-now', {method: 'POST', body: {}});
  assert.equal(typeof result.expired, 'number');
  assert.equal(await mongo.auditLogs().countDocuments({action: 'wallet.expiry.run'}), 1);
});

test('two concurrent adjustments with one key move the balance once', async () => {
  const user = await makeUser({name: 'Race Wallet', email: `racew-${randomUUID().slice(0, 6)}@example.invalid`});
  const body = {coins: 30, direction: 'credit', reason: 'Concurrent double submit.', idempotencyKey: `k${randomUUID().replaceAll('-', '')}`};
  const results = await Promise.all([
    call(`/admin/wallet/accounts/${user.id}/adjust`, {method: 'POST', body}),
    call(`/admin/wallet/accounts/${user.id}/adjust`, {method: 'POST', body}),
  ]);
  assert.ok(results.every((r) => r.status === 200), 'both callers get an answer');
  assert.equal((await mongo.walletAccounts().findOne({user_id: user.id})).balance_coins, 30, 'credited once');
  assert.equal(await mongo.walletTransactions().countDocuments({user_id: user.id}), 1);
});

/* ============================================================== audit log */

test('the audit log resolves actors and names its entities', async () => {
  const product = await makeProduct({name: 'Audited Product'});
  const variant = await makeVariant(product.id);
  const order = await makePaidOrder();
  const entries = [
    ['product.update', product.id, 'Audited Product'],
    ['category.update', categoryId, 'T-Shirts'],
    ['order.processing', order.orderId, `Order #${order.number}`],
    ['inventory.update', variant.id, `${variant.sku} · ${product.name}`],
  ];
  for (const [action, entity] of entries) {
    const logId = id();
    await mongo.auditLogs().insertOne({
      _id: logId, id: logId, actor_id: adminUser.id, action, entity_id: entity, created_at: new Date(),
    });
  }

  const data = await ok('/admin/audit?limit=100');
  for (const [action, entity, expected] of entries) {
    const row = data.rows.find((r) => r.action === action && r.entity_id === entity);
    assert.ok(row, `${action} is in the log`);
    assert.equal(row.entity_label, expected, `${action} resolves its entity to a label`);
    assert.equal(row.actor_name, 'Site Admin');
    assert.equal(row.actor_email, adminUser.email);
    assert.equal(row.actor_id, undefined, 'the raw actor id is replaced, not added to');
  }

  // An entity that no longer exists cannot be named by any lookup.
  const orphanId = id();
  await mongo.auditLogs().insertOne({
    _id: orphanId, id: orphanId, actor_id: adminUser.id, action: 'product.delete',
    entity_id: id(), created_at: new Date(),
  });
  const orphan = (await ok('/admin/audit?action=product.delete&limit=100')).rows.find((r) => r.id === orphanId);
  assert.equal(orphan.entity_label, null, 'reported as unnamed rather than guessed at');

  // Newest first, filterable, and the action list is what was really recorded.
  const times = data.rows.map((r) => new Date(r.created_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  const filtered = await ok('/admin/audit?action=product.update&limit=100');
  assert.ok(filtered.rows.every((r) => r.action === 'product.update'));
  assert.equal(filtered.total, await mongo.auditLogs().countDocuments({action: 'product.update'}));
  assert.deepEqual(data.actions, [...data.actions].sort(), 'actions are sorted');
  assert.equal(new Set(data.actions).size, data.actions.length, 'and distinct');
  assert.ok(data.actions.includes('product.update'));
  assert.ok(!data.actions.includes('nothing.happened'));
});

test('audit paging reports a real total', async () => {
  const total = (await ok('/admin/audit?limit=1')).total;
  assert.equal(total, await mongo.auditLogs().countDocuments({}));
  const firstPage = await ok('/admin/audit?limit=5&page=1');
  assert.equal(firstPage.pages, Math.max(1, Math.ceil(total / 5)));
  assert.ok(firstPage.rows.length <= 5);
});

/* ========================================================= homepage rail */
//
// The hanging-garment hero. Its images and hang tags are product fields an
// operator edits, and GET /rail builds the hero from the catalogue at request
// time -- so a price change cannot leave a stale tag on the homepage.

/** The product body the strict schema accepts, with rail fields overridable. */
const productBody = (patch = {}) => ({
  name: 'Rail Tee', slug: `rail-${randomUUID().slice(0, 8)}`,
  description: 'A product used for the homepage rail tests.',
  brand: 'Gemies', category_id: categoryId, audience: 'Men', price: 79900,
  compare_price: null, images: ['/assets/products/a.webp'],
  published: true, featured: false, ...patch,
});

test('rail fields default to off, so an existing product is unaffected', async () => {
  const created = await ok('/admin/products', {method: 'POST', body: productBody()});
  const stored = await mongo.products().findOne({_id: created.id});
  assert.equal(stored.rail_enabled, false);
  assert.equal(stored.rail_front, null);
  assert.equal(stored.rail_back, null);
  assert.equal(stored.rail_tag, '');
});

test('an operator sets a front and a back rail image, and a hang tag', async () => {
  const created = await ok('/admin/products', {method: 'POST', body: productBody({
    rail_enabled: true,
    rail_front: '/uploads/rail-front.webp',
    rail_back: '/uploads/rail-back.webp',
    rail_tag: 'NEW',
  })});
  const stored = await mongo.products().findOne({_id: created.id});
  assert.equal(stored.rail_enabled, true);
  assert.equal(stored.rail_front, '/uploads/rail-front.webp');
  assert.equal(stored.rail_back, '/uploads/rail-back.webp');
  assert.equal(stored.rail_tag, 'NEW');

  // And they can be changed, including clearing the back again.
  await ok(`/admin/products/${created.id}`, {method: 'PUT', body: productBody({
    slug: stored.slug,
    rail_enabled: true,
    rail_front: '/uploads/rail-front-2.webp',
    rail_back: null,
    rail_tag: '',
  })});
  const updated = await mongo.products().findOne({_id: created.id});
  assert.equal(updated.rail_front, '/uploads/rail-front-2.webp');
  assert.equal(updated.rail_back, null);
  assert.equal(updated.rail_tag, '');
});

test('a rail image must be a path this app serves', async () => {
  // The same validator as the catalogue images: an arbitrary external host
  // cannot be put on the homepage.
  for (const bad of ['https://evil.example/x.webp', '/etc/passwd', 'rail.webp', '/assets/../secret.webp']) {
    const result = await call('/admin/products', {method: 'POST', body: productBody({rail_front: bad})});
    assert.equal(result.status, 400, bad);
  }
});

test('a rail entry with no front image is refused', async () => {
  const result = await call('/admin/products', {method: 'POST', body: productBody({rail_enabled: true})});
  assert.equal(result.status, 400);
  assert.match(result.body.error, /front rail image/);
});

test('GET /rail serves the rail from the catalogue, newest edits included', async () => {
  // Clear the rail so this test owns it.
  await mongo.products().updateMany({rail_enabled: true}, {$set: {rail_enabled: false}});

  const created = await ok('/admin/products', {method: 'POST', body: productBody({
    name: 'Rail Hero Tee', price: 123400,
    rail_enabled: true, rail_front: '/uploads/hero-front.webp', rail_back: '/uploads/hero-back.webp',
  })});

  const rail = await ok('/rail', {auth: null});
  const item = rail.items.find((r) => r.name.startsWith('Rail Hero Tee'));
  assert.ok(item, 'the product is on the rail');
  assert.equal(item.image, '/uploads/hero-front.webp');
  assert.equal(item.backImage, '/uploads/hero-back.webp', 'the back face is its own photo');
  assert.match(item.href, /^\/product\/rail-/);
  // No override, so the tag is the live price.
  assert.match(item.tag, /1,234/);

  // Change the price: the tag follows, with no rebuild and no stale figure.
  await ok(`/admin/products/${created.id}`, {method: 'PUT', body: productBody({
    name: 'Rail Hero Tee', slug: (await mongo.products().findOne({_id: created.id})).slug,
    price: 55500, rail_enabled: true, rail_front: '/uploads/hero-front.webp',
  })});
  const repriced = await ok('/rail', {auth: null});
  assert.match(repriced.items.find((r) => r.name.startsWith('Rail Hero Tee')).tag, /555/);

  // An override wins, and is what the operator typed.
  await ok(`/admin/products/${created.id}`, {method: 'PUT', body: productBody({
    name: 'Rail Hero Tee', slug: (await mongo.products().findOne({_id: created.id})).slug,
    price: 55500, rail_enabled: true, rail_front: '/uploads/hero-front.webp', rail_tag: 'SALE',
  })});
  assert.equal((await ok('/rail', {auth: null})).items.find((r) => r.name.startsWith('Rail Hero Tee')).tag, 'SALE');
});

test('the rail omits backImage rather than duplicating the front', async () => {
  await mongo.products().updateMany({rail_enabled: true}, {$set: {rail_enabled: false}});
  await ok('/admin/products', {method: 'POST', body: productBody({
    name: 'Front Only Tee', rail_enabled: true, rail_front: '/uploads/front-only.webp',
  })});
  const item = (await ok('/rail', {auth: null})).items.find((r) => r.name.startsWith('Front Only Tee'));
  assert.equal(item.image, '/uploads/front-only.webp');
  // Absent, not equal to the front: the component's fallback reuses the front,
  // and sending it twice would make the reverse look deliberate.
  assert.equal('backImage' in item, false);
});

test('the rail shows only what an operator put on it, and is public', async () => {
  await mongo.products().updateMany({rail_enabled: true}, {$set: {rail_enabled: false}});

  // Off the rail.
  await ok('/admin/products', {method: 'POST', body: productBody({name: 'Not On Rail'})});
  // On the rail but unpublished: a draft must not reach the homepage.
  const draft = await ok('/admin/products', {method: 'POST', body: productBody({
    name: 'Draft Rail Tee', published: false, rail_enabled: true, rail_front: '/uploads/draft.webp',
  })});
  // On the rail and published.
  await ok('/admin/products', {method: 'POST', body: productBody({
    name: 'Live Rail Tee', rail_enabled: true, rail_front: '/uploads/live.webp',
  })});

  const rail = await ok('/rail', {auth: null});
  const names = rail.items.map((r) => r.name);
  assert.ok(names.some((n) => n.startsWith('Live Rail Tee')));
  assert.ok(!names.some((n) => n.startsWith('Not On Rail')), 'not enabled');
  assert.ok(!names.some((n) => n.startsWith('Draft Rail Tee')), 'unpublished');

  // Public: no session needed, and no internal identifiers are exposed.
  const serialised = JSON.stringify(rail);
  assert.equal(serialised.includes(draft.id), false, 'the product id stays internal');
  assert.equal(serialised.includes('_id'), false);
});
