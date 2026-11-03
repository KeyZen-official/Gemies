// Tranche 2: commerce, payments and wallet on MongoDB.
//
// These three move together because they share transactions. The tests that
// matter most are the concurrency ones: six `SELECT ... FOR UPDATE` locks were
// replaced by conditional atomic updates, and if a filter is wrong MongoDB
// will not catch it the way a CHECK constraint would.
//
//   node --test tests/tranche2.test.mjs
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

await startMongo();

const mongo = await import('../server/mongo.mjs');
const {id, passwordHash} = await import('../server/security.mjs');
const commerce = await import('../server/commerce.mjs');
const wallet = await import('../server/wallet.mjs');
const paymentsModule = await import('../server/payments.mjs');

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
  city: 'Test City', state: 'Test State', postalCode: '400001', country: 'India',
};

let productId;

before(async () => {
  await mongo.connect();
  await mongo.ensureSchema();
  const categoryId = id();
  productId = id();
  await mongo.categories().insertOne({_id: categoryId, id: categoryId, name: 'Tees', slug: 'tees', segment: 'tees', parent_id: null, in_nav: true, display_order: 0});
  await mongo.products().insertOne({
    _id: productId, id: productId, slug: 'tranche2-tee', name: 'Tranche2 Tee',
    description: 'Fixture product for tranche 2 tests.', brand: 'Gemies',
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

async function makeUser() {
  const uid = id();
  await mongo.users().insertOne({
    _id: uid, id: uid, name: 'Buyer', email: `b${uid}@example.invalid`,
    password_hash: await passwordHash('a-very-secure-test-password'),
    role: 'customer', verified: true, created_at: new Date(),
  });
  return {id: uid, email: `b${uid}@example.invalid`};
}

// Variants are unique on (product_id, size, color), so every fixture variant
// needs its own colourway or the second one in a test file collides.
let variantSeq = 0;
async function makeVariant(stock, reserved = 0) {
  const vid = id();
  variantSeq += 1;
  await mongo.variants().insertOne({
    _id: vid, id: vid, product_id: productId, sku: `SKU-${vid.slice(0, 8)}`,
    size: 'M', color: `Black-${variantSeq}`, stock, reserved,
  });
  return vid;
}

const addToCart = (user, variantId, quantity = 1) => mongo.cartItems().updateOne(
  {user_id: user.id, variant_id: variantId},
  {$set: {user_id: user.id, variant_id: variantId, quantity}},
  {upsert: true},
);

async function capture(order) {
  const p = await commerce.paymentOrder(order._id ?? order.id);
  const payment = {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: p.amount, currency: p.currency, status: 'captured', captured: true,
  };
  remotes.set(payment.id, payment);
  await commerce.acceptCapturedPayment(payment);
  return payment;
}

const credit = (user, coins) => wallet.postStandalone({
  userId: user.id, kind: 'promotional_credit', coins,
  idempotencyKey: `seed:${id()}`, description: 'Test credit',
});

/* ------------------------------------------------------------- cart & quote */

test('the cart joins variants and products, and quote applies settings', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 2);

  const rows = await commerce.cart(user.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Tranche2 Tee');
  assert.equal(rows[0].price, 100000);
  assert.equal(rows[0].available, 10, 'available is stock minus reserved');
  assert.equal(rows[0].sku.startsWith('SKU-'), true);

  const q = await commerce.quote(user.id);
  assert.equal(q.subtotal, 200000);
  assert.equal(q.total, 200000, 'no tax or shipping configured by default');
  assert.equal(q.currency, 'INR');
  assert.equal(q.tax_bps, 0);
});

test('a coupon discounts the quote and enforces its minimum', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  await mongo.coupons().insertOne({_id: 'TEN', code: 'TEN', percent: 10, active: true, expires_at: null, minimum: 0});
  await mongo.coupons().insertOne({_id: 'BIG', code: 'BIG', percent: 50, active: true, expires_at: null, minimum: 999999});

  const q = await commerce.quote(user.id, 'TEN');
  assert.equal(q.discount, 10000);
  assert.equal(q.total, 90000);
  await assert.rejects(() => commerce.quote(user.id, 'BIG'), (e) => e.status === 400 && /minimum spend/i.test(e.message));
  await assert.rejects(() => commerce.quote(user.id, 'NOPE'), (e) => e.status === 400);
  // Lowercase is accepted, as the SQL upper-cased the code.
  assert.equal((await commerce.quote(user.id, 'ten')).discount, 10000);
});

/* ------------------------------------------------- lock 2: stock reservation */

test('stock cannot be oversold by concurrent checkouts', async () => {
  const v = await makeVariant(5);
  const buyers = await Promise.all(Array.from({length: 8}, () => makeUser()));
  for (const buyer of buyers) await addToCart(buyer, v, 1);

  const results = await Promise.allSettled(buyers.map((b) =>
    commerce.createOrder(b, {address: ADDRESS, coupon: '', useWallet: false}, id())));
  const made = results.filter((r) => r.status === 'fulfilled').length;
  const variant = await mongo.variants().findOne({_id: v});

  assert.equal(made, 5, `only five of eight could reserve, got ${made}`);
  assert.equal(variant.reserved, 5, 'reserved matches the orders placed');
  assert.ok(variant.reserved <= variant.stock, 'reserved never exceeds stock');
  for (const failure of results.filter((r) => r.status === 'rejected')) {
    assert.equal(failure.reason.status, 409);
    assert.match(failure.reason.message, /enough stock/);
  }
});

test('a reservation larger than the free stock is refused outright', async () => {
  const user = await makeUser();
  const v = await makeVariant(3, 2);
  await addToCart(user, v, 2);
  await assert.rejects(
    () => commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id()),
    (e) => e.status === 409 && /enough stock/.test(e.message),
  );
  assert.equal((await mongo.variants().findOne({_id: v})).reserved, 2, 'nothing was reserved');
});

/* --------------------------------------------- lock 1: checkout idempotency */

test('one idempotency key is one order, even concurrently', async () => {
  const user = await makeUser();
  const v = await makeVariant(50);
  await addToCart(user, v, 1);
  const key = id();

  const results = await Promise.allSettled(Array.from({length: 5}, () =>
    commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, key)));
  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.ok(ok.length >= 1, 'at least one succeeded');
  assert.equal(new Set(ok.map((r) => r.value._id)).size, 1, 'all successes are the same order');
  assert.equal(await mongo.orders().countDocuments({user_id: user.id, checkout_key: key}), 1);
  // And the stock was reserved once, not five times.
  assert.equal((await mongo.variants().findOne({_id: v})).reserved, 1);
});

test('the same key with different details is refused', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const key = id();
  await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, key);
  await assert.rejects(
    () => commerce.createOrder(user, {address: {...ADDRESS, city: 'Elsewhere'}, coupon: '', useWallet: false}, key),
    (e) => e.status === 409 && /details changed/.test(e.message),
  );
});

test('an order number is a gapless atomic sequence', async () => {
  const user = await makeUser();
  const v = await makeVariant(20);
  const numbers = [];
  for (let n = 0; n < 4; n += 1) {
    await addToCart(user, v, 1);
    const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
    numbers.push(order.number);
  }
  assert.equal(new Set(numbers).size, 4, 'every order number is distinct');
  for (let n = 1; n < numbers.length; n += 1) {
    assert.equal(numbers[n], numbers[n - 1] + 1, 'and they increment by one');
  }
});

/* ------------------------------------------------ locks 3 & 4: payment path */

test('a browser refresh mid-payment reuses one gateway order', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  const first = await commerce.paymentOrder(order._id);
  const second = await commerce.paymentOrder(order._id);
  assert.equal(first.gateway_order_id, second.gateway_order_id);
  assert.equal(await mongo.payments().countDocuments({order_id: order._id}), 1);
  assert.equal(first.amount, order.total);
});

test('a duplicate capture fulfils exactly once', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 2);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  const p = await commerce.paymentOrder(order._id);
  const payment = {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: p.amount, currency: p.currency, status: 'captured', captured: true,
  };
  remotes.set(payment.id, payment);

  // The webhook and the browser callback, together.
  await Promise.allSettled([
    commerce.acceptCapturedPayment(payment),
    commerce.acceptCapturedPayment(payment),
    commerce.acceptCapturedPayment(payment),
  ]);

  const settled = await mongo.orders().findOne({_id: order._id});
  assert.equal(settled.payment_status, 'paid');
  assert.equal(settled.status, 'confirmed');
  const variant = await mongo.variants().findOne({_id: v});
  assert.equal(variant.stock, 8, 'stock consumed exactly once');
  assert.equal(variant.reserved, 0, 'and the reservation released exactly once');
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: `invoice:${order._id}`}), 1);
  assert.equal(await mongo.paymentAttempts().countDocuments({gateway_payment_id: payment.id}), 1);
});

test('a capture for the wrong amount or currency is refused', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  const p = await commerce.paymentOrder(order._id);

  for (const bad of [
    {amount: p.amount + 1, currency: p.currency},
    {amount: p.amount, currency: 'USD'},
  ]) {
    const payment = {
      id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
      status: 'captured', captured: true, ...bad,
    };
    remotes.set(payment.id, payment);
    await assert.rejects(() => commerce.acceptCapturedPayment(payment),
      (e) => e.status === 400 && /does not match the order/.test(e.message));
  }
  assert.equal((await mongo.orders().findOne({_id: order._id})).payment_status, 'pending');
});

test('an uncaptured payment is refused, and a second payment id cannot attach', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  const p = await commerce.paymentOrder(order._id);

  await assert.rejects(() => commerce.acceptCapturedPayment({
    id: 'pay_x', order_id: p.gateway_order_id, amount: p.amount, currency: p.currency,
    status: 'authorized', captured: false,
  }), (e) => e.status === 409 && /not captured/.test(e.message));

  const good = {id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id, amount: p.amount, currency: p.currency, status: 'captured', captured: true};
  remotes.set(good.id, good);
  await commerce.acceptCapturedPayment(good);

  const other = {id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id, amount: p.amount, currency: p.currency, status: 'captured', captured: true};
  remotes.set(other.id, other);
  await assert.rejects(() => commerce.acceptCapturedPayment(other),
    (e) => e.status === 409 && /different payment is already attached/.test(e.message));
});

test('a capture after the reservation lapsed is held for refund, not fulfilled', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  const p = await commerce.paymentOrder(order._id);
  // The reservation expired and the order was released.
  await commerce.releaseOrder(order._id);

  const payment = {id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id, amount: p.amount, currency: p.currency, status: 'captured', captured: true};
  remotes.set(payment.id, payment);
  await commerce.acceptCapturedPayment(payment);

  const settled = await mongo.orders().findOne({_id: order._id});
  assert.equal(settled.payment_status, 'paid');
  assert.equal(settled.status, 'review', 'held for review rather than confirmed');
  assert.equal((await mongo.variants().findOne({_id: v})).stock, 10, 'no stock was consumed');
  assert.ok(await mongo.jobs().findOne({dedupe_key: `refund:${order._id}`}), 'a refund was queued');
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: `invoice:${order._id}`}), 0, 'and no invoice');
});

/* ---------------------------------------------------- lock 6: releaseOrder */

test('concurrent releases free the stock exactly once', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 3);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  assert.equal((await mongo.variants().findOne({_id: v})).reserved, 3);

  const results = await Promise.all(Array.from({length: 5}, () => commerce.releaseOrder(order._id)));
  assert.equal(results.filter(Boolean).length, 1, 'only one release took effect');
  const variant = await mongo.variants().findOne({_id: v});
  assert.equal(variant.reserved, 0, 'stock released once, not five times');
  assert.equal(variant.stock, 10);
  assert.equal((await mongo.orders().findOne({_id: order._id})).status, 'cancelled');
});

test('a paid order cannot be released', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await capture(order);
  assert.equal(await commerce.releaseOrder(order._id), false);
  assert.equal((await mongo.orders().findOne({_id: order._id})).status, 'confirmed');
});

/* ---------------------------------------- lock 5 + wallet: the CHECK is gone */

test('the wallet cannot be overdrawn, concurrently', async () => {
  const user = await makeUser();
  await credit(user, 100);
  // Five independent debits of 30 against 100: at most three fit, and the
  // balance must never go below zero. This is the test that replaces
  // CHECK(balance_coins >= 0).
  const attempts = await Promise.allSettled(Array.from({length: 5}, () => wallet.postStandalone({
    userId: user.id, kind: 'expiry', coins: 30, idempotencyKey: `burn:${id()}`, description: 'Concurrent debit',
  })));
  const settled = attempts.filter((a) => a.status === 'fulfilled').length;
  const summary = await wallet.walletSummary(user.id);
  assert.ok(settled <= 3, `at most three debits of 30 fit in 100, got ${settled}`);
  assert.equal(summary.balanceCoins, 100 - settled * 30);
  assert.ok(summary.balanceCoins >= 0);
  const [recon] = await wallet.reconcile(user.id);
  assert.equal(recon.balanced, true, 'the cached balance still equals the ledger');
});

test('one idempotency key is one wallet movement, concurrently', async () => {
  const user = await makeUser();
  const key = `once:${id()}`;
  const results = await Promise.allSettled(Array.from({length: 8}, () => wallet.postStandalone({
    userId: user.id, kind: 'promotional_credit', coins: 40, idempotencyKey: key, description: 'Race',
  })));
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.equal(await mongo.walletTransactions().countDocuments({idempotency_key: key}), 1);
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 40, 'the balance moved once');
  const [recon] = await wallet.reconcile(user.id);
  assert.equal(recon.balanced, true);
});

test('coins reduce the gateway amount but not the order total', async () => {
  await mongo.storeSettings().updateOne({_id: 1}, {$set: {wallet_enabled: true, wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0}});
  const user = await makeUser();
  await credit(user, 300);
  const v = await makeVariant(10);
  await addToCart(user, v, 2);

  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  assert.equal(order.wallet_coins, 300);
  assert.equal(order.wallet_applied, 30000);
  assert.equal(order.total, 200000, 'the order keeps its full value');
  assert.equal(commerce.payableOf(order), 170000);

  const held = await wallet.walletSummary(user.id);
  assert.equal(held.balanceCoins, 300, 'nothing is debited before payment');
  assert.equal(held.heldCoins, 300);

  const p = await commerce.paymentOrder(order._id);
  assert.equal(p.amount, 170000, 'the gateway is asked for the remainder only');
  await capture(order);

  const after = await wallet.walletSummary(user.id);
  assert.equal(after.balanceCoins, 0, 'coins spent on capture');
  assert.equal(after.heldCoins, 0);
  const [recon] = await wallet.reconcile(user.id);
  assert.equal(recon.balanced, true);
});

test('a wallet-only order settles without any gateway payment, exactly once', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  await credit(user, 1000);

  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  assert.equal(commerce.payableOf(order), 0);
  await assert.rejects(() => commerce.paymentOrder(order._id),
    (e) => e.status === 409 && /needs no card payment/.test(e.message));

  // Five concurrent settlements.
  await Promise.allSettled(Array.from({length: 5}, () => commerce.completeWalletOrder(order._id)));
  const settled = await mongo.orders().findOne({_id: order._id});
  assert.equal(settled.payment_status, 'paid');
  assert.equal(settled.status, 'confirmed');
  assert.equal(await mongo.payments().countDocuments({order_id: order._id}), 0, 'no gateway payment exists');
  assert.equal(await mongo.walletTransactions().countDocuments({order_id: order._id, kind: 'purchase_redemption'}), 1,
    'the coins were spent exactly once');
  assert.equal((await mongo.variants().findOne({_id: v})).stock, 9, 'stock consumed once');
  assert.ok(await mongo.jobs().findOne({dedupe_key: `invoice:${order._id}`}));
  const [recon] = await wallet.reconcile(user.id);
  assert.equal(recon.balanced, true);
});

test('a released order returns its held coins unspent', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 2);
  await credit(user, 200);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  assert.equal((await wallet.walletSummary(user.id)).heldCoins, 200);

  await commerce.releaseOrder(order._id);
  const after = await wallet.walletSummary(user.id);
  assert.equal(after.balanceCoins, 200, 'every coin is still there');
  assert.equal(after.heldCoins, 0);
  assert.equal(after.availableCoins, 200);
  assert.equal(await mongo.walletTransactions().countDocuments({order_id: order._id}), 0,
    'no ledger entry was ever written');
});

test('one order can hold coins only once', async () => {
  const user = await makeUser();
  await credit(user, 400);
  const orderId = id();
  await mongo.orders().insertOne({_id: orderId, id: orderId, user_id: user.id, number: 999999, total: 100000, wallet_applied: 0, currency: 'INR'});
  await mongo.transaction((s) => wallet.reserve(s, {userId: user.id, orderId, coins: 100, idempotencyKey: `a:${orderId}`}));
  await assert.rejects(
    () => mongo.transaction((s) => wallet.reserve(s, {userId: user.id, orderId, coins: 100, idempotencyKey: `b:${orderId}`})),
    (e) => e.code === 11000 || /duplicate key/i.test(e.message),
    'the partial unique index allows one live hold per order',
  );
});

/* ------------------------------------------------------------ payment states */

test('an authorised payment records an attempt and fulfils nothing', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  const p = await commerce.paymentOrder(order._id);

  const result = await paymentsModule.markAuthorized({
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: p.amount, currency: p.currency, status: 'authorized', method: 'card',
  });
  assert.equal(result.recorded, true);
  const payment = await mongo.payments().findOne({order_id: order._id});
  assert.equal(payment.status, 'authorized');
  assert.ok(payment.authorized_at);
  assert.equal(payment.gateway_payment_id, null, 'authorisation does not attach a payment id');
  assert.equal((await mongo.orders().findOne({_id: order._id})).status, 'pending', 'nothing fulfilled');
  assert.equal((await mongo.variants().findOne({_id: v})).stock, 10);
});

test('a failed payment leaves the order open and emails once per attempt', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  const p = await commerce.paymentOrder(order._id);
  const failure = {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: p.amount, currency: p.currency, status: 'failed',
    error_code: 'BAD_CARD', error_description: 'Card declined by issuer',
  };
  await paymentsModule.markFailed(failure);
  await paymentsModule.markFailed(failure);

  assert.equal((await mongo.orders().findOne({_id: order._id})).status, 'pending', 'the order stays open for a retry');
  assert.equal((await mongo.payments().findOne({order_id: order._id})).status, 'failed');
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: `payment-failed:${failure.id}`}), 1,
    'one email per failed attempt, not per webhook delivery');
  const attempt = await mongo.paymentAttempts().findOne({gateway_payment_id: failure.id});
  assert.equal(attempt.error_code, 'BAD_CARD');

  // A retry can still capture against the same gateway order.
  const good = {id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id, amount: p.amount, currency: p.currency, status: 'captured', captured: true};
  remotes.set(good.id, good);
  await commerce.acceptCapturedPayment(good);
  assert.equal((await mongo.orders().findOne({_id: order._id})).status, 'confirmed');
  assert.equal(await mongo.paymentAttempts().countDocuments({order_id: order._id}), 2, 'both attempts are on record');
});

test('a captured attempt is never moved backwards by a late event', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  const p = await commerce.paymentOrder(order._id);
  const payment = {id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id, amount: p.amount, currency: p.currency, status: 'captured', captured: true};
  remotes.set(payment.id, payment);
  await commerce.acceptCapturedPayment(payment);

  // A payment.failed for the same id arrives late.
  await paymentsModule.markFailed({...payment, status: 'failed', error_description: 'Late failure'});
  assert.equal((await mongo.paymentAttempts().findOne({gateway_payment_id: payment.id})).status, 'captured',
    'the capture stands');
  assert.equal((await mongo.payments().findOne({order_id: order._id})).status, 'captured');
  assert.equal((await mongo.orders().findOne({_id: order._id})).status, 'confirmed');
});

test('orderDetails returns the full shape the API responds with', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 2);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await capture(order);

  const details = await commerce.orderDetails(order._id);
  assert.equal(details.id, order._id, 'id mirrors _id');
  assert.equal(details.number, order.number);
  assert.equal(details.items.length, 1);
  assert.equal(details.items[0].unit_price, 100000, 'the line price is the snapshot, not the live product');
  assert.ok(details.payment.gateway_payment_id);
  assert.equal(details.shipment, null);
  assert.deepEqual(details.refunds, []);
  assert.equal(details.refund, null);
  assert.deepEqual(details.events, []);
  assert.equal(details.address.city, 'Test City');
  assert.equal(await commerce.orderDetails('no-such-order'), null);
});

test('an order line is a snapshot that later catalogue edits cannot change', async () => {
  const user = await makeUser();
  const v = await makeVariant(10);
  await addToCart(user, v, 1);
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await mongo.products().updateOne({_id: productId}, {$set: {name: 'RENAMED', price: 1}});
  const details = await commerce.orderDetails(order._id);
  assert.equal(details.items[0].name, 'Tranche2 Tee', 'the order keeps the name it was placed with');
  assert.equal(details.items[0].unit_price, 100000);
  await mongo.products().updateOne({_id: productId}, {$set: {name: 'Tranche2 Tee', price: 100000}});
});
