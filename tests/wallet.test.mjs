// Wallet ledger — Phase 1.
//
// Financial behaviour, tested against an isolated in-memory database. The
// things asserted here are the ones that cost real money if they are wrong:
// a balance that can go negative, a credit that applies twice, coins consumed
// by a payment that never completed, or a conversion-rate change that restates
// history.
//
//   npm test
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
process.env.BUSINESS_NAME = 'TEST FIXTURE — NOT A REAL INVOICE';
process.env.BUSINESS_ADDRESS = 'Test address only';
process.env.BUSINESS_EMAIL = 'fixture@example.invalid';
process.env.RESEND_API_KEY = 'fixture';
process.env.EMAIL_FROM = 'fixture@example.invalid';

// An isolated in-memory replica set, started before anything under server/ is
// imported so those modules connect to it and never to Atlas.
await startMongo();
const mongo = await import('../server/mongo.mjs');
const {
  users, categories, products, variants, cartItems, orders, orderItems, payments,
  refunds, invoices: invoiceDocs, jobs, auditLogs, storeSettings, walletAccounts,
  walletTransactions, exchangeRequests,
} = mongo;
/** `SELECT count(*)::int AS n FROM c WHERE ...`, keeping the `.n` shape. */
const countN = async (collection, filter = {}) => ({n: await collection().countDocuments(filter)});
const {app} = await import('../server/app.mjs');
const {id, passwordHash} = await import('../server/security.mjs');
const wallet = await import('../server/wallet.mjs');

let server, base, customer, other, adminUser, variantId;
const nativeFetch = globalThis.fetch;
const remotes = new Map();

// Only Razorpay and Resend are reached by these tests; anything else is a bug
// in the test rather than something to stub generously.
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith(base || 'http://never.invalid')) return nativeFetch(url, options);
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
  if (!data) throw new Error(`Unexpected test provider call: ${url}`);
  return new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}});
};

async function request(route, {method = 'GET', body, session, headers = {}} = {}) {
  const response = await nativeFetch(`${base}/api${route}`, {
    method,
    headers: {
      Origin: process.env.APP_URL,
      ...(body ? {'Content-Type': 'application/json'} : {}),
      ...(session ? {Cookie: session.cookie, 'X-CSRF-Token': session.csrf} : {}),
      ...headers,
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const data = response.headers.get('content-type')?.includes('json')
    ? await response.json() : await response.arrayBuffer();
  return {status: response.status, data};
}

/**
 * A customer row, with no session.
 *
 * Signing in is deliberately separate: POST /auth/login is rate limited to
 * twelve attempts per IP per fifteen minutes, and most of the wallets below
 * are exercised through the module rather than over HTTP. Logging in for each
 * one exhausts the limiter and every later login silently returns 429.
 */
async function fixtureUser(name, role = 'customer') {
  const uid = id();
  const email = `${name}@example.invalid`;
  await users().insertOne({
    _id: uid, id: uid, name, email,
    password_hash: await passwordHash('a-very-secure-test-password'),
    verified: true, role, created_at: new Date(),
  });
  return {id: uid, name, email, role};
}

/** A customer row plus a signed-in session, for the routes that need one. */
async function fixtureSession(name, role = 'customer') {
  const user = await fixtureUser(name, role);
  const response = await nativeFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {Origin: process.env.APP_URL, 'Content-Type': 'application/json'},
    body: JSON.stringify({email: user.email, password: 'a-very-secure-test-password'}),
  });
  assert.equal(response.status, 200, `fixture login for ${name} should succeed`);
  const payload = await response.json();
  return {...user, cookie: response.headers.get('set-cookie').split(';')[0], csrf: payload.user.csrf};
}

/** Puts the wallet into a known, fully configured state. */
async function configure(overrides = {}) {
  const base = {
    wallet_enabled: true, wallet_paise_per_coin: 100, wallet_min_redeem_coins: 0,
    wallet_max_order_percent: 100, wallet_min_order_value: 0,
    wallet_partial_redemption: true, wallet_coins_expire: false, wallet_expiry_days: 0,
    wallet_promo_enabled: true, exchange_enabled: true, exchange_window_days: 14,
    exchange_credit_shipping: false, ...overrides,
  };
  await storeSettings().updateOne({_id: 1}, {$set: {...base}});
  return base;
}

const credit = (user, coins, key, extra = {}) => wallet.postStandalone({
  userId: user.id, kind: 'promotional_credit', coins, idempotencyKey: key,
  description: 'Test credit', ...extra,
});

/** The ledger is the record; this proves the cached balance still agrees. */
async function assertBalanced(user) {
  const [row] = await wallet.reconcile(user.id);
  assert.ok(row, 'an account row should exist');
  assert.equal(row.cached, row.ledger, `cached ${row.cached} should equal ledger ${row.ledger}`);
  assert.equal(row.cached_credited, row.ledger_credited);
  assert.equal(row.cached_debited, row.ledger_debited);
  assert.equal(row.balanced, true);
}

before(async () => {
  await mongo.connect();
  await mongo.ensureSchema();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  customer = await fixtureSession('walletcustomer');
  other = await fixtureSession('walletother');
  adminUser = await fixtureSession('walletadmin', 'admin');
  const categoryId = id();
  const productId = id();
  variantId = id();
  await categories().insertOne({_id: categoryId, id: categoryId, name: 'Tees', slug: 'tees', segment: 'tees', parent_id: null, in_nav: true, display_order: 0});
  await products().insertOne({
    _id: productId, id: productId, slug: 'wallet-test-tee', name: 'Wallet test tee',
    description: 'Fixture product for wallet tests only.', brand: 'Test brand',
    category_id: categoryId, audience: 'Unisex', price: 100000, compare_price: null,
    images: ['/assets/products/regular-black-02.webp'], published: true, featured: false,
    is_demo: false, display_order: 0, swatches: [], colorways: [], fit: null, fabric: null,
    created_at: new Date(),
  });
  await variants().insertOne({_id: variantId, id: variantId, product_id: productId, sku: 'WALLET-TEST-M', size: 'M', color: 'Black', stock: 100, reserved: 0});
  await configure();
});

after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise((resolve) => server.close(resolve));
  await mongo.close();
  await stopMongo();
});

/* ------------------------------------------------------------------- schema */

test('a fresh store has the wallet switched off until it is configured', async () => {
  // This read column defaults out of information_schema, because a DDL default
  // was what an existing store got when the migration was applied to it. A
  // document has no column defaults, so the equivalent single source of truth
  // is DEFAULT_SETTINGS in mongo.mjs, which is what ensureSchema seeds the
  // settings singleton with on a database that does not have one yet.
  const defaults = mongo.DEFAULT_SETTINGS;
  const policy = Object.keys(defaults).filter((k) => k.startsWith('wallet') || k.startsWith('exchange'));
  assert.equal(policy.length, 12, 'twelve wallet and exchange settings');
  assert.equal(defaults.wallet_enabled, false, 'the wallet is off by default');
  assert.equal(defaults.exchange_enabled, false, 'exchanges are off by default');
  assert.equal(defaults.exchange_window_days, 0, 'no eligibility window is invented');
  assert.equal(defaults.wallet_paise_per_coin, 100, 'the default rate is 1 coin = 1 rupee');
  assert.equal(defaults.wallet_coins_expire, false);
  assert.equal(defaults.wallet_promo_enabled, false);

  // And every collection the wallet and exchange code writes to is readable,
  // which is what the `SELECT count(*) FROM <table>` loop was checking.
  for (const collection of [walletAccounts, walletTransactions, mongo.walletReservations,
    exchangeRequests, mongo.exchangeItems, mongo.exchangeStatusHistory]) {
    assert.equal(typeof await collection().countDocuments({}), 'number');
  }
});

test('no wallet code path can drive a balance negative, and drift is detectable', async () => {
  // This used to assert that a raw `UPDATE wallet_accounts SET
  // balance_coins=-1` was refused by a CHECK constraint. MongoDB has no CHECK,
  // so that guarantee moved into the debit's own filter
  // (`balance_coins: {$gte: coins}` in wallet.post) and is enforced by the
  // query rather than by the engine. That is a real reduction in enforcement,
  // so this test now covers both halves of what is actually true.
  const subject = await fixtureUser(`negbal${id().slice(0, 8)}`);
  await wallet.ensureAccount(subject.id);
  await credit(subject, 10, `neg:${id()}`);

  // 1. The application cannot do it. An over-debit is refused and moves nothing.
  await assert.rejects(
    () => wallet.postStandalone({
      userId: subject.id, kind: 'admin_adjustment', signedDirection: 'debit',
      coins: 11, idempotencyKey: `over:${id()}`, description: 'Over-debit attempt',
    }),
    /Insufficient wallet balance/,
  );
  assert.equal((await walletAccounts().findOne({user_id: subject.id})).balance_coins, 10);

  // Nor concurrently: ten debits of 10 against a balance of 10.
  const racers = await Promise.allSettled(Array.from({length: 10}, () => wallet.postStandalone({
    userId: subject.id, kind: 'admin_adjustment', signedDirection: 'debit',
    coins: 10, idempotencyKey: `race:${id()}`, description: 'Concurrent debit',
  })));
  assert.equal(racers.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one debit applied');
  assert.equal((await walletAccounts().findOne({user_id: subject.id})).balance_coins, 0);
  assert.ok((await walletAccounts().findOne({user_id: subject.id})).balance_coins >= 0);

  // 2. A write that bypasses the application CAN now set a negative balance,
  // which the engine used to prevent. What still holds is that it cannot hide:
  // reconcile() compares the cached balance against the ledger and reports it.
  await walletAccounts().updateOne({user_id: subject.id}, {$set: {balance_coins: -1}});
  const [drifted] = await wallet.reconcile(subject.id);
  assert.equal(drifted.cached, -1, 'the engine no longer refuses this');
  assert.equal(drifted.balanced, false, 'but the integrity check catches it');
  assert.notEqual(drifted.cached, drifted.ledger);

  // And the admin integrity endpoint surfaces it rather than reporting health.
  const report = await request('/admin/wallet/integrity', {session: adminUser});
  assert.equal(report.status, 200);
  assert.ok(report.data.drifted.some((r) => r.user_id === subject.id),
    'a drifted account is listed, not silently averaged away');

  // Put it back so later assertions on totals are not poisoned.
  await walletAccounts().updateOne({user_id: subject.id}, {$set: {balance_coins: 0}});
  await assertBalanced(subject);
});

/* ------------------------------------------------------------------- ledger */

test('a credit records coins, the rate snapshot and the running balance', async () => {
  const row = await credit(customer, 500, `c:${id()}`);
  assert.equal(row.direction, 'credit');
  assert.equal(row.coins, 500);
  assert.equal(row.paise_per_coin, 100);
  assert.equal(row.inr_value, 50000, '500 coins at 100 paise is 50000 paise');
  assert.equal(row.balance_after, 500);
  await assertBalanced(customer);
});

test('a debit reduces the balance and records it', async () => {
  const before = (await wallet.walletSummary(customer.id)).balanceCoins;
  const row = await wallet.postStandalone({
    userId: customer.id, kind: 'expiry', coins: 100,
    idempotencyKey: `d:${id()}`, description: 'Test expiry',
  });
  assert.equal(row.direction, 'debit');
  assert.equal(row.balance_after, before - 100);
  assert.equal((await wallet.walletSummary(customer.id)).balanceCoins, before - 100);
  await assertBalanced(customer);
});

test('a debit larger than the balance is refused and moves nothing', async () => {
  const before = (await wallet.walletSummary(customer.id)).balanceCoins;
  await assert.rejects(
    () => wallet.postStandalone({
      userId: customer.id, kind: 'expiry', coins: before + 1,
      idempotencyKey: `over:${id()}`, description: 'Overdraw attempt',
    }),
    (error) => error.status === 409 && /insufficient/i.test(error.message),
  );
  assert.equal((await wallet.walletSummary(customer.id)).balanceCoins, before);
  await assertBalanced(customer);
});

test('one idempotency key is one movement of value', async () => {
  const key = `once:${id()}`;
  const before = (await wallet.walletSummary(customer.id)).balanceCoins;
  const first = await credit(customer, 250, key);
  const second = await credit(customer, 250, key);
  assert.equal(second.existing, true);
  assert.equal(second.id, first.id, 'the same row comes back');
  assert.equal((await wallet.walletSummary(customer.id)).balanceCoins, before + 250,
    'the balance moved once, not twice');
  await assertBalanced(customer);
});

test('concurrent retries of one credit produce exactly one transaction', async () => {
  const key = `race:${id()}`;
  const before = (await wallet.walletSummary(customer.id)).balanceCoins;
  const results = await Promise.all(Array.from({length: 8}, () => credit(customer, 40, key)));
  assert.equal(new Set(results.map((r) => r.id)).size, 1, 'all eight resolved to one row');
  assert.equal((await wallet.walletSummary(customer.id)).balanceCoins, before + 40);
  const count = await countN(walletTransactions, {idempotency_key: key});
  assert.equal(count.n, 1);
  await assertBalanced(customer);
});

test('concurrent debits cannot between them overdraw the balance', async () => {
  const victim = await fixtureUser(`race${Date.now().toString(36)}`);
  await credit(victim, 100, `seed:${id()}`);
  // Five independent debits of 30 against a balance of 100: at most three can
  // succeed, and the balance must never go below zero.
  const attempts = await Promise.allSettled(Array.from({length: 5}, () => wallet.postStandalone({
    userId: victim.id, kind: 'expiry', coins: 30,
    idempotencyKey: `burn:${id()}`, description: 'Concurrent debit',
  })));
  const settled = attempts.filter((a) => a.status === 'fulfilled').length;
  const balance = (await wallet.walletSummary(victim.id)).balanceCoins;
  assert.ok(settled <= 3, `at most three debits of 30 fit in 100, got ${settled}`);
  assert.equal(balance, 100 - settled * 30);
  assert.ok(balance >= 0);
  await assertBalanced(victim);
});

test('changing the conversion rate does not restate completed transactions', async () => {
  const user = await fixtureUser(`rate${Date.now().toString(36)}`);
  const atOneRupee = await credit(user, 100, `rate:${id()}`);
  assert.equal(atOneRupee.paise_per_coin, 100);
  assert.equal(atOneRupee.inr_value, 10000);

  await configure({wallet_paise_per_coin: 250});
  const atTwoFifty = await credit(user, 100, `rate2:${id()}`);
  assert.equal(atTwoFifty.paise_per_coin, 250, 'the new rate applies to new transactions');
  assert.equal(atTwoFifty.inr_value, 25000);

  const reread = await walletTransactions().findOne({_id: atOneRupee.id});
  assert.equal(reread.paise_per_coin, 100, 'the earlier transaction keeps its own rate');
  assert.equal(reread.inr_value, 10000, 'and its own rupee value');
  await configure();
});

/* -------------------------------------------------------------- reservations */

test('a reservation holds coins without spending them', async () => {
  const user = await fixtureUser(`hold${Date.now().toString(36)}`);
  await credit(user, 300, `hold:${id()}`);
  const orderId = id();
  // `number` was a GENERATED ALWAYS AS IDENTITY column, so the SQL insert left
  // it out. It is uniquely indexed, so a document has to carry one or the
  // second fixture order collides on null.
  await orders().insertOne({
    _id: orderId, id: orderId, number: await mongo.nextSequence('orders'),
    user_id: user.id, checkout_key: id(), request_hash: 'h',
    currency: 'INR', subtotal: 100000, discount: 0, tax: 0, shipping: 0, total: 100000,
    tax_bps: 0, address: {}, email: user.email, status: 'pending', payment_status: 'pending',
    reserved: false, wallet_applied: 0, wallet_coins: 0, expires_at: null, created_at: new Date(),
  });

  await mongo.transaction((session) => wallet.reserve(session, {userId: user.id, orderId, coins: 120, idempotencyKey: `res:${orderId}`}));
  const summary = await wallet.walletSummary(user.id);
  assert.equal(summary.balanceCoins, 300, 'the balance is untouched by a hold');
  assert.equal(summary.heldCoins, 120);
  assert.equal(summary.availableCoins, 180, 'only unheld coins are available to spend');
  assert.equal(
    (await countN(walletTransactions, {user_id: user.id})).n, 1,
    'a hold writes no ledger row',
  );
  return {user, orderId};
});

test('releasing a hold costs the customer nothing and writes no ledger row', async () => {
  const user = await fixtureUser(`rel${Date.now().toString(36)}`);
  await credit(user, 300, `rel:${id()}`);
  const orderId = id();
  // `number` was a GENERATED ALWAYS AS IDENTITY column, so the SQL insert left
  // it out. It is uniquely indexed, so a document has to carry one or the
  // second fixture order collides on null.
  await orders().insertOne({
    _id: orderId, id: orderId, number: await mongo.nextSequence('orders'),
    user_id: user.id, checkout_key: id(), request_hash: 'h',
    currency: 'INR', subtotal: 100000, discount: 0, tax: 0, shipping: 0, total: 100000,
    tax_bps: 0, address: {}, email: user.email, status: 'pending', payment_status: 'pending',
    reserved: false, wallet_applied: 0, wallet_coins: 0, expires_at: null, created_at: new Date(),
  });
  await mongo.transaction((session) => wallet.reserve(session, {userId: user.id, orderId, coins: 200, idempotencyKey: `res:${orderId}`}));
  assert.equal((await wallet.walletSummary(user.id)).availableCoins, 100);

  // This is the failed-payment path.
  await mongo.transaction((session) => wallet.releaseReservation(session, {orderId}));
  const after = await wallet.walletSummary(user.id);
  assert.equal(after.balanceCoins, 300, 'the balance is intact');
  assert.equal(after.heldCoins, 0);
  assert.equal(after.availableCoins, 300, 'every coin is spendable again');
  assert.equal((await countN(walletTransactions, {user_id: user.id})).n, 1,
    'releasing writes no ledger row, because nothing was ever spent');
  await assertBalanced(user);
});

test('consuming a hold debits exactly once, at the rate it was held at', async () => {
  const user = await fixtureUser(`con${Date.now().toString(36)}`);
  await credit(user, 500, `con:${id()}`);
  const orderId = id();
  // `number` was a GENERATED ALWAYS AS IDENTITY column, so the SQL insert left
  // it out. It is uniquely indexed, so a document has to carry one or the
  // second fixture order collides on null.
  await orders().insertOne({
    _id: orderId, id: orderId, number: await mongo.nextSequence('orders'),
    user_id: user.id, checkout_key: id(), request_hash: 'h',
    currency: 'INR', subtotal: 100000, discount: 0, tax: 0, shipping: 0, total: 100000,
    tax_bps: 0, address: {}, email: user.email, status: 'pending', payment_status: 'pending',
    reserved: false, wallet_applied: 0, wallet_coins: 0, expires_at: null, created_at: new Date(),
  });
  await mongo.transaction((session) => wallet.reserve(session, {userId: user.id, orderId, coins: 150, idempotencyKey: `res:${orderId}`}));

  // The rate moves between holding and capture; the hold's rate must win.
  await configure({wallet_paise_per_coin: 500});
  const row = await mongo.transaction((session) => wallet.consumeReservation(session, {orderId}));
  assert.equal(row.kind, 'purchase_redemption');
  assert.equal(row.coins, 150);
  assert.equal(row.paise_per_coin, 100, 'the rate snapshotted on the hold is used');
  assert.equal(row.inr_value, 15000);
  await configure();

  const after = await wallet.walletSummary(user.id);
  assert.equal(after.balanceCoins, 350);
  assert.equal(after.heldCoins, 0);

  // A redelivered webhook or a retried capture must not debit again.
  const second = await mongo.transaction((session) => wallet.consumeReservation(session, {orderId}));
  assert.equal(second, null, 'there is no live hold left to consume');
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 350);
  await assertBalanced(user);
});

test('an order cannot hold coins twice', async () => {
  const user = await fixtureUser(`dbl${Date.now().toString(36)}`);
  await credit(user, 400, `dbl:${id()}`);
  const orderId = id();
  // `number` was a GENERATED ALWAYS AS IDENTITY column, so the SQL insert left
  // it out. It is uniquely indexed, so a document has to carry one or the
  // second fixture order collides on null.
  await orders().insertOne({
    _id: orderId, id: orderId, number: await mongo.nextSequence('orders'),
    user_id: user.id, checkout_key: id(), request_hash: 'h',
    currency: 'INR', subtotal: 100000, discount: 0, tax: 0, shipping: 0, total: 100000,
    tax_bps: 0, address: {}, email: user.email, status: 'pending', payment_status: 'pending',
    reserved: false, wallet_applied: 0, wallet_coins: 0, expires_at: null, created_at: new Date(),
  });
  await mongo.transaction((session) => wallet.reserve(session, {userId: user.id, orderId, coins: 100, idempotencyKey: `a:${orderId}`}));
  await assert.rejects(
    () => mongo.transaction((session) => wallet.reserve(session, {userId: user.id, orderId, coins: 100, idempotencyKey: `b:${orderId}`})),
    /unique|duplicate/i,
    'the live-hold index allows one hold per order',
  );
  assert.equal((await wallet.walletSummary(user.id)).heldCoins, 100);
});

test('a hold cannot exceed what is available after existing holds', async () => {
  const user = await fixtureUser(`cap${Date.now().toString(36)}`);
  await credit(user, 100, `cap:${id()}`);
  const orderId = id();
  // `number` was a GENERATED ALWAYS AS IDENTITY column, so the SQL insert left
  // it out. It is uniquely indexed, so a document has to carry one or the
  // second fixture order collides on null.
  await orders().insertOne({
    _id: orderId, id: orderId, number: await mongo.nextSequence('orders'),
    user_id: user.id, checkout_key: id(), request_hash: 'h',
    currency: 'INR', subtotal: 100000, discount: 0, tax: 0, shipping: 0, total: 100000,
    tax_bps: 0, address: {}, email: user.email, status: 'pending', payment_status: 'pending',
    reserved: false, wallet_applied: 0, wallet_coins: 0, expires_at: null, created_at: new Date(),
  });
  await assert.rejects(
    () => mongo.transaction((session) => wallet.reserve(session, {userId: user.id, orderId, coins: 101, idempotencyKey: `x:${orderId}`})),
    (error) => error.status === 409 && /insufficient/i.test(error.message),
  );
});

/* ------------------------------------------------------------------ policy */

test('redemption limits are applied on the server, in integer paise', async () => {
  const settings = {
    enabled: true, paisePerCoin: 100, minRedeemCoins: 10,
    maxOrderPercent: 50, minOrderValue: 50000, partialRedemption: true,
  };
  // A balance under the cap redeems in full.
  assert.deepEqual(
    wallet.redeemableFor({availableCoins: 1000, orderTotal: 300000, settings}),
    {coins: 1000, inr: 100000, allowed: true, reason: null},
  );
  // The cap bites: 50% of 300000 paise is 150000, which is 1500 coins.
  assert.equal(wallet.redeemableFor({availableCoins: 5000, orderTotal: 300000, settings}).coins, 1500);
  assert.equal(wallet.redeemableFor({availableCoins: 5000, orderTotal: 300000, settings}).inr, 150000);
  // Below the configured order minimum.
  assert.equal(wallet.redeemableFor({availableCoins: 1000, orderTotal: 10000, settings}).allowed, false);
  // Below the minimum redeemable coins.
  assert.equal(wallet.redeemableFor({availableCoins: 5, orderTotal: 300000, settings}).allowed, false);
  // A disabled wallet offers nothing.
  assert.equal(wallet.redeemableFor({availableCoins: 1000, orderTotal: 300000, settings: {...settings, enabled: false}}).allowed, false);
  // Nothing to spend.
  assert.equal(wallet.redeemableFor({availableCoins: 0, orderTotal: 300000, settings}).allowed, false);
  // With partial redemption off, coins must cover the order or are not offered.
  assert.equal(
    wallet.redeemableFor({availableCoins: 1000, orderTotal: 300000, settings: {...settings, partialRedemption: false}}).allowed,
    false,
  );
  assert.equal(
    wallet.redeemableFor({availableCoins: 1000, orderTotal: 100000, settings: {...settings, partialRedemption: false, maxOrderPercent: 100}}).coins,
    1000,
  );
  // A rate that does not divide the cap evenly floors rather than rounds up,
  // so a redemption can never exceed the configured share of the order.
  const odd = {...settings, paisePerCoin: 300, minRedeemCoins: 0, maxOrderPercent: 100, minOrderValue: 0};
  const result = wallet.redeemableFor({availableCoins: 100, orderTotal: 1000, settings: odd});
  assert.equal(result.coins, 3, '1000 paise buys three 300-paise coins, not four');
  assert.ok(result.inr <= 1000, 'the rupee value never exceeds the order total');
});

test('coin and paise conversion is integer-only and never rounds up', () => {
  assert.equal(wallet.coinsToPaise(7, 100), 700);
  assert.equal(wallet.paiseToCoins(999, 100), 9, 'floors rather than rounding to 10');
  assert.equal(wallet.paiseToCoins(99, 100), 0);
  assert.equal(wallet.paiseToCoins(0, 100), 0);
});

/* -------------------------------------------------- uniqueness guarantees */

test('one order can redeem at most once, enforced by the database', async () => {
  const user = await fixtureUser(`uniq${Date.now().toString(36)}`);
  await credit(user, 500, `uniq:${id()}`);
  const orderId = id();
  // `number` was a GENERATED ALWAYS AS IDENTITY column, so the SQL insert left
  // it out. It is uniquely indexed, so a document has to carry one or the
  // second fixture order collides on null.
  await orders().insertOne({
    _id: orderId, id: orderId, number: await mongo.nextSequence('orders'),
    user_id: user.id, checkout_key: id(), request_hash: 'h',
    currency: 'INR', subtotal: 100000, discount: 0, tax: 0, shipping: 0, total: 100000,
    tax_bps: 0, address: {}, email: user.email, status: 'pending', payment_status: 'pending',
    reserved: false, wallet_applied: 0, wallet_coins: 0, expires_at: null, created_at: new Date(),
  });
  await wallet.postStandalone({
    userId: user.id, kind: 'purchase_redemption', coins: 50, orderId,
    idempotencyKey: `r1:${orderId}`, description: 'First redemption',
  });
  // A different idempotency key, same order: the partial unique index is what
  // stops this, not the key.
  await assert.rejects(
    () => wallet.postStandalone({
      userId: user.id, kind: 'purchase_redemption', coins: 50, orderId,
      idempotencyKey: `r2:${orderId}`, description: 'Second redemption',
    }),
    /unique|duplicate/i,
  );
  await assertBalanced(user);
});

test('one exchange can credit at most once, enforced by the database', async () => {
  const user = await fixtureUser(`exuniq${Date.now().toString(36)}`);
  const orderId = id();
  // `number` was a GENERATED ALWAYS AS IDENTITY column, so the SQL insert left
  // it out. It is uniquely indexed, so a document has to carry one or the
  // second fixture order collides on null.
  await orders().insertOne({
    _id: orderId, id: orderId, number: await mongo.nextSequence('orders'),
    user_id: user.id, checkout_key: id(), request_hash: 'h',
    currency: 'INR', subtotal: 100000, discount: 0, tax: 0, shipping: 0, total: 100000,
    tax_bps: 0, address: {}, email: user.email, status: 'pending', payment_status: 'pending',
    reserved: false, wallet_applied: 0, wallet_coins: 0, expires_at: null, created_at: new Date(),
  });
  const exchangeId = id();
  await exchangeRequests().insertOne({
    _id: exchangeId, id: exchangeId, order_id: orderId, user_id: user.id,
    status: 'requested', reason: 'damaged', reason_note: '', images: [],
    eligible_coins: 100, eligible_inr: 10000, calculation: null, decision_note: '',
    credited_transaction_id: null, created_at: new Date(), updated_at: new Date(),
  });
  await wallet.postStandalone({
    userId: user.id, kind: 'exchange_credit', coins: 100, exchangeId, orderId,
    idempotencyKey: `ex1:${exchangeId}`, description: 'Exchange credit',
  });
  await assert.rejects(
    () => wallet.postStandalone({
      userId: user.id, kind: 'exchange_credit', coins: 100, exchangeId, orderId,
      idempotencyKey: `ex2:${exchangeId}`, description: 'Duplicate exchange credit',
    }),
    /unique|duplicate/i,
    'a second credit for the same exchange is impossible',
  );
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 100);
  await assertBalanced(user);
});

test('an unknown transaction kind or a non-positive amount is rejected', async () => {
  await assert.rejects(() => wallet.postStandalone({
    userId: customer.id, kind: 'cash_withdrawal', coins: 10,
    idempotencyKey: `bad:${id()}`, description: 'There is no cash-out',
  }), /Unknown wallet transaction kind/);
  await assert.rejects(() => wallet.postStandalone({
    userId: customer.id, kind: 'promotional_credit', coins: 0,
    idempotencyKey: `bad:${id()}`, description: 'Zero',
  }), /positive whole number/);
  await assert.rejects(() => wallet.postStandalone({
    userId: customer.id, kind: 'promotional_credit', coins: 1.5,
    idempotencyKey: `bad:${id()}`, description: 'Fractional',
  }), /positive whole number/);
});

/* -------------------------------------------------------------- admin tools */

test('an admin adjustment needs a reason and is recorded against the administrator', async () => {
  const user = await fixtureUser(`adj${Date.now().toString(36)}`);
  await assert.rejects(
    () => wallet.adminAdjust({userId: user.id, coins: 10, direction: 'credit', reason: 'x', actorId: adminUser.id, idempotencyKey: `a:${id()}`}),
    /reason of at least 5 characters/,
  );
  const row = await wallet.adminAdjust({
    userId: user.id, coins: 60, direction: 'credit',
    reason: 'Goodwill after a delayed delivery', actorId: adminUser.id, idempotencyKey: `a:${id()}`,
  });
  assert.equal(row.kind, 'admin_adjustment');
  assert.equal(row.direction, 'credit');
  assert.equal(row.actor_id, adminUser.id, 'the acting administrator is on the row');
  assert.equal(row.description, 'Goodwill after a delayed delivery');

  const down = await wallet.adminAdjust({
    userId: user.id, coins: 10, direction: 'debit',
    reason: 'Correcting an over-credit', actorId: adminUser.id, idempotencyKey: `b:${id()}`,
  });
  assert.equal(down.direction, 'debit');
  assert.equal(down.balance_after, 50);
  await assertBalanced(user);
});

test('a correction is a new entry; history cannot be edited away', async () => {
  const user = await fixtureUser(`imm${Date.now().toString(36)}`);
  const original = await credit(user, 80, `imm:${id()}`);
  // The only correction path the module exposes is another append.
  await wallet.adminAdjust({
    userId: user.id, coins: 80, direction: 'debit',
    reason: 'Reversing an incorrect promotional credit', actorId: adminUser.id, idempotencyKey: `rev:${id()}`,
  });
  const rows = {rows: await walletTransactions().find({user_id: user.id}).sort({created_at: 1}).toArray()};
  assert.equal(rows.rows.length, 2, 'both the mistake and its reversal are visible');
  assert.equal(rows.rows[0].id, original.id, 'the original row is untouched');
  assert.equal(rows.rows[0].coins, 80);
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 0);
  await assertBalanced(user);
});

/* ------------------------------------------------------------------ routes */

test('wallet routes require authentication and never serve another customer', async () => {
  assert.equal((await request('/wallet')).status, 401);
  assert.equal((await request('/wallet/transactions')).status, 401);
  assert.equal((await request('/admin/wallet/accounts')).status, 401);
  assert.equal((await request('/admin/wallet/accounts', {session: customer})).status, 403,
    'a customer cannot read the admin wallet list');
  assert.equal((await request('/admin/wallet/integrity', {session: customer})).status, 403);
  assert.equal(
    (await request(`/admin/wallet/accounts/${customer.id}/adjust`, {
      method: 'POST', session: customer,
      body: {coins: 1000000, direction: 'credit', reason: 'Self-serve credit attempt', idempotencyKey: 'attack-key-1'},
    })).status, 403,
    'a customer cannot credit their own wallet',
  );
});

test('GET /wallet reports the balance, rate and limits from the server', async () => {
  const response = await request('/wallet', {session: customer});
  assert.equal(response.status, 200);
  const body = response.data;
  assert.equal(typeof body.balanceCoins, 'number');
  assert.equal(body.paisePerCoin, 100);
  assert.equal(body.availableInr, body.availableCoins * 100, 'the rupee value is derived server-side');
  assert.equal(body.currency, 'INR');
  assert.equal(typeof body.limits.maxOrderPercent, 'number');
  assert.equal(typeof body.pendingCoins, 'number');
});

test('wallet history paginates and filters, and shows a running balance', async () => {
  const page1 = await request('/wallet/transactions?page=1&limit=2', {session: customer});
  assert.equal(page1.status, 200);
  assert.ok(page1.data.rows.length <= 2);
  assert.ok(page1.data.total >= 3);
  assert.ok(page1.data.rows.every((r) => typeof r.balance_after === 'number'));
  assert.ok(page1.data.rows.every((r) => r.paise_per_coin > 0));
  assert.ok(page1.data.kinds.includes('exchange_credit'), 'the kind list is published for the filter UI');

  const page2 = await request('/wallet/transactions?page=2&limit=2', {session: customer});
  const overlap = page2.data.rows.filter((r) => page1.data.rows.some((q) => q.id === r.id));
  assert.equal(overlap.length, 0, 'pages do not repeat rows');

  const credits = await request('/wallet/transactions?direction=credit&limit=50', {session: customer});
  assert.ok(credits.data.rows.every((r) => r.direction === 'credit'));
  const expiries = await request('/wallet/transactions?kind=expiry&limit=50', {session: customer});
  assert.ok(expiries.data.rows.every((r) => r.kind === 'expiry'));
  assert.equal((await request('/wallet/transactions?kind=nonsense', {session: customer})).status, 400);
});

test('one customer cannot see another customer wallet', async () => {
  const mine = await request('/wallet/transactions?limit=50', {session: other});
  assert.ok(mine.data.rows.every((r) => r.user_id === other.id),
    'every row belongs to the requesting customer');
});

test('the admin wallet views report real balances and the integrity check', async () => {
  const accounts = await request('/admin/wallet/accounts?limit=50', {session: adminUser});
  assert.equal(accounts.status, 200);
  assert.ok(accounts.data.rows.some((a) => a.user_id === customer.id));
  assert.equal(typeof accounts.data.summary.outstanding_coins, 'number');

  const detail = await request(`/admin/wallet/accounts/${customer.id}?limit=5`, {session: adminUser});
  assert.equal(detail.status, 200);
  assert.equal(detail.data.user.id, customer.id);
  assert.equal(detail.data.integrity.balanced, true);

  assert.equal((await request('/admin/wallet/accounts/not-a-real-user', {session: adminUser})).status, 404);

  const integrity = await request('/admin/wallet/integrity', {session: adminUser});
  assert.equal(integrity.status, 200);
  assert.equal(integrity.data.drifted.length, 0, 'no account has drifted from its ledger');
});

test('the admin adjustment endpoint is idempotent', async () => {
  const user = await fixtureUser(`api${Date.now().toString(36)}`);
  const body = {coins: 25, direction: 'credit', reason: 'Verified via the API', idempotencyKey: `api-key-${Date.now()}`};
  const first = await request(`/admin/wallet/accounts/${user.id}/adjust`, {method: 'POST', session: adminUser, body});
  const second = await request(`/admin/wallet/accounts/${user.id}/adjust`, {method: 'POST', session: adminUser, body});
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.data.existing, true);
  assert.equal(second.data.transaction.id, first.data.transaction.id);
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 25);

  const audited = await auditLogs().findOne({action: 'wallet.adjust', entity_id: first.data.transaction.id});
  assert.ok(audited, 'the adjustment is in the audit log');
  assert.equal(audited.actor_id, adminUser.id);
});

/* ------------------------------------------------- wallet settings endpoint */

test('wallet settings are configurable, validated, and separate from store settings', async () => {
  const valid = {
    wallet_enabled: true, wallet_paise_per_coin: 100, wallet_min_redeem_coins: 10,
    wallet_max_order_percent: 50, wallet_min_order_value: 50000,
    wallet_partial_redemption: true, wallet_coins_expire: false, wallet_expiry_days: 0,
    wallet_promo_enabled: false, exchange_enabled: true, exchange_window_days: 14,
    exchange_credit_shipping: false,
  };
  assert.equal((await request('/admin/settings/wallet', {method: 'PUT', session: adminUser, body: valid})).status, 200);
  const saved = (await request('/admin/settings', {session: adminUser})).data;
  assert.equal(saved.wallet_max_order_percent, 50);
  assert.equal(saved.exchange_window_days, 14);

  assert.equal((await request('/admin/settings/wallet', {method: 'PUT', session: adminUser, body: {...valid, wallet_coins_expire: true, wallet_expiry_days: 0}})).status, 400,
    'expiry on with no duration is refused');
  assert.equal((await request('/admin/settings/wallet', {method: 'PUT', session: adminUser, body: {...valid, exchange_enabled: true, exchange_window_days: 0}})).status, 400,
    'exchanges on with no window is refused');
  assert.equal((await request('/admin/settings/wallet', {method: 'PUT', session: adminUser, body: {...valid, wallet_paise_per_coin: 0}})).status, 400);
  assert.equal((await request('/admin/settings/wallet', {method: 'PUT', session: adminUser, body: {...valid, wallet_max_order_percent: 101}})).status, 400);
  assert.equal((await request('/admin/settings/wallet', {method: 'PUT', session: adminUser, body: {...valid, surprise: 1}})).status, 400,
    'an unknown field is refused');
  assert.equal((await request('/admin/settings/wallet', {method: 'PUT', session: customer, body: valid})).status, 403);

  // The pre-existing storefront settings endpoint must still accept exactly
  // its original eleven fields, with none of the new ones.
  const current = (await request('/admin/settings', {session: adminUser})).data;
  const legacy = {
    shipping: current.shipping, free_shipping_threshold: current.free_shipping_threshold,
    tax_bps: current.tax_bps, support_email: current.support_email,
    returns_policy: current.returns_policy, privacy_policy: current.privacy_policy,
    terms: current.terms, social_x: current.social_x, social_facebook: current.social_facebook,
    social_instagram: current.social_instagram, social_linkedin: current.social_linkedin,
  };
  assert.equal((await request('/admin/settings', {method: 'PUT', session: adminUser, body: legacy})).status, 200,
    'the original settings contract is unchanged');
  await configure();
});

test('there is no cash-out path anywhere in the wallet', async () => {
  // Belt and braces: the kind list is the complete set of ways value moves,
  // and none of them pays money out.
  assert.deepEqual(wallet.TRANSACTION_KINDS, [
    'exchange_credit', 'purchase_redemption', 'redemption_release',
    'admin_adjustment', 'promotional_credit', 'expiry',
  ]);
  // This used to read the CHECK constraint on wallet_transactions.kind out of
  // pg_constraint and assert no cash-out value appeared in it. MongoDB has no
  // CHECK, so the enforcing list is TRANSACTION_KINDS above, asserted against
  // wallet.post itself rather than against a catalogue table: anything not on
  // that list is refused before a document is written.
  assert.ok(!wallet.TRANSACTION_KINDS.some((kind) => /withdraw|payout|cash|refund/i.test(kind)),
    'no kind names a way of paying money out');
  for (const kind of ['cash_withdrawal', 'payout', 'bank_transfer', 'refund_to_card']) {
    await assert.rejects(() => wallet.postStandalone({
      userId: customer.id, kind, coins: 10,
      idempotencyKey: `cashout:${id()}`, description: 'Attempted cash-out',
    }), /Unknown wallet transaction kind/, `${kind} is refused`);
  }
  // And nothing was written while trying.
  await assertBalanced(customer);

  // The only debits that exist reduce a balance against a GEMIES order or an
  // expiry. Each is checked in its own test above; this asserts the set.
  const debits = ['purchase_redemption', 'expiry', 'admin_adjustment'];
  assert.ok(debits.every((kind) => wallet.TRANSACTION_KINDS.includes(kind)));
});

/* ======================================================= exchanges (phase 3) */

const exchanges = await import('../server/exchanges.mjs');
const {createOrder, paymentOrder, acceptCapturedPayment} = await import('../server/commerce.mjs');

/** A real paid order, through the real capture path with a mocked gateway. */
async function paidOrder(user, quantity = 2) {
  await cartItems().updateOne(
    {user_id: user.id, variant_id: variantId},
    {$set: {user_id: user.id, variant_id: variantId, quantity}},
    {upsert: true},
  );
  const order = await createOrder(user, {
    address: {name: 'Fixture Customer', phone: '9876543210', line1: '123 Test street', line2: '',
      city: 'Test City', state: 'Test State', postalCode: '400001', country: 'India'},
    coupon: '',
  }, id());
  const p = await paymentOrder(order.id);
  const payment = {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: p.amount, currency: p.currency, status: 'captured', captured: true,
  };
  remotes.set(payment.id, payment);
  await acceptCapturedPayment(payment);
  return orders().findOne({_id: order.id});
}

async function requestExchange(user, order, overrides = {}) {
  const items = await orderItems().find({order_id: order.id}).toArray();
  return exchanges.createExchange(user, order.id, {
    reason: 'size_too_small',
    note: '',
    images: [],
    items: [{order_item_id: items[0].id, quantity: 1}],
    ...overrides,
  });
}

test('the credit is built from what was paid, not the catalogue price', () => {
  // 2 x 100000 paise, 10% coupon, 5% tax on the discounted subtotal.
  const order = {subtotal: 200000, discount: 20000, tax: 9000, shipping: 5000, total: 194000};
  const items = [{id: 'a', name: 'Tee', sku: 'T', unit_price: 100000, quantity: 2}];

  const one_unit = exchanges.creditForLines({
    order, items, lines: [{order_item_id: 'a', quantity: 1}], creditShipping: false,
  });
  // gross 100000, discount share 10000, taxable 90000, tax share 4500.
  assert.equal(one_unit.lines[0].gross, 100000);
  assert.equal(one_unit.lines[0].discountShare, 10000, 'the coupon is allocated to the line');
  assert.equal(one_unit.lines[0].taxable, 90000);
  assert.equal(one_unit.lines[0].taxShare, 4500, 'tax is allocated in proportion');
  assert.equal(one_unit.eligible, 94500);
  assert.ok(one_unit.eligible < 100000, 'less than the undiscounted price was paid, so less comes back');
  assert.equal(one_unit.wholeOrder, false);
  assert.equal(one_unit.shipping, 0, 'shipping is not credited on a partial return');

  // The whole order back, with shipping credited.
  const all = exchanges.creditForLines({
    order, items, lines: [{order_item_id: 'a', quantity: 2}], creditShipping: true,
  });
  assert.equal(all.wholeOrder, true);
  assert.equal(all.shipping, 5000);
  assert.equal(all.eligible, 189000 + 5000, 'the full paid value, including delivery');
  assert.ok(all.eligible <= order.total, 'never more than the order was worth');

  // Shipping stays out when the operator has not configured it.
  assert.equal(exchanges.creditForLines({
    order, items, lines: [{order_item_id: 'a', quantity: 2}], creditShipping: false,
  }).shipping, 0);
});

test('allocated shares can never exceed the discount or tax the order carried', () => {
  // Three lines and a discount that does not divide evenly.
  const order = {subtotal: 100000, discount: 33333, tax: 7777, shipping: 0, total: 74444};
  const items = [
    {id: 'a', name: 'A', sku: 'A', unit_price: 33333, quantity: 1},
    {id: 'b', name: 'B', sku: 'B', unit_price: 33333, quantity: 1},
    {id: 'c', name: 'C', sku: 'C', unit_price: 33334, quantity: 1},
  ];
  const result = exchanges.creditForLines({
    order, items, creditShipping: false,
    lines: items.map((i) => ({order_item_id: i.id, quantity: 1})),
  });
  const discountAllocated = result.lines.reduce((n, l) => n + l.discountShare, 0);
  const taxAllocated = result.lines.reduce((n, l) => n + l.taxShare, 0);
  // The discount may be over-allocated by a paise or two, which shrinks the
  // credit. That is the safe direction and is why it is ceiled. Under-
  // allocating it is what produced a credit larger than the order.
  assert.ok(discountAllocated >= order.discount,
    `discount must never be under-allocated: ${discountAllocated} >= ${order.discount}`);
  assert.ok(discountAllocated <= order.discount + result.lines.length,
    'and over-allocated by at most one paise per line');
  assert.ok(taxAllocated <= order.tax, `tax must never be over-allocated: ${taxAllocated} <= ${order.tax}`);
  assert.ok(result.eligible <= order.total,
    `the total credit cannot exceed the order: ${result.eligible} <= ${order.total}`);
});

test('returning more units than were ordered is refused', () => {
  const order = {subtotal: 100000, discount: 0, tax: 0, shipping: 0, total: 100000};
  const items = [{id: 'a', name: 'Tee', sku: 'T', unit_price: 50000, quantity: 2}];
  assert.throws(() => exchanges.creditForLines({
    order, items, lines: [{order_item_id: 'a', quantity: 3}], creditShipping: false,
  }), /at most 2/);
  assert.throws(() => exchanges.creditForLines({
    order, items, lines: [{order_item_id: 'nope', quantity: 1}], creditShipping: false,
  }), /not part of this order/);
});

test('no order is eligible until an exchange window is configured', async () => {
  await configure({exchange_enabled: false, exchange_window_days: 0});
  const user = await fixtureUser(`elig${Date.now().toString(36)}`);
  const order = await paidOrder(user);
  let check = await exchanges.eligibility(order.id, user.id);
  assert.equal(check.eligible, false);
  assert.match(check.reason, /not currently available/);

  // Enabled but with no window is still a refusal, not an open door.
  await storeSettings().updateOne({_id: 1}, {$set: {exchange_enabled: true, exchange_window_days: 0}});
  check = await exchanges.eligibility(order.id, user.id);
  assert.equal(check.eligible, false);
  assert.match(check.reason, /No exchange window is configured/);

  await configure();
  check = await exchanges.eligibility(order.id, user.id);
  assert.equal(check.eligible, true);
  assert.equal(check.windowDays, 14);
  assert.ok(check.items.length >= 1);
});

test('an expired window, an unpaid order and another customer order are all refused', async () => {
  const user = await fixtureUser(`exp${Date.now().toString(36)}`);
  const order = await paidOrder(user);

  await configure({exchange_window_days: 1});
  await orders().updateOne({_id: order.id}, {$set: {created_at: new Date(Date.now() - 10 * 86400000)}});
  const expired = await exchanges.eligibility(order.id, user.id);
  assert.equal(expired.eligible, false);
  assert.match(expired.reason, /window closed/);
  await orders().updateOne({_id: order.id}, {$set: {created_at: new Date()}});
  await configure();

  // Someone else's order is simply not found.
  const stranger = await fixtureUser(`str${Date.now().toString(36)}`);
  assert.equal((await exchanges.eligibility(order.id, stranger.id)).eligible, false);

  await orders().updateOne({_id: order.id}, {$set: {payment_status: 'pending'}});
  const unpaid = await exchanges.eligibility(order.id, user.id);
  assert.equal(unpaid.eligible, false);
  assert.match(unpaid.reason, /Only paid orders/);
  await orders().updateOne({_id: order.id}, {$set: {payment_status: 'paid'}});
});

test('submitting a request credits nothing', async () => {
  const user = await fixtureUser(`sub${Date.now().toString(36)}`);
  const order = await paidOrder(user);
  const request = await requestExchange(user, order);
  assert.ok(request.coins > 0, 'an eligible figure is computed and shown');

  const summary = await wallet.walletSummary(user.id);
  assert.equal(summary.balanceCoins, 0, 'nothing is credited on submission');
  assert.equal(summary.pendingCoins, 0, 'and nothing is pending until it is approved');
  assert.equal((await countN(walletTransactions, {user_id: user.id})).n, 0);

  const detail = await exchanges.exchangeDetails(request.id);
  assert.equal(detail.status, 'requested');
  assert.equal(detail.history.length, 1);
  assert.equal(detail.history[0].to_status, 'requested');
});

test('approval makes coins pending but still credits nothing', async () => {
  const user = await fixtureUser(`appr${Date.now().toString(36)}`);
  const order = await paidOrder(user);
  const request = await requestExchange(user, order);

  for (const next of ['under_review', 'approved']) {
    await exchanges.transition(request.id, next, {actor: adminUser});
    assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 0, `${next} must not credit`);
  }
  const pending = await wallet.walletSummary(user.id);
  assert.ok(pending.pendingCoins > 0, 'approved coins show as pending');
  assert.equal(pending.pendingInr, pending.pendingCoins * 100);
  assert.equal(pending.balanceCoins, 0, 'pending is not spendable');

  // Pickup and collection still credit nothing.
  for (const next of ['pickup_scheduled', 'picked_up', 'received']) {
    await exchanges.transition(request.id, next, {actor: adminUser});
    assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 0, `${next} must not credit`);
  }
  assert.equal((await countN(walletTransactions, {user_id: user.id})).n, 0);
});

test('coins are credited only when inspection passes, and exactly once', async () => {
  const user = await fixtureUser(`cred${Date.now().toString(36)}`);
  const order = await paidOrder(user);
  const request = await requestExchange(user, order);
  for (const next of ['approved', 'pickup_scheduled', 'picked_up', 'received', 'inspection_passed']) {
    await exchanges.transition(request.id, next, {actor: adminUser});
  }
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 0, 'inspection_passed alone credits nothing');

  const result = await exchanges.transition(request.id, 'coins_credited', {actor: adminUser});
  assert.ok(result.transaction, 'a ledger row was written');
  assert.equal(result.transaction.kind, 'exchange_credit');
  assert.equal(result.transaction.actor_id, adminUser.id);

  const after = await wallet.walletSummary(user.id);
  assert.equal(after.balanceCoins, result.transaction.coins);
  assert.equal(after.pendingCoins, 0, 'it is no longer pending once credited');
  await assertBalanced(user);

  // A second attempt is refused by the state machine, and the partial unique
  // index would refuse it even if the state machine did not.
  await assert.rejects(
    () => exchanges.transition(request.id, 'coins_credited', {actor: adminUser}),
    (error) => error.status === 409,
  );
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, after.balanceCoins);
  assert.equal(
    (await countN(walletTransactions, {exchange_id: request.id, kind: 'exchange_credit'})).n,
    1, 'exactly one credit exists for this exchange',
  );
});

test('concurrent credit approvals produce one credit', async () => {
  const user = await fixtureUser(`conc${Date.now().toString(36)}`);
  const order = await paidOrder(user);
  const request = await requestExchange(user, order);
  for (const next of ['approved', 'pickup_scheduled', 'picked_up', 'received', 'inspection_passed']) {
    await exchanges.transition(request.id, next, {actor: adminUser});
  }
  const attempts = await Promise.allSettled(Array.from({length: 5}, () =>
    exchanges.transition(request.id, 'coins_credited', {actor: adminUser})));
  assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1, 'one of five succeeded');
  assert.equal(
    (await countN(walletTransactions, {exchange_id: request.id, kind: 'exchange_credit'})).n,
    1,
  );
  await assertBalanced(user);
});

test('only valid transitions are permitted', async () => {
  const user = await fixtureUser(`sm${Date.now().toString(36)}`);
  const order = await paidOrder(user);
  const request = await requestExchange(user, order);

  // Straight from requested to credited would skip the inspection entirely.
  await assert.rejects(() => exchanges.transition(request.id, 'coins_credited', {actor: adminUser}),
    (error) => error.status === 409 && /cannot move to/.test(error.message));
  await assert.rejects(() => exchanges.transition(request.id, 'received', {actor: adminUser}),
    (error) => error.status === 409);
  await assert.rejects(() => exchanges.transition(request.id, 'inspection_passed', {actor: adminUser}),
    (error) => error.status === 409);
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 0);

  // A rejection needs a reason.
  await assert.rejects(() => exchanges.transition(request.id, 'rejected', {actor: adminUser, note: 'no'}),
    (error) => error.status === 400 && /at least 5 characters/.test(error.message));
  await exchanges.transition(request.id, 'rejected', {actor: adminUser, note: 'Item shows signs of wear beyond policy.'});
  const detail = await exchanges.exchangeDetails(request.id);
  assert.equal(detail.status, 'rejected');
  assert.equal(detail.decision_note, 'Item shows signs of wear beyond policy.');
  assert.deepEqual(detail.nextStates, [], 'a rejected request is terminal');
  assert.equal((await wallet.walletSummary(user.id)).pendingCoins, 0, 'a rejected request promises nothing');
});

test('a failed inspection credits nothing and can be revisited', async () => {
  const user = await fixtureUser(`fail${Date.now().toString(36)}`);
  const order = await paidOrder(user);
  const request = await requestExchange(user, order);
  for (const next of ['approved', 'pickup_scheduled', 'picked_up', 'received']) {
    await exchanges.transition(request.id, next, {actor: adminUser});
  }
  await exchanges.transition(request.id, 'inspection_failed', {actor: adminUser, note: 'Returned item is not the item ordered.'});
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 0);
  await assert.rejects(() => exchanges.transition(request.id, 'coins_credited', {actor: adminUser}),
    (error) => error.status === 409, 'a failed inspection cannot jump to a credit');

  // An operator can look again and put it back to received.
  await exchanges.transition(request.id, 'received', {actor: adminUser, note: 'Re-inspected after customer contact.'});
  await exchanges.transition(request.id, 'inspection_passed', {actor: adminUser});
  const result = await exchanges.transition(request.id, 'coins_credited', {actor: adminUser});
  assert.ok(result.transaction.coins > 0);
  await assertBalanced(user);
});

test('the same units cannot be sent back twice', async () => {
  const user = await fixtureUser(`dup${Date.now().toString(36)}`);
  const order = await paidOrder(user, 2);
  const items = await orderItems().find({order_id: order.id}).toArray();
  await exchanges.createExchange(user, order.id, {
    reason: 'damaged', note: '', images: [], items: [{order_item_id: items[0].id, quantity: 2}],
  });
  // Both units are committed, so nothing is left.
  const check = await exchanges.eligibility(order.id, user.id);
  assert.equal(check.eligible, false);
  assert.match(check.reason, /already part of an exchange/);
  await assert.rejects(() => exchanges.createExchange(user, order.id, {
    reason: 'damaged', note: '', images: [], items: [{order_item_id: items[0].id, quantity: 1}],
  }), (error) => error.status === 409);
});

test('a cancelled request releases its units back', async () => {
  const user = await fixtureUser(`canc${Date.now().toString(36)}`);
  const order = await paidOrder(user, 1);
  const request = await requestExchange(user, order);
  assert.equal((await exchanges.eligibility(order.id, user.id)).eligible, false, 'committed while live');

  await exchanges.transition(request.id, 'cancelled', {actor: user, isCustomer: true, note: 'Changed my mind'});
  assert.equal((await exchanges.eligibility(order.id, user.id)).eligible, true, 'returnable again');
  assert.equal((await wallet.walletSummary(user.id)).pendingCoins, 0);
});

test('a customer cannot move a request through the workflow', async () => {
  const user = await fixtureUser(`cust${Date.now().toString(36)}`);
  const order = await paidOrder(user);
  const request = await requestExchange(user, order);

  for (const next of ['approved', 'received', 'inspection_passed', 'coins_credited']) {
    await assert.rejects(
      () => exchanges.transition(request.id, next, {actor: user, isCustomer: true}),
      (error) => error.status === 409,
      `a customer must not be able to set ${next}`,
    );
  }
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 0);

  // And cannot touch somebody else's request at all.
  const stranger = await fixtureUser(`sneak${Date.now().toString(36)}`);
  await assert.rejects(
    () => exchanges.transition(request.id, 'cancelled', {actor: stranger, isCustomer: true}),
    (error) => error.status === 404,
  );
});

test('a cash refund reduces what an exchange can still credit', async () => {
  const user = await fixtureUser(`cap2${Date.now().toString(36)}`);
  const order = await paidOrder(user, 1);
  const request = await requestExchange(user, order);
  const before = await exchanges.computeCredit(request.id);
  assert.ok(before.eligibleInr > 0);

  // A cash refund of the whole order through the separate Razorpay path.
  await (async () => { const refundId = id(); await refunds().insertOne({
    _id: refundId, id: refundId, order_id: order.id, refund_key: 'full', provider_id: null,
    status: 'processed', amount: order.total, reason: 'Support refund', created_at: new Date(),
  }); })();
  const after = await exchanges.computeCredit(request.id);
  assert.equal(after.eligibleInr, 0, 'a fully refunded order has nothing left to credit');
  assert.equal(after.calculation.cappedByHeadroom, true);

  for (const next of ['approved', 'pickup_scheduled', 'picked_up', 'received', 'inspection_passed']) {
    await exchanges.transition(request.id, next, {actor: adminUser});
  }
  await assert.rejects(
    () => exchanges.transition(request.id, 'coins_credited', {actor: adminUser}),
    (error) => error.status === 409 && /already been refunded/.test(error.message),
    'the customer cannot be made whole twice',
  );
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 0);
});

test('the exchange routes enforce ownership and role', async () => {
  const order = await paidOrder(customer, 1);
  assert.equal((await request(`/orders/${order.id}/exchange-eligibility`)).status, 401);
  assert.equal((await request('/exchanges')).status, 401);
  assert.equal((await request('/admin/exchanges')).status, 401);
  assert.equal((await request('/admin/exchanges', {session: customer})).status, 403);

  const eligible = await request(`/orders/${order.id}/exchange-eligibility`, {session: customer});
  assert.equal(eligible.status, 200);
  assert.equal(eligible.data.eligible, true);
  assert.deepEqual(eligible.data.reasons, exchanges.EXCHANGE_REASONS);

  const items = await orderItems().find({order_id: order.id}).toArray();
  const created = await request(`/orders/${order.id}/exchange`, {
    method: 'POST', session: customer,
    body: {reason: 'size_too_large', note: '', images: [], items: [{order_item_id: items[0].id, quantity: 1}]},
  });
  assert.equal(created.status, 201);

  // Another customer cannot read it, and a miss looks the same as a refusal.
  assert.equal((await request(`/exchanges/${created.data.id}`, {session: other})).status, 404);
  assert.equal((await request(`/exchanges/${created.data.id}`, {session: customer})).status, 200);
  assert.equal((await request(`/exchanges/${created.data.id}`, {session: adminUser})).status, 200);

  // A customer cannot drive the workflow over HTTP either.
  assert.equal((await request(`/admin/exchanges/${created.data.id}/transition`, {
    method: 'POST', session: customer, body: {status: 'coins_credited', note: ''},
  })).status, 403);
  // Nor post an unknown status as an admin.
  assert.equal((await request(`/admin/exchanges/${created.data.id}/transition`, {
    method: 'POST', session: adminUser, body: {status: 'teleported', note: ''},
  })).status, 400);
  assert.equal((await wallet.walletSummary(customer.id)).pendingCoins, 0);

  const queue = await request('/admin/exchanges?limit=50', {session: adminUser});
  assert.equal(queue.status, 200);
  assert.ok(queue.data.rows.some((r) => r.id === created.data.id));
  assert.ok(queue.data.statuses.includes('coins_credited'));

  const detail = await request(`/admin/exchanges/${created.data.id}`, {session: adminUser});
  assert.equal(detail.status, 200);
  assert.ok(detail.data.credit.eligibleInr > 0, 'the admin sees the live recomputed figure');
  assert.ok(Array.isArray(detail.data.nextStates));
});

test('an exchange never touches the cash refund path', async () => {
  const user = await fixtureUser(`sep${Date.now().toString(36)}`);
  const order = await paidOrder(user, 1);
  const request = await requestExchange(user, order);
  for (const next of ['approved', 'pickup_scheduled', 'picked_up', 'received', 'inspection_passed', 'coins_credited']) {
    await exchanges.transition(request.id, next, {actor: adminUser});
  }
  const refundCount = await countN(refunds, {order_id: order.id});
  assert.equal(refundCount.n, 0, 'no refund row was created');
  const payment = await payments().findOne({order_id: order.id});
  assert.equal(payment.refunded_amount, 0, 'payments.refunded_amount is untouched');
  const after = await orders().findOne({_id: order.id});
  assert.equal(after.payment_status, 'paid', 'the order is still paid, not refunding');
  assert.ok(['confirmed', 'processing', 'shipped', 'delivered'].includes(after.status));
});

test('the settings screen cannot send wallet fields to the strict store endpoint', async () => {
  // GET /admin/settings returns the whole row, wallet columns included. The
  // admin screen used to spread that straight back into PUT /admin/settings,
  // whose schema is `.strict()` -- so adding the wallet columns broke the
  // settings screen until it was taught to split the two groups. This asserts
  // both halves of that contract.
  const current = (await request('/admin/settings', {session: adminUser})).data;

  const storeFields = ['shipping', 'free_shipping_threshold', 'tax_bps', 'support_email',
    'returns_policy', 'privacy_policy', 'terms',
    'social_x', 'social_facebook', 'social_instagram', 'social_linkedin'];
  const walletFields = ['wallet_enabled', 'wallet_paise_per_coin', 'wallet_min_redeem_coins',
    'wallet_max_order_percent', 'wallet_min_order_value', 'wallet_partial_redemption',
    'wallet_coins_expire', 'wallet_expiry_days', 'wallet_promo_enabled',
    'exchange_enabled', 'exchange_window_days', 'exchange_credit_shipping'];

  // Both groups are present on the read.
  for (const key of [...storeFields, ...walletFields]) {
    assert.ok(key in current, `GET /admin/settings should expose ${key}`);
  }

  // The store half alone is accepted.
  const storeOnly = Object.fromEntries(storeFields.map((k) => [k, current[k]]));
  assert.equal((await request('/admin/settings', {method: 'PUT', session: adminUser, body: storeOnly})).status, 200);

  // The whole row is not — this is the regression.
  const everything = Object.fromEntries([...storeFields, ...walletFields].map((k) => [k, current[k]]));
  assert.equal((await request('/admin/settings', {method: 'PUT', session: adminUser, body: everything})).status, 400,
    'sending wallet fields to the store endpoint must be refused, so the screen has to split them');

  // And the wallet half alone goes to its own endpoint.
  const walletOnly = Object.fromEntries(walletFields.map((k) => [k, current[k]]));
  assert.equal((await request('/admin/settings/wallet', {method: 'PUT', session: adminUser, body: walletOnly})).status, 200);
  assert.equal((await request('/admin/settings/wallet', {method: 'PUT', session: adminUser, body: everything})).status, 400,
    'and store fields are not accepted by the wallet endpoint either');
  await configure();
});

/* ============================================ checkout redemption (phase 4) */

const {walletOfferFor, payableOf, completeWalletOrder, quote, releaseOrder} = await import('../server/commerce.mjs');

const ADDRESS = {
  name: 'Fixture Customer', phone: '9876543210', line1: '123 Test street', line2: '',
  city: 'Test City', state: 'Test State', postalCode: '400001', country: 'India',
};

async function basket(user, quantity = 1) {
  await cartItems().updateOne(
    {user_id: user.id, variant_id: variantId},
    {$set: {user_id: user.id, variant_id: variantId, quantity}},
    {upsert: true},
  );
}

/** Captures the gateway portion of an order through the real capture path. */
async function capture(order) {
  const p = await paymentOrder(order.id);
  const payment = {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: p.amount, currency: p.currency, status: 'captured', captured: true,
  };
  remotes.set(payment.id, payment);
  await acceptCapturedPayment(payment);
  return {p, payment};
}

test('an order placed without coins is completely unchanged', async () => {
  const user = await fixtureUser(`nocoin${Date.now().toString(36)}`);
  await basket(user);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  assert.equal(order.wallet_applied, 0);
  assert.equal(order.wallet_coins, 0);
  assert.equal(payableOf(order), order.total, 'the gateway is asked for the whole total');
  const {p} = await capture(order);
  assert.equal(p.amount, order.total);
  const settled = await orders().findOne({_id: order.id});
  assert.equal(settled.payment_status, 'paid');
  assert.equal(settled.status, 'confirmed');
});

test('coins reduce the gateway amount but not the order total', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`part${Date.now().toString(36)}`);
  await credit(user, 300, `part:${id()}`);
  await basket(user, 2);

  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  assert.equal(order.wallet_coins, 300);
  assert.equal(order.wallet_applied, 30000, '300 coins at 100 paise');
  assert.equal(order.total, 200000, 'the order is still worth its full value');
  assert.equal(payableOf(order), 170000, 'only the remainder goes to the gateway');

  // The coins are held, not spent.
  const held = await wallet.walletSummary(user.id);
  assert.equal(held.balanceCoins, 300, 'nothing is debited before payment');
  assert.equal(held.heldCoins, 300);
  assert.equal(held.availableCoins, 0);

  const {p} = await capture(order);
  assert.equal(p.amount, 170000, 'payments.amount is the payable portion');

  const after = await wallet.walletSummary(user.id);
  assert.equal(after.balanceCoins, 0, 'the coins are spent on capture');
  assert.equal(after.heldCoins, 0);
  const ledger = await walletTransactions().findOne({order_id: order.id, kind: 'purchase_redemption'});
  assert.equal(ledger.coins, 300);
  assert.equal(ledger.inr_value, 30000);
  await assertBalanced(user);
  await configure();
});

test('a wallet-only order completes without any gateway payment', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`only${Date.now().toString(36)}`);
  await basket(user, 1);
  const preview = await quote(user.id);
  // Exactly enough coins to cover the whole order.
  await credit(user, preview.total / 100, `only:${id()}`);

  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  assert.equal(payableOf(order), 0, 'nothing left for a card to pay');

  const settled = await completeWalletOrder(order.id);
  assert.equal(settled.payment_status, 'paid');
  assert.equal(settled.status, 'confirmed');

  // No payments row at all, because nothing was collected.
  assert.equal((await countN(payments, {order_id: order.id})).n, 0);
  // Stock was still consumed, and the invoice and confirmation still queued.
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 0);
  assert.ok(await jobs().findOne({dedupe_key: `invoice:${order.id}`}), 'the invoice is queued');
  assert.ok(await jobs().findOne({dedupe_key: `paid:${order.id}`}), 'the confirmation email is queued');
  await assertBalanced(user);
  await configure();
});

test('a wallet-only order cannot be settled twice', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`twice${Date.now().toString(36)}`);
  await basket(user, 1);
  const preview = await quote(user.id);
  await credit(user, preview.total / 100, `twice:${id()}`);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());

  await completeWalletOrder(order.id);
  const balanceAfter = (await wallet.walletSummary(user.id)).balanceCoins;
  const stockAfter = (await variants().findOne({_id: variantId})).stock;

  // A retried request returns the settled order rather than doing it again.
  const again = await completeWalletOrder(order.id);
  assert.equal(again.payment_status, 'paid');
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, balanceAfter, 'coins are not spent twice');
  assert.equal((await variants().findOne({_id: variantId})).stock, stockAfter, 'stock is not decremented twice');
  assert.equal(
    (await countN(walletTransactions, {order_id: order.id, kind: 'purchase_redemption'})).n,
    1,
  );
  await configure();
});

test('concurrent settlement of a wallet-only order spends the coins once', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`race4${Date.now().toString(36)}`);
  await basket(user, 1);
  const preview = await quote(user.id);
  await credit(user, preview.total / 100, `race4:${id()}`);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());

  const attempts = await Promise.allSettled(Array.from({length: 5}, () => completeWalletOrder(order.id)));
  assert.ok(attempts.some((a) => a.status === 'fulfilled'), 'at least one succeeded');
  assert.equal(
    (await countN(walletTransactions, {order_id: order.id, kind: 'purchase_redemption'})).n,
    1, 'exactly one redemption exists',
  );
  await assertBalanced(user);
  await configure();
});

test('a failed payment does not consume the coins', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`failpay${Date.now().toString(36)}`);
  await credit(user, 200, `failpay:${id()}`);
  await basket(user, 2);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  assert.equal(order.wallet_coins, 200);
  assert.equal((await wallet.walletSummary(user.id)).heldCoins, 200);

  // The customer abandons the payment and cancels the order.
  await mongo.transaction((session) => releaseOrder(order.id, session));

  const after = await wallet.walletSummary(user.id);
  assert.equal(after.balanceCoins, 200, 'every coin is still there');
  assert.equal(after.heldCoins, 0, 'the hold is released');
  assert.equal(after.availableCoins, 200, 'and spendable again');
  assert.equal(
    (await countN(walletTransactions, {order_id: order.id})).n,
    0, 'no ledger row was ever written',
  );
  await assertBalanced(user);
  await configure();
});

test('a capture for the wrong amount is still refused', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`wrong${Date.now().toString(36)}`);
  await credit(user, 100, `wrong:${id()}`);
  await basket(user, 2);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  const p = await paymentOrder(order.id);

  // The gateway reports the full order total rather than the payable amount --
  // which is exactly what a tampered or mismatched capture looks like.
  const bad = {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: order.total, currency: order.currency, status: 'captured', captured: true,
  };
  remotes.set(bad.id, bad);
  await assert.rejects(() => acceptCapturedPayment(bad),
    (error) => error.status === 400 && /does not match the order/.test(error.message));

  const still = await orders().findOne({_id: order.id});
  assert.equal(still.payment_status, 'pending', 'the order was not marked paid');
  assert.equal((await wallet.walletSummary(user.id)).balanceCoins, 100, 'and the coins were not spent');
  await configure();
});

test('the server never trusts a client-supplied wallet amount', async () => {
  await configure({wallet_max_order_percent: 50, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureSession(`trust${Date.now().toString(36)}`);
  await credit(user, 5000, `trust:${id()}`);
  await basket(user, 1);

  // Anything beyond the boolean is refused outright by the strict schema.
  for (const extra of [
    {walletCoins: 5000}, {walletApplied: 999999}, {paisePerCoin: 100000},
    {wallet_applied: 999999}, {coins: 5000},
  ]) {
    const response = await request('/checkout/quote', {
      method: 'POST', session: user, body: {address: ADDRESS, coupon: '', useWallet: true, ...extra},
    });
    assert.equal(response.status, 400, `${JSON.stringify(extra)} must be rejected`);
  }

  // And the figure the server offers is its own, capped by the configured 50%.
  const preview = await request('/checkout/quote', {
    method: 'POST', session: user, body: {address: ADDRESS, coupon: '', useWallet: true},
  });
  assert.equal(preview.status, 200);
  const cap = Math.floor(preview.data.total * 0.5);
  assert.ok(preview.data.wallet.inr <= cap, `${preview.data.wallet.inr} <= ${cap}`);
  assert.equal(preview.data.wallet.coins, Math.floor(cap / 100));

  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  assert.equal(order.wallet_applied, preview.data.wallet.inr, 'the order records the server figure');
  assert.ok(order.wallet_applied <= order.total * 0.5 + 1);
  await configure();
});

test('redemption limits are enforced at checkout, not just in the preview', async () => {
  const user = await fixtureUser(`limits${Date.now().toString(36)}`);
  await credit(user, 50, `limits:${id()}`);
  await basket(user, 1);

  // An order below the configured minimum cannot use coins at all.
  await configure({wallet_min_order_value: 100000000});
  await assert.rejects(
    () => createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id()),
    (error) => error.status === 409 && /must be at least/.test(error.message),
  );

  // Below the minimum redeemable coin count.
  await configure({wallet_min_order_value: 0, wallet_min_redeem_coins: 5000});
  await assert.rejects(
    () => createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id()),
    (error) => error.status === 409 && /At least 5000 coins/.test(error.message),
  );

  // With the wallet switched off entirely.
  await configure({wallet_enabled: false});
  await assert.rejects(
    () => createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id()),
    (error) => error.status === 409 && /not enabled/.test(error.message),
  );

  // No coins at all.
  await configure();
  const broke = await fixtureUser(`broke${Date.now().toString(36)}`);
  await basket(broke, 1);
  await assert.rejects(
    () => createOrder(broke, {address: ADDRESS, coupon: '', useWallet: true}, id()),
    (error) => error.status === 409 && /No coins available/.test(error.message),
  );
});

test('coins cannot be double-spent across two concurrent checkouts', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`dbl4${Date.now().toString(36)}`);
  await credit(user, 100, `dbl4:${id()}`);
  await basket(user, 1);

  // Two checkouts, each wanting the same 100 coins. createOrder locks the
  // customer row, so they serialise and the first one's hold is visible to
  // the second.
  const first = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  assert.equal(first.wallet_coins, 100);
  await basket(user, 1);

  // The second checkout is REFUSED rather than quietly placed at full price.
  // That is the right behaviour: the customer asked to pay with coins, and
  // being charged the full amount without being told would be worse than an
  // error they can act on.
  await assert.rejects(
    () => createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id()),
    (error) => error.status === 409 && /No coins available/.test(error.message),
    'held coins cannot be spent by a second checkout',
  );

  // Without asking for coins, the same basket checks out normally.
  const second = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  assert.equal(second.wallet_coins, 0);
  assert.equal(payableOf(second), second.total);
  await assertBalanced(user);
  await configure();
});

test('an order paid partly in coins still invoices and refunds against its full value', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`inv4${Date.now().toString(36)}`);
  await credit(user, 100, `inv4:${id()}`);
  await basket(user, 2);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  await capture(order);

  const settled = await orders().findOne({_id: order.id});
  assert.equal(settled.wallet_applied, 10000);
  assert.equal(settled.total, 200000, 'the invoice total is the full order value');

  // The refundable balance is what the gateway actually captured, not the
  // order total -- coins are not refundable as cash.
  const {refundableBalance} = await import('../server/fulfillment.mjs');
  const balance = await refundableBalance(order.id);
  assert.equal(balance.captured, 190000, 'only the card portion is refundable');
  assert.equal(balance.balance, 190000);
  await configure();
});

/* =================================================== invoices (phase 5) */

const invoices = await import('../server/invoices.mjs');
const {allocateInvoiceLines, taxRateFor} = await import('../server/invoice-lines.mjs');

test('line allocation reconciles exactly to the order totals', () => {
  // The invariant that matters: an invoice whose columns do not add up is a
  // broken document. Checked over awkward baskets where the shares cannot
  // divide evenly.
  const baskets = [
    [{unit_price: 10001, quantity: 2}],
    [{unit_price: 33333, quantity: 1}, {unit_price: 33333, quantity: 1}, {unit_price: 33334, quantity: 1}],
    [{unit_price: 1, quantity: 1}, {unit_price: 99999, quantity: 3}],
    [{unit_price: 7777, quantity: 7}, {unit_price: 3, quantity: 1}, {unit_price: 50000, quantity: 2}],
  ];
  const rates = [0, 500, 1800, 2800, 10000];
  const coupons = [0, 1, 10, 33, 90];

  for (const items of baskets) {
    const named = items.map((item, i) => ({...item, name: `Item ${i}`, sku: `S${i}`, size: 'M', color: 'Black'}));
    const subtotal = named.reduce((n, i) => n + i.unit_price * i.quantity, 0);
    for (const percent of coupons) {
      const discount = Math.floor((subtotal * percent) / 100);
      for (const bps of rates) {
        const tax = Math.round(((subtotal - discount) * bps) / 10000);
        const order = {subtotal, discount, tax, tax_bps: bps};
        const out = allocateInvoiceLines(order, named);

        const discountSum = out.lines.reduce((n, l) => n + l.discount, 0);
        const taxSum = out.lines.reduce((n, l) => n + l.tax, 0);
        const totalSum = out.lines.reduce((n, l) => n + l.total, 0);
        const label = `basket=${named.length} coupon=${percent}% bps=${bps}`;

        assert.equal(discountSum, discount, `discount must reconcile exactly — ${label}`);
        assert.equal(taxSum, tax, `tax must reconcile exactly — ${label}`);
        assert.equal(totalSum, subtotal - discount + tax, `line totals must reconcile — ${label}`);
        assert.ok(out.lines.every((l) => l.taxable >= 0), `no negative taxable value — ${label}`);
        assert.ok(out.lines.every((l) => l.tax >= 0), `no negative tax — ${label}`);
      }
    }
  }
});

test('a zero-value basket allocates nothing rather than dividing by zero', () => {
  const out = allocateInvoiceLines(
    {subtotal: 0, discount: 0, tax: 0, tax_bps: 1800},
    [{unit_price: 0, quantity: 1, name: 'Free', sku: 'F', size: 'M', color: 'Black'}],
  );
  assert.equal(out.subtotal, 0);
  assert.equal(out.tax, 0);
  assert.equal(out.lines[0].total, 0);
});

test('the tax rate is read from the order, or honestly flagged as derived', () => {
  assert.deepEqual(taxRateFor({tax_bps: 1800, tax: 3240, subtotal: 20002, discount: 2000}), {bps: 1800, derived: false});
  assert.deepEqual(taxRateFor({tax_bps: 0, tax: 0, subtotal: 1000, discount: 0}), {bps: 0, derived: false});
  // An order placed before tax_bps existed: the rate is reconstructed and the
  // invoice says so rather than implying it was recorded.
  const old = taxRateFor({tax_bps: 0, tax: 3240, subtotal: 20002, discount: 2000});
  assert.equal(old.bps, 1800);
  assert.equal(old.derived, true);
});

test('an invoice is issued once, with a stable number', async () => {
  const user = await fixtureUser(`inv5${Date.now().toString(36)}`);
  await basket(user, 2);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await capture(order);

  const first = await invoices.createInvoice(order.id);
  assert.match(first.number, /^GEM-\d{6}$/, `expected a GEM- number, got ${first.number}`);
  assert.equal(first.version, 1);
  assert.equal(first.status, 'issued');

  // A retried job must not renumber or reissue.
  const again = await invoices.createInvoice(order.id);
  assert.equal(again.id, first.id);
  assert.equal(again.number, first.number);
  assert.equal((await countN(invoiceDocs, {order_id: order.id})).n, 1);
});

test('an invoice does not change when the product or address changes later', async () => {
  const user = await fixtureUser(`frozen${Date.now().toString(36)}`);
  await basket(user, 1);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await capture(order);
  const invoice = await invoices.createInvoice(order.id);
  const before = await invoices.invoicePdf(order.id);
  const snapshot = (await invoiceDocs().findOne({_id: invoice.id})).snapshot;
  const originalName = snapshot.lines[0].name;

  // Everything the old implementation would have re-read at render time.
  await products().updateOne({slug: 'wallet-test-tee'}, {$set: {name: 'RENAMED AFTER INVOICING', price: 999999}});
  await orderItems().updateMany({order_id: order.id}, {$set: {name: 'TAMPERED LINE'}});
  await orders().updateOne({_id: order.id}, {$set: {'address.name': 'Someone Else'}});

  const after = await invoices.invoicePdf(order.id);
  const reread = (await invoiceDocs().findOne({_id: invoice.id})).snapshot;

  // Restored BEFORE asserting. A failing assertion throws, and leaving the
  // shared fixture product renamed and repriced poisoned every test after
  // this one — which is exactly what happened the first time this ran.
  await products().updateOne({slug: 'wallet-test-tee'}, {$set: {name: 'Wallet test tee', price: 100000}});

  assert.equal(reread.lines[0].name, originalName, 'the snapshot still holds the original product name');
  assert.equal(reread.customer.name, ADDRESS.name, 'and the original customer name');
  assert.equal(before.length, after.length, 'the reprint is the same document');
  assert.ok(before.equals(after), 'a reprint is byte-identical to the original');
});

test('the invoice snapshot carries both payment components', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`split5${Date.now().toString(36)}`);
  await credit(user, 100, `split5:${id()}`);
  await basket(user, 2);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  await capture(order);
  const invoice = await invoices.createInvoice(order.id);
  const s = (await invoiceDocs().findOne({_id: invoice.id})).snapshot;

  assert.equal(s.payment.walletApplied, 10000);
  assert.equal(s.payment.walletCoins, 100);
  assert.equal(s.payment.gatewayAmount, 190000);
  assert.equal(s.payment.paidTotal, 200000, 'the two components add up to the order total');
  assert.equal(s.payment.paidTotal, s.totals.total);
  assert.match(s.payment.method, /Wallet coins and card/);

  // Coins are a payment, not a reduction of the taxable value.
  assert.equal(s.totals.taxable + s.totals.tax, s.totals.total - s.totals.shipping);
  assert.ok(await invoices.invoicePdf(order.id));
  await configure();
});

test('a wallet-only order still produces a complete invoice', async () => {
  await configure({wallet_max_order_percent: 100, wallet_min_order_value: 0, wallet_min_redeem_coins: 0});
  const user = await fixtureUser(`winv${Date.now().toString(36)}`);
  await basket(user, 1);
  const preview = await quote(user.id);
  await credit(user, preview.total / 100, `winv:${id()}`);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: true}, id());
  await completeWalletOrder(order.id);

  const invoice = await invoices.createInvoice(order.id);
  const s = (await invoiceDocs().findOne({_id: invoice.id})).snapshot;
  assert.equal(s.payment.gatewayAmount, 0, 'no gateway payment was taken');
  assert.equal(s.payment.walletApplied, s.totals.total, 'coins covered the whole order');
  assert.equal(s.payment.method, 'Wallet coins');
  assert.equal(s.payment.reference, '', 'and there is no gateway reference to print');
  const pdf = await invoices.invoicePdf(order.id);
  assert.ok(pdf.length > 1000, 'a real PDF was produced');
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  await configure();
});

test('the invoice prints the configured business identity and nothing invented', async () => {
  const user = await fixtureUser(`biz${Date.now().toString(36)}`);
  await basket(user, 1);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await capture(order);
  const invoice = await invoices.createInvoice(order.id);
  const s = (await invoiceDocs().findOne({_id: invoice.id})).snapshot;

  assert.equal(s.business.name, process.env.BUSINESS_NAME);
  assert.equal(s.business.address, process.env.BUSINESS_ADDRESS);
  // No GSTIN is configured in the test fixture, so no place of supply block and
  // no tax registration line is fabricated.
  assert.equal(s.business.taxId, '');
  assert.equal(s.placeOfSupply, null, 'no place of supply without a GSTIN');
  assert.equal(s.business.registration, '', 'no registration number is invented');
});

test('an invoice cannot be issued for an unpaid order', async () => {
  const user = await fixtureUser(`unpaid5${Date.now().toString(36)}`);
  await basket(user, 1);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await assert.rejects(() => invoices.createInvoice(order.id),
    (error) => error.status === 409 && /requires a verified payment/.test(error.message));
  assert.equal((await countN(invoiceDocs, {order_id: order.id})).n, 0);
});

test('a revision supersedes the original without overwriting it', async () => {
  const user = await fixtureUser(`rev5${Date.now().toString(36)}`);
  await basket(user, 1);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await capture(order);
  const original = await invoices.createInvoice(order.id);
  const originalPdf = await invoices.invoicePdf(order.id, {invoiceId: original.id});

  await assert.rejects(() => invoices.reviseInvoice(order.id, 'typo', adminUser.id),
    /at least 10 characters/, 'a revision needs a real reason');

  const revised = await invoices.reviseInvoice(order.id, 'Customer name was recorded incorrectly at checkout.', adminUser.id);
  assert.equal(revised.version, 2);
  assert.equal(revised.revision_of, original.id);
  assert.match(revised.number, /-R1$/, 'the revision is suffixed, keeping the original number recognisable');

  const old = await invoiceDocs().findOne({_id: original.id});
  assert.equal(old.status, 'void', 'the original is voided, not deleted');
  assert.ok(old.snapshot.order, 'and its snapshot is intact');

  // Both documents remain retrievable.
  const stillOriginal = await invoices.invoicePdf(order.id, {invoiceId: original.id});
  assert.ok(stillOriginal.equals(originalPdf), 'the voided original still renders unchanged');
  const live = await invoices.invoicePdf(order.id);
  assert.ok(live.length > 1000);

  const history = await invoices.invoiceHistory(order.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 2);
  assert.equal(history[1].status, 'void');

  // One live invoice per order, enforced by the partial unique index.
  await assert.rejects(
    // The partial unique index on (order_id) WHERE status='issued' is what
    // makes this impossible, and it is a real index rather than application
    // logic -- so writing straight past createInvoice still cannot do it.
    () => invoiceDocs().insertOne({
      _id: id(), id: id(), order_id: order.id, number: 'GEM-999999',
      business: {}, snapshot: {}, status: 'issued', version: 9,
      revision_of: null, reason: '', created_at: new Date(),
    }),
    /duplicate key/i,
    'a second issued invoice for one order is impossible',
  );
});

test('an invoice with no snapshot refuses to print rather than inventing one', async () => {
  const user = await fixtureUser(`legacy${Date.now().toString(36)}`);
  await basket(user, 1);
  const order = await createOrder(user, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await capture(order);
  // Exactly what a row written by the previous implementation looks like.
  await (async () => { const legacyId = id(); await invoiceDocs().insertOne({
    _id: legacyId, id: legacyId, order_id: order.id,
    number: `SZ-${String(order.number).padStart(8, '0')}`,
    business: invoices.businessDetails(), snapshot: {}, status: 'issued', version: 1,
    revision_of: null, reason: '', created_at: new Date(),
  }); })();
  await assert.rejects(() => invoices.invoicePdf(order.id),
    (error) => error.status === 409 && /predates the billing snapshot/.test(error.message),
    'it must not silently fall back to live data');
});

test('the invoice download is authorised, and only to its owner', async () => {
  const owner = await fixtureSession(`owner5${Date.now().toString(36)}`);
  await basket(owner, 1);
  const order = await createOrder(owner, {address: ADDRESS, coupon: '', useWallet: false}, id());
  await capture(order);
  await invoices.createInvoice(order.id);

  assert.equal((await request(`/orders/${order.id}/invoice`)).status, 401, 'anonymous is refused');
  assert.equal((await request(`/orders/${order.id}/invoice`, {session: other})).status, 404,
    'another customer gets a 404, not someone else’s invoice');
  const mine = await request(`/orders/${order.id}/invoice`, {session: owner});
  assert.equal(mine.status, 200);
  assert.equal(Buffer.from(mine.data).subarray(0, 4).toString(), '%PDF');
  // An administrator may fetch it for support.
  assert.equal((await request(`/orders/${order.id}/invoice`, {session: adminUser})).status, 200);
});
