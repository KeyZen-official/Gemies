// The Shiprocket integration, end to end, against a mocked provider.
//
// Nothing here reaches Shiprocket. Every call is served by the stub below,
// which records what was asked for so "the provider was called once" is an
// assertion rather than an assumption. No real shipment is ever created.
//
//   node --test tests/shiprocket.test.mjs
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startMongo, stopMongo} from './mongo-harness.mjs';

process.env.NODE_ENV = 'test';
process.env.STORE_CURRENCY = 'INR';
process.env.APP_URL = 'http://localhost:3000';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture';
process.env.RAZORPAY_KEY_SECRET = 'fixture-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'fixture-webhook';
process.env.RESEND_API_KEY = 'fixture';
process.env.EMAIL_FROM = 'fixture@example.invalid';
process.env.ADMIN_NOTIFICATION_EMAIL = 'ops@example.invalid';
// Invoices refuse to issue without a configured business identity, and one
// test checks a shipping label cannot disturb an invoice.
process.env.BUSINESS_NAME = 'TEST FIXTURE - NOT A REAL INVOICE';
process.env.BUSINESS_ADDRESS = 'Test address only';
process.env.BUSINESS_EMAIL = 'fixture@example.invalid';
// Shiprocket, fully configured. The password is a fixture and never leaves
// this process.
process.env.SHIPROCKET_EMAIL = 'ship@example.invalid';
process.env.SHIPROCKET_PASSWORD = 'fixture-password';
process.env.SHIPROCKET_PICKUP_LOCATION = 'Primary';
process.env.SHIPROCKET_PICKUP_PINCODE = '400103';
process.env.SHIPROCKET_WEBHOOK_SECRET = 'fixture-shiprocket-webhook-secret';
process.env.PACKAGE_WEIGHT_KG = '0.4';
process.env.PACKAGE_LENGTH_CM = '25';
process.env.PACKAGE_BREADTH_CM = '20';
process.env.PACKAGE_HEIGHT_CM = '4';

await startMongo();

const mongo = await import('../server/mongo.mjs');
const {id, passwordHash} = await import('../server/security.mjs');
const {app} = await import('../server/app.mjs');
const commerce = await import('../server/commerce.mjs');
const fulfillment = await import('../server/fulfillment.mjs');
const sr = await import('../server/shiprocket.mjs');
const providers = await import('../server/providers.mjs');
const {runJob} = await import('../server/jobs.mjs');

/**
 * Works the queue until it is empty.
 *
 * runJob() claims the oldest due job, which after a shipment is created is an
 * email rather than the reconciliation the test is waiting on. Draining is
 * what the worker does anyway -- it calls runJob in a loop.
 */
async function drain(limit = 400) {
  for (let i = 0; i < limit; i += 1) if (!await runJob()) return i;
  return limit;
}

const PASSWORD = 'a-very-secure-test-password';
const ORIGIN = 'http://localhost:3000';

/* -------------------------------------------------------- the provider stub */

/**
 * A Shiprocket stub that behaves like the real thing in the ways that matter:
 * it requires a bearer token, it can expire that token, it can rate-limit, and
 * it returns their actual response shapes.
 */
const calls = [];
let authCount = 0;
let token = 'stub-token-1';
let rejectToken = false;
let rateLimitOnce = false;
let failPath = '';
let timeoutPath = '';
let awbSeq = 0;
const parcels = new Map();   // provider shipment id -> {awb, courier, status, code}
const byAwb = new Map();
let serviceable = true;

const nativeFetch = globalThis.fetch;
let base = null;

globalThis.fetch = async (url, options = {}) => {
  if (base && String(url).startsWith(base)) return nativeFetch(url, options);
  const address = new URL(url);
  const path = address.pathname.replace('/v1/external', '');
  const body = options.body ? JSON.parse(options.body) : null;

  if (address.hostname === 'api.resend.com') {
    return json({id: 'test-email-id'});
  }
  if (address.hostname === 'api.razorpay.com') {
    const key = address.pathname.replace('/v1', '');
    if (key === '/orders' && options.method === 'POST') {
      const order = {id: `order_${randomUUID().replaceAll('-', '')}`, amount: body.amount, currency: body.currency, receipt: body.receipt};
      parcels.set(order.id, order);
      return json(order);
    }
    return json(parcels.get(key.split('/').at(-1)) ?? {});
  }
  if (address.hostname !== 'apiv2.shiprocket.in') throw new Error(`Unexpected call: ${url}`);

  calls.push({path, body, auth: options.headers?.Authorization ?? null});

  if (path === '/auth/login') {
    authCount += 1;
    rejectToken = false;
    token = `stub-token-${authCount}`;
    return json({token});
  }

  // Everything else needs the current bearer token.
  if (options.headers?.Authorization !== `Bearer ${token}` || rejectToken) {
    return json({message: 'Unauthenticated.'}, 401);
  }
  if (timeoutPath && path.includes(timeoutPath)) throw new Error('simulated network timeout');
  if (rateLimitOnce && path.includes('/courier/serviceability')) {
    rateLimitOnce = false;
    return json({message: 'Too many requests', retry_after: 0}, 429);
  }
  if (failPath && path.includes(failPath)) {
    return json({message: 'Pickup location is not serviceable for this courier.'}, 422);
  }

  if (path === '/orders/create/adhoc') {
    const providerOrderId = `${60000 + parcels.size}`;
    const providerShipmentId = `${90000 + parcels.size}`;
    parcels.set(providerShipmentId, {providerOrderId, awb: null, courier: null, status: 'NEW', code: 1, activities: []});
    return json({order_id: Number(providerOrderId), shipment_id: Number(providerShipmentId), status: 'NEW'});
  }
  if (path === '/courier/serviceability/') {
    if (!serviceable) return json({data: {available_courier_companies: []}});
    return json({data: {available_courier_companies: [
      {courier_company_id: 51, courier_name: 'Delhivery Surface', rate: 62.5, estimated_delivery_days: '4', etd: 'Feb 2, 2026', cod: 1, rating: 4.2},
      {courier_company_id: 11, courier_name: 'Bluedart Express', rate: 128.0, estimated_delivery_days: '2', etd: 'Jan 31, 2026', cod: 0, rating: 4.6},
    ]}});
  }
  if (path === '/courier/assign/awb') {
    const parcel = parcels.get(String(body.shipment_id));
    if (!parcel) return json({message: 'Shipment not found.'}, 404);
    awbSeq += 1;
    parcel.awb = `AWB${1000 + awbSeq}`;
    parcel.courier = body.courier_id === 11 ? 'Bluedart Express' : 'Delhivery Surface';
    parcel.courierId = body.courier_id ?? 51;
    parcel.status = 'PICKUP SCHEDULED';
    parcel.code = 2;
    byAwb.set(parcel.awb, parcel);
    return json({response: {data: {
      awb_code: parcel.awb, courier_name: parcel.courier,
      courier_company_id: parcel.courierId, applied_weight: 0.5, freight_charges: 62.5,
    }}});
  }
  if (path === '/courier/generate/pickup') {
    const parcel = parcels.get(String(body.shipment_id[0]));
    if (!parcel) return json({message: 'Shipment not found.'}, 404);
    parcel.pickup = 'PICKUP_SCHEDULED';
    return json({response: {pickup_token_number: 'PKT-991', pickup_scheduled_date: '2026-01-30 10:00:00', pickup_status: 1}, message: 'Pickup scheduled'});
  }
  if (path === '/courier/generate/label') {
    return json({label_created: 1, label_url: 'https://shiprocket.example.invalid/label/abc.pdf'});
  }
  if (path === '/manifests/generate') {
    const parcel = parcels.get(String(body.shipment_id[0]));
    if (!parcel?.pickup) return json({message: 'Manifest is available after a pickup is scheduled.'}, 422);
    return json({manifest_url: 'https://shiprocket.example.invalid/manifest/abc.pdf'});
  }
  if (path === '/orders/cancel/shipment/awbs') {
    for (const awb of body.awbs) {
      const parcel = byAwb.get(awb);
      if (parcel) { parcel.status = 'CANCELED'; parcel.code = 8; }
    }
    return json({message: 'Shipment cancelled successfully.'});
  }
  if (path === '/orders/cancel') return json({message: 'Order cancelled successfully.'});

  if (path.startsWith('/courier/track/awb/')) {
    const parcel = byAwb.get(decodeURIComponent(path.split('/').at(-1)));
    if (!parcel) return json({tracking_data: {track_status: 0, error: 'No data'}});
    return json({tracking_data: trackingFor(parcel)});
  }
  if (path.startsWith('/courier/track/shipment/')) {
    const parcel = parcels.get(decodeURIComponent(path.split('/').at(-1)));
    if (!parcel) return json({tracking_data: {track_status: 0, error: 'No data'}});
    return json({tracking_data: trackingFor(parcel)});
  }
  return json({message: `stub has no route for ${path}`}, 404);
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

function trackingFor(parcel) {
  return {
    track_status: 1,
    shipment_status: parcel.code,
    track_url: 'https://shiprocket.example.invalid/track/abc',
    shipment_track: [{
      awb_code: parcel.awb,
      current_status: parcel.status,
      current_status_code: parcel.code,
      courier_name: parcel.courier,
      edd: '2026-02-02 18:00:00',
      ...(parcel.code === 7 ? {delivered_date: '2026-02-01 14:30:00'} : {}),
    }],
    shipment_track_activities: parcel.activities ?? [],
  };
}

/** Moves the stubbed parcel on, as a courier scan would. */
function advance(providerShipmentId, status, code, extra = {}) {
  const parcel = parcels.get(String(providerShipmentId));
  parcel.status = status;
  parcel.code = code;
  parcel.activities = [{status, activity: extra.activity ?? status, location: extra.location ?? 'Mumbai', date: extra.date ?? '2026-01-31 09:00:00'}, ...(parcel.activities ?? [])];
  return parcel;
}

/* ------------------------------------------------------------------ fixtures */

const ADDRESS = {
  name: 'Asha Patel', phone: '9876543210', line1: '12 Linking Road', line2: 'Flat 4',
  city: 'Mumbai', state: 'Maharashtra', postalCode: '400050', country: 'India',
};

let server, adminAuth, customerAuth, adminUser, productId;

async function call(path, {method = 'GET', body, auth = adminAuth} = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers.origin = ORIGIN;
  if (auth) { headers.cookie = auth.cookie; if (method !== 'GET') headers['x-csrf-token'] = auth.csrf; }
  const response = await nativeFetch(`${base}/api${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return {status: response.status, body: payload};
}
async function ok(path, options) {
  const result = await call(path, options);
  assert.ok(result.status >= 200 && result.status < 300, `${options?.method ?? 'GET'} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function signIn(email) {
  const response = await nativeFetch(`${base}/api/auth/login`, {
    method: 'POST', headers: {'content-type': 'application/json', origin: ORIGIN},
    body: JSON.stringify({email, password: PASSWORD}),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  return {cookie: (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '), csrf: payload.user.csrf};
}

async function makeUser(role = 'customer') {
  const uid = id();
  const email = `${role}-${uid.slice(0, 8)}@example.invalid`;
  await mongo.users().insertOne({
    _id: uid, id: uid, name: 'Asha Patel', email,
    password_hash: await passwordHash(PASSWORD), role, verified: true, created_at: new Date(),
  });
  return {id: uid, email, role};
}

let seq = 0;
/** A paid order, which is the only kind that may be shipped. */
async function paidOrder({address = ADDRESS, user = null} = {}) {
  const buyer = user ?? await makeUser();
  seq += 1;
  const vid = id();
  await mongo.variants().insertOne({_id: vid, id: vid, product_id: productId, sku: `SR-SKU-${seq}`, size: 'M', color: `Black-${seq}`, stock: 10, reserved: 0});
  await mongo.cartItems().insertOne({user_id: buyer.id, variant_id: vid, quantity: 2});
  const order = await commerce.createOrder(buyer, {address, coupon: ''}, `key-${randomUUID()}`);
  const p = await commerce.paymentOrder(order.id);
  const payment = {id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id, amount: p.amount, currency: p.currency, status: 'captured', captured: true, method: 'card'};
  parcels.set(payment.id, payment);
  await commerce.acceptCapturedPayment(payment);
  return {orderId: order.id, number: order.number, user: buyer, total: order.total};
}

const shipmentOf = (orderId) => mongo.shipments().findOne({order_id: orderId});
const countCalls = (fragment) => calls.filter((c) => c.path.includes(fragment)).length;

before(async () => {
  await mongo.connect();
  await mongo.ensureSchema();
  const categoryId = id();
  productId = id();
  await mongo.categories().insertOne({_id: categoryId, id: categoryId, name: 'Tees', slug: 'tees', segment: 'tees', parent_id: null, in_nav: true, display_order: 0});
  await mongo.products().insertOne({
    _id: productId, id: productId, slug: 'shiprocket-tee', name: 'Shiprocket Tee',
    description: 'Fixture product.', brand: 'Gemies', category_id: categoryId, audience: 'Men',
    price: 100000, compare_price: null, images: ['/assets/products/a.webp'], published: true,
    featured: false, is_demo: false, display_order: 0, swatches: [], colorways: [], fit: null,
    fabric: null, created_at: new Date(),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  adminUser = await makeUser('admin');
  adminAuth = await signIn(adminUser.email);
  customerAuth = await signIn((await makeUser()).email);
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise((resolve) => server.close(resolve));
  await mongo.close();
  await stopMongo();
});

/* ============================================================ credentials */

test('the token is fetched once, cached, and never leaves the server', async () => {
  providers.resetShiprocketToken();
  const before = authCount;
  const order = await paidOrder();
  // Several operations in a row share one login.
  await ok(`/admin/orders/${order.orderId}/couriers`);
  await ok(`/admin/orders/${order.orderId}/couriers`);
  assert.equal(authCount - before, 1, 'one authentication for several calls');

  // Every authenticated call carried a bearer token.
  const authed = calls.filter((c) => c.path !== '/auth/login');
  assert.ok(authed.every((c) => typeof c.auth === 'string' && c.auth.startsWith('Bearer ')));

  // And nothing in an API response echoes the credentials.
  const panel = JSON.stringify(await ok(`/admin/orders/${order.orderId}/shipment`));
  for (const secret of [process.env.SHIPROCKET_PASSWORD, process.env.SHIPROCKET_WEBHOOK_SECRET, token]) {
    assert.equal(panel.includes(secret), false, 'no credential or token reaches a response');
  }
});

test('a rejected token is refreshed and the call retried once', async () => {
  const order = await paidOrder();
  const before = authCount;
  // The provider starts rejecting the cached token, as it does after 240 hours.
  rejectToken = true;
  const result = await ok(`/admin/orders/${order.orderId}/couriers`);
  assert.ok(result.couriers.length > 0, 'the retry succeeded');
  assert.equal(authCount - before, 1, 're-authenticated exactly once');
});

test('a rate limit is waited out, not failed', async () => {
  const order = await paidOrder();
  rateLimitOnce = true;
  const result = await ok(`/admin/orders/${order.orderId}/couriers`);
  assert.ok(result.couriers.length > 0);
});

test('bad credentials are reported as configuration, not retried forever', async () => {
  // A 400/403 from /auth/login is a wrong email or password. The message has
  // to name the variables or an operator has nothing to go on.
  const saved = process.env.SHIPROCKET_PASSWORD;
  providers.resetShiprocketToken();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/auth/login')) return json({message: 'Invalid credentials'}, 400);
    return realFetch(url, options);
  };
  try {
    const order = await paidOrder();
    const result = await call(`/admin/orders/${order.orderId}/couriers`);
    assert.equal(result.status, 503);
    assert.match(result.body.error, /SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD/);
  } finally {
    globalThis.fetch = realFetch;
    process.env.SHIPROCKET_PASSWORD = saved;
    providers.resetShiprocketToken();
  }
});

/* ======================================================= package & address */

test('missing parcel dimensions are an operator error, not an estimate', () => {
  const saved = process.env.PACKAGE_WEIGHT_KG;
  delete process.env.PACKAGE_WEIGHT_KG;
  try {
    assert.throws(() => sr.packageSpec(), /PACKAGE_WEIGHT_KG/);
    assert.throws(() => sr.packageSpec(), /not estimated/);
  } finally { process.env.PACKAGE_WEIGHT_KG = saved; }
  // Configured, it reports the real numbers.
  assert.deepEqual(sr.packageSpec(), {weight: 0.4, length: 25, breadth: 20, height: 4});
});

/*
  Readiness is reported honestly, and the optional variables stay optional.

  The gap this covers was real: `config.shippingEnabled` is satisfied by an
  email, a password and a pickup nickname, and the admin dashboard reported
  that as "Shipping: Configured". An install with no parcel measurements
  therefore showed a green tile and an enabled "Create shipment" button, and
  the operator only discovered the problem as a 503 after clicking it.
*/
test('shipping readiness names every blocking variable and no optional one', async () => {
  assert.deepEqual(sr.shippingConfigGaps(), {ready: true, missing: []},
    'the fixture is fully configured');

  // Each blocking variable is named when it alone is absent.
  for (const name of ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_PICKUP_LOCATION',
    'SHIPROCKET_PICKUP_PINCODE', 'PACKAGE_WEIGHT_KG', 'PACKAGE_LENGTH_CM',
    'PACKAGE_BREADTH_CM', 'PACKAGE_HEIGHT_CM']) {
    const saved = process.env[name];
    delete process.env[name];
    try {
      const gaps = sr.shippingConfigGaps();
      assert.equal(gaps.ready, false, `${name} must block a booking`);
      assert.deepEqual(gaps.missing, [name], `${name} is named on its own`);
    } finally { process.env[name] = saved; }
  }

  // A pickup PIN that is present but not a valid Indian PIN is still a gap:
  // the serviceability and rate queries would fail on it.
  const savedPin = process.env.SHIPROCKET_PICKUP_PINCODE;
  process.env.SHIPROCKET_PICKUP_PINCODE = '12';
  try {
    assert.deepEqual(sr.shippingConfigGaps().missing, ['SHIPROCKET_PICKUP_PINCODE']);
  } finally { process.env.SHIPROCKET_PICKUP_PINCODE = savedPin; }

  // A measurement of zero is not a measurement.
  const savedWeight = process.env.PACKAGE_WEIGHT_KG;
  process.env.PACKAGE_WEIGHT_KG = '0';
  try {
    assert.deepEqual(sr.shippingConfigGaps().missing, ['PACKAGE_WEIGHT_KG']);
  } finally { process.env.PACKAGE_WEIGHT_KG = savedWeight; }

  // The three genuinely optional ones never block, because blank is a working
  // configuration for each: Shiprocket picks the courier and the channel, and
  // tracking converges through the polled job without a webhook secret.
  for (const name of ['SHIPROCKET_COURIER_ID', 'SHIPROCKET_CHANNEL_ID', 'SHIPROCKET_WEBHOOK_SECRET']) {
    const saved = process.env[name];
    delete process.env[name];
    try {
      assert.deepEqual(sr.shippingConfigGaps(), {ready: true, missing: []},
        `${name} is optional and must not block a booking`);
    } finally { if (saved !== undefined) process.env[name] = saved; }
  }
});

test('the admin panel disables booking and names the gap when the parcel is unmeasured', async () => {
  const order = await paidOrder();
  const saved = process.env.PACKAGE_LENGTH_CM;
  delete process.env.PACKAGE_LENGTH_CM;
  try {
    const panel = await ok(`/admin/orders/${order.orderId}/shipment`);
    assert.equal(panel.shippingConfigured, false);
    assert.deepEqual(panel.shippingMissing, ['PACKAGE_LENGTH_CM']);
    assert.equal(panel.can.create, false, 'the button the operator would click is disabled');
    assert.equal(panel.can.couriers, false, 'and so is the rate lookup that needs a weight');
  } finally { process.env.PACKAGE_LENGTH_CM = saved; }

  // Restored, the same order is bookable again.
  const ready = await ok(`/admin/orders/${order.orderId}/shipment`);
  assert.equal(ready.shippingConfigured, true);
  assert.deepEqual(ready.shippingMissing, []);
  assert.equal(ready.can.create, true);
});

test('an invalid Indian PIN code is refused before the provider is called', async () => {
  const order = await paidOrder({address: {...ADDRESS, postalCode: '12'}});
  const before = calls.length;
  const result = await call(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  assert.equal(result.status, 409);
  assert.match(result.body.error, /PIN code/);
  assert.equal(calls.length, before, 'Shiprocket was not called');
  assert.equal(await mongo.shipments().countDocuments({order_id: order.orderId}), 0);

  assert.equal(sr.validPincode('400050'), true);
  for (const bad of ['040050', '12345', '1234567', '', null, 'abcdef']) assert.equal(sr.validPincode(bad), false);
});

test('an unserviceable destination is reported honestly', async () => {
  const order = await paidOrder();
  serviceable = false;
  try {
    const result = await ok(`/admin/orders/${order.orderId}/couriers`);
    assert.equal(result.serviceable, false);
    assert.deepEqual(result.couriers, []);
  } finally { serviceable = true; }
});

/* ============================================ eligibility & deduplication */

test('an unpaid, failed or cancelled order is never shipped', async () => {
  const buyer = await makeUser();
  const vid = id();
  await mongo.variants().insertOne({_id: vid, id: vid, product_id: productId, sku: `SR-UNPAID-${id().slice(0, 6)}`, size: 'M', color: `Grey-${id().slice(0, 6)}`, stock: 5, reserved: 0});
  await mongo.cartItems().insertOne({user_id: buyer.id, variant_id: vid, quantity: 1});
  const pending = await commerce.createOrder(buyer, {address: ADDRESS, coupon: ''}, `key-${randomUUID()}`);

  const unpaid = await call(`/admin/orders/${pending.id}/shipment`, {method: 'POST', body: {}});
  assert.equal(unpaid.status, 409);
  assert.match(unpaid.body.error, /cannot be shipped/);

  // Cancelled.
  await mongo.orders().updateOne({_id: pending.id}, {$set: {payment_status: 'paid', status: 'cancelled'}});
  const cancelled = await call(`/admin/orders/${pending.id}/shipment`, {method: 'POST', body: {}});
  assert.equal(cancelled.status, 409);

  // Refunded.
  await mongo.orders().updateOne({_id: pending.id}, {$set: {status: 'refunded'}});
  assert.equal((await call(`/admin/orders/${pending.id}/shipment`, {method: 'POST', body: {}})).status, 409);
  assert.equal(await mongo.shipments().countDocuments({order_id: pending.id}), 0, 'no shipment was created for any of them');
});

test('a shipment is created once, however many times it is requested', async () => {
  const order = await paidOrder();
  const before = countCalls('/orders/create/adhoc');

  const first = await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  assert.ok(first.awb);
  assert.equal(countCalls('/orders/create/adhoc') - before, 1);

  // Again: the AWB already exists, so nothing is booked.
  const again = await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  assert.equal(again.awb, first.awb);
  assert.equal(countCalls('/orders/create/adhoc') - before, 1, 'the provider was not asked twice');
  assert.equal(await mongo.shipments().countDocuments({order_id: order.orderId}), 1);
});

test('two admins clicking Create at once produce one shipment', async () => {
  const order = await paidOrder();
  const before = countCalls('/orders/create/adhoc');
  const results = await Promise.allSettled([
    call(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}}),
    call(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}}),
  ]);
  assert.ok(results.some((r) => r.value?.status === 201), 'one succeeded');
  assert.equal(await mongo.shipments().countDocuments({order_id: order.orderId}), 1);
  assert.equal(countCalls('/orders/create/adhoc') - before, 1, 'one provider booking');
});

test('an uncertain creation is parked for reconciliation, never retried blindly', async () => {
  const order = await paidOrder();
  timeoutPath = '/orders/create/adhoc';
  try {
    const failed = await call(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
    assert.equal(failed.status, 503);
    assert.match(failed.body.error, /uncertain/);
  } finally { timeoutPath = ''; }

  const parked = await shipmentOf(order.orderId);
  assert.equal(parked.status, 'reconciliation_required');
  assert.ok(parked.last_error, 'the reason is recorded for the operator');

  // The provider may already hold the order, so a retry must not create a
  // second one: it is refused until a human reconciles.
  const before = countCalls('/orders/create/adhoc');
  const retry = await call(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  assert.equal(retry.status, 409);
  assert.match(retry.body.error, /reconciliation/);
  assert.equal(countCalls('/orders/create/adhoc'), before, 'no second booking attempt');
});

/* ================================================== couriers, AWB, pickup */

test('courier options are quoted with rates in paise, cheapest first', async () => {
  const order = await paidOrder();
  const result = await ok(`/admin/orders/${order.orderId}/couriers`);
  assert.equal(result.serviceable, true);
  assert.equal(result.pincode, '400050');
  assert.equal(result.weight, 0.4);
  assert.equal(result.couriers.length, 2);

  const [cheapest, dearest] = result.couriers;
  assert.equal(cheapest.name, 'Delhivery Surface');
  // 62.5 rupees from the provider becomes 6250 paise here.
  assert.equal(cheapest.rate, 6250);
  assert.equal(dearest.rate, 12800);
  assert.ok(cheapest.rate < dearest.rate, 'cheapest first');
  assert.equal(cheapest.estimated_days, '4');
  assert.equal(dearest.etd, 'Jan 31, 2026');
  assert.equal(cheapest.courier_id, '51');
});

test('a chosen courier is the one requested, and its details are stored', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {courierId: '11'}});
  const assign = calls.filter((c) => c.path === '/courier/assign/awb').at(-1);
  assert.equal(assign.body.courier_id, 11, 'the selection reached the provider');

  const s = await shipmentOf(order.orderId);
  assert.equal(s.courier, 'Bluedart Express');
  assert.equal(s.courier_id, '11');
  assert.match(s.awb, /^AWB\d+$/);
  assert.equal(s.status, 'awb_assigned');
  // Freight is stored in paise, like every other amount.
  assert.equal(s.freight_charge, 6250);
  // A confirmed order moves to processing once dispatch is committed.
  assert.equal((await mongo.orders().findOne({_id: order.orderId})).status, 'processing');
});

test('AWB assignment can be done as its own step, and only once', async () => {
  const order = await paidOrder();
  // Create without assigning, by letting the create succeed and the assign fail.
  failPath = '/courier/assign/awb';
  try {
    await call(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  } finally { failPath = ''; }
  let s = await shipmentOf(order.orderId);
  assert.equal(s.status, 'assignment_review');
  assert.equal(s.awb, null);
  assert.ok(s.provider_shipment_id, 'the provider order survived the failed assignment');
  assert.ok(s.last_error, 'the provider message is kept for the operator');

  // An operator reconciles by retrying the assignment alone.
  await mongo.shipments().updateOne({_id: s._id}, {$set: {status: 'created'}});
  const assigned = await ok(`/admin/orders/${order.orderId}/awb`, {method: 'POST', body: {courierId: '51'}});
  assert.match(assigned.awb, /^AWB\d+$/);

  // A second assignment is refused rather than booking a second AWB.
  const twice = await call(`/admin/orders/${order.orderId}/awb`, {method: 'POST', body: {}});
  assert.equal(twice.status, 409);
  assert.match(twice.body.error, /already assigned/);
});

test('pickup is scheduled once an AWB exists, and recorded', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});

  const result = await ok(`/admin/orders/${order.orderId}/pickup`, {method: 'POST', body: {}});
  assert.equal(result.token, 'PKT-991');
  const s = await shipmentOf(order.orderId);
  assert.equal(s.pickup_token, 'PKT-991');
  assert.ok(s.pickup_scheduled_at instanceof Date);
  assert.equal(s.stage, 'pickup_scheduled');
  // And it is in the history.
  assert.ok(await mongo.shippingEvents().countDocuments({shipment_id: s._id, stage: 'pickup_scheduled'}) >= 1);
});

test('pickup before an AWB is refused', async () => {
  const order = await paidOrder();
  const result = await call(`/admin/orders/${order.orderId}/pickup`, {method: 'POST', body: {}});
  assert.equal(result.status, 404);
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  assert.equal((await call(`/admin/orders/${order.orderId}/pickup`, {method: 'POST', body: {}})).status, 200);
});

/* ====================================================== label and manifest */

test('a label is generated and stored without touching the invoice', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const invoices = await import('../server/invoices.mjs');
  const invoice = await invoices.createInvoice(order.orderId);
  const pdfBefore = await invoices.invoicePdf(order.orderId);

  const label = await ok(`/admin/orders/${order.orderId}/label`, {method: 'POST', body: {}});
  assert.match(label.url, /^https:\/\//);
  assert.equal((await shipmentOf(order.orderId)).label_url, label.url);

  // The GEMIES invoice is a separate document and is untouched by any of this.
  const stored = await mongo.invoices().findOne({_id: invoice._id});
  assert.equal(stored.number, invoice.number);
  assert.equal(stored.status, 'issued');
  assert.ok(pdfBefore.equals(await invoices.invoicePdf(order.orderId)), 'the invoice PDF is byte-identical');
  assert.equal(stored.snapshot.business.name !== undefined, true);
});

test('a manifest needs a scheduled pickup, and says so', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const tooEarly = await call(`/admin/orders/${order.orderId}/manifest`, {method: 'POST', body: {}});
  assert.equal(tooEarly.status, 409);
  assert.match(tooEarly.body.error, /pickup/i);

  await ok(`/admin/orders/${order.orderId}/pickup`, {method: 'POST', body: {}});
  const manifest = await ok(`/admin/orders/${order.orderId}/manifest`, {method: 'POST', body: {}});
  assert.match(manifest.url, /^https:\/\//);
  assert.equal((await shipmentOf(order.orderId)).manifest_url, manifest.url);
});

/* ================================================================ tracking */

test('tracking advances the shipment, the order and the history', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s0 = await shipmentOf(order.orderId);

  advance(s0.provider_shipment_id, 'IN TRANSIT', 6, {location: 'Bhiwandi'});
  const shipped = await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  assert.equal(shipped.stage, 'in_transit');
  assert.equal(shipped.provider_status, 'IN TRANSIT', "Shiprocket's own words are preserved");
  assert.equal((await mongo.orders().findOne({_id: order.orderId})).status, 'shipped');
  let s = await shipmentOf(order.orderId);
  assert.ok(s.estimated_delivery instanceof Date, 'the estimate is stored when supplied');
  assert.equal(s.tracking_url, 'https://shiprocket.example.invalid/track/abc');

  advance(s0.provider_shipment_id, 'OUT FOR DELIVERY', 19);
  assert.equal((await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}})).stage, 'out_for_delivery');

  advance(s0.provider_shipment_id, 'DELIVERED', 7);
  const delivered = await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  assert.equal(delivered.stage, 'delivered');
  assert.equal((await mongo.orders().findOne({_id: order.orderId})).status, 'delivered');
  s = await shipmentOf(order.orderId);
  assert.ok(s.delivered_at instanceof Date, 'the delivery timestamp is recorded');
  // IST, not UTC: 14:30 IST is 09:00 UTC.
  assert.equal(s.delivered_at.toISOString(), '2026-02-01T09:00:00.000Z');

  // The history has a row per stage, newest first.
  const history = (await ok(`/admin/orders/${order.orderId}/shipment`)).history;
  assert.ok(history.length >= 4);
  assert.equal(history[0].stage, 'delivered');
  assert.ok(history.some((h) => h.location === 'Bhiwandi'));
});

test('a late event cannot move a delivered parcel backwards', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s0 = await shipmentOf(order.orderId);

  advance(s0.provider_shipment_id, 'DELIVERED', 7);
  await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  const deliveredAt = (await shipmentOf(order.orderId)).delivered_at;

  // An "In Transit" scan arrives after the delivery, which happens routinely.
  advance(s0.provider_shipment_id, 'IN TRANSIT', 6);
  const late = await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  assert.equal(late.changed, false);
  assert.match(late.reason, /arrived after a later status/);

  const s = await shipmentOf(order.orderId);
  assert.equal(s.stage, 'delivered', 'still delivered');
  assert.equal(s.provider_status, 'DELIVERED');
  assert.equal(s.delivered_at.getTime(), deliveredAt.getTime());
  assert.equal((await mongo.orders().findOne({_id: order.orderId})).status, 'delivered');
  // But the late scan is still in the history, because it did happen.
  assert.ok(await mongo.shippingEvents().countDocuments({shipment_id: s._id, stage: 'in_transit'}) >= 1);
});

test('RTO and exception statuses map without losing the provider wording', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s0 = await shipmentOf(order.orderId);

  advance(s0.provider_shipment_id, 'UNDELIVERED - Customer unavailable', 12);
  const exception = await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  assert.equal(exception.stage, 'exception');
  assert.equal((await shipmentOf(order.orderId)).provider_status, 'UNDELIVERED - Customer unavailable');
  // An exception needs a person, so an operator is told.
  assert.ok(await mongo.emailNotifications().countDocuments({dedupe_key: {$regex: '^admin:delivery-exception'}}) >= 1);

  advance(s0.provider_shipment_id, 'RTO INITIATED', 21);
  assert.equal((await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}})).stage, 'rto_initiated');
  advance(s0.provider_shipment_id, 'RTO DELIVERED', 10);
  assert.equal((await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}})).stage, 'rto_delivered');
  // A returned parcel must not read as delivered to the customer.
  assert.notEqual((await mongo.orders().findOne({_id: order.orderId})).status, 'delivered');
});

test('status mapping covers the documented codes and keeps the original', () => {
  const cases = [
    ['Shipment created', 1, 'created'], ['PICKUP SCHEDULED', 2, 'pickup_scheduled'],
    ['PICKED UP', 4, 'picked_up'], ['IN TRANSIT', 6, 'in_transit'],
    ['OUT FOR DELIVERY', 19, 'out_for_delivery'], ['DELIVERED', 7, 'delivered'],
    ['CANCELED', 8, 'cancelled'], ['RTO INITIATED', 21, 'rto_initiated'],
    ['RTO DELIVERED', 10, 'rto_delivered'], ['UNDELIVERED', 12, 'exception'],
  ];
  for (const [status, code, stage] of cases) {
    const result = sr.normaliseStatus(status, code);
    assert.equal(result.stage, stage, `${status} (${code})`);
    assert.equal(result.providerStatus, status, 'the provider status is never discarded');
    assert.equal(result.providerCode, code);
  }
  // An unknown status falls back rather than guessing.
  assert.equal(sr.normaliseStatus('SOMETHING NEW', 999).stage, 'created');
  // Delivered outranks in transit; RTO and cancellation outrank delivered.
  assert.ok(sr.rankOf('delivered') > sr.rankOf('in_transit'));
  assert.ok(sr.rankOf('rto_delivered') > sr.rankOf('delivered'));
  assert.ok(sr.rankOf('cancelled') > sr.rankOf('delivered'));
});

test('a parcel with no scan yet is reported as such, not as an error', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s = await shipmentOf(order.orderId);
  // Drop the stub's record so tracking returns track_status 0, as it does in
  // the first hour after an AWB is issued.
  byAwb.delete(s.awb);
  parcels.delete(s.provider_shipment_id);
  const result = await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  assert.equal(result.changed, false);
  assert.match(result.reason, /not reported a scan/);
  assert.ok((await shipmentOf(order.orderId)).last_synced instanceof Date, 'the attempt is still recorded');
});

/* ============================================================ cancellation */

test('a booking can be cancelled before pickup, and not after', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const result = await ok(`/admin/orders/${order.orderId}/cancel-shipment`, {method: 'POST', body: {}});
  assert.match(result.message, /cancelled/i);
  const s = await shipmentOf(order.orderId);
  assert.equal(s.status, 'cancelled');
  assert.equal(s.stage, 'cancelled');
  assert.ok(s.cancelled_at instanceof Date);
  // The order goes back to confirmed, not cancelled: the customer has paid.
  assert.equal((await mongo.orders().findOne({_id: order.orderId})).status, 'confirmed');
  assert.equal((await mongo.orders().findOne({_id: order.orderId})).payment_status, 'paid');

  assert.equal((await call(`/admin/orders/${order.orderId}/cancel-shipment`, {method: 'POST', body: {}})).status, 409);

  // Already picked up: refused, with a reason that says what to do instead.
  const other = await paidOrder();
  await ok(`/admin/orders/${other.orderId}/shipment`, {method: 'POST', body: {}});
  const s2 = await shipmentOf(other.orderId);
  advance(s2.provider_shipment_id, 'IN TRANSIT', 6);
  await ok(`/admin/orders/${other.orderId}/track`, {method: 'POST', body: {}});
  const tooLate = await call(`/admin/orders/${other.orderId}/cancel-shipment`, {method: 'POST', body: {}});
  assert.equal(tooLate.status, 409);
  assert.match(tooLate.body.error, /return with the courier/i);
});

/* ================================================================ webhooks */

const deliver = async (payload, {secret = process.env.SHIPROCKET_WEBHOOK_SECRET, header = 'x-api-key'} = {}) => {
  const response = await nativeFetch(`${base}/api/webhooks/shiprocket`, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...(secret ? {[header]: secret} : {})},
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return {status: response.status, body};
};

test('a webhook without the shared secret is refused', async () => {
  const before = await mongo.webhookEvents().countDocuments({kind: 'shiprocket.tracking'});
  assert.equal((await deliver({awb: 'AWB1001'}, {secret: null})).status, 401);
  assert.equal((await deliver({awb: 'AWB1001'}, {secret: 'wrong-secret'})).status, 401);
  assert.equal(await mongo.webhookEvents().countDocuments({kind: 'shiprocket.tracking'}), before,
    'an unauthenticated delivery never reaches the event log');
});

test('the secret is accepted under any of the documented header names', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s = await shipmentOf(order.orderId);
  for (const header of ['x-api-key', 'x-shiprocket-token', 'x-webhook-secret']) {
    const result = await deliver({awb: s.awb, current_status: 'IN TRANSIT', current_timestamp: `2026-01-30 0${header.length % 9}:00:00`}, {header});
    assert.equal(result.status, 200, header);
  }
});

test('a webhook never changes an order from its own payload', async () => {
  // The whole point of the design: Shiprocket does not sign its bodies, so a
  // payload claiming delivery is treated as a hint to go and check, not as
  // evidence. The stub still reports the parcel in transit.
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s = await shipmentOf(order.orderId);
  advance(s.provider_shipment_id, 'IN TRANSIT', 6);

  const result = await deliver({awb: s.awb, current_status: 'DELIVERED', current_status_id: 7, current_timestamp: '2026-01-30 11:00:00'});
  assert.equal(result.status, 200);
  assert.equal(result.body.queued, true);

  // Before the job runs, nothing has moved.
  assert.equal((await shipmentOf(order.orderId)).stage, 'created');

  // The job reconciles against the API, which says in transit -- not delivered.
  await drain();
  const after = await shipmentOf(order.orderId);
  assert.equal(after.stage, 'in_transit', 'the API decided, not the payload');
  assert.equal(after.provider_status, 'IN TRANSIT');
  assert.equal(after.delivered_at, null, 'a forged delivery claim changed nothing');
  assert.notEqual((await mongo.orders().findOne({_id: order.orderId})).status, 'delivered');

  // What the payload claimed is kept, for diagnostics only.
  const event = await mongo.webhookEvents().findOne({kind: 'shiprocket.tracking', 'claimed.awb': s.awb});
  assert.equal(event.claimed.status, 'DELIVERED');
  assert.equal(event.order_id, order.orderId);
});

test('a redelivered webhook is acknowledged once and queues one job', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s = await shipmentOf(order.orderId);
  const payload = {awb: s.awb, current_status: 'IN TRANSIT', current_timestamp: '2026-01-30 12:00:00'};

  const first = await deliver(payload);
  assert.equal(first.status, 200);
  assert.ok(!first.body.duplicate);
  const jobsAfterFirst = await mongo.jobs().countDocuments({kind: 'tracking', dedupe_key: {$regex: `^sr-webhook:${s._id}` }});

  for (let i = 0; i < 3; i += 1) {
    const again = await deliver(payload);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
  }
  assert.equal(await mongo.webhookEvents().countDocuments({'claimed.awb': s.awb, 'claimed.scan_time': '2026-01-30 12:00:00'}), 1);
  assert.equal(await mongo.jobs().countDocuments({kind: 'tracking', dedupe_key: {$regex: `^sr-webhook:${s._id}`}}), jobsAfterFirst,
    'no extra reconciliation jobs');
});

test('out-of-order webhooks leave the newest state standing', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s = await shipmentOf(order.orderId);

  advance(s.provider_shipment_id, 'DELIVERED', 7);
  await deliver({awb: s.awb, current_status: 'DELIVERED', current_timestamp: '2026-02-01 14:30:00'});
  await drain();
  assert.equal((await shipmentOf(order.orderId)).stage, 'delivered');

  // A much older scan is redelivered late. The API still says delivered, so
  // the reconciliation is a no-op -- and even if the API regressed, the rank
  // guard would refuse it.
  advance(s.provider_shipment_id, 'IN TRANSIT', 6);
  await deliver({awb: s.awb, current_status: 'IN TRANSIT', current_timestamp: '2026-01-29 08:00:00'});
  await drain();
  const after = await shipmentOf(order.orderId);
  assert.equal(after.stage, 'delivered');
  assert.equal((await mongo.orders().findOne({_id: order.orderId})).status, 'delivered');
});

test('a webhook for an unknown parcel is acknowledged, not retried', async () => {
  const result = await deliver({awb: 'AWB-NOT-OURS', current_status: 'DELIVERED'});
  assert.equal(result.status, 200);
  assert.equal(result.body.matched, false);
  // Recorded so a pattern of these is visible, with no order attached.
  const event = await mongo.webhookEvents().findOne({'claimed.awb': 'AWB-NOT-OURS'});
  assert.equal(event.order_id, null);
});

test('a malformed webhook body is rejected', async () => {
  const bad = await nativeFetch(`${base}/api/webhooks/shiprocket`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-api-key': process.env.SHIPROCKET_WEBHOOK_SECRET},
    body: 'not json at all',
  });
  assert.equal(bad.status, 400);

  // Valid JSON with nothing to act on.
  assert.equal((await deliver({hello: 'world'})).status, 400);
  assert.equal((await deliver([1, 2, 3])).status, 400);
});

test('with no secret configured the endpoint refuses everything', async () => {
  const {config} = await import('../server/config.mjs');
  const saved = config.shiprocketWebhookSecret;
  config.shiprocketWebhookSecret = '';
  try {
    const result = await deliver({awb: 'AWB1001'}, {secret: 'anything'});
    assert.equal(result.status, 503);
    assert.match(result.body.error, /SHIPROCKET_WEBHOOK_SECRET/);
  } finally { config.shiprocketWebhookSecret = saved; }
});

/* =========================================================== notifications */

test('each stage emails the customer once, however many times it is seen', async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s = await shipmentOf(order.orderId);
  const countFor = (template) => mongo.emailNotifications().countDocuments({order_id: order.orderId, template});

  // Creation and AWB each have their own email, sent once.
  assert.equal(await countFor('shipment_created'), 1);
  assert.equal(await countFor('awb'), 1);

  advance(s.provider_shipment_id, 'IN TRANSIT', 6);
  await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  assert.equal(await countFor('tracking'), 1);

  // Polling the same stage repeatedly, and a webhook for it, send nothing more.
  await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  await deliver({awb: s.awb, current_status: 'IN TRANSIT', current_timestamp: '2026-01-30 13:00:00'});
  await drain();
  assert.equal(await countFor('tracking'), 1, 'one email for the stage, not one per event');

  // A new stage is a new email.
  advance(s.provider_shipment_id, 'OUT FOR DELIVERY', 19);
  await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  assert.equal(await countFor('tracking'), 2);
  advance(s.provider_shipment_id, 'DELIVERED', 7);
  await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  assert.equal(await countFor('tracking'), 3);

  // The emails name the order and carry the tracking details.
  const queued = await mongo.jobs().findOne({dedupe_key: `tracking:${s._id}:delivered`});
  assert.ok(queued, 'the delivery email is keyed on the shipment and stage');
  const {buildEmail} = await import('../server/emails/index.mjs');
  const built = await buildEmail(queued.payload);
  assert.match(built.subject, new RegExp(`#${order.number}`));
  assert.ok(built.text.includes(s.awb), 'the tracking number is in the email');
});

test('a webhook does not block on email delivery', async () => {
  // The handler records and queues, then returns. Proof: the email job is
  // still pending when the response has already been sent.
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s = await shipmentOf(order.orderId);
  advance(s.provider_shipment_id, 'OUT FOR DELIVERY', 19);

  const started = Date.now();
  const result = await deliver({awb: s.awb, current_status: 'OUT FOR DELIVERY', current_timestamp: '2026-01-31 07:00:00'});
  assert.equal(result.status, 200);
  assert.ok(Date.now() - started < 2000, 'the webhook returned promptly');
  // Nothing has been sent yet; the work is queued.
  assert.equal(await mongo.emailNotifications().countDocuments({order_id: order.orderId, template: 'tracking'}), 0);
  await drain();
  assert.equal(await mongo.emailNotifications().countDocuments({order_id: order.orderId, template: 'tracking'}), 1);
});

/* ======================================================= the admin surface */

test('the shipment panel reports exactly which actions are allowed', async () => {
  const order = await paidOrder();
  let panel = await ok(`/admin/orders/${order.orderId}/shipment`);
  assert.equal(panel.shipment, null);
  assert.equal(panel.can.create, true);
  assert.equal(panel.can.assign, false);
  assert.equal(panel.can.pickup, false);
  assert.equal(panel.can.label, false);
  assert.equal(panel.can.manifest, false);
  assert.equal(panel.shippingConfigured, true);
  assert.equal(panel.webhookConfigured, true);

  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  panel = await ok(`/admin/orders/${order.orderId}/shipment`);
  assert.equal(panel.can.create, false, 'already created');
  assert.equal(panel.can.assign, false, 'already assigned');
  assert.equal(panel.can.label, true);
  assert.equal(panel.can.pickup, true);
  assert.equal(panel.can.manifest, false, 'no pickup yet');
  assert.equal(panel.can.cancel, true);
  assert.ok(panel.shipment.awb);
  assert.equal(panel.shipment._id, undefined, 'the internal id is not exposed');

  await ok(`/admin/orders/${order.orderId}/pickup`, {method: 'POST', body: {}});
  panel = await ok(`/admin/orders/${order.orderId}/shipment`);
  assert.equal(panel.can.manifest, true);

  const s = await shipmentOf(order.orderId);
  advance(s.provider_shipment_id, 'IN TRANSIT', 6);
  await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});
  panel = await ok(`/admin/orders/${order.orderId}/shipment`);
  assert.equal(panel.can.cancel, false, 'in transit, so no longer cancellable');
  assert.equal(panel.can.pickup, false);
});

test('shipping actions require an administrator and are audited', async () => {
  const order = await paidOrder();
  for (const [path, method] of [
    ['/shipment', 'POST'], ['/awb', 'POST'], ['/pickup', 'POST'],
    ['/manifest', 'POST'], ['/cancel-shipment', 'POST'], ['/label', 'POST'], ['/track', 'POST'],
  ]) {
    assert.equal((await call(`/admin/orders/${order.orderId}${path}`, {method, body: {}, auth: customerAuth})).status, 403, path);
    assert.equal((await call(`/admin/orders/${order.orderId}${path}`, {method, body: {}, auth: null})).status, 401, path);
  }
  assert.equal((await call(`/admin/orders/${order.orderId}/shipment`, {auth: customerAuth})).status, 403);
  assert.equal((await call(`/admin/orders/${order.orderId}/couriers`, {auth: customerAuth})).status, 403);

  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  await ok(`/admin/orders/${order.orderId}/pickup`, {method: 'POST', body: {}});
  await ok(`/admin/orders/${order.orderId}/label`, {method: 'POST', body: {}});
  for (const action of ['shipment.create', 'shipment.pickup', 'shipment.label']) {
    assert.equal(await mongo.auditLogs().countDocuments({action, entity_id: order.orderId, actor_id: adminUser.id}), 1, action);
  }
});

test('a provider error reaches the admin with the provider message', async () => {
  const order = await paidOrder();
  failPath = '/courier/assign/awb';
  try {
    const result = await call(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
    assert.equal(result.status, 409);
    assert.match(result.body.error, /Shiprocket: Pickup location is not serviceable/);
  } finally { failPath = ''; }
  const s = await shipmentOf(order.orderId);
  assert.match(s.last_error, /not serviceable/, 'kept on the shipment for the panel');
});

/* ==================================================== the customer surface */

test('a customer sees nothing invented before the order ships', async () => {
  const buyer = await makeUser();
  const auth = await signIn(buyer.email);
  const order = await paidOrder({user: buyer});

  const before = await ok(`/orders/${order.orderId}/tracking`, {auth});
  assert.equal(before.available, false);
  assert.equal(before.message, 'Tracking details will appear once your order is shipped.');
  assert.equal(before.awb, undefined, 'no placeholder AWB');
  assert.equal(before.history, undefined);
});

test('a customer sees the real tracking once an AWB exists', async () => {
  const buyer = await makeUser();
  const auth = await signIn(buyer.email);
  const order = await paidOrder({user: buyer});
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const s = await shipmentOf(order.orderId);
  advance(s.provider_shipment_id, 'IN TRANSIT', 6, {location: 'Bhiwandi'});
  await ok(`/admin/orders/${order.orderId}/track`, {method: 'POST', body: {}});

  const tracking = await ok(`/orders/${order.orderId}/tracking`, {auth});
  assert.equal(tracking.available, true);
  assert.equal(tracking.awb, s.awb);
  assert.equal(tracking.courier, 'Delhivery Surface');
  assert.equal(tracking.stage, 'in_transit');
  assert.equal(tracking.stage_label, 'In transit');
  assert.equal(tracking.provider_status, 'IN TRANSIT');
  assert.match(tracking.tracking_url, /^https:\/\//);
  assert.ok(tracking.estimated_delivery, 'the estimate is shown when the courier gives one');
  assert.ok(tracking.history.length >= 1);
  assert.ok(tracking.history.some((h) => h.location === 'Bhiwandi'));
  // No internal identifiers leak to the customer.
  const serialised = JSON.stringify(tracking);
  assert.equal(serialised.includes(s.provider_shipment_id), false, 'the provider shipment id stays internal');
  assert.equal(serialised.includes(process.env.SHIPROCKET_WEBHOOK_SECRET), false);
});

test("a customer cannot read another customer's tracking", async () => {
  const order = await paidOrder();
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  assert.equal((await call(`/orders/${order.orderId}/tracking`, {auth: customerAuth})).status, 404);
  assert.equal((await call(`/orders/${order.orderId}/tracking`, {auth: null})).status, 401);
});

test('the customer tracking endpoint never calls the provider', async () => {
  const buyer = await makeUser();
  const auth = await signIn(buyer.email);
  const order = await paidOrder({user: buyer});
  await ok(`/admin/orders/${order.orderId}/shipment`, {method: 'POST', body: {}});
  const before = calls.length;
  for (let i = 0; i < 5; i += 1) await ok(`/orders/${order.orderId}/tracking`, {auth});
  assert.equal(calls.length, before, 'a customer refreshing cannot drive Shiprocket traffic');
});

/* ================================================ the worker's reconciliation */

test('the worker sweeps live parcels and leaves finished ones alone', async () => {
  const live = await paidOrder();
  await ok(`/admin/orders/${live.orderId}/shipment`, {method: 'POST', body: {}});
  const done = await paidOrder();
  await ok(`/admin/orders/${done.orderId}/shipment`, {method: 'POST', body: {}});
  const doneShipment = await shipmentOf(done.orderId);
  advance(doneShipment.provider_shipment_id, 'DELIVERED', 7);
  await ok(`/admin/orders/${done.orderId}/track`, {method: 'POST', body: {}});

  const {maintenance} = await import('../server/jobs.mjs');
  await maintenance();

  const queued = await mongo.jobs().find({kind: 'tracking', status: 'pending'}, {projection: {payload: 1}}).toArray();
  const orders = queued.map((j) => j.payload.orderId);
  assert.ok(orders.includes(live.orderId), 'a live parcel is polled');
  assert.ok(!orders.includes(done.orderId), 'a delivered parcel is not polled again');
});
