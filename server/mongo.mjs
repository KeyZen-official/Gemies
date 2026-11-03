import {MongoClient} from 'mongodb';
import {config} from './config.mjs';

/**
 * The MongoDB connection, collections and indexes.
 *
 * One client for the process. The driver pools internally, so this is shared
 * rather than opened per request.
 *
 * Two conventions carried over from the SQL schema, both deliberate:
 *
 *  - `_id` holds the same UUID string the SQL rows used, and every document
 *    also carries `id` with that value. The duplication costs 36 bytes a
 *    document and means the 167 existing call sites that read `row.id` keep
 *    working, and every API response keeps its exact shape. Mapping `_id` to
 *    `id` on read instead would mean touching every projection and every
 *    consumer, which is where a migration this size goes wrong.
 *
 *  - Money stays integer paise, exactly as before. No Decimal128, no floats.
 */

let client = null;
let database = null;

/** Opens the shared connection. Safe to call repeatedly. */
export async function connect() {
  if (database) return database;
  const uri = config.mongoUri;
  if (!uri) throw new Error('MONGODB_URI is required.');
  client = new MongoClient(uri, {
    // Multi-document transactions need majority concerns; set here so every
    // financial write inherits them rather than relying on per-call options.
    retryWrites: true,
    writeConcern: {w: 'majority'},
    serverSelectionTimeoutMS: 15000,
  });
  await client.connect();
  database = client.db(config.mongoDbName);

  // Say so, on the terminal, with enough detail to prove WHICH database is
  // being used -- the host actually selected, the replica set and the database
  // name. "Connected" on its own is not useful when the usual mistake is
  // connecting successfully to the wrong place.
  //
  // Credentials are never printed: the host comes from the server's own hello
  // response, not from the connection string.
  let host = 'unknown';
  let replicaSet = null;
  try {
    const hello = await database.admin().command({hello: 1});
    host = hello.me ?? host;
    replicaSet = hello.setName ?? null;
  } catch {
    // A user without the privilege to run `hello` can still read and write, so
    // this is reported as unknown rather than treated as a failure.
  }
  console.log(`MongoDB connected: database "${config.mongoDbName}" on ${host}${replicaSet ? ` (replica set ${replicaSet})` : ''}`);
  return database;
}

export const db = () => {
  if (!database) throw new Error('MongoDB is not connected. Call connect() first.');
  return database;
};

export const close = async () => {
  if (client) await client.close();
  client = null;
  database = null;
};

export const mongoClient = () => client;

/** Collection handles, named exactly as the SQL tables were. */
export const col = (name) => db().collection(name);

export const users = () => col('users');
export const sessions = () => col('sessions');
export const authTokens = () => col('auth_tokens');
export const rateLimits = () => col('rate_limits');
export const categories = () => col('categories');
export const products = () => col('products');
export const variants = () => col('variants');
export const cartItems = () => col('cart_items');
export const wishlist = () => col('wishlist');
export const addresses = () => col('addresses');
export const storeSettings = () => col('store_settings');
export const coupons = () => col('coupons');
export const orders = () => col('orders');
export const orderItems = () => col('order_items');
export const payments = () => col('payments');
export const paymentAttempts = () => col('payment_attempts');
export const refunds = () => col('refunds');
export const invoices = () => col('invoices');
export const shipments = () => col('shipments');
export const shippingEvents = () => col('shipping_events');
export const webhookEvents = () => col('webhook_events');
export const jobs = () => col('jobs');
export const emailNotifications = () => col('email_notifications');
export const auditLogs = () => col('audit_logs');
export const newsletter = () => col('newsletter');
export const contactMessages = () => col('contact_messages');
export const walletAccounts = () => col('wallet_accounts');
export const walletTransactions = () => col('wallet_transactions');
export const walletReservations = () => col('wallet_reservations');
export const exchangeRequests = () => col('exchange_requests');
export const exchangeItems = () => col('exchange_items');
export const exchangeStatusHistory = () => col('exchange_status_history');
export const counters = () => col('counters');

/* -------------------------------------------------------------- transactions */

/**
 * Runs `fn` in a transaction.
 *
 * The session is passed to `fn`, and every operation inside must be given
 * `{session}` or it will silently run outside the transaction — which is the
 * single easiest way to break atomicity here, so callers pass it explicitly
 * rather than it being inferred.
 *
 * `withTransaction` retries on transient errors, which is why no Razorpay,
 * Shiprocket or Resend call may appear inside one: a retry would re-send it.
 * That rule held in the SQL version and it holds here.
 */
export async function transaction(fn) {
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); }, {
      readConcern: {level: 'snapshot'},
      writeConcern: {w: 'majority'},
      readPreference: 'primary',
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * `{session}` or `{}`, so a caller can spread it into driver options.
 *
 * Functions like `enqueue`, `queueEmail`, `audit` and most of the wallet take
 * an optional session, so a write can be made atomic with the state change
 * that justified it, and can also be called on its own. This turns "maybe a
 * session" into options either way, which keeps the call sites free of
 * conditionals.
 *
 * This used to sit behind `asSession`, which recognised a PostgreSQL client by
 * its `.query` method and dropped it, so a not-yet-migrated caller's write ran
 * outside any transaction. There are no PostgreSQL callers left, so the
 * scaffolding is gone and a session passed here is always honoured.
 */
export const withSession = (session) => (session ? {session} : {});

/* ------------------------------------------------------------------ sequences */

/**
 * The next value of a monotonic sequence.
 *
 * Replaces `BIGINT GENERATED ALWAYS AS IDENTITY` on `orders.number` and
 * `exchange_requests.number`. `findOneAndUpdate` with `$inc` is atomic in
 * MongoDB, so two concurrent checkouts cannot be handed the same order number.
 */
export async function nextSequence(name, session = undefined) {
  const row = await counters().findOneAndUpdate(
    {_id: name},
    {$inc: {seq: 1}},
    {upsert: true, returnDocument: 'after', ...(session ? {session} : {})},
  );
  return row.seq;
}

/* -------------------------------------------------------------------- indexes */

/**
 * Creates every index and validator the application relies on.
 *
 * This is the whole schema. It replaced a SQL migration file, and the index
 * list below is a direct translation of that file's constraints and indexes,
 * which is why several entries carry a note about the SQL they came from.
 * Idempotent: createIndexes is a no-op for an index that already matches, so
 * this runs on every boot instead of a migration step.
 *
 * The CHECK constraints that SQL enforced in the engine cannot all be
 * expressed here. Those that are single-field bounds become $jsonSchema
 * validators below; the cross-field ones (stock >= reserved,
 * wallet_applied <= total) are enforced by conditional updates in the code
 * that writes them, and each of those sites says so.
 */
export async function ensureSchema() {
  const d = db();

  // Every index is named explicitly. MongoDB derives a name from the keys
  // alone, so a plain index and a partial unique index on the same field --
  // wallet_transactions.order_id is both -- would collide on the generated
  // name and the second createIndex would fail.
  const nameFor = (keys, options) => [
    ...Object.entries(keys).map(([field, direction]) => `${field}_${direction}`),
    options.unique ? 'u' : null,
    options.partialFilterExpression ? 'pf' : null,
    options.sparse ? 'sp' : null,
  ].filter(Boolean).join('_');

  const unique = (c, keys, options = {}) => {
    const full = {...options, unique: true};
    return {c, keys, options: {...full, name: nameFor(keys, full)}};
  };
  const plain = (c, keys, options = {}) => ({c, keys, options: {...options, name: nameFor(keys, options)}});

  // A unique index over a column that is only sometimes filled. In Postgres a
  // UNIQUE index ignores NULLs, so many rows could sit at NULL while the index
  // still rejected duplicate real values. MongoDB treats null as an ordinary
  // value and would reject the second unfilled row, and `sparse` does not help
  // because it only skips documents where the field is ABSENT -- these
  // documents are written with an explicit null. Restricting the index to
  // string values reproduces the SQL behaviour.
  const uniqueWhenSet = (c, field) => unique(c, {[field]: 1}, {partialFilterExpression: {[field]: {$type: 'string'}}});

  const specs = [
    unique('users', {email: 1}),
    plain('sessions', {user_id: 1}),
    plain('sessions', {expires_at: 1}),
    plain('auth_tokens', {user_id: 1, kind: 1}),
    plain('auth_tokens', {expires_at: 1}),
    plain('rate_limits', {expires_at: 1}),

    unique('categories', {name: 1}),
    unique('categories', {slug: 1}),
    // Postgres needed COALESCE(parent_id,'') because NULLs do not collide in a
    // unique index. MongoDB treats null as a value, so a plain compound unique
    // index gives the same guarantee for top-level categories directly.
    unique('categories', {parent_id: 1, segment: 1}),
    plain('categories', {parent_id: 1, display_order: 1}),

    unique('products', {slug: 1}),
    plain('products', {category_id: 1, published: 1}),
    plain('products', {fit: 1}),
    plain('products', {fabric: 1}),
    plain('products', {created_at: -1}),

    unique('variants', {sku: 1}),
    unique('variants', {product_id: 1, size: 1, color: 1}),
    plain('variants', {product_id: 1}),

    unique('cart_items', {user_id: 1, variant_id: 1}),
    unique('wishlist', {user_id: 1, product_id: 1}),
    plain('addresses', {user_id: 1}),
    unique('coupons', {code: 1}),

    unique('orders', {number: 1}),
    unique('orders', {user_id: 1, checkout_key: 1}),
    plain('orders', {user_id: 1, created_at: -1}),
    plain('orders', {status: 1, expires_at: 1}),
    plain('orders', {payment_status: 1, created_at: -1}),
    plain('order_items', {order_id: 1}),
    plain('order_items', {variant_id: 1}),

    unique('payments', {order_id: 1}),
    // A payment row exists before the gateway order id is known, so many rows
    // sit at null at once and must not collide with each other.
    uniqueWhenSet('payments', 'gateway_order_id'),
    uniqueWhenSet('payments', 'gateway_payment_id'),
    unique('payment_attempts', {gateway_payment_id: 1}),
    plain('payment_attempts', {order_id: 1, created_at: -1}),

    unique('refunds', {order_id: 1, refund_key: 1}),
    uniqueWhenSet('refunds', 'provider_id'),
    plain('refunds', {order_id: 1, created_at: -1}),

    unique('invoices', {number: 1}),
    // One LIVE invoice per order. The original stays as 'void', so this is a
    // partial index exactly as it was in SQL.
    unique('invoices', {order_id: 1}, {partialFilterExpression: {status: 'issued'}}),
    plain('invoices', {order_id: 1, version: -1}),

    // One shipment per order, and one GEMIES shipment per Shiprocket record.
    // These three are what make duplicate shipment creation impossible even
    // if two operators click Create at the same moment.
    unique('shipments', {order_id: 1}),
    uniqueWhenSet('shipments', 'provider_order_id'),
    uniqueWhenSet('shipments', 'provider_shipment_id'),
    uniqueWhenSet('shipments', 'awb'),
    // The worker's tracking sweep reads by provider id and stage.
    plain('shipments', {stage: 1, last_synced: 1}),
    unique('shipping_events', {event_key: 1}),
    plain('shipping_events', {shipment_id: 1, created_at: -1}),

    unique('webhook_events', {event_id: 1}, {partialFilterExpression: {event_id: {$type: 'string'}}}),

    unique('jobs', {dedupe_key: 1}),
    plain('jobs', {status: 1, available_at: 1}),
    // The second half of the worker's claim filter: a running job whose lease
    // has elapsed. Without this, recovering an abandoned job scans every job.
    plain('jobs', {status: 1, locked_until: 1}),
    plain('jobs', {created_at: -1}),

    unique('email_notifications', {dedupe_key: 1}),
    plain('email_notifications', {status: 1, created_at: -1}),
    plain('email_notifications', {order_id: 1, created_at: -1}),

    plain('audit_logs', {created_at: -1}),
    plain('audit_logs', {action: 1, created_at: -1}),
    unique('newsletter', {email: 1}),

    unique('contact_messages', {fingerprint: 1}),
    plain('contact_messages', {created_at: -1}),
    plain('contact_messages', {handled_at: 1, created_at: -1}),

    unique('wallet_accounts', {user_id: 1}),
    unique('wallet_transactions', {idempotency_key: 1}),
    plain('wallet_transactions', {user_id: 1, created_at: -1}),
    plain('wallet_transactions', {order_id: 1}),
    // One exchange credit per exchange, one redemption per order. These two
    // partial unique indexes are what make a double-clicked approval harmless,
    // so they are not optional.
    unique('wallet_transactions', {exchange_id: 1}, {partialFilterExpression: {kind: 'exchange_credit'}}),
    unique('wallet_transactions', {order_id: 1}, {partialFilterExpression: {kind: 'purchase_redemption'}}),

    unique('wallet_reservations', {idempotency_key: 1}),
    unique('wallet_reservations', {order_id: 1}, {partialFilterExpression: {status: 'held'}}),
    plain('wallet_reservations', {user_id: 1, status: 1}),

    unique('exchange_requests', {number: 1}),
    plain('exchange_requests', {user_id: 1, created_at: -1}),
    plain('exchange_requests', {order_id: 1}),
    plain('exchange_requests', {status: 1, created_at: -1}),
    unique('exchange_items', {exchange_id: 1, order_item_id: 1}),
    plain('exchange_status_history', {exchange_id: 1, created_at: 1}),
  ];

  // Indexes an earlier version of this file created that are now wrong. These
  // were `sparse: true` uniques standing in for Postgres's NULL-ignoring
  // uniques; sparse does not skip explicit nulls, so they rejected the second
  // unfilled row. Superseded by the uniqueWhenSet partial indexes above.
  // Dropped by name, so nothing a later schema version adds is at risk.
  const retired = [
    ['payments', 'gateway_order_id_1_u_sp'],
    ['payments', 'gateway_payment_id_1_u_sp'],
    ['refunds', 'provider_id_1_u_sp'],
    ['shipments', 'provider_order_id_1_u_sp'],
    ['shipments', 'provider_shipment_id_1_u_sp'],
  ];
  for (const [c, name] of retired) {
    await d.collection(c).dropIndex(name).catch((error) => {
      if (!/index not found|IndexNotFound|ns not found|NamespaceNotFound/i.test(error.message)) throw error;
    });
  }

  for (const {c, keys, options} of specs) {
    await d.collection(c).createIndex(keys, options).catch((error) => {
      // An index that already exists with different options is worth seeing,
      // not swallowing.
      if (!/already exists|IndexOptionsConflict|IndexKeySpecsConflict/i.test(error.message)) throw error;
      console.error(JSON.stringify({event: 'index_conflict', collection: c, keys, reason: error.message}));
    });
  }

  // The settings singleton, which the SQL schema seeded with
  // INSERT INTO store_settings(id) VALUES(1) ON CONFLICT DO NOTHING.
  await storeSettings().updateOne(
    {_id: 1},
    {$setOnInsert: DEFAULT_SETTINGS},
    {upsert: true},
  );

  return specs.length;
}

/**
 * store_settings defaults, carried over column for column from the SQL
 * DEFAULTs so an existing deployment behaves identically.
 */
export const DEFAULT_SETTINGS = {
  id: 1,
  shipping: 0,
  free_shipping_threshold: 0,
  tax_bps: 0,
  support_email: '',
  returns_policy: '',
  privacy_policy: '',
  terms: '',
  social_x: '',
  social_facebook: '',
  social_instagram: '',
  social_linkedin: '',
  wallet_enabled: false,
  wallet_paise_per_coin: 100,
  wallet_min_redeem_coins: 0,
  wallet_max_order_percent: 100,
  wallet_min_order_value: 0,
  wallet_partial_redemption: true,
  wallet_coins_expire: false,
  wallet_expiry_days: 0,
  wallet_promo_enabled: false,
  exchange_enabled: false,
  exchange_window_days: 0,
  exchange_credit_shipping: false,
};
