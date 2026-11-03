// Tranche 5: the worker, the public routes, the webhook and contact, on MongoDB.
//
// The load-bearing piece here is the job claim. `FOR UPDATE SKIP LOCKED` is
// gone and a single findOneAndUpdate stands in for it, so the tests that
// matter are the ones that run several workers at the same time and check that
// no job was ever handed out twice.
//
//   node --test tests/tranche5.test.mjs
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHmac} from 'node:crypto';
import {startMongo, stopMongo} from './mongo-harness.mjs';

process.env.NODE_ENV = 'test';
process.env.STORE_CURRENCY = 'INR';
process.env.APP_URL = 'http://localhost:3000';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture';
process.env.RAZORPAY_KEY_SECRET = 'fixture-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.RESEND_API_KEY = 'fixture';
process.env.EMAIL_FROM = 'fixture@example.invalid';
process.env.ADMIN_NOTIFICATION_EMAIL = 'ops@example.invalid';
process.env.BUSINESS_EMAIL = 'support@example.invalid';
// The worker must not start itself; these tests drive runJob by hand.
process.env.RUN_WORKER = 'false';

await startMongo();

const mongo = await import('../server/mongo.mjs');
const {id, passwordHash} = await import('../server/security.mjs');
const commerce = await import('../server/commerce.mjs');
const wallet = await import('../server/wallet.mjs');
const queue = await import('../server/queue.mjs');
const jobsModule = await import('../server/jobs.mjs');
const contact = await import('../server/contact.mjs');
const {razorpayWebhook} = await import('../server/webhooks.mjs');

/* -------------------------------------------------------- provider doubles */

const remotes = new Map();
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const address = new URL(url);
  const payload = options.body ? JSON.parse(options.body) : {};
  const key = address.pathname.replace('/v1', '');
  let data;
  if (address.hostname === 'api.razorpay.com') {
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

before(async () => {
  await mongo.connect();
  await mongo.ensureSchema();
  const categoryId = id();
  productId = id();
  await mongo.categories().insertOne({_id: categoryId, id: categoryId, name: 'Tees', slug: 'tees', segment: 'tees', parent_id: null, in_nav: true, display_order: 0});
  await mongo.products().insertOne({
    _id: productId, id: productId, slug: 'tranche5-tee', name: 'Tranche5 Tee',
    description: 'Fixture product for tranche 5 tests.', brand: 'Gemies',
    category_id: categoryId, audience: 'Men', price: 100000, compare_price: null,
    images: ['/assets/products/a.webp'], published: true, featured: false, is_demo: false,
    display_order: 0, created_at: new Date(), colorways: [],
  });
  await mongo.storeSettings().updateOne({_id: 1}, {$set: {wallet_enabled: true, wallet_paise_per_coin: 100, wallet_max_order_percent: 100}});
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
 * A job that succeeds without touching a provider.
 *
 * An `email` job whose ledger row is already `sent` short-circuits: the worker
 * sees the send has happened and marks the job done. That makes it the
 * cheapest way to exercise the claim-and-complete path without a template or
 * a mail provider in the way.
 */
async function noopJob(label) {
  const key = `t5-${label}-${randomUUID()}`;
  await queue.queueEmail(key, 'buyer@example.invalid', 'Noop', {template: 'cancelled'});
  await mongo.emailNotifications().updateOne({dedupe_key: key}, {$set: {status: 'sent'}});
  return key;
}

/** A pending order holding reserved stock and, optionally, wallet coins. */
async function pendingOrder({coins = 0, quantity = 1} = {}) {
  const user = await makeUser();
  const variantId = await makeVariant(10);
  await mongo.cartItems().insertOne({user_id: user.id, variant_id: variantId, quantity});
  if (coins > 0) {
    await wallet.postStandalone({
      userId: user.id, kind: 'promotional_credit', coins,
      idempotencyKey: `seed:${id()}`, description: 'Test credit',
    });
  }
  // The client asks to use the wallet; the server decides how many coins.
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: '', useWallet: coins > 0}, `key-${randomUUID()}`);
  return {user, variantId, orderId: order.id, order};
}

/* ======================================================= job queue: claiming */

test('concurrent workers never claim the same job twice', async () => {
  const keys = [];
  for (let i = 0; i < 8; i += 1) keys.push(await noopJob(`fan${i}`));

  // Eight workers, eight jobs, all started together. If the claim were not
  // atomic, two workers would take one job and another would be left queued.
  const results = await Promise.all(Array.from({length: 8}, () => jobsModule.runJob()));
  assert.equal(results.filter(Boolean).length, 8, 'every worker got a job of its own');

  const docs = await mongo.jobs().find({dedupe_key: {$in: keys}}).toArray();
  assert.equal(docs.length, 8);
  for (const job of docs) {
    assert.equal(job.status, 'done', `${job.dedupe_key} completed`);
    assert.equal(job.attempts, 1, 'claimed exactly once, so attempts never reached 2');
    assert.equal(job.locked_until, null, 'the lease is given back on completion');
    assert.deepEqual(job.payload, {}, 'an email payload is wiped on success');
    assert.ok(job.ran_at instanceof Date, 'the claim stamps a run time');
  }
});

test('more workers than jobs means the surplus workers get nothing', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  await noopJob('scarce1');
  await noopJob('scarce2');

  const results = await Promise.all(Array.from({length: 6}, () => jobsModule.runJob()));
  assert.equal(results.filter(Boolean).length, 2, 'exactly two jobs existed, so exactly two ran');
  assert.equal(results.filter((r) => r === false).length, 4, 'the rest returned false rather than blocking');
});

test('the oldest due job is claimed first', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  const older = await noopJob('order-older');
  const newer = await noopJob('order-newer');
  // available_at is the ordering key, as it was in the SQL.
  await mongo.jobs().updateOne({dedupe_key: older}, {$set: {available_at: new Date(Date.now() - 60000)}});
  await mongo.jobs().updateOne({dedupe_key: newer}, {$set: {available_at: new Date(Date.now() - 1000)}});

  await jobsModule.runJob();
  assert.equal((await mongo.jobs().findOne({dedupe_key: older})).status, 'done');
  assert.equal((await mongo.jobs().findOne({dedupe_key: newer})).status, 'pending', 'the newer job waits its turn');
  await jobsModule.runJob();
  assert.equal((await mongo.jobs().findOne({dedupe_key: newer})).status, 'done');
});

test('a job queued for the future is not claimed yet', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  const key = await noopJob('future');
  await mongo.jobs().updateOne({dedupe_key: key}, {$set: {available_at: new Date(Date.now() + 3600000)}});
  assert.equal(await jobsModule.runJob(), false, 'nothing is due');
  assert.equal((await mongo.jobs().findOne({dedupe_key: key})).attempts, 0);
});

/* ================================================= job queue: lease recovery */

test('a job held under a live lease is left alone', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  const key = await noopJob('leased');
  await mongo.jobs().updateOne({dedupe_key: key}, {$set: {
    status: 'running', locked_until: new Date(Date.now() + 300000), attempts: 1,
  }});
  assert.equal(await jobsModule.runJob(), false, 'another worker still owns it');
  const job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.attempts, 1, 'not re-claimed');
  assert.equal(job.status, 'running');
});

test('a crashed worker releases its job when the lease expires', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  const key = await noopJob('abandoned');
  // Exactly the state a worker that died mid-job leaves behind: still
  // 'running', with a lease that has since elapsed. Nothing sweeps for this;
  // the claim filter itself is the recovery path.
  await mongo.jobs().updateOne({dedupe_key: key}, {$set: {
    status: 'running', locked_until: new Date(Date.now() - 1000), attempts: 1,
  }});

  assert.equal(await jobsModule.runJob(), true, 'the expired lease is reclaimed');
  const job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.status, 'done');
  assert.equal(job.attempts, 2, 'the re-claim counts as another attempt');
});

test('two workers racing to recover one abandoned job: only one wins', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  const key = await noopJob('contested');
  await mongo.jobs().updateOne({dedupe_key: key}, {$set: {
    status: 'running', locked_until: new Date(Date.now() - 1000), attempts: 3,
  }});

  const results = await Promise.all([jobsModule.runJob(), jobsModule.runJob()]);
  assert.equal(results.filter(Boolean).length, 1, 'one worker reclaimed it, the other found nothing');
  assert.equal((await mongo.jobs().findOne({dedupe_key: key})).attempts, 4,
    'incremented once, not twice');
});

/* ================================================== job queue: retry, backoff */

test('a failed job is retried with exponential backoff', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  // An invoice job for an order that cannot be invoiced: createInvoice refuses
  // with a 409, which is a retryable failure.
  const key = `t5-retry-${randomUUID()}`;
  await queue.enqueue('invoice', key, {orderId: id()});

  assert.equal(await jobsModule.runJob(), true);
  let job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.status, 'pending', 'not terminal on the first failure');
  assert.equal(job.attempts, 1);
  assert.equal(job.locked_until, null, 'the lease is released on failure');
  assert.match(job.last_error, /verified payment/, 'an HttpError message is kept');
  // 15 * 2**1 = 30 seconds.
  const firstDelay = (job.available_at.getTime() - Date.now()) / 1000;
  assert.ok(firstDelay > 25 && firstDelay <= 31, `first retry in ~30s, got ${firstDelay}`);

  // Attempt 5 should ask for 15 * 2**5 = 480 seconds.
  await mongo.jobs().updateOne({dedupe_key: key}, {$set: {attempts: 4, status: 'pending', available_at: new Date(Date.now() - 1000)}});
  await jobsModule.runJob();
  job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.attempts, 5);
  const fifthDelay = (job.available_at.getTime() - Date.now()) / 1000;
  assert.ok(fifthDelay > 470 && fifthDelay <= 481, `fifth retry in ~480s, got ${fifthDelay}`);

  // The last retry before the job gives up: 15 * 2**7 = 1920 seconds. The
  // Math.min(3600, ...) ceiling in the module is unreachable, because the
  // eighth attempt is terminal; this asserts the real worst-case delay rather
  // than the nominal cap.
  await mongo.jobs().updateOne({dedupe_key: key}, {$set: {attempts: 6, status: 'pending', available_at: new Date(Date.now() - 1000)}});
  await jobsModule.runJob();
  job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.attempts, 7);
  assert.equal(job.status, 'pending', 'the seventh attempt still retries');
  const lastDelay = (job.available_at.getTime() - Date.now()) / 1000;
  assert.ok(lastDelay > 1910 && lastDelay <= 1921, `last retry in ~1920s, got ${lastDelay}`);
});

test('a job gives up after the attempt ceiling', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  const key = `t5-terminal-${randomUUID()}`;
  await queue.enqueue('invoice', key, {orderId: id()});
  await mongo.jobs().updateOne({dedupe_key: key}, {$set: {attempts: 7}});

  await jobsModule.runJob();
  const job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.attempts, 8);
  assert.equal(job.status, 'failed', 'the eighth attempt is the last');
  assert.equal(await jobsModule.runJob(), false, 'a failed job is not picked up again');
});

test('an unknown job kind fails without being retried forever', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  const key = `t5-unknown-${randomUUID()}`;
  await queue.enqueue('not_a_real_kind', key, {});
  await jobsModule.runJob();
  const job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.status, 'pending');
  assert.match(job.last_error, /Inspect provider state/,
    'a non-HttpError is reported as a redacted reason, never the raw message');
});

test('a terminal email failure is mirrored onto the delivery ledger', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  const key = `t5-mirror-${randomUUID()}`;
  await queue.queueEmail(key, 'buyer@example.invalid', 'Stuck', {template: 'cancelled'});
  // An uncertain send older than Resend's 24-hour idempotency window. The
  // worker refuses to retry it, because the key no longer protects us.
  await mongo.emailNotifications().updateOne({dedupe_key: key}, {$set: {
    status: 'sending', created_at: new Date(Date.now() - 24 * 3600000),
  }});

  await jobsModule.runJob();
  const job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.status, 'failed', 'a reconciliation error is terminal at once');
  assert.equal(job.attempts, 1, 'terminal on the first attempt, not after eight');
  const ledger = await mongo.emailNotifications().findOne({dedupe_key: key});
  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.last_error, job.last_error, 'the ledger carries the same redacted reason');
});

test('an email job with no ledger row is terminal', async () => {
  await mongo.jobs().deleteMany({status: {$in: ['pending', 'running']}});
  const key = `t5-orphan-${randomUUID()}`;
  await queue.enqueue('email', key, {key, recipient: 'x@example.invalid', subject: 'Orphan'});
  await jobsModule.runJob();
  const job = await mongo.jobs().findOne({dedupe_key: key});
  assert.equal(job.status, 'failed');
  assert.match(job.last_error, /Inspect provider state/);
});

/* ============================================== job queue: deduplication */

test('enqueueing the same key twice is one job', async () => {
  const key = `t5-dedupe-${randomUUID()}`;
  await queue.enqueue('invoice', key, {orderId: 'first'});
  await queue.enqueue('invoice', key, {orderId: 'second'});
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: key}), 1);
  assert.equal((await mongo.jobs().findOne({dedupe_key: key})).payload.orderId, 'first',
    'ON CONFLICT DO NOTHING keeps the first payload');
});

test('concurrent enqueues of one key are one job', async () => {
  const key = `t5-dedupe-race-${randomUUID()}`;
  await Promise.all(Array.from({length: 5}, () => queue.enqueue('invoice', key, {orderId: 'x'})));
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: key}), 1);
});

test('queueEmail writes one ledger row and one job per key', async () => {
  const key = `t5-email-dedupe-${randomUUID()}`;
  await queue.queueEmail(key, 'a@example.invalid', 'One', {template: 'cancelled'});
  await queue.queueEmail(key, 'b@example.invalid', 'Two', {template: 'cancelled'});
  assert.equal(await mongo.emailNotifications().countDocuments({dedupe_key: key}), 1);
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: key}), 1);
  assert.equal((await mongo.emailNotifications().findOne({dedupe_key: key})).recipient, 'a@example.invalid');
});

/* ================================================= maintenance / order release */

test('maintenance releases expired orders atomically', async () => {
  const {orderId, variantId, user} = await pendingOrder({coins: 50});
  const held = await mongo.walletReservations().findOne({order_id: orderId});
  assert.equal(held.status, 'held', 'the order is holding coins');
  assert.equal((await mongo.variants().findOne({_id: variantId})).reserved, 1);

  await mongo.orders().updateOne({_id: orderId}, {$set: {expires_at: new Date(Date.now() - 1000)}});
  await jobsModule.maintenance();

  const order = await mongo.orders().findOne({_id: orderId});
  assert.equal(order.status, 'cancelled');
  assert.equal(order.reserved, false);
  assert.equal((await mongo.variants().findOne({_id: variantId})).reserved, 0, 'stock handed back');
  assert.equal((await mongo.walletReservations().findOne({order_id: orderId})).status, 'released');
  const summary = await wallet.walletSummary(user.id);
  assert.equal(summary.availableCoins, 50, 'the held coins are spendable again');
  assert.equal(summary.heldCoins, 0);
});

test('a failure anywhere in the release rolls back all of it', async () => {
  const {orderId, variantId, user} = await pendingOrder({coins: 40});
  const before = {
    order: await mongo.orders().findOne({_id: orderId}),
    reserved: (await mongo.variants().findOne({_id: variantId})).reserved,
    hold: await mongo.walletReservations().findOne({order_id: orderId}),
  };
  assert.equal(before.order.status, 'pending');
  assert.equal(before.reserved, 1);
  assert.equal(before.hold.status, 'held');

  // This is what the asSession bridge used to prevent. releaseOrder's writes
  // now run inside the caller's session, so throwing after them undoes the
  // cancellation, the stock return and the coin release together.
  await assert.rejects(() => mongo.transaction(async (session) => {
    const released = await commerce.releaseOrder(orderId, session);
    assert.equal(released, true, 'the release itself succeeded before we abort it');
    throw new Error('simulated failure after release');
  }), /simulated failure/);

  const order = await mongo.orders().findOne({_id: orderId});
  assert.equal(order.status, 'pending', 'the cancellation was rolled back');
  assert.equal(order.reserved, true);
  assert.equal((await mongo.variants().findOne({_id: variantId})).reserved, 1, 'stock was not handed back');
  assert.equal((await mongo.walletReservations().findOne({order_id: orderId})).status, 'held',
    'the coins are still held');
  assert.equal((await wallet.walletSummary(user.id)).availableCoins, 0);

  // And it still releases cleanly when nothing throws.
  assert.equal(await mongo.transaction((session) => commerce.releaseOrder(orderId, session)), true);
  assert.equal((await mongo.orders().findOne({_id: orderId})).status, 'cancelled');
  assert.equal((await mongo.variants().findOne({_id: variantId})).reserved, 0);
  assert.equal((await wallet.walletSummary(user.id)).availableCoins, 40);
});

test('concurrent releases return the stock exactly once', async () => {
  const {orderId, variantId} = await pendingOrder({quantity: 2});
  const reservedBefore = (await mongo.variants().findOne({_id: variantId})).reserved;
  assert.equal(reservedBefore, 2);

  const results = await Promise.allSettled([
    mongo.transaction((session) => commerce.releaseOrder(orderId, session)),
    mongo.transaction((session) => commerce.releaseOrder(orderId, session)),
  ]);
  const released = results.filter((r) => r.status === 'fulfilled' && r.value === true);
  assert.equal(released.length, 1, 'only one caller claimed the cancellation');
  assert.equal((await mongo.variants().findOne({_id: variantId})).reserved, 0,
    'reserved went to zero, not negative');
});

test('maintenance sweeps expired sessions, tokens and rate limits', async () => {
  const past = new Date(Date.now() - 1000);
  const future = new Date(Date.now() + 3600000);
  const user = await makeUser();
  await mongo.sessions().insertMany([
    {_id: id(), id: id(), user_id: user.id, expires_at: past},
    {_id: id(), id: id(), user_id: user.id, expires_at: future},
  ]);
  await mongo.authTokens().insertOne({_id: id(), id: id(), user_id: user.id, kind: 'verify', token_hash: 'x', expires_at: past});
  await mongo.rateLimits().insertOne({_id: id(), scope: 'x', hits: 1, expires_at: past});
  const doneId = id();
  await mongo.jobs().insertOne({
    _id: doneId, id: doneId, kind: 'invoice', dedupe_key: `t5-old-${randomUUID()}`,
    payload: {}, status: 'done', attempts: 1, available_at: past, locked_until: null,
    last_error: null, ran_at: past, created_at: new Date(Date.now() - 31 * 86400000),
  });

  await jobsModule.maintenance();

  assert.equal(await mongo.sessions().countDocuments({user_id: user.id, expires_at: {$lt: new Date()}}), 0);
  assert.equal(await mongo.sessions().countDocuments({user_id: user.id}), 1, 'the live session survives');
  assert.equal(await mongo.authTokens().countDocuments({user_id: user.id}), 0);
  assert.equal(await mongo.rateLimits().countDocuments({scope: 'x'}), 0);
  assert.equal(await mongo.jobs().countDocuments({_id: doneId}), 0, 'done jobs are pruned after 30 days');
});

/* ============================================================== webhooks */

const webhookSecret = () => process.env.RAZORPAY_WEBHOOK_SECRET;

/** Calls the handler directly with the raw body Razorpay would have signed. */
async function deliver(event, payload, {eventId = null, signature = null, secret = null} = {}) {
  const body = Buffer.from(JSON.stringify({event, payload}));
  const sig = signature ?? createHmac('sha256', secret ?? webhookSecret()).update(body).digest('hex');
  const req = {
    body,
    headers: {
      'x-razorpay-signature': sig,
      ...(eventId ? {'x-razorpay-event-id': eventId} : {}),
    },
  };
  let status = 200;
  let json = null;
  const res = {
    json: (value) => { json = value; return res; },
    status: (code) => { status = code; return res; },
  };
  try {
    await razorpayWebhook(req, res);
    return {status, json};
  } catch (error) {
    return {status: error.status ?? 500, error: error.message};
  }
}

/** A paid order with a refund already registered against the provider. */
async function refundableOrder({refundStatus = 'processed'} = {}) {
  const user = await makeUser();
  const variantId = await makeVariant(10);
  await mongo.cartItems().insertOne({user_id: user.id, variant_id: variantId, quantity: 1});
  const order = await commerce.createOrder(user, {address: ADDRESS, coupon: ''}, `key-${randomUUID()}`);
  const p = await commerce.paymentOrder(order.id);
  const payment = {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: p.gateway_order_id,
    amount: p.amount, currency: p.currency, status: 'captured', captured: true, method: 'card',
  };
  remotes.set(payment.id, payment);
  await commerce.acceptCapturedPayment(payment);

  const refundId = id();
  const providerId = `rfnd_${randomUUID().replaceAll('-', '')}`;
  await mongo.refunds().insertOne({
    _id: refundId, id: refundId, order_id: order.id, refund_key: 'full',
    provider_id: providerId, status: 'pending', amount: p.amount,
    reason: 'Support refund', created_at: new Date(),
  });
  // What the API will say when syncRefundById re-reads it. This, not the
  // webhook payload, is what decides the stored status.
  remotes.set(providerId, {id: providerId, payment_id: payment.id, amount: p.amount, status: refundStatus});
  return {orderId: order.id, variantId, refundId, providerId, payment, gatewayOrderId: p.gateway_order_id, amount: p.amount};
}

test('an invalid webhook signature is refused and records nothing', async () => {
  const before = await mongo.webhookEvents().countDocuments({});
  const bad = await deliver('payment.captured', {payment: {entity: {id: 'pay_x'}}}, {signature: '0'.repeat(64)});
  assert.equal(bad.status, 400);
  assert.match(bad.error, /Invalid webhook signature/);

  const wrongSecret = await deliver('payment.captured', {payment: {entity: {id: 'pay_x'}}}, {secret: 'not-the-secret'});
  assert.equal(wrongSecret.status, 400);

  assert.equal(await mongo.webhookEvents().countDocuments({}), before,
    'an unsigned delivery never reaches the event log');
});

test('the previous webhook secret is still accepted during a rotation', async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS = 'older-webhook-secret';
  const result = await deliver('contact.anything', {}, {eventId: `evt_${randomUUID()}`, secret: 'older-webhook-secret'});
  assert.equal(result.status, 200);
  delete process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS;
});

test('a refund webhook reconciles the refund against the provider', async () => {
  const {orderId, refundId, variantId} = await refundableOrder({refundStatus: 'processed'});
  const stockBefore = (await mongo.variants().findOne({_id: variantId})).stock;

  const result = await deliver('refund.processed', {refund: {entity: {id: (await mongo.refunds().findOne({_id: refundId})).provider_id}}}, {eventId: `evt_${randomUUID()}`});
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);

  assert.equal((await mongo.refunds().findOne({_id: refundId})).status, 'processed');
  const order = await mongo.orders().findOne({_id: orderId});
  assert.equal(order.payment_status, 'refunded', 'the refund webhook is functional again');
  assert.equal((await mongo.variants().findOne({_id: variantId})).stock, stockBefore + 1);
});

test('a refund is never marked successful on the payload alone', async () => {
  // The event says "processed". The API, which is the only thing trusted,
  // says the refund is still pending.
  const {refundId, orderId} = await refundableOrder({refundStatus: 'pending'});
  const providerId = (await mongo.refunds().findOne({_id: refundId})).provider_id;

  const result = await deliver('refund.processed', {refund: {entity: {id: providerId, status: 'processed'}}}, {eventId: `evt_${randomUUID()}`});
  assert.equal(result.status, 200);
  assert.equal((await mongo.refunds().findOne({_id: refundId})).status, 'pending',
    'the stored status comes from the API, not the event');
  assert.notEqual((await mongo.orders().findOne({_id: orderId})).payment_status, 'refunded');
});

test('a refund event for a refund we do not know is retried, not swallowed', async () => {
  const before = await mongo.webhookEvents().countDocuments({});
  const result = await deliver('refund.processed', {refund: {entity: {id: `rfnd_${randomUUID()}`}}}, {eventId: `evt_${randomUUID()}`});
  assert.equal(result.status, 409);
  assert.match(result.error, /awaiting reconciliation/);
  assert.equal(await mongo.webhookEvents().countDocuments({}), before,
    'not recorded, so Razorpay keeps redelivering until our write catches up');
});

test('a redelivered event is acknowledged once and acted on once', async () => {
  const {refundId, variantId} = await refundableOrder({refundStatus: 'processed'});
  const providerId = (await mongo.refunds().findOne({_id: refundId})).provider_id;
  const eventId = `evt_${randomUUID()}`;
  const body = {refund: {entity: {id: providerId}}};

  const first = await deliver('refund.processed', body, {eventId});
  assert.equal(first.status, 200);
  assert.ok(!first.json.duplicate);
  const stockAfterFirst = (await mongo.variants().findOne({_id: variantId})).stock;

  for (let i = 0; i < 3; i += 1) {
    const again = await deliver('refund.processed', body, {eventId});
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true, 'the same event id is recognised');
  }
  assert.equal(await mongo.webhookEvents().countDocuments({event_id: eventId}), 1);
  assert.equal((await mongo.variants().findOne({_id: variantId})).stock, stockAfterFirst,
    'no second stock restore');
});

test('deliveries without an event id fall back to the body hash', async () => {
  const body = {note: `no-id-${randomUUID()}`};
  const first = await deliver('contact.something', body);
  assert.equal(first.status, 200);
  assert.ok(!first.json.duplicate);
  const second = await deliver('contact.something', body);
  assert.equal(second.json.duplicate, true, 'identical bytes read as the same event');

  // Several header-less events must not collide on a null event_id, which is
  // what the partial unique index on event_id exists for.
  const other = await deliver('contact.something', {note: `no-id-${randomUUID()}`});
  assert.equal(other.status, 200);
  assert.ok(!other.json.duplicate);
  assert.ok(await mongo.webhookEvents().countDocuments({event_id: null}) >= 2);
});

test('an out-of-order failure event cannot unpick a captured payment', async () => {
  const {orderId, gatewayOrderId, payment} = await refundableOrder();
  const captured = await mongo.payments().findOne({order_id: orderId});
  assert.equal(captured.status, 'captured');

  // A payment.failed for an earlier attempt, arriving after the capture.
  const failed = await deliver('payment.failed', {payment: {entity: {
    id: `pay_${randomUUID().replaceAll('-', '')}`, order_id: gatewayOrderId,
    status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'Declined',
  }}}, {eventId: `evt_${randomUUID()}`});
  assert.equal(failed.status, 200);

  const after = await mongo.payments().findOne({order_id: orderId});
  assert.equal(after.status, 'captured', 'the capture stands');
  assert.equal(after.gateway_payment_id, payment.id);
  assert.equal((await mongo.orders().findOne({_id: orderId})).payment_status, 'paid');
});

test('a late authorization event cannot move a captured payment backwards', async () => {
  const {orderId, gatewayOrderId, payment, amount} = await refundableOrder();
  const lateId = `pay_${randomUUID().replaceAll('-', '')}`;
  remotes.set(lateId, {
    id: lateId, order_id: gatewayOrderId, amount, currency: 'INR',
    status: 'authorized', captured: false, method: 'card',
  });

  const result = await deliver('payment.authorized', {payment: {entity: {id: lateId}}}, {eventId: `evt_${randomUUID()}`});
  assert.equal(result.status, 200);

  const after = await mongo.payments().findOne({order_id: orderId});
  assert.equal(after.status, 'captured');
  assert.equal(after.gateway_payment_id, payment.id, 'the captured payment id is untouched');
});

test('an unrecognised event is acknowledged and logged without a side effect', async () => {
  const eventId = `evt_${randomUUID()}`;
  const result = await deliver('subscription.charged', {whatever: true}, {eventId});
  assert.equal(result.status, 200);
  const row = await mongo.webhookEvents().findOne({event_id: eventId});
  assert.equal(row.kind, 'subscription.charged');
  assert.ok(row.body_hash, 'the body hash is kept as the fallback key');
  assert.ok(row.processed_at instanceof Date);
});

/* =============================================================== contact */

const enquiry = (patch = {}) => ({
  name: 'Asha Patel',
  email: `asha-${randomUUID().slice(0, 8)}@example.invalid`,
  subject: 'Question about sizing',
  message: 'I would like to know whether the medium runs small across the shoulders before I order.',
  ...patch,
});

test('an enquiry is stored and both emails are queued', async () => {
  const body = enquiry();
  const result = await contact.submitEnquiry(body);
  assert.match(result.message, /has been received/);

  const stored = await mongo.contactMessages().findOne({email: body.email});
  assert.ok(stored, 'the enquiry is recorded before any email is attempted');
  assert.equal(stored.subject, body.subject);
  assert.equal(stored.handled_at, null);
  assert.equal(stored.user_id, null);

  assert.equal(await mongo.emailNotifications().countDocuments({dedupe_key: `contact:${stored._id}`}), 1);
  assert.equal(await mongo.emailNotifications().countDocuments({dedupe_key: `contact-ack:${stored._id}`}), 1);
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: `contact:${stored._id}`}), 1);
});

test('a resubmitted enquiry is one record and one pair of emails', async () => {
  const body = enquiry();
  await contact.submitEnquiry(body);
  const stored = await mongo.contactMessages().findOne({email: body.email});

  // Same person, same message, twice.
  await contact.submitEnquiry(body);
  assert.equal(await mongo.contactMessages().countDocuments({email: body.email}), 1);
  assert.equal(await mongo.emailNotifications().countDocuments({dedupe_key: `contact:${stored._id}`}), 1);
  assert.equal(await mongo.emailNotifications().countDocuments({
    dedupe_key: {$in: [`contact:${stored._id}`, `contact-ack:${stored._id}`]},
  }), 2, 'still exactly two emails');
});

test('two identical enquiries racing each other store one', async () => {
  const body = enquiry();
  const results = await Promise.allSettled([
    contact.submitEnquiry(body),
    contact.submitEnquiry(body),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2,
    'both callers are told their message was received');
  assert.equal(await mongo.contactMessages().countDocuments({email: body.email}), 1);
  const stored = await mongo.contactMessages().findOne({email: body.email});
  assert.equal(await mongo.emailNotifications().countDocuments({
    dedupe_key: {$in: [`contact:${stored._id}`, `contact-ack:${stored._id}`]},
  }), 2, 'the loser queued nothing');
});

test('the enquiry and its emails commit together or not at all', async () => {
  // submitEnquiry writes the message and queues both emails in one
  // transaction. This drives the same two collections through the same
  // transaction helper and aborts it, which is the property the module relies
  // on: a mail-queue failure must not leave an orphaned enquiry behind.
  const fingerprint = `rollback-${randomUUID()}`;
  const messageId = id();
  await assert.rejects(() => mongo.transaction(async (session) => {
    await mongo.contactMessages().insertOne({
      _id: messageId, id: messageId, fingerprint, name: 'Rollback',
      email: 'rollback@example.invalid', subject: 'Nope', message: 'x'.repeat(25),
      order_number: null, user_id: null, handled_at: null, handled_by: null,
      created_at: new Date(),
    }, {session});
    await queue.queueEmail(`contact:${messageId}`, 'ops@example.invalid', 'Nope', {template: 'contact_enquiry'}, session);
    throw new Error('mail queue unavailable');
  }), /mail queue unavailable/);

  assert.equal(await mongo.contactMessages().countDocuments({fingerprint}), 0, 'no orphaned enquiry');
  assert.equal(await mongo.emailNotifications().countDocuments({dedupe_key: `contact:${messageId}`}), 0);
  assert.equal(await mongo.jobs().countDocuments({dedupe_key: `contact:${messageId}`}), 0);
});

test('validation and the abuse controls are unchanged', async () => {
  // Link-heavy messages are answered exactly like a genuine submission, so a
  // bot learns nothing from the response.
  await assert.rejects(() => contact.submitEnquiry(enquiry({
    message: 'Buy now http://a.example http://b.example http://c.example and more text here.',
  })), /has been received/);
  // A link in the subject of a support question.
  await assert.rejects(() => contact.submitEnquiry(enquiry({subject: 'see http://spam.example'})), /has been received/);
  // Header injection.
  await assert.rejects(() => contact.submitEnquiry(enquiry({
    message: 'Please help me with my order.\nbcc: victim@example.invalid\nthanks very much',
  })), /has been received/);
  // The honeypot is only allowed to be empty.
  await assert.rejects(() => contact.submitEnquiry(enquiry({website: 'http://bot.example'})));
  // Schema floors.
  await assert.rejects(() => contact.submitEnquiry(enquiry({message: 'too short'})), /more detail/);
  await assert.rejects(() => contact.submitEnquiry(enquiry({name: 'A'})), /Tell us your name/);
  await assert.rejects(() => contact.submitEnquiry(enquiry({email: 'not-an-email'})));
  // And none of those stored anything.
  assert.equal(await mongo.contactMessages().countDocuments({name: 'A'}), 0);
});

test('an enquiry from a signed-in customer is attributed to them', async () => {
  const user = await makeUser();
  const body = enquiry({orderNumber: '1024'});
  await contact.submitEnquiry(body, user);
  const stored = await mongo.contactMessages().findOne({email: body.email});
  assert.equal(stored.user_id, user.id);
  assert.equal(stored.order_number, '1024');
});

test('the enquiry recipient falls back to the published support address', async () => {
  const configured = await contact.enquiryRecipient();
  assert.equal(configured, 'support@example.invalid', 'BUSINESS_EMAIL wins when set');

  delete process.env.BUSINESS_EMAIL;
  const {config} = await import('../server/config.mjs');
  const saved = config.businessEmail;
  config.businessEmail = '';
  await mongo.storeSettings().updateOne({_id: 1}, {$set: {support_email: 'help@example.invalid'}});
  assert.equal(await contact.enquiryRecipient(), 'help@example.invalid');
  config.businessEmail = saved;
  process.env.BUSINESS_EMAIL = 'support@example.invalid';
});
