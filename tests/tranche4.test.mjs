// Tranche 4: exchanges on MongoDB.
//
// This module decides how many coins a customer gets back, so the tests that
// matter are the arithmetic ones (a credit must never exceed what was paid,
// however the discount and tax divide) and the single-credit ones (coins are
// credited at exactly one transition, once).
//
//   node --test tests/tranche4.test.mjs
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

await startMongo();

const mongo = await import('../server/mongo.mjs');
const {id, passwordHash} = await import('../server/security.mjs');
const commerce = await import('../server/commerce.mjs');
const wallet = await import('../server/wallet.mjs');
const exchanges = await import('../server/exchanges.mjs');

const remotes = new Map();
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const address = new URL(url);
  const payload = options.body ? JSON.parse(options.body) : {};
  let data;
  if (address.hostname === 'api.razorpay.com') {
    const key = address.pathname.replace('/v1', '');
    if (key === '/orders' && options.method === 'POST') {
      data = {id: `order_${randomUUID().replaceAll('-', '')}`, amount: payload.amount, currency: payload.currency, receipt: payload.receipt};
      remotes.set(data.id, data);
    } else data = remotes.get(key.split('/').at(-1));
  } else if (address.hostname === 'api.resend.com') data = {id: 'test-email-id'};
  if (!data) throw new Error(`Unexpected provider call: ${url}`);
  return new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}});
};

const ADDRESS = {
  name: 'Fixture Customer', phone: '9876543210', line1: '1 Test street', line2: '',
  city: 'Test City', state: 'Maharashtra', postalCode: '400001', country: 'India',
};

let productId;
let adminUser;

/** Exchanges are off by default, so every test has to turn them on. */
const settings = async (patch) => mongo.storeSettings().updateOne({_id: 1}, {$set: patch});

before(async () => {
  await mongo.connect();
  await mongo.ensureSchema();
  const categoryId = id();
  productId = id();
  await mongo.categories().insertOne({_id: categoryId, id: categoryId, name: 'Tees', slug: 'tees', segment: 'tees', parent_id: null, in_nav: true, display_order: 0});
  await mongo.products().insertOne({
    _id: productId, id: productId, slug: 'tranche4-tee', name: 'Tranche4 Tee',
    description: 'Fixture product for tranche 4 tests.', brand: 'Gemies',
    category_id: categoryId, audience: 'Men', price: 100000, compare_price: null,
    images: ['/assets/products/a.webp'], published: true, featured: false, is_demo: false,
    display_order: 0, created_at: new Date(), colorways: [],
  });
  await settings({
    wallet_enabled: true,
    wallet_paise_per_coin: 100,
    exchange_enabled: true,
    exchange_window_days: 30,
    exchange_credit_shipping: false,
  });
  adminUser = await makeUser('admin');
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await mongo.close();
  await stopMongo();
});

/* ------------------------------------------------------------------ helpers */

async function makeUser(role = 'customer') {
  const uid = id();
  const email = `b${uid}@example.invalid`;
  await mongo.users().insertOne({
    _id: uid, id: uid, name: 'Buyer', email,
    password_hash: await passwordHash('a-very-secure-test-password'),
    role, verified: true, created_at: new Date(),
  });
  return {id: uid, email, role};
}

let variantSeq = 0;
async function makeVariant(stock = 10) {
  const vid = id();
  variantSeq += 1;
  await mongo.variants().insertOne({
    _id: vid, id: vid, product_id: productId, sku: `SKU-${vid.slice(0, 8)}`,
    size: 'M', color: `Black-${variantSeq}`, stock, reserved: 0,
  });
  return vid;
}

/**
 * A paid, delivered order. `lines` is a list of quantities, each becoming its
 * own variant so a multi-line order can be built.
 */
async function deliveredOrder({lines = [1], coupon = ''} = {}) {
  const user = await makeUser();
  const variantIds = [];
  for (const quantity of lines) {
    const variantId = await makeVariant();
    variantIds.push(variantId);
    await mongo.cartItems().insertOne({user_id: user.id, variant_id: variantId, quantity});
  }
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon}, `key-${randomUUID()}`);
  const p = await commerce.paymentOrder(order.id);
  const payment = {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: p.amount, currency: p.currency, status: 'captured', captured: true, method: 'card',
  };
  remotes.set(payment.id, payment);
  await commerce.acceptCapturedPayment(payment);
  await mongo.orders().updateOne({_id: order.id}, {$set: {status: 'delivered'}});
  const items = await mongo.orderItems().find({order_id: order.id}).toArray();
  return {user, orderId: order.id, items, order: await mongo.orders().findOne({_id: order.id})};
}

/** Walks a request from `requested` all the way to credited. */
async function driveToCredit(exchangeId, actor = adminUser) {
  for (const status of ['approved', 'pickup_scheduled', 'picked_up', 'received', 'inspection_passed']) {
    await exchanges.transition(exchangeId, status, {actor});
  }
  return exchanges.transition(exchangeId, 'coins_credited', {actor});
}

/* --------------------------------------------------------------- eligibility */

test('eligibility is refused until it is configured, and respects the window', async () => {
  const {user, orderId} = await deliveredOrder();

  await settings({exchange_enabled: false});
  assert.equal((await exchanges.eligibility(orderId, user.id)).reason, 'Exchanges are not currently available.');

  await settings({exchange_enabled: true, exchange_window_days: 0});
  assert.equal((await exchanges.eligibility(orderId, user.id)).reason, 'No exchange window is configured.');

  await settings({exchange_window_days: 30});
  const ok = await exchanges.eligibility(orderId, user.id);
  assert.equal(ok.eligible, true);
  assert.equal(ok.items.length, 1);
  assert.equal(ok.items[0].returnable, 1);
  assert.equal(ok.items[0].product_slug, 'tranche4-tee', 'the product slug is joined through the variant');
  assert.deepEqual(ok.reasons, exchanges.EXCHANGE_REASONS);

  // Another customer's order is not found rather than forbidden.
  const other = await makeUser();
  assert.equal((await exchanges.eligibility(orderId, other.id)).reason, 'Order not found.');
});

test('the window runs from the delivery scan when there is one', async () => {
  const {user, orderId} = await deliveredOrder();
  await settings({exchange_window_days: 30});

  // Backdate the order well outside the window, then record a delivery
  // yesterday. The delivery date is what the window must run from.
  await mongo.orders().updateOne({_id: orderId}, {$set: {created_at: new Date(Date.now() - 200 * 86400000)}});
  assert.equal((await exchanges.eligibility(orderId, user.id)).eligible, false, 'order date alone is out of window');

  const shipmentId = id();
  await mongo.shipments().insertOne({_id: shipmentId, id: shipmentId, order_id: orderId, provider_order_id: 'po', provider_shipment_id: 'ps', awb: 'A1', courier: 'X', tracking_url: null, label_url: null, status: 'delivered', last_synced: new Date()});
  const eventId = id();
  await mongo.shippingEvents().insertOne({_id: eventId, id: eventId, shipment_id: shipmentId, event_key: `${shipmentId}:7:x`, status: 'DELIVERED', details: {}, created_at: new Date(Date.now() - 86400000)});

  // ILIKE '%deliver%' became a case-insensitive regex, so 'DELIVERED' matches.
  const after = await exchanges.eligibility(orderId, user.id);
  assert.equal(after.eligible, true, 'the delivery scan reopens the window');
  assert.ok(new Date(after.closesAt).getTime() > Date.now());
});

test('an unpaid or cancelled order is not exchangeable', async () => {
  await settings({exchange_window_days: 30});
  const user = await makeUser();
  const variantId = await makeVariant();
  await mongo.cartItems().insertOne({user_id: user.id, variant_id: variantId, quantity: 1});
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: ''}, `key-${randomUUID()}`);
  assert.equal((await exchanges.eligibility(order.id, user.id)).reason, 'Only paid orders can be exchanged.');

  const {user: u2, orderId} = await deliveredOrder();
  await mongo.orders().updateOne({_id: orderId}, {$set: {status: 'refunded'}});
  assert.match((await exchanges.eligibility(orderId, u2.id)).reason, /refunded cannot be exchanged/);
});

test('units committed to a live request are not offered again', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items} = await deliveredOrder({lines: [2]});
  const item = items[0];

  const created = await exchanges.createExchange(user, orderId, {
    reason: 'size_too_small', note: '', images: [],
    items: [{order_item_id: item.id, quantity: 1}],
  });

  const left = await exchanges.eligibility(orderId, user.id);
  assert.equal(left.items[0].returnable, 1, 'one of the two units is committed');

  // Asking for both now is refused against the remaining one.
  await assert.rejects(() => exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: item.id, quantity: 2}],
  }), /can still be exchanged/);

  // Cancelling the first request releases the unit again.
  await exchanges.transition(created.id, 'cancelled', {actor: user, note: 'Changed my mind', isCustomer: true});
  assert.equal((await exchanges.eligibility(orderId, user.id)).items[0].returnable, 2);
});

/* ------------------------------------------------------------ credit maths */

test('the credit never exceeds the order total, with an uneven coupon', async () => {
  await settings({exchange_window_days: 30});
  const code = `EX${randomUUID().slice(0, 6).toUpperCase()}`;
  const couponId = id();
  await mongo.coupons().insertOne({_id: couponId, id: couponId, code, percent: 17, minimum: 0, active: true});
  await settings({tax_bps: 1200});

  // Three lines of three different quantities, so neither the discount nor the
  // tax divides evenly across them. This is the case that produced a credit
  // larger than the order before the discount share was ceiled.
  const {user, orderId, items, order} = await deliveredOrder({lines: [1, 2, 3], coupon: code});
  assert.ok(order.discount > 0, 'the coupon applied');
  assert.ok(order.tax > 0, 'tax applied');

  const created = await exchanges.createExchange(user, orderId, {
    reason: 'wrong_product', note: '', images: [],
    items: items.map((i) => ({order_item_id: i.id, quantity: i.quantity})),
  });

  assert.ok(created.eligibleInr <= order.total,
    `credit ${created.eligibleInr} must not exceed order total ${order.total}`);
  const lineSum = created.calculation.lines.reduce((sum, l) => sum + l.eligible, 0);
  assert.equal(created.calculation.subtotalEligible, Math.min(lineSum, order.total));
  assert.equal(created.calculation.wholeOrder, true);
  assert.equal(created.calculation.shipping, 0, 'shipping credit is off');

  await settings({tax_bps: 0});
});

test('shipping is credited only on a whole-order return, and only when enabled', async () => {
  // The threshold has to sit above the order subtotal or shipping is free and
  // there is nothing to credit. A threshold of 0 means "always free".
  await settings({exchange_window_days: 30, shipping: 9900, free_shipping_threshold: 10000000, exchange_credit_shipping: true});
  const {user, orderId, items, order} = await deliveredOrder({lines: [1, 1]});
  assert.equal(order.shipping, 9900, 'the order carries a delivery charge');

  // Partial return: no shipping.
  const partial = await exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
  });
  assert.equal(partial.calculation.wholeOrder, false);
  assert.equal(partial.calculation.shipping, 0);

  // Whole-order return on a fresh order: shipping included.
  const second = await deliveredOrder({lines: [1, 1]});
  const whole = await exchanges.createExchange(second.user, second.orderId, {
    reason: 'damaged', note: '', images: [],
    items: second.items.map((i) => ({order_item_id: i.id, quantity: i.quantity})),
  });
  assert.equal(whole.calculation.wholeOrder, true);
  assert.equal(whole.calculation.shipping, 9900);

  // Same return with the setting off.
  await settings({exchange_credit_shipping: false});
  const third = await deliveredOrder({lines: [1, 1]});
  const off = await exchanges.createExchange(third.user, third.orderId, {
    reason: 'damaged', note: '', images: [],
    items: third.items.map((i) => ({order_item_id: i.id, quantity: i.quantity})),
  });
  assert.equal(off.calculation.shipping, 0);

  await settings({shipping: 0, free_shipping_threshold: 0});
});

test('a cash refund eats the headroom an exchange could have credited', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items, order} = await deliveredOrder();

  // A full cash refund already settled against this order.
  const refundId = id();
  await mongo.refunds().insertOne({
    _id: refundId, id: refundId, order_id: orderId, refund_key: 'full',
    provider_id: 'rfnd_x', status: 'processed', amount: order.total,
    reason: 'Cash refund', created_at: new Date(),
  });

  const created = await exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
  });
  assert.equal(created.calculation.alreadyRefunded, order.total);
  assert.equal(created.calculation.headroom, 0);
  assert.equal(created.calculation.cappedByHeadroom, true);
  assert.equal(created.coins, 0);

  // And the credit transition refuses rather than crediting zero coins.
  await assert.rejects(() => driveToCredit(created.id), /already been refunded or credited in full/);
});

test('a second exchange on one order cannot credit the same value twice', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items, order} = await deliveredOrder({lines: [1, 1]});

  const first = await exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
  });
  await driveToCredit(first.id);

  const second = await exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: items[1].id, quantity: 1}],
  });
  assert.ok(second.calculation.alreadyCredited > 0, 'the first credit is counted against the second');

  await driveToCredit(second.id);
  const credits = await mongo.walletTransactions()
    .find({order_id: orderId, kind: 'exchange_credit'}).toArray();
  const total = credits.reduce((sum, t) => sum + t.inr_value, 0);
  assert.ok(total <= order.total, `credited ${total} must not exceed order total ${order.total}`);
});

/* ----------------------------------------------------------- state machine */

test('the state machine refuses any transition it does not list', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items} = await deliveredOrder();
  const created = await exchanges.createExchange(user, orderId, {
    reason: 'size_too_small', note: '', images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
  });

  // No jumping straight to a credit.
  await assert.rejects(() => exchanges.transition(created.id, 'coins_credited', {actor: adminUser}),
    /cannot move to coins credited/);
  // Rejection needs a written reason.
  await assert.rejects(() => exchanges.transition(created.id, 'rejected', {actor: adminUser, note: 'no'}),
    /at least 5 characters/);

  await exchanges.transition(created.id, 'rejected', {actor: adminUser, note: 'Item shows signs of wear.'});
  // Terminal.
  await assert.rejects(() => exchanges.transition(created.id, 'approved', {actor: adminUser}),
    /cannot move to approved/);

  const detail = await exchanges.exchangeDetails(created.id);
  assert.equal(detail.status, 'rejected');
  assert.deepEqual(detail.nextStates, []);
  assert.equal(detail.decision_note, 'Item shows signs of wear.');
});

test('a customer can only cancel, and only their own request', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items} = await deliveredOrder();
  const created = await exchanges.createExchange(user, orderId, {
    reason: 'size_too_large', note: '', images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
  });

  const stranger = await makeUser();
  await assert.rejects(() => exchanges.transition(created.id, 'cancelled', {actor: stranger, isCustomer: true}),
    /not found/, 'another customer sees a miss, not a forbidden');
  // The wording here reads awkwardly ("cannot approved") because the module
  // interpolates the target state. Pre-existing; asserted as it is rather than
  // changed, since this tranche is a database migration.
  await assert.rejects(() => exchanges.transition(created.id, 'approved', {actor: user, isCustomer: true}),
    /You cannot approved this request now/);

  await exchanges.transition(created.id, 'approved', {actor: adminUser});
  await exchanges.transition(created.id, 'pickup_scheduled', {actor: adminUser});
  // Past pickup scheduling a customer may no longer withdraw it.
  await exchanges.transition(created.id, 'picked_up', {actor: adminUser});
  await assert.rejects(() => exchanges.transition(created.id, 'cancelled', {actor: user, isCustomer: true}),
    /cannot cancel this request now/);
});

test('coins are credited at one transition, once', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items} = await deliveredOrder();
  const created = await exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
  });

  // Every step before the credit moves no coins at all.
  for (const status of ['approved', 'pickup_scheduled', 'picked_up', 'received', 'inspection_passed']) {
    await exchanges.transition(created.id, status, {actor: adminUser});
    const summary = await wallet.walletSummary(user.id);
    assert.equal(summary.availableCoins, 0, `${status} must credit nothing`);
  }

  const result = await exchanges.transition(created.id, 'coins_credited', {actor: adminUser});
  assert.ok(result.transaction, 'a ledger entry came back');
  assert.equal(result.transaction.kind, 'exchange_credit');
  assert.ok(result.transaction.coins > 0);

  const summary = await wallet.walletSummary(user.id);
  assert.equal(summary.availableCoins, result.transaction.coins);

  const request = await mongo.exchangeRequests().findOne({_id: created.id});
  assert.equal(request.status, 'coins_credited');
  assert.equal(request.credited_transaction_id, result.transaction.id);

  // Terminal, so it cannot be credited a second time.
  await assert.rejects(() => exchanges.transition(created.id, 'coins_credited', {actor: adminUser}),
    /cannot move to coins credited/);
  assert.equal(await mongo.walletTransactions().countDocuments({exchange_id: created.id}), 1);

  // The ledger and the cached balance agree. reconcile returns one row per
  // account, each carrying `balanced`.
  const [check] = await wallet.reconcile(user.id);
  assert.equal(check.balanced, true);
  assert.equal(check.cached, check.ledger);
});

test('two concurrent credits produce one ledger entry', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items} = await deliveredOrder();
  const created = await exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
  });
  for (const status of ['approved', 'pickup_scheduled', 'picked_up', 'received', 'inspection_passed']) {
    await exchanges.transition(created.id, status, {actor: adminUser});
  }

  const results = await Promise.allSettled([
    exchanges.transition(created.id, 'coins_credited', {actor: adminUser}),
    exchanges.transition(created.id, 'coins_credited', {actor: adminUser}),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1,
    'the conditional status claim lets exactly one through');
  assert.equal(await mongo.walletTransactions().countDocuments({exchange_id: created.id}), 1);

  const summary = await wallet.walletSummary(user.id);
  const entry = await mongo.walletTransactions().findOne({exchange_id: created.id});
  assert.equal(summary.availableCoins, entry.coins, 'credited exactly once');
  assert.equal((await wallet.reconcile(user.id))[0].balanced, true);
});

test('two concurrent transitions out of one state let only one through', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items} = await deliveredOrder();
  const created = await exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
  });

  const results = await Promise.allSettled([
    exchanges.transition(created.id, 'approved', {actor: adminUser}),
    exchanges.transition(created.id, 'rejected', {actor: adminUser, note: 'Rejected on inspection of photos.'}),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const request = await mongo.exchangeRequests().findOne({_id: created.id});
  assert.ok(['approved', 'rejected'].includes(request.status));
  // One history row for the creation and one for whichever transition won.
  assert.equal(await mongo.exchangeStatusHistory().countDocuments({exchange_id: created.id}), 2,
    'the losing transition leaves no history behind');
});

/* --------------------------------------------------------------------- reads */

test('a request carries its number, its lines and its full history', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items, order} = await deliveredOrder();
  const replacementVariant = await makeVariant();

  const created = await exchanges.createExchange(user, orderId, {
    reason: 'size_too_small', note: 'Runs small on the shoulders.',
    images: ['/uploads/a.webp'],
    items: [{order_item_id: items[0].id, quantity: 1, replacement_variant_id: replacementVariant}],
  });

  const stored = await mongo.exchangeRequests().findOne({_id: created.id});
  assert.equal(typeof stored.number, 'number', 'the identity column became a counter sequence');
  assert.ok(stored.number > 0);
  assert.deepEqual(stored.images, ['/uploads/a.webp'], 'images are stored as an array, not a JSON string');
  assert.equal(stored.calculation.paisePerCoin, 100, 'the working is stored as a document');

  await exchanges.transition(created.id, 'approved', {actor: adminUser, note: 'Looks fine.'});

  const detail = await exchanges.exchangeDetails(created.id);
  assert.equal(detail.order_number, order.number);
  assert.equal(detail.customer_email, user.email);
  assert.equal(detail.customer_name, 'Buyer');
  assert.equal(detail.items.length, 1);

  const line = detail.items[0];
  assert.equal(line.name, items[0].name, 'the order line snapshot is joined in');
  assert.equal(line.sku, items[0].sku);
  assert.equal(line.ordered_quantity, items[0].quantity);
  assert.equal(line.unit_price, items[0].unit_price);
  assert.ok(line.eligible_inr > 0, 'the per-line working was written back');
  const replacement = await mongo.variants().findOne({_id: replacementVariant});
  assert.equal(line.replacement_sku, replacement.sku, 'the LEFT JOIN on the replacement variant');
  assert.equal(line.replacement_size, 'M');

  assert.equal(detail.history.length, 2);
  assert.equal(detail.history[0].to_status, 'requested', 'oldest first');
  assert.equal(detail.history[1].to_status, 'approved');
  assert.equal(detail.history[1].actor_email, adminUser.email, 'the actor is resolved to an email');
  assert.deepEqual(detail.nextStates, exchanges.TRANSITIONS.approved);

  assert.equal(await exchanges.exchangeDetails(id()), null, 'an unknown id is a null, not a throw');
});

test('a line without a replacement variant reads back as null, not a crash', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId, items} = await deliveredOrder();
  const created = await exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
  });
  const detail = await exchanges.exchangeDetails(created.id);
  assert.equal(detail.items[0].replacement_variant_id, null);
  assert.equal(detail.items[0].replacement_sku, null);
  assert.equal(detail.items[0].replacement_size, null);
});

test('a line that is not on the order is refused', async () => {
  await settings({exchange_window_days: 30});
  const {user, orderId} = await deliveredOrder();
  await assert.rejects(() => exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [],
    items: [{order_item_id: id(), quantity: 1}],
  }), /not available to exchange/);
  await assert.rejects(() => exchanges.createExchange(user, orderId, {
    reason: 'damaged', note: '', images: [], items: [],
  }), /at least one item/);
  assert.equal(await mongo.exchangeRequests().countDocuments({order_id: orderId}), 0,
    'a refused request leaves nothing behind');
});
