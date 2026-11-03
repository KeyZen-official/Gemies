import {
  walletAccounts, walletTransactions, walletReservations, exchangeRequests,
  storeSettings, orders, transaction, withSession,
} from './mongo.mjs';
import {id, assert} from './security.mjs';
import {config} from './config.mjs';
import {expiredCoins, nextExpiry} from './wallet-expiry.mjs';

/**
 * The wallet ledger.
 *
 * Every movement of store credit goes through post() below. Nothing else
 * writes to wallet_transactions, and nothing anywhere updates or deletes a
 * document in it: an admin correction is a new compensating entry, so the
 * history of a balance cannot be rewritten.
 *
 * Invariants, and where each one is now enforced:
 *
 *  - A balance can never go negative.
 *      In SQL this was `CHECK(balance_coins >= 0)` plus a `FOR UPDATE` lock.
 *      MongoDB has neither, so the guarantee moved into the debit's own
 *      filter: `{balance_coins: {$gte: coins}}`. The update is atomic, so two
 *      concurrent debits cannot both see a sufficient balance, and a debit
 *      that would overdraw simply matches no document.
 *
 *  - One idempotency key is one movement of value, forever.
 *      Unique index on idempotency_key. post() checks first for a clean
 *      result, and the index is what actually decides a race.
 *
 *  - One exchange credits once; one order redeems once.
 *      Two partial unique indexes, not application logic.
 *
 *  - The rupee value of a past transaction never changes.
 *      paise_per_coin and inr_value are snapshotted on every document.
 *
 *  - Coins held for a checkout are not spent until payment is captured.
 *      wallet_reservations. Available balance subtracts live holds; the ledger
 *      entry is written only when a reservation is consumed.
 *
 * There is no cash-out. Coins leave a wallet only as a purchase redemption, an
 * expiry, or a negative admin adjustment -- never as money.
 */

const CREDIT_KINDS = new Set(['exchange_credit', 'promotional_credit', 'redemption_release']);
const DEBIT_KINDS = new Set(['purchase_redemption', 'expiry']);

export const TRANSACTION_KINDS = [
  'exchange_credit', 'purchase_redemption', 'redemption_release',
  'admin_adjustment', 'promotional_credit', 'expiry',
];

/* ------------------------------------------------------------------ settings */

export async function walletSettings(client = undefined) {
  const s = await storeSettings().findOne({_id: 1}, withSession(client));
  return {
    enabled: s.wallet_enabled,
    paisePerCoin: s.wallet_paise_per_coin,
    minRedeemCoins: s.wallet_min_redeem_coins,
    maxOrderPercent: s.wallet_max_order_percent,
    minOrderValue: s.wallet_min_order_value,
    partialRedemption: s.wallet_partial_redemption,
    coinsExpire: s.wallet_coins_expire,
    expiryDays: s.wallet_expiry_days,
    promoEnabled: s.wallet_promo_enabled,
    exchangeEnabled: s.exchange_enabled,
    exchangeWindowDays: s.exchange_window_days,
    exchangeCreditShipping: s.exchange_credit_shipping,
    currency: config.currency,
  };
}

export const coinsToPaise = (coins, paisePerCoin) => coins * paisePerCoin;

/**
 * Paise to coins, rounded DOWN.
 *
 * Floor rather than round: rounding up would credit or redeem a fraction of a
 * paise the customer never paid, and across many transactions that is money
 * created out of arithmetic. Callers that need the remainder report it.
 */
export const paiseToCoins = (paise, paisePerCoin) => Math.floor(paise / paisePerCoin);

/* ------------------------------------------------------------------ accounts */

/** Returns the account, creating it on first touch. */
export async function ensureAccount(userId, client = undefined) {
  const options = withSession(client);
  await walletAccounts().updateOne(
    {user_id: userId},
    {$setOnInsert: {
      _id: userId, id: userId, user_id: userId,
      balance_coins: 0, lifetime_credited: 0, lifetime_debited: 0,
      created_at: new Date(), updated_at: new Date(),
    }},
    {upsert: true, ...options},
  );
  return walletAccounts().findOne({user_id: userId}, options);
}

/** Coins held by checkouts in progress, which are not available to spend. */
async function heldCoins(userId, client = undefined) {
  const row = await walletReservations().aggregate([
    {$match: {user_id: userId, status: 'held', expires_at: {$gt: new Date()}}},
    {$group: {_id: null, coins: {$sum: '$coins'}}},
  ], withSession(client)).next();
  return row?.coins ?? 0;
}

/**
 * Coins promised by an exchange that has not yet been credited.
 *
 * Derived from the exchange requests rather than stored as pending ledger
 * entries: a pending row in an append-only ledger of settled value would have
 * to be mutated or reversed later. Only states after approval count, because a
 * request still under review may be rejected.
 */
const PENDING_STATES = ['approved', 'pickup_scheduled', 'picked_up', 'received', 'inspection_passed'];

async function pendingCoins(userId, client = undefined) {
  const row = await exchangeRequests().aggregate([
    {$match: {user_id: userId, status: {$in: PENDING_STATES}, eligible_coins: {$ne: null}}},
    {$group: {_id: null, coins: {$sum: '$eligible_coins'}}},
  ], withSession(client)).next();
  return row?.coins ?? 0;
}

export async function walletSummary(userId, client = undefined) {
  const [account, settings, held, pending, expiring] = await Promise.all([
    ensureAccount(userId, client),
    walletSettings(client),
    heldCoins(userId, client),
    pendingCoins(userId, client),
    nextExpiryFor(userId, client),
  ]);
  const available = Math.max(0, account.balance_coins - held);
  return {
    enabled: settings.enabled,
    currency: settings.currency,
    paisePerCoin: settings.paisePerCoin,
    balanceCoins: account.balance_coins,
    heldCoins: held,
    availableCoins: available,
    availableInr: coinsToPaise(available, settings.paisePerCoin),
    pendingCoins: pending,
    pendingInr: coinsToPaise(pending, settings.paisePerCoin),
    lifetimeCredited: account.lifetime_credited,
    lifetimeDebited: account.lifetime_debited,
    limits: {
      minRedeemCoins: settings.minRedeemCoins,
      maxOrderPercent: settings.maxOrderPercent,
      minOrderValue: settings.minOrderValue,
      partialRedemption: settings.partialRedemption,
    },
    expiry: settings.coinsExpire ? {days: settings.expiryDays, next: expiring} : null,
  };
}

/* -------------------------------------------------------------------- ledger */

/**
 * Appends one transaction and moves the balance.
 *
 * MUST run inside a transaction: the balance is moved first to obtain the
 * post-movement figure for `balance_after`, then the entry is written. If the
 * entry collides on its idempotency key the whole transaction aborts, which is
 * what undoes the balance change. Two concurrent calls with one key therefore
 * produce exactly one movement — one commits, the other rolls back.
 */
export async function post(client, {
  userId, kind, coins, idempotencyKey, description,
  orderId = null, exchangeId = null, reservationId = null, actorId = null,
  paisePerCoin = null, signedDirection = null,
}) {
  assert(TRANSACTION_KINDS.includes(kind), 500, `Unknown wallet transaction kind: ${kind}`);
  assert(Number.isInteger(coins) && coins > 0, 400, 'Coin amount must be a positive whole number.');
  assert(idempotencyKey && typeof idempotencyKey === 'string', 500, 'A wallet transaction requires an idempotency key.');

  const direction = kind === 'admin_adjustment'
    ? (assert(signedDirection === 'credit' || signedDirection === 'debit', 400, 'An adjustment must be a credit or a debit.'), signedDirection)
    : (CREDIT_KINDS.has(kind) ? 'credit' : (assert(DEBIT_KINDS.has(kind), 500, `Kind ${kind} has no direction.`), 'debit'));

  const options = withSession(client);
  const existing = await walletTransactions().findOne({idempotency_key: idempotencyKey}, options);
  if (existing) return {...existing, existing: true};

  await ensureAccount(userId, client);
  const rate = paisePerCoin ?? (await walletSettings(client)).paisePerCoin;

  // The filter carries the guarantee. A credit always applies; a debit applies
  // only while the balance covers it, which is what replaces the removed CHECK
  // constraint and the row lock together.
  const moved = await walletAccounts().findOneAndUpdate(
    direction === 'credit'
      ? {user_id: userId}
      : {user_id: userId, balance_coins: {$gte: coins}},
    {
      $inc: direction === 'credit'
        ? {balance_coins: coins, lifetime_credited: coins}
        : {balance_coins: -coins, lifetime_debited: coins},
      $set: {updated_at: new Date()},
    },
    {returnDocument: 'after', ...options},
  );

  if (!moved) {
    const account = await walletAccounts().findOne({user_id: userId}, options);
    assert(false, 409,
      `Insufficient wallet balance: ${account?.balance_coins ?? 0} coin(s) available, ${coins} requested.`);
  }

  const txId = id();
  const row = {
    _id: txId,
    id: txId,
    user_id: userId,
    kind,
    direction,
    coins,
    paise_per_coin: rate,
    inr_value: coinsToPaise(coins, rate),
    balance_after: moved.balance_coins,
    order_id: orderId,
    exchange_id: exchangeId,
    reservation_id: reservationId,
    idempotency_key: idempotencyKey,
    description,
    actor_id: actorId,
    created_at: new Date(),
  };
  await walletTransactions().insertOne(row, options);
  return row;
}

/**
 * Appends a transaction in its own database transaction.
 *
 * A duplicate-key race is resolved by returning the entry the winner wrote, so
 * two simultaneous retries both succeed and only one movement of value exists.
 */
export async function postStandalone(args) {
  try {
    return await transaction((session) => post(session, args));
  } catch (error) {
    if (error?.code === 11000 || /duplicate key/i.test(error?.message ?? '')) {
      const row = await walletTransactions().findOne({idempotency_key: args.idempotencyKey});
      if (row) return {...row, existing: true};
    }
    throw error;
  }
}

/* --------------------------------------------------------------- reservations */

const HOLD_MINUTES = 30;

/**
 * What a customer may redeem against an order of `orderTotal` paise.
 *
 * Pure policy arithmetic in integer paise, so the checkout screen and the
 * server agree without the client computing anything.
 */
export function redeemableFor({availableCoins, orderTotal, settings}) {
  const no = (reason) => ({coins: 0, inr: 0, allowed: false, reason});
  if (!settings.enabled) return no('The wallet is not enabled.');
  if (availableCoins <= 0) return no('No coins available.');
  if (orderTotal < settings.minOrderValue) {
    return no(`Orders must be at least ${settings.minOrderValue} paise to use coins.`);
  }

  const capPaise = Math.floor((orderTotal * settings.maxOrderPercent) / 100);
  const capCoins = paiseToCoins(capPaise, settings.paisePerCoin);
  const coins = Math.min(availableCoins, capCoins);

  if (coins <= 0) return no('This order is too small to redeem coins against.');
  if (coins < settings.minRedeemCoins) {
    return no(`At least ${settings.minRedeemCoins} coins are required to redeem.`);
  }

  const inr = coinsToPaise(coins, settings.paisePerCoin);
  if (!settings.partialRedemption && inr < orderTotal) {
    return no('Coins must cover the whole order; partial redemption is disabled.');
  }
  return {coins, inr, allowed: true, reason: null};
}

/**
 * Holds coins for an order without spending them.
 *
 * Must run inside the transaction that creates the order, so an order can
 * never exist with a redemption recorded on it and no matching hold. The
 * partial unique index on (order_id) where status='held' is what stops a
 * repeated checkout stacking holds.
 */
export async function reserve(client, {userId, orderId, coins, idempotencyKey}) {
  assert(Number.isInteger(coins) && coins > 0, 400, 'Coin amount must be a positive whole number.');
  const options = withSession(client);

  const existing = await walletReservations().findOne({idempotency_key: idempotencyKey}, options);
  if (existing) return {...existing, existing: true};

  const account = await ensureAccount(userId, client);
  const held = await heldCoins(userId, client);
  const available = account.balance_coins - held;
  assert(coins <= available, 409,
    `Insufficient wallet balance: ${available} coin(s) available, ${coins} requested.`);

  const settings = await walletSettings(client);
  const reservationId = id();
  const row = {
    _id: reservationId,
    id: reservationId,
    user_id: userId,
    order_id: orderId,
    coins,
    paise_per_coin: settings.paisePerCoin,
    inr_value: coinsToPaise(coins, settings.paisePerCoin),
    status: 'held',
    idempotency_key: idempotencyKey,
    expires_at: new Date(Date.now() + HOLD_MINUTES * 60000),
    created_at: new Date(),
    settled_at: null,
  };
  await walletReservations().insertOne(row, options);
  return row;
}

/**
 * Turns a hold into a spend. Called only once payment is confirmed.
 *
 * The hold is claimed with a conditional update rather than read then written,
 * so a redelivered webhook racing the browser callback cannot both consume it.
 * The ledger entry carries the reservation's snapshotted rate, not today's.
 */
export async function consumeReservation(client, {orderId, actorId = null}) {
  const options = withSession(client);
  const held = await walletReservations().findOneAndUpdate(
    {order_id: orderId, status: 'held'},
    {$set: {status: 'consumed', settled_at: new Date()}},
    {returnDocument: 'after', ...options},
  );
  if (!held) return null;

  const order = await orders().findOne({_id: orderId}, {projection: {number: 1}, ...options});
  return post(client, {
    userId: held.user_id,
    kind: 'purchase_redemption',
    coins: held.coins,
    paisePerCoin: held.paise_per_coin,
    orderId,
    reservationId: held._id,
    actorId,
    idempotencyKey: `redeem:${orderId}`,
    description: `Redeemed against order #${order?.number ?? orderId}`,
  });
}

/**
 * Releases a hold without spending anything.
 *
 * Writes no ledger entry: the coins never left the wallet, so recording a
 * credit would overstate what the customer has earned. Safe to call repeatedly.
 */
export async function releaseReservation(client, {orderId}) {
  const result = await walletReservations().updateMany(
    {order_id: orderId, status: 'held'},
    {$set: {status: 'released', settled_at: new Date()}},
    withSession(client),
  );
  return result.modifiedCount > 0;
}

/* --------------------------------------------------------------- admin tools */

export async function adminAdjust({userId, coins, direction, reason, actorId, idempotencyKey}) {
  assert(typeof reason === 'string' && reason.trim().length >= 5, 400,
    'An adjustment requires a reason of at least 5 characters.');
  return postStandalone({
    userId,
    kind: 'admin_adjustment',
    signedDirection: direction,
    coins,
    actorId,
    idempotencyKey,
    description: reason.trim(),
  });
}

/** One page of a customer's wallet history, newest first. */
export async function history(userId, {page = 1, limit = 20, kind = '', direction = ''} = {}) {
  const match = {user_id: userId, ...(kind ? {kind} : {}), ...(direction ? {direction} : {})};
  const [rows, total] = await Promise.all([
    walletTransactions().aggregate([
      {$match: match},
      {$sort: {created_at: -1, _id: 1}},
      {$skip: (page - 1) * limit},
      {$limit: limit},
      // The order number, which the SQL got with a LEFT JOIN.
      {$lookup: {from: 'orders', localField: 'order_id', foreignField: '_id', as: '_order',
        pipeline: [{$project: {number: 1}}]}},
      {$addFields: {order_number: {$first: '$_order.number'}}},
      {$project: {_order: 0}},
    ]).toArray(),
    walletTransactions().countDocuments(match),
  ]);
  return {rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit))};
}

/**
 * Proves the cached balance equals the ledger.
 *
 * The balance on the account is a cache so a read is one document instead of
 * an aggregate over a whole history. This is the check that it has not
 * drifted. It reports; it never repairs, because a silent repair would hide
 * the bug that caused the drift.
 */
export async function reconcile(userId = null) {
  return walletAccounts().aggregate([
    ...(userId ? [{$match: {user_id: userId}}] : []),
    {$lookup: {from: 'wallet_transactions', localField: 'user_id', foreignField: 'user_id', as: 'tx',
      pipeline: [{$project: {direction: 1, coins: 1}}]}},
    {$project: {
      _id: 0,
      user_id: 1,
      cached: '$balance_coins',
      cached_credited: '$lifetime_credited',
      cached_debited: '$lifetime_debited',
      ledger: {$sum: {$map: {input: '$tx', as: 't',
        in: {$cond: [{$eq: ['$$t.direction', 'credit']}, '$$t.coins', {$multiply: ['$$t.coins', -1]}]}}}},
      ledger_credited: {$sum: {$map: {input: '$tx', as: 't',
        in: {$cond: [{$eq: ['$$t.direction', 'credit']}, '$$t.coins', 0]}}}},
      ledger_debited: {$sum: {$map: {input: '$tx', as: 't',
        in: {$cond: [{$eq: ['$$t.direction', 'debit']}, '$$t.coins', 0]}}}},
    }},
    {$addFields: {balanced: {$and: [
      {$eq: ['$cached', '$ledger']},
      {$eq: ['$cached_credited', '$ledger_credited']},
      {$eq: ['$cached_debited', '$ledger_debited']},
    ]}}},
  ]).toArray();
}

/* ------------------------------------------------------------------ expiry */

/** Expires one customer's stale coins. No-op unless configured. */
export async function expireCoinsFor(userId) {
  const settings = await walletSettings();
  if (!settings.coinsExpire || settings.expiryDays <= 0) return null;

  const rows = await walletTransactions()
    .find({user_id: userId}, {projection: {_id: 1, direction: 1, coins: 1, created_at: 1}})
    .sort({created_at: 1, _id: 1})
    .toArray();
  const due = expiredCoins(rows.map((r) => ({...r, id: r._id})), {expiryDays: settings.expiryDays});
  if (due.coins <= 0) return null;

  return postStandalone({
    userId,
    kind: 'expiry',
    coins: due.coins,
    idempotencyKey: `expire:${userId}:${due.lastLotId}`,
    description: settings.expiryDays === 1
      ? 'Coins expired after 1 day'
      : `Coins expired after ${settings.expiryDays} days`,
  });
}

/** Sweeps every wallet that could have expired coins. */
export async function expireCoinsSweep({limit = 200} = {}) {
  const settings = await walletSettings();
  if (!settings.coinsExpire || settings.expiryDays <= 0) return {expired: 0, accounts: 0};

  const cutoff = new Date(Date.now() - settings.expiryDays * 86400000);
  const candidates = await walletAccounts().aggregate([
    {$match: {balance_coins: {$gt: 0}}},
    {$lookup: {from: 'wallet_transactions', as: 'old',
      let: {u: '$user_id'},
      pipeline: [
        {$match: {$expr: {$and: [
          {$eq: ['$user_id', '$$u']},
          {$eq: ['$direction', 'credit']},
          {$lte: ['$created_at', cutoff]},
        ]}}},
        {$limit: 1},
        {$project: {_id: 1}},
      ]}},
    {$match: {'old.0': {$exists: true}}},
    {$limit: limit},
    {$project: {user_id: 1}},
  ]).toArray();

  let expired = 0;
  let accounts = 0;
  for (const row of candidates) {
    // One customer's failure must not stop the sweep for everyone else.
    try {
      const posted = await expireCoinsFor(row.user_id);
      if (posted && !posted.existing) { expired += posted.coins; accounts += 1; }
    } catch (error) {
      console.error(JSON.stringify({event: 'wallet_expiry_failed', reason: error.message}));
    }
  }
  return {expired, accounts};
}

/** When this customer's next coins lapse, for the wallet page. */
export async function nextExpiryFor(userId, client = undefined) {
  const settings = await walletSettings(client);
  if (!settings.coinsExpire || settings.expiryDays <= 0) return null;
  const rows = await walletTransactions()
    .find({user_id: userId}, {projection: {_id: 1, direction: 1, coins: 1, created_at: 1}, ...withSession(client)})
    .sort({created_at: 1, _id: 1})
    .toArray();
  return nextExpiry(rows, {expiryDays: settings.expiryDays});
}

/**
 * Lapses holds whose checkout never completed.
 *
 * Nothing is credited back, because nothing was debited. Expired holds already
 * fall out of heldCoins via its expires_at filter, so this keeps the
 * collection honest rather than being a correctness requirement.
 */
export async function expireReservations() {
  const result = await walletReservations().updateMany(
    {status: 'held', expires_at: {$lte: new Date()}},
    {$set: {status: 'released', settled_at: new Date()}},
  );
  return result.modifiedCount;
}
