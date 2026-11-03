// Tranche 3: fulfillment and invoices on MongoDB.
//
// The interesting cases here are the ones where a provider call and a database
// write can disagree: a shipment created twice, a refund issued twice, an
// invoice renumbered on a retry. Four more FOR UPDATE locks were replaced by
// conditional updates, so the concurrency tests are what prove them.
//
//   node --test tests/tranche3.test.mjs
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
// Shiprocket has to look configured or every fulfillment call is a 503.
process.env.SHIPROCKET_EMAIL = 'ship@example.invalid';
process.env.SHIPROCKET_PASSWORD = 'fixture';
process.env.SHIPROCKET_PICKUP_LOCATION = 'Primary';
process.env.PACKAGE_WEIGHT_KG = '0.4';
process.env.PACKAGE_LENGTH_CM = '25';
process.env.PACKAGE_BREADTH_CM = '20';
process.env.PACKAGE_HEIGHT_CM = '4';
// Invoices refuse to issue without a configured business identity.
process.env.BUSINESS_NAME = 'SWAYAMSIDDHA FASHION AND LIFESTYLES';
process.env.BUSINESS_TRADE_NAME = 'GEMIES';
process.env.BUSINESS_ADDRESS = 'Acropolis, Laxman Mhatre Road, Borivali West, Mumbai, Maharashtra 400103';
process.env.BUSINESS_EMAIL = 'swayamsiddha20@gmail.com';
process.env.BUSINESS_TAX_ID = '27BSUPK4844B1ZH';
process.env.INVOICE_PREFIX = 'GEM';

await startMongo();

const mongo = await import('../server/mongo.mjs');
const {id, passwordHash} = await import('../server/security.mjs');
const commerce = await import('../server/commerce.mjs');
const fulfillment = await import('../server/fulfillment.mjs');
const invoicesModule = await import('../server/invoices.mjs');

/* -------------------------------------------------------- provider doubles */

// Every provider response the tests need, plus a count of what was called, so
// "the provider was asked once" is an assertion rather than an assumption.
const calls = [];
const remotes = new Map();
let shiprocketHandler = () => ({});
const nativeFetch = globalThis.fetch;

globalThis.fetch = async (url, options = {}) => {
  const address = new URL(url);
  const payload = options.body ? JSON.parse(options.body) : {};
  const path = address.pathname;
  calls.push({host: address.hostname, path, payload});
  let data;

  if (address.hostname === 'api.razorpay.com') {
    const key = path.replace('/v1', '');
    if (key === '/orders' && options.method === 'POST') {
      data = {id: `order_${randomUUID().replaceAll('-', '')}`, amount: payload.amount, currency: payload.currency, receipt: payload.receipt};
      remotes.set(data.id, data);
    } else if (/\/payments\/[^/]+\/refund$/.test(key)) {
      const refundId = `rfnd_${randomUUID().replaceAll('-', '')}`;
      data = {id: refundId, payment_id: key.split('/')[2], amount: payload.amount, status: 'processed', receipt: payload.receipt};
      remotes.set(refundId, data);
    } else if (/\/payments\/[^/]+\/refunds$/.test(key)) {
      const paymentId = key.split('/')[2];
      data = {items: [...remotes.values()].filter((r) => r.payment_id === paymentId)};
    } else data = remotes.get(key.split('/').at(-1));
  } else if (address.hostname === 'apiv2.shiprocket.in') {
    if (path.endsWith('/auth/login')) data = {token: 'fixture-token'};
    else data = shiprocketHandler(path.replace('/v1/external', ''), payload);
  } else if (address.hostname === 'api.resend.com') data = {id: 'test-email-id'};

  if (!data) throw new Error(`Unexpected provider call: ${url}`);
  return new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}});
};

const ADDRESS = {
  name: 'Fixture Customer', phone: '9876543210', line1: '1 Test street', line2: '',
  city: 'Test City', state: 'Maharashtra', postalCode: '400001', country: 'India',
};

let productId;

before(async () => {
  await mongo.connect();
  await mongo.ensureSchema();
  const categoryId = id();
  productId = id();
  await mongo.categories().insertOne({_id: categoryId, id: categoryId, name: 'Tees', slug: 'tees', segment: 'tees', parent_id: null, in_nav: true, display_order: 0});
  await mongo.products().insertOne({
    _id: productId, id: productId, slug: 'tranche3-tee', name: 'Tranche3 Tee',
    description: 'Fixture product for tranche 3 tests.', brand: 'Gemies',
    category_id: categoryId, audience: 'Men', price: 100000, compare_price: null,
    images: ['/assets/products/a.webp'], published: true, featured: false, is_demo: false,
    display_order: 0, created_at: new Date(), colorways: [],
  });
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await mongo.close();
  await stopMongo();
});

/* ------------------------------------------------------------------ helpers */

async function makeUser() {
  const uid = id();
  const email = `b${uid}@example.invalid`;
  await mongo.users().insertOne({
    _id: uid, id: uid, name: 'Buyer', email,
    password_hash: await passwordHash('a-very-secure-test-password'),
    role: 'customer', verified: true, created_at: new Date(),
  });
  return {id: uid, email};
}

let variantSeq = 0;
async function makeVariant(stock) {
  const vid = id();
  variantSeq += 1;
  await mongo.variants().insertOne({
    _id: vid, id: vid, product_id: productId, sku: `SKU-${vid.slice(0, 8)}`,
    size: 'M', color: `Black-${variantSeq}`, stock, reserved: 0,
  });
  return vid;
}

/** A paid order with a captured payment, which is where this module starts. */
async function paidOrder({stock = 5, quantity = 1} = {}) {
  const user = await makeUser();
  const variantId = await makeVariant(stock);
  await mongo.cartItems().updateOne(
    {user_id: user.id, variant_id: variantId},
    {$set: {user_id: user.id, variant_id: variantId, quantity}},
    {upsert: true},
  );
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: ''}, `key-${randomUUID()}`);
  const p = await commerce.paymentOrder(order.id);
  const payment = {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: p.amount, currency: p.currency, status: 'captured', captured: true, method: 'card',
  };
  remotes.set(payment.id, payment);
  await commerce.acceptCapturedPayment(payment);
  return {user, variantId, orderId: order.id, gatewayPaymentId: payment.id};
}

const shipmentOk = () => {
  shiprocketHandler = (path) => {
    if (path === '/orders/create/adhoc') return {order_id: 55500 + variantSeq, shipment_id: 77700 + variantSeq};
    if (path === '/courier/assign/awb') return {response: {data: {awb_code: `AWB${variantSeq}-${Date.now()}`, courier_name: 'Delhivery', courier_company_id: 11}}};
    return {};
  };
};

const countCalls = (path) => calls.filter((c) => c.path.endsWith(path)).length;

/* ------------------------------------------------------------------ shipping */

test('a shipment is created once, with the provider asked once', async () => {
  shipmentOk();
  const {orderId} = await paidOrder();
  const before = countCalls('/orders/create/adhoc');

  const s = await fulfillment.createShipment(orderId);
  assert.equal(s.status, 'awb_assigned');
  assert.ok(s.awb, 'an AWB is recorded');
  assert.equal(s.courier, 'Delhivery');
  assert.equal(countCalls('/orders/create/adhoc') - before, 1);

  // Second call: already has an AWB, so it short-circuits and asks nobody.
  const again = await fulfillment.createShipment(orderId);
  assert.equal(again._id, s._id);
  assert.equal(countCalls('/orders/create/adhoc') - before, 1, 'the provider is not asked twice');
  assert.equal(await mongo.shipments().countDocuments({order_id: orderId}), 1);

  // The AWB assignment promotes a confirmed order to processing.
  const o = await mongo.orders().findOne({_id: orderId});
  assert.equal(o.status, 'processing');
});

test('two concurrent fulfillments produce one shipment', async () => {
  shipmentOk();
  const {orderId} = await paidOrder();
  const results = await Promise.allSettled([
    fulfillment.createShipment(orderId),
    fulfillment.createShipment(orderId),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.ok(ok.length >= 1, 'at least one fulfillment succeeds');
  assert.equal(await mongo.shipments().countDocuments({order_id: orderId}), 1,
    'the unique index on order_id is what keeps this to one shipment');
});

test('an unpaid order cannot be fulfilled', async () => {
  shipmentOk();
  const user = await makeUser();
  const variantId = await makeVariant(3);
  await mongo.cartItems().insertOne({user_id: user.id, variant_id: variantId, quantity: 1});
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: ''}, `key-${randomUUID()}`);
  await assert.rejects(() => fulfillment.createShipment(order.id), /cannot be shipped/);
  assert.equal(await mongo.shipments().countDocuments({order_id: order.id}), 0);
});

test('a provider failure parks the shipment for reconciliation', async () => {
  const {orderId} = await paidOrder();
  shiprocketHandler = (path) => {
    if (path === '/orders/create/adhoc') return {};  // no identifiers returned
    return {};
  };
  await assert.rejects(() => fulfillment.createShipment(orderId), /shipment identifiers/);
  const s = await mongo.shipments().findOne({order_id: orderId});
  assert.equal(s.status, 'reconciliation_required');

  // And it does not silently retry from a parked state.
  await assert.rejects(() => fulfillment.createShipment(orderId), /reconciliation/);
});

test('tracking records one event per status and emails once', async () => {
  shipmentOk();
  const {orderId} = await paidOrder();
  const s = await fulfillment.createShipment(orderId);

  shiprocketHandler = (path) => {
    if (path.startsWith('/courier/track/')) {
      return {tracking_data: {track_status: 1, shipment_status: 6, track_url: 'https://track.example.invalid/1', shipment_track: [{current_status: 'Shipped', awb_code: s.awb, courier_name: 'Delhivery', pickup_date: '2026-01-02'}]}};
    }
    return {};
  };

  // Creation and AWB assignment are themselves history, so the timeline
  // already has two entries before any courier scan arrives.
  const afterCreate = await mongo.shippingEvents().countDocuments({shipment_id: s._id});
  assert.equal(afterCreate, 2, 'shipment created and AWB assigned are both recorded');

  await fulfillment.syncTracking(orderId);
  const afterScan = await mongo.shippingEvents().countDocuments({shipment_id: s._id});
  assert.equal(afterScan, afterCreate + 1, 'one event for the courier scan');
  assert.equal((await mongo.orders().findOne({_id: orderId})).status, 'shipped');
  const emails = await mongo.emailNotifications().countDocuments({order_id: orderId, template: 'tracking'});
  assert.equal(emails, 1);

  // Re-polling the same status: the unique index on event_key absorbs it, and
  // the stage has not changed so nothing is emailed either.
  await fulfillment.syncTracking(orderId);
  assert.equal(await mongo.shippingEvents().countDocuments({shipment_id: s._id}), afterScan, 'no duplicate event');
  assert.equal(await mongo.emailNotifications().countDocuments({order_id: orderId, template: 'tracking'}), 1, 'no duplicate email');

  const shipment = await mongo.shipments().findOne({_id: s._id});
  assert.equal(shipment.tracking_url, 'https://track.example.invalid/1');
  assert.ok(shipment.last_synced instanceof Date);
});

test('a delivery scan moves the order to delivered', async () => {
  shipmentOk();
  const {orderId} = await paidOrder();
  const s = await fulfillment.createShipment(orderId);
  shiprocketHandler = (path) => {
    if (path.startsWith('/courier/track/')) {
      return {tracking_data: {track_status: 1, shipment_status: 7, shipment_track: [{current_status: 'Delivered', delivered_date: '2026-01-05'}]}};
    }
    return {};
  };
  await fulfillment.syncTracking(orderId);
  assert.equal((await mongo.orders().findOne({_id: orderId})).status, 'delivered');
  // COALESCE(awb): a response without an AWB must not erase the one on record.
  assert.equal((await mongo.shipments().findOne({_id: s._id})).awb, s.awb);
});

/* ------------------------------------------------------------------- refunds */

test('the refundable balance is the capture less every unfailed refund', async () => {
  const {orderId} = await paidOrder();
  const first = await fulfillment.refundableBalance(orderId);
  assert.equal(first.captured, first.balance, 'nothing refunded yet');
  assert.equal(first.refunded, 0);

  const rid = id();
  await mongo.refunds().insertOne({_id: rid, id: rid, order_id: orderId, refund_key: 'k1', provider_id: null, status: 'pending', amount: 1000, reason: 'test', created_at: new Date()});
  const second = await fulfillment.refundableBalance(orderId);
  assert.equal(second.refunded, 1000, 'a pending refund already counts against the balance');
  assert.equal(second.balance, first.captured - 1000);

  await mongo.refunds().updateOne({_id: rid}, {$set: {status: 'failed'}});
  const third = await fulfillment.refundableBalance(orderId);
  assert.equal(third.refunded, 0, 'a failed refund does not');
  assert.equal(third.balance, first.captured);
});

test('a full refund settles the order and restores stock once', async () => {
  const {orderId, variantId} = await paidOrder({stock: 5, quantity: 2});
  const stockBefore = (await mongo.variants().findOne({_id: variantId})).stock;

  const r = await fulfillment.requestRefund(orderId, 'Customer changed their mind.');
  assert.equal(r.status, 'processed');

  const o = await mongo.orders().findOne({_id: orderId});
  assert.equal(o.payment_status, 'refunded');
  assert.equal(o.status, 'refunded');
  assert.equal((await mongo.variants().findOne({_id: variantId})).stock, stockBefore + 2);

  const p = await mongo.payments().findOne({order_id: orderId});
  assert.equal(p.refunded_amount, p.amount);

  // Reconciling again must not restore stock a second time.
  const row = await mongo.refunds().findOne({order_id: orderId});
  await fulfillment.syncRefundById(row._id);
  assert.equal((await mongo.variants().findOne({_id: variantId})).stock, stockBefore + 2,
    'the conditional claim on the order is what makes the restore single-shot');

  // A fully refunded order is no longer refundable at all, so a second
  // request is refused on eligibility rather than reaching the refund key.
  await assert.rejects(() => fulfillment.requestRefund(orderId, 'Refund it again.'),
    /not eligible for a refund/);
});

test('a repeated partial refund request resolves to the one refund', async () => {
  // The (order_id, refund_key) index is what makes this idempotent. A full
  // refund cannot be used to show it: once the first one settles the order is
  // `refunded` and the next request is refused on eligibility before the key
  // is ever consulted, which the test above asserts.
  const {orderId} = await paidOrder();
  const before = countCalls('/refund');
  const first = await fulfillment.requestRefund(orderId, 'Goodwill.', {amount: 1500, refundKey: 'goodwill'});
  await fulfillment.requestRefund(orderId, 'Goodwill, retried.', {amount: 1500, refundKey: 'goodwill'});
  assert.equal(await mongo.refunds().countDocuments({order_id: orderId}), 1);
  assert.equal(countCalls('/refund') - before, 1, 'the gateway is asked to refund once');
  assert.equal((await mongo.refunds().findOne({order_id: orderId})).reason, 'Goodwill.',
    'the retry returns the original, it does not overwrite it');
  assert.equal(first.amount, 1500);
});

test('concurrent full refund requests issue one refund', async () => {
  const {orderId} = await paidOrder();
  const before = countCalls('/refund');
  await Promise.allSettled([
    fulfillment.requestRefund(orderId, 'Racing request one.'),
    fulfillment.requestRefund(orderId, 'Racing request two.'),
  ]);
  assert.equal(await mongo.refunds().countDocuments({order_id: orderId}), 1);
  assert.equal(countCalls('/refund') - before, 1);
});

test('a partial refund needs its own key and cannot exceed the balance', async () => {
  const {orderId} = await paidOrder();
  const {captured} = await fulfillment.refundableBalance(orderId);

  await assert.rejects(() => fulfillment.requestRefund(orderId, 'Partial, no key.', {amount: 1000}),
    /requires a refund key/);
  await assert.rejects(() => fulfillment.requestRefund(orderId, 'Too much.', {amount: captured + 1, refundKey: 'over'}),
    /refundable balance/);
  await assert.rejects(() => fulfillment.requestRefund(orderId, 'Fractional.', {amount: 10.5, refundKey: 'frac'}),
    /whole number/);

  const r = await fulfillment.requestRefund(orderId, 'Goodwill on shipping.', {amount: 1000, refundKey: 'shipping-goodwill'});
  assert.equal(r.amount, 1000);
  const o = await mongo.orders().findOne({_id: orderId});
  assert.equal(o.payment_status, 'partially_refunded', 'a part refund is neither paid nor refunded');
  assert.notEqual(o.status, 'refunded');

  // Two partial refunds cannot between them exceed the capture.
  await assert.rejects(() => fulfillment.requestRefund(orderId, 'Second goodwill.', {amount: captured, refundKey: 'second'}),
    /refundable balance/);
});

test('a shipped order is not refundable through support', async () => {
  shipmentOk();
  const {orderId} = await paidOrder();
  await fulfillment.createShipment(orderId);
  await assert.rejects(() => fulfillment.requestRefund(orderId, 'Refund a shipped order.'),
    /Cancel or return the shipment/);
});

test('a failed refund does not leave the order stuck in refunding', async () => {
  const {orderId, gatewayPaymentId} = await paidOrder();
  const refundId = id();
  const providerId = `rfnd_${randomUUID().replaceAll('-', '')}`;
  const amount = (await mongo.payments().findOne({order_id: orderId})).amount;
  await mongo.refunds().insertOne({_id: refundId, id: refundId, order_id: orderId, refund_key: 'full', provider_id: providerId, status: 'pending', amount, reason: 'Bank declined.', created_at: new Date()});
  await mongo.orders().updateOne({_id: orderId}, {$set: {payment_status: 'refunding'}});
  remotes.set(providerId, {id: providerId, payment_id: gatewayPaymentId, amount, status: 'failed'});

  await fulfillment.syncRefundById(refundId);
  assert.equal((await mongo.orders().findOne({_id: orderId})).payment_status, 'paid');
  assert.equal(await mongo.emailNotifications().countDocuments({order_id: orderId, template: 'refund_failed'}), 1);
});

test('an order with nothing to reconcile says so', async () => {
  const {orderId} = await paidOrder();
  await assert.rejects(() => fulfillment.syncRefund(orderId), /requires reconciliation/);
});

/* ------------------------------------------------------------------ invoices */

test('an invoice is issued once, numbered from the order', async () => {
  const {orderId} = await paidOrder();
  const o = await mongo.orders().findOne({_id: orderId});

  const inv = await invoicesModule.createInvoice(orderId);
  assert.equal(inv.number, `GEM-${String(o.number).padStart(6, '0')}`);
  assert.equal(inv.status, 'issued');
  assert.equal(inv.version, 1);
  assert.equal(inv.revision_of, null);
  assert.ok(inv.snapshot.lines.length > 0, 'the snapshot is stored as a document, not a JSON string');
  assert.equal(inv.business.taxId, '27BSUPK4844B1ZH');

  // A retried invoice job must not renumber or recompute.
  const again = await invoicesModule.createInvoice(orderId);
  assert.equal(again._id, inv._id);
  assert.equal(again.number, inv.number);
  assert.equal(await mongo.invoices().countDocuments({order_id: orderId}), 1);
});

test('an unpaid order has no invoice', async () => {
  const user = await makeUser();
  const variantId = await makeVariant(3);
  await mongo.cartItems().insertOne({user_id: user.id, variant_id: variantId, quantity: 1});
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: ''}, `key-${randomUUID()}`);
  await assert.rejects(() => invoicesModule.createInvoice(order.id), /requires a verified payment/);
  await assert.rejects(() => invoicesModule.invoicePdf(order.id), /not available yet/);
});

test('a reprint is byte-identical and ignores later catalogue edits', async () => {
  const {orderId} = await paidOrder();
  const inv = await invoicesModule.createInvoice(orderId);

  const first = await invoicesModule.invoicePdf(orderId);
  assert.ok(first.length > 1000, 'a real PDF came back');
  assert.equal(first.subarray(0, 4).toString(), '%PDF');

  // Rename the product and the customer. The snapshot is what renders, so
  // neither can reach a document already sent.
  await mongo.products().updateOne({_id: productId}, {$set: {name: 'Renamed After Invoicing'}});
  await mongo.orders().updateOne({_id: orderId}, {$set: {address: {...ADDRESS, name: 'Someone Else'}}});

  const second = await invoicesModule.invoicePdf(orderId);
  assert.ok(first.equals(second), 'a reprint is the same file, byte for byte');

  const byId = await invoicesModule.invoicePdf(orderId, {invoiceId: inv._id});
  assert.ok(first.equals(byId));
});

test('a revision voids the original and keeps both retrievable', async () => {
  const {orderId} = await paidOrder();
  const original = await invoicesModule.createInvoice(orderId);

  await assert.rejects(() => invoicesModule.reviseInvoice(orderId, 'typo', 'admin'),
    /at least 10 characters/);

  const revised = await invoicesModule.reviseInvoice(orderId, 'Customer name was recorded incorrectly at checkout.', 'admin');
  assert.equal(revised.version, 2);
  assert.equal(revised.revision_of, original.id);
  assert.equal(revised.number, `${original.number}-R1`);
  assert.equal(revised.status, 'issued');
  assert.equal((await mongo.invoices().findOne({_id: original._id})).status, 'void');

  // Both documents still render.
  assert.ok((await invoicesModule.invoicePdf(orderId, {invoiceId: original._id})).length > 1000);
  assert.ok((await invoicesModule.invoicePdf(orderId, {invoiceId: revised._id})).length > 1000);

  const history = await invoicesModule.invoiceHistory(orderId);
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 2, 'newest first');
  assert.equal(history[1].version, 1);
  assert.equal(history[0].reason, 'Customer name was recorded incorrectly at checkout.');
  assert.equal(history[0].id, revised.id);
});

test('two concurrent revisions produce one replacement', async () => {
  const {orderId} = await paidOrder();
  await invoicesModule.createInvoice(orderId);
  await Promise.allSettled([
    invoicesModule.reviseInvoice(orderId, 'First concurrent correction attempt.', 'admin'),
    invoicesModule.reviseInvoice(orderId, 'Second concurrent correction attempt.', 'admin'),
  ]);
  assert.equal(await mongo.invoices().countDocuments({order_id: orderId, status: 'issued'}), 1,
    'exactly one live invoice survives');
  const total = await mongo.invoices().countDocuments({order_id: orderId});
  assert.ok(total === 2 || total === 3, `one or two revisions, got ${total}`);
});

test('an invoice without a snapshot is refused rather than rendered live', async () => {
  const {orderId} = await paidOrder();
  const legacyId = id();
  await mongo.invoices().insertOne({
    _id: legacyId, id: legacyId, order_id: orderId, number: 'GEM-LEGACY',
    business: {name: 'Old'}, snapshot: {}, status: 'issued', version: 1,
    revision_of: null, reason: '', created_at: new Date(),
  });
  await assert.rejects(() => invoicesModule.invoicePdf(orderId), /predates the billing snapshot/);
});
