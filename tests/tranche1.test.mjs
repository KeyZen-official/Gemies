// Tranche 1 of the PostgreSQL to MongoDB migration: security, queue, catalog
// and auth, verified against an isolated in-memory replica set.
//
//   node --test tests/tranche1.test.mjs
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startMongo, stopMongo} from './mongo-harness.mjs';

process.env.NODE_ENV = 'test';
process.env.STORE_CURRENCY = 'INR';
process.env.APP_URL = 'http://localhost:3000';
process.env.RESEND_API_KEY = 'fixture';
process.env.EMAIL_FROM = 'fixture@example.invalid';
process.env.ADMIN_NOTIFICATION_EMAIL = 'ops@example.invalid';

// Must happen before server/mongo.mjs is loaded.
await startMongo();

const mongo = await import('../server/mongo.mjs');
const {id, hash, token, passwordHash, limit, audit, createSession, sessionMiddleware, HttpError} =
  await import('../server/security.mjs');
const {enqueue, queueEmail, queueAdminEmail} = await import('../server/queue.mjs');
const catalog = await import('../server/catalog.mjs');

before(async () => {
  await mongo.connect();
  await mongo.ensureSchema();
});
after(async () => {
  await mongo.close();
  await stopMongo();
});

/** A request/response pair thin enough to drive the middleware directly. */
const fakeRes = () => {
  const headers = {};
  return {
    cookies: {},
    set: (k, v) => { headers[k] = v; },
    cookie: (name, value, options) => { fakeRes.last = {name, value, options}; },
    headers,
  };
};

async function makeUser({email = `u${id()}@example.invalid`, role = 'customer', verified = true} = {}) {
  const uid = id();
  await mongo.users().insertOne({
    _id: uid, id: uid, name: 'Fixture', email,
    password_hash: await passwordHash('a-very-secure-test-password'),
    role, verified, created_at: new Date(),
  });
  return {id: uid, email, role, verified};
}

/* ------------------------------------------------------------------ security */

test('a session resolves to its user, and an expired one resolves to nobody', async () => {
  const user = await makeUser();
  const res = {cookie: () => {}};
  const csrf = await createSession(res, user.id);
  const raw = await mongo.sessions().findOne({user_id: user.id});
  assert.ok(raw, 'the session was written');
  assert.equal(raw._id, raw.token_hash, '_id mirrors the token hash');

  // sessionMiddleware hashes the cookie, so drive it with a known raw token.
  const rawToken = token();
  await mongo.sessions().insertOne({
    _id: hash(rawToken), token_hash: hash(rawToken), user_id: user.id,
    csrf: 'csrf-value', expires_at: new Date(Date.now() + 60000), created_at: new Date(),
  });
  const req = {headers: {cookie: `sid=${rawToken}`}};
  await new Promise((done) => sessionMiddleware(req, fakeRes(), done));
  assert.equal(req.user.id, user.id);
  assert.equal(req.user.email, user.email);
  assert.equal(req.user.role, 'customer');
  assert.equal(req.user.verified, true);
  assert.equal(req.user.csrf, 'csrf-value');
  assert.equal(req.sessionHash, hash(rawToken));

  // Expired.
  const stale = token();
  await mongo.sessions().insertOne({
    _id: hash(stale), token_hash: hash(stale), user_id: user.id,
    csrf: 'x', expires_at: new Date(Date.now() - 1000), created_at: new Date(),
  });
  const expiredReq = {headers: {cookie: `sid=${stale}`}};
  await new Promise((done) => sessionMiddleware(expiredReq, fakeRes(), done));
  assert.equal(expiredReq.user, undefined, 'an expired session authenticates nobody');
  assert.ok(csrf.length > 0);
});

test('a session whose user is gone authenticates nobody', async () => {
  const user = await makeUser();
  const raw = token();
  await mongo.sessions().insertOne({
    _id: hash(raw), token_hash: hash(raw), user_id: user.id,
    csrf: 'x', expires_at: new Date(Date.now() + 60000), created_at: new Date(),
  });
  await mongo.users().deleteOne({_id: user.id});
  const req = {headers: {cookie: `sid=${raw}`}};
  await new Promise((done) => sessionMiddleware(req, fakeRes(), done));
  assert.equal(req.user, undefined);
});

test('the rate limiter counts, blocks, and resets when the window elapses', async () => {
  const gate = limit('probe', 3, 900);
  const req = {ip: `1.2.3.${Math.floor(Math.random() * 250)}`};
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await new Promise((done, fail) => gate(req, fakeRes(), (e) => (e ? fail(e) : done())));
  }
  await assert.rejects(
    () => new Promise((done, fail) => { try { gate(req, fakeRes(), done).catch(fail); } catch (e) { fail(e); } }),
    (error) => error instanceof HttpError && error.status === 429,
    'the fourth request in the window is refused',
  );

  // Expire the window by hand; the next request must reset to 1, not stay
  // blocked. A plain $inc would have failed this.
  const key = hash(`probe:${req.ip}`);
  await mongo.rateLimits().updateOne({_id: key}, {$set: {expires_at: new Date(Date.now() - 1000)}});
  await new Promise((done, fail) => gate(req, fakeRes(), (e) => (e ? fail(e) : done())));
  const row = await mongo.rateLimits().findOne({_id: key});
  assert.equal(row.hits, 1, 'the counter reset rather than remaining blocked');
});

test('concurrent requests cannot both read the same rate-limit count', async () => {
  const gate = limit('race', 50, 900);
  const req = {ip: '9.9.9.9'};
  await Promise.all(Array.from({length: 20}, () => new Promise((done) => {
    gate(req, fakeRes(), done).catch(() => done());
  })));
  const row = await mongo.rateLimits().findOne({_id: hash(`race:${req.ip}`)});
  assert.equal(row.hits, 20, 'every one of the 20 requests was counted exactly once');
});

test('audit entries are written with an id mirroring _id', async () => {
  const user = await makeUser();
  const row = await audit(user.id, 'probe.action', 'entity-1');
  assert.equal(row.id, row._id);
  const stored = await mongo.auditLogs().findOne({_id: row._id});
  assert.equal(stored.actor_id, user.id);
  assert.equal(stored.action, 'probe.action');
  assert.equal(stored.entity_id, 'entity-1');
  assert.ok(stored.created_at instanceof Date);
});

/* --------------------------------------------------------------------- queue */

test('enqueue is idempotent on its dedupe key', async () => {
  const key = `job:${id()}`;
  await enqueue('invoice', key, {orderId: 'o1'});
  await enqueue('invoice', key, {orderId: 'DIFFERENT'});
  const rows = await mongo.jobs().find({dedupe_key: key}).toArray();
  assert.equal(rows.length, 1, 'one key is one job');
  assert.equal(rows[0].payload.orderId, 'o1', 'the first payload wins, as ON CONFLICT DO NOTHING did');
  assert.equal(rows[0].id, rows[0]._id);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].attempts, 0);
});

test('concurrent enqueues of one key produce one job', async () => {
  const key = `race:${id()}`;
  await Promise.all(Array.from({length: 10}, () => enqueue('tracking', key, {orderId: 'o'})));
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: key}), 1);
});

test('queueEmail writes a ledger row and a job, both idempotent', async () => {
  const key = `mail:${id()}`;
  await queueEmail(key, 'a@example.invalid', 'Subject', {template: 'paid', userId: 'u1', orderId: 'o1'});
  await queueEmail(key, 'b@example.invalid', 'Different', {template: 'paid'});

  const ledger = await mongo.emailNotifications().find({dedupe_key: key}).toArray();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].recipient, 'a@example.invalid');
  assert.equal(ledger[0].template, 'paid');
  assert.equal(ledger[0].user_id, 'u1');
  assert.equal(ledger[0].order_id, 'o1');
  assert.equal(ledger[0].status, 'pending');

  const job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.kind, 'email');
  assert.equal(job.payload.recipient, 'a@example.invalid');
  assert.equal(job.payload.key, key);
});

test('queueAdminEmail is a no-op without a configured address', async () => {
  const {config} = await import('../server/config.mjs');
  const original = config.adminEmail;
  config.adminEmail = '';
  assert.equal(await queueAdminEmail(`admin:${id()}`, 'S', {template: 'admin_order'}), false);
  config.adminEmail = original;
  const key = `ops:${id()}`;
  assert.equal(await queueAdminEmail(key, 'S', {template: 'admin_order'}), true);
  assert.ok(await mongo.jobs().findOne({dedupe_key: `admin:${key}`}));
});

test('a queue write joins the caller transaction when given a session', async () => {
  const key = `tx:${id()}`;
  await assert.rejects(() => mongo.transaction(async (session) => {
    await enqueue('invoice', key, {orderId: 'o'}, session);
    throw new Error('rolled back');
  }), /rolled back/);
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: key}), 0,
    'the job was rolled back with the transaction');
});

test('withSession turns an optional session into driver options', async () => {
  // This replaces a test for `asSession`, the bridge that recognised a
  // PostgreSQL client and dropped it. Tranche 6 removed it along with the last
  // PostgreSQL caller, so a session passed here is always honoured now.
  assert.deepEqual(mongo.withSession(undefined), {});
  assert.equal(mongo.asSession, undefined, 'the bridge is gone, not merely unused');

  const fake = {id: 'not-really-a-session'};
  assert.deepEqual(mongo.withSession(fake), {session: fake});

  // And an enqueue with no session still works on its own.
  const key = `sessionless:${id()}`;
  await enqueue('invoice', key, {orderId: 'o'});
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: key}), 1);
});

/* ------------------------------------------------------------------- catalog */

async function seedCatalogue() {
  const parentId = id();
  const childId = id();
  const hiddenId = id();
  await mongo.categories().insertMany([
    {_id: parentId, id: parentId, name: 'T-Shirts', slug: 't-shirts', segment: 't-shirts', parent_id: null, in_nav: true, display_order: 0},
    {_id: childId, id: childId, name: 'Oversized', slug: 't-shirts-oversized', segment: 'oversized', parent_id: parentId, in_nav: true, display_order: 1},
    {_id: hiddenId, id: hiddenId, name: 'Retired', slug: 'retired', segment: 'retired', parent_id: null, in_nav: false, display_order: 9},
  ]);

  const made = [];
  const add = async (name, slug, categoryId, price, extra = {}) => {
    const pid = id();
    await mongo.products().insertOne({
      _id: pid, id: pid, slug, name, description: `${name} description`, brand: 'Gemies',
      category_id: categoryId, audience: 'Men', price, compare_price: null,
      images: ['/assets/products/a.webp'], published: true, featured: false, is_demo: false,
      display_order: 0, created_at: new Date(), swatches: [], colorways: [{name: 'Black', hex: '#000000'}],
      fit: null, fabric: null, ...extra,
    });
    made.push(pid);
    return pid;
  };

  const onParent = await add('Parent Tee', 'parent-tee', parentId, 100000);
  const onChild = await add('Child Tee', 'child-tee', childId, 200000, {fit: 'Oversized'});
  const elsewhere = await add('Retired Tee', 'retired-tee', hiddenId, 50000);

  const variant = async (productId, size, color, stock, reserved = 0) => {
    const vid = id();
    await mongo.variants().insertOne({
      _id: vid, id: vid, product_id: productId, sku: `SKU-${vid.slice(0, 8)}`,
      size, color, stock, reserved,
    });
    return vid;
  };
  await variant(onParent, 'M', 'Black', 5);
  await variant(onParent, 'L', 'Black', 0);
  await variant(onChild, 'S', 'White', 3);
  await variant(elsewhere, 'M', 'Black', 0, 0);

  return {parentId, childId, hiddenId, onParent, onChild, elsewhere};
}

test('the category tree nests children and counts published products', async () => {
  const seed = await seedCatalogue();
  const tree = await catalog.categoryTree();
  const parent = tree.find((row) => row.slug === 't-shirts');
  assert.ok(parent, 'the navigable parent is present');
  assert.equal(parent.href, '/shop/t-shirts');
  assert.equal(parent.children.length, 1);
  assert.equal(parent.children[0].href, '/shop/t-shirts/oversized', 'the child URL nests under its parent');
  assert.equal(parent.product_count, 1, 'counts products filed directly on it');
  assert.equal(parent.children[0].product_count, 1);
  assert.equal(tree.some((row) => row.slug === 'retired'), false, 'in_nav=false stays out of the menu');
  assert.ok(seed.parentId);
});

test('a /shop path resolves to its category, both levels', async () => {
  const top = await catalog.resolveCategory(['t-shirts']);
  assert.equal(top.slug, 't-shirts');
  const child = await catalog.resolveCategory(['t-shirts', 'oversized']);
  assert.equal(child.slug, 't-shirts-oversized');
  // A child segment must not resolve as a top-level path.
  assert.equal(await catalog.resolveCategory(['oversized']), null);
  assert.equal(await catalog.resolveCategory(['nope']), null);
  assert.equal(await catalog.resolveCategory(['t-shirts', 'nope']), null);
  assert.equal(await catalog.resolveCategory([]), null);
});

test('a category listing includes its whole subtree', async () => {
  const all = await catalog.listProducts({});
  assert.ok(all.total >= 3, `expected the seeded products, got ${all.total}`);

  const parent = await catalog.listProducts({category: 't-shirts'});
  const slugs = parent.products.map((p) => p.slug);
  assert.ok(slugs.includes('parent-tee'), 'products on the parent');
  assert.ok(slugs.includes('child-tee'), 'and products in its subtree');
  assert.ok(!slugs.includes('retired-tee'), 'but nothing outside it');
  assert.equal(parent.total, 2);

  const child = await catalog.listProducts({category: 't-shirts-oversized'});
  assert.deepEqual(child.products.map((p) => p.slug), ['child-tee']);

  // An unknown category matches nothing rather than everything.
  assert.equal((await catalog.listProducts({category: 'does-not-exist'})).total, 0);
});

test('a listing carries category names, parent segment and available stock', async () => {
  const listing = await catalog.listProducts({category: 't-shirts-oversized'});
  const row = listing.products[0];
  assert.equal(row.category, 'Oversized');
  assert.equal(row.category_slug, 't-shirts-oversized');
  assert.equal(row.category_segment, 'oversized');
  assert.equal(row.category_parent_segment, 't-shirts', 'the parent segment is resolved for the URL');
  assert.equal(row.available, 3, 'available is stock minus reserved, summed over variants');
  assert.equal(row.id, row._id, 'id mirrors _id so API responses are unchanged');
});

test('search matches name, brand and description, case-insensitively', async () => {
  assert.equal((await catalog.listProducts({q: 'child tee'})).total, 1);
  assert.equal((await catalog.listProducts({q: 'CHILD'})).total, 1, 'case-insensitive');
  assert.ok((await catalog.listProducts({q: 'description'})).total >= 3, 'matches the description');
  assert.ok((await catalog.listProducts({q: 'gemies'})).total >= 3, 'matches the brand');
  assert.equal((await catalog.listProducts({q: 'zzznothing'})).total, 0);
  // A regex metacharacter must be treated as a literal, not a pattern.
  assert.equal((await catalog.listProducts({q: '.*'})).total, 0, 'the search term is escaped');
});

test('filters narrow the listing, including variant-level ones', async () => {
  assert.equal((await catalog.listProducts({size: 'S'})).total, 1, 'by size');
  assert.equal((await catalog.listProducts({color: 'White'})).total, 1, 'by colour');
  assert.equal((await catalog.listProducts({size: 'M,S'})).total, 3, 'multi-select is a union');
  assert.equal((await catalog.listProducts({fit: 'Oversized'})).total, 1, 'by fit');
  assert.equal((await catalog.listProducts({audience: 'Men'})).total >= 3, true, 'by audience');
  assert.equal((await catalog.listProducts({brand: 'Gemies'})).total >= 3, true, 'by brand');
  assert.equal((await catalog.listProducts({minPrice: 150000})).total, 1, 'by minimum price');
  assert.equal((await catalog.listProducts({maxPrice: 60000})).total, 1, 'by maximum price');
  assert.equal((await catalog.listProducts({minPrice: 90000, maxPrice: 150000})).total, 1, 'by a price range');
  // Only products with sellable stock.
  const inStock = await catalog.listProducts({inStock: 'true'});
  assert.ok(inStock.products.every((p) => p.available > 0));
  assert.equal(inStock.products.map((p) => p.slug).includes('retired-tee'), false, 'zero-stock excluded');
  // A variant filter combines with a category filter rather than replacing it.
  assert.equal((await catalog.listProducts({category: 't-shirts', size: 'S'})).total, 1);
});

test('sorting and pagination are stable', async () => {
  const low = await catalog.listProducts({sort: 'price-low', limit: 48});
  const prices = low.products.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  const high = await catalog.listProducts({sort: 'price-high', limit: 48});
  assert.equal(high.products[0].price, Math.max(...prices));
  const byName = await catalog.listProducts({sort: 'name', limit: 48});
  const names = byName.products.map((p) => p.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));

  const page1 = await catalog.listProducts({limit: 2, page: 1});
  const page2 = await catalog.listProducts({limit: 2, page: 2});
  assert.equal(page1.products.length, 2);
  assert.equal(page1.pages, Math.ceil(page1.total / 2));
  const overlap = page2.products.filter((p) => page1.products.some((q) => q._id === p._id));
  assert.equal(overlap.length, 0, 'pages do not repeat products');
});

test('facets report real options, and omit dimensions the data lacks', async () => {
  const {facets} = await catalog.listProducts({});
  assert.ok(facets.sizes.some((s) => s.value === 'M'));
  assert.ok(facets.sizes.every((s) => s.count > 0));
  // Shortest first, so S/M/L/XL reads in wearable order.
  const lengths = facets.sizes.map((s) => s.value.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));

  const black = facets.colors.find((c) => c.value === 'Black');
  assert.ok(black, 'colours are reported');
  assert.equal(black.hex, '#000000', 'the swatch hex comes from the product colourways');

  assert.ok(facets.fits.some((f) => f.value === 'Oversized'));
  assert.deepEqual(facets.fabrics, [], 'a dimension the catalogue does not carry returns empty');
  assert.equal(typeof facets.price.min, 'number');
  assert.ok(facets.price.max >= facets.price.min);
  assert.ok(facets.availability.total >= 3);
  assert.ok(facets.availability.inStock >= 2);
  assert.ok(facets.availability.inStock <= facets.availability.total);

  // Facets ignore the other active filters on purpose, so options do not
  // vanish underneath a customer ticking boxes.
  const filtered = await catalog.listProducts({size: 'S'});
  assert.equal(filtered.total, 1);
  assert.ok(filtered.facets.sizes.length > 1, 'all sizes still offered while one is selected');
});

test('an empty scope returns empty facets rather than throwing', async () => {
  const {facets, total} = await catalog.listProducts({q: 'zzznothing'});
  assert.equal(total, 0);
  assert.deepEqual(facets.sizes, []);
  assert.deepEqual(facets.colors, []);
  assert.deepEqual(facets.price, {min: null, max: null});
  assert.deepEqual(facets.availability, {inStock: 0, total: 0});
});

test('unpublished products never appear in the storefront listing', async () => {
  const pid = id();
  await mongo.products().insertOne({
    _id: pid, id: pid, slug: 'draft-tee', name: 'Draft Tee', description: 'Hidden draft',
    brand: 'Gemies', category_id: null, audience: 'Men', price: 1000, images: [],
    published: false, featured: false, is_demo: false, display_order: 0,
    created_at: new Date(), colorways: [],
  });
  assert.equal((await catalog.listProducts({q: 'Draft Tee'})).total, 0);
});

/* ---------------------------------------------------------- auth, over HTTP */

const {app} = await import('../server/app.mjs');
let server;
let base;

test('auth routes: registration, verification, login, reset and addresses', async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  base = `http://127.0.0.1:${server.address().port}`;

  const call = async (route, {method = 'GET', body, cookie, csrf} = {}) => {
    const res = await fetch(`${base}/api${route}`, {
      method,
      headers: {
        Origin: process.env.APP_URL,
        ...(body ? {'Content-Type': 'application/json'} : {}),
        ...(cookie ? {Cookie: cookie} : {}),
        ...(csrf ? {'X-CSRF-Token': csrf} : {}),
      },
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return {status: res.status, data, setCookie: res.headers.get('set-cookie')};
  };

  const address = `reg${Date.now().toString(36)}@example.invalid`;
  const secret = 'a-very-secure-test-password';

  // Registration is accepted and does not reveal whether the address was new.
  const first = await call('/auth/register', {method: 'POST', body: {name: 'New Person', email: address, password: secret}});
  assert.equal(first.status, 202);
  const second = await call('/auth/register', {method: 'POST', body: {name: 'Imposter', email: address, password: secret}});
  assert.equal(second.status, 202, 'a duplicate returns the same response');
  assert.deepEqual(second.data, first.data, 'and the identical message');
  assert.equal(await mongo.users().countDocuments({email: address}), 1,
    'the unique index kept it to one account');
  assert.equal((await mongo.users().findOne({email: address})).name, 'New Person',
    'the second registration did not overwrite the first');

  // Unverified accounts cannot sign in.
  const blocked = await call('/auth/login', {method: 'POST', body: {email: address, password: secret}});
  assert.equal(blocked.status, 403);

  // The verification token reached the queue, hashed, with the raw value only
  // in the job payload.
  const job = await mongo.jobs().findOne({kind: 'email', 'payload.template': 'verify', 'payload.recipient': address});
  assert.ok(job, 'a verification email was queued');
  const raw = job.payload.data.url.match(/token=([a-f0-9]{64})/)[1];
  assert.ok(await mongo.authTokens().findOne({token_hash: hash(raw), kind: 'verify'}),
    'only the hash is stored');
  assert.ok(await mongo.emailNotifications().findOne({recipient: address, template: 'verify'}),
    'and the ledger row exists');
  assert.ok(await mongo.jobs().findOne({dedupe_key: `welcome:${(await mongo.users().findOne({email: address}))._id}`}),
    'the welcome email is keyed on the user so it can only be sent once');

  // Single use.
  assert.equal((await call('/auth/verify', {method: 'POST', body: {token: raw}})).status, 200);
  assert.equal((await call('/auth/verify', {method: 'POST', body: {token: raw}})).status, 400,
    'the token cannot be replayed');
  assert.equal((await mongo.users().findOne({email: address})).verified, true);

  // Sign in.
  const login = await call('/auth/login', {method: 'POST', body: {email: address, password: secret}});
  assert.equal(login.status, 200);
  assert.equal(login.data.user.email, address);
  assert.equal(login.data.user.role, 'customer');
  assert.ok(login.data.user.csrf);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Lax/);
  const cookie = login.setCookie.split(';')[0];
  const csrf = login.data.user.csrf;

  // The session resolves on a later request.
  const session = await call('/auth/session', {cookie});
  assert.equal(session.data.user.email, address);

  // Wrong password, and an unknown address, are both 401 and indistinguishable.
  assert.equal((await call('/auth/login', {method: 'POST', body: {email: address, password: 'wrong-password-here'}})).status, 401);
  assert.equal((await call('/auth/login', {method: 'POST', body: {email: 'nobody@example.invalid', password: secret}})).status, 401);

  // CSRF and origin are enforced on writes.
  assert.equal((await call('/auth/profile', {method: 'PATCH', cookie, body: {name: 'No Token'}})).status, 403,
    'a write without the CSRF token is refused');
  assert.equal((await call('/auth/profile', {method: 'PATCH', cookie, csrf, body: {name: 'Renamed Person'}})).status, 200);
  assert.equal((await mongo.users().findOne({email: address})).name, 'Renamed Person');

  // Addresses.
  const addressBody = {
    name: 'Fixture Customer', phone: '9876543210', line1: '123 Test street', line2: '',
    city: 'Test City', state: 'Test State', postalCode: '400001', country: 'India',
  };
  assert.equal((await call('/auth/addresses', {method: 'POST', cookie, csrf, body: addressBody})).status, 201);
  const saved = await call('/auth/addresses', {cookie});
  assert.equal(saved.data.length, 1);
  assert.equal(saved.data[0].details.city, 'Test City');
  assert.ok(saved.data[0].id, 'the address carries an id');
  assert.equal((await call(`/auth/addresses/${saved.data[0].id}`, {method: 'DELETE', cookie, csrf})).status, 200);
  assert.equal((await call('/auth/addresses', {cookie})).data.length, 0);

  // Password reset invalidates every session and cannot be replayed.
  assert.equal((await call('/auth/forgot', {method: 'POST', body: {email: address}})).status, 200);
  const resetJob = await mongo.jobs().findOne({kind: 'email', 'payload.template': 'reset', 'payload.recipient': address});
  const resetToken = resetJob.payload.data.url.match(/token=([a-f0-9]{64})/)[1];
  const reset = await call('/auth/reset', {method: 'POST', body: {token: resetToken, password: 'a-brand-new-passphrase'}});
  assert.equal(reset.status, 200);
  assert.equal((await call('/auth/session', {cookie})).data.user, null,
    'every existing session was destroyed');
  assert.equal((await call('/auth/reset', {method: 'POST', body: {token: resetToken, password: 'another-one-entirely'}})).status, 400,
    'the reset token cannot be replayed');
  assert.ok(await mongo.emailNotifications().findOne({recipient: address, template: 'password_changed'}),
    'the owner is told their password changed');

  // And the new password works.
  assert.equal((await call('/auth/login', {method: 'POST', body: {email: address, password: 'a-brand-new-passphrase'}})).status, 200);

  await new Promise((done) => server.close(done));
});

test('admin role is read from the database, never from the client', async () => {
  const server2 = app.listen(0, '127.0.0.1');
  await new Promise((done) => server2.once('listening', done));
  const at = `http://127.0.0.1:${server2.address().port}`;

  const customer = await makeUser({role: 'customer'});
  const raw = token();
  await mongo.sessions().insertOne({
    _id: hash(raw), token_hash: hash(raw), user_id: customer.id,
    csrf: 'c', expires_at: new Date(Date.now() + 60000), created_at: new Date(),
  });
  const res = await fetch(`${at}/api/auth/session`, {headers: {Origin: process.env.APP_URL, Cookie: `sid=${raw}`}});
  const body = await res.json();
  assert.equal(body.user.role, 'customer', 'the role comes from the user document');

  // Promote in the database only; the same cookie must now report admin.
  await mongo.users().updateOne({_id: customer.id}, {$set: {role: 'admin'}});
  const after = await (await fetch(`${at}/api/auth/session`, {headers: {Origin: process.env.APP_URL, Cookie: `sid=${raw}`}})).json();
  assert.equal(after.user.role, 'admin', 'role is re-read per request, not cached in the session');

  await new Promise((done) => server2.close(done));
});
