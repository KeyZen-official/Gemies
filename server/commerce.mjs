import {
  cartItems, variants, products, orders, orderItems, payments, refunds,
  shipments, shippingEvents, invoices, storeSettings, coupons, users,
  transaction, nextSequence, withSession,
} from './mongo.mjs';
import {id, assert, hash} from './security.mjs';
import {config} from './config.mjs';
import {enqueue, queueEmail, queueAdminEmail} from './queue.mjs';
import {razorpay} from './providers.mjs';
import {recordAttempt} from './payments.mjs';
import * as wallet from './wallet.mjs';

/**
 * Cart, quote, order creation and payment capture.
 *
 * Six `SELECT ... FOR UPDATE` row locks were removed in the move to MongoDB,
 * which has no equivalent. Each became a conditional atomic update whose
 * filter carries the guarantee the lock used to provide, and each site says
 * which. That is a stronger pattern in one respect -- the condition is visible
 * in the query rather than implied by a lock held elsewhere -- and weaker in
 * another: if a filter is written wrongly the database will not catch it, so
 * every one of them is covered by a concurrency test.
 */

/** The cart, joined to its variants and products. */
export async function cart(userId, client = undefined) {
  const rows = await cartItems().aggregate([
    {$match: {user_id: userId}},
    {$sort: {variant_id: 1}},
    {$lookup: {from: 'variants', localField: 'variant_id', foreignField: '_id', as: 'v'}},
    {$unwind: '$v'},
    {$lookup: {from: 'products', localField: 'v.product_id', foreignField: '_id', as: 'p'}},
    {$unwind: '$p'},
    {$project: {
      _id: 0,
      variant_id: '$variant_id',
      quantity: '$quantity',
      size: '$v.size',
      color: '$v.color',
      available: {$subtract: ['$v.stock', '$v.reserved']},
      sku: '$v.sku',
      product_id: '$p._id',
      name: '$p.name',
      slug: '$p.slug',
      price: '$p.price',
      images: '$p.images',
      published: '$p.published',
      is_demo: '$p.is_demo',
    }},
  ], withSession(client)).toArray();
  return rows;
}

export function totals(items, settings, coupon = null) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const discount = coupon && subtotal >= coupon.minimum ? Math.floor(subtotal * coupon.percent / 100) : 0;
  const shipping = subtotal === 0 || subtotal - discount >= settings.free_shipping_threshold ? 0 : settings.shipping;
  const tax = Math.round((subtotal - discount) * settings.tax_bps / 10000);
  const total = subtotal - discount + tax + shipping;
  assert(Number.isSafeInteger(total) && total <= 100000000, 400, 'Order amount exceeds the supported limit.');
  // tax_bps comes back with the figures so the order can record the rate it
  // was charged at, not just the amount.
  return {subtotal, discount, shipping, tax, total, tax_bps: settings.tax_bps};
}

export async function quote(userId, code = '', client = undefined) {
  const options = withSession(client);
  const items = await cart(userId, client);
  const settings = await storeSettings().findOne({_id: 1}, options);
  let coupon = null;
  if (code) {
    coupon = await coupons().findOne({
      code: code.toUpperCase(),
      active: true,
      $or: [{expires_at: null}, {expires_at: {$gt: new Date()}}],
    }, options);
    assert(coupon, 400, 'This coupon is invalid or expired.');
    assert(items.reduce((n, i) => n + i.price * i.quantity, 0) >= coupon.minimum, 400,
      'The minimum spend for this coupon has not been reached.');
  }
  return {items, ...totals(items, settings, coupon), currency: config.currency};
}

/**
 * What a customer may pay for this order with coins, computed entirely here.
 *
 * The client sends a boolean. It never sends a balance, a coin count, a rupee
 * discount or a conversion rate, because each is a number it could lie about.
 */
export async function walletOfferFor(userId, orderTotal, client = undefined) {
  const settings = await wallet.walletSettings(client);
  const summary = await wallet.walletSummary(userId, client);
  const offer = wallet.redeemableFor({availableCoins: summary.availableCoins, orderTotal, settings});
  return {...offer, availableCoins: summary.availableCoins, paisePerCoin: settings.paisePerCoin, enabled: settings.enabled};
}

export async function createOrder(user, body, key) {
  assert(/^[a-zA-Z0-9-]{16,80}$/.test(key || ''), 400, 'A checkout idempotency key is required.');
  return transaction(async (session) => {
    // LOCK 1 (was `SELECT id FROM users WHERE id=$1 FOR UPDATE`).
    // Writing to the customer's own document takes a document-level lock for
    // the life of the transaction, so two simultaneous checkouts for one
    // customer serialise: the second hits a write conflict and withTransaction
    // retries it, by which point the first order exists and the
    // checkout_key branch below returns it.
    await users().updateOne({_id: user.id}, {$set: {last_checkout_at: new Date()}}, {session});

    const fingerprint = hash(JSON.stringify(body));
    const existing = await orders().findOne({user_id: user.id, checkout_key: key}, {session});
    if (existing) {
      assert(existing.request_hash === fingerprint, 409, 'Checkout details changed. Start a new checkout.');
      return existing;
    }

    const q = await quote(user.id, body.coupon, session);
    assert(q.items.length > 0, 400, 'Your bag is empty.');
    assert(q.items.length <= 50, 400, 'A maximum of 50 items is supported.');

    for (const item of q.items) {
      assert(item.published, 409, `${item.name} is no longer available.`);
      assert(!(config.production && item.is_demo), 409, 'Development catalogue products cannot be purchased in production.');
      // LOCK 2 (was `UPDATE variants SET reserved=reserved+$1 WHERE id=$2 AND
      // stock-reserved>=$1 RETURNING id`). The $expr filter is the oversell
      // guard: the increment applies only while enough stock is unreserved,
      // and no document matching means no stock, not a silent zero.
      const reserved = await variants().findOneAndUpdate(
        {_id: item.variant_id, $expr: {$gte: [{$subtract: ['$stock', '$reserved']}, item.quantity]}},
        {$inc: {reserved: item.quantity}},
        {session},
      );
      assert(reserved, 409, `${item.name} does not have enough stock.`);
    }

    let walletApplied = 0;
    let walletCoins = 0;
    if (body.useWallet) {
      const offer = await walletOfferFor(user.id, q.total, session);
      assert(offer.allowed, 409, offer.reason ?? 'Wallet coins cannot be used on this order.');
      walletApplied = offer.inr;
      walletCoins = offer.coins;
    }

    const orderId = id();
    const number = await nextSequence('orders', session);
    const order = {
      _id: orderId,
      id: orderId,
      number,
      user_id: user.id,
      checkout_key: key,
      request_hash: fingerprint,
      status: 'pending',
      payment_status: 'pending',
      currency: q.currency,
      subtotal: q.subtotal,
      discount: q.discount,
      tax: q.tax,
      tax_bps: q.tax_bps ?? 0,
      shipping: q.shipping,
      total: q.total,
      wallet_applied: walletApplied,
      wallet_coins: walletCoins,
      address: body.address,
      email: user.email,
      expires_at: new Date(Date.now() + 30 * 60000),
      reserved: true,
      created_at: new Date(),
    };
    await orders().insertOne(order, {session});

    const lines = q.items.map((i) => {
      const lineId = id();
      return {
        _id: lineId, id: lineId, order_id: orderId, variant_id: i.variant_id,
        name: i.name, sku: i.sku, size: i.size, color: i.color,
        image: i.images?.[0] ?? null, unit_price: i.price, quantity: i.quantity,
      };
    });
    await orderItems().insertMany(lines, {session});

    // Held inside the same transaction as the order, so an order can never
    // exist with a redemption recorded on it and no matching hold.
    if (walletCoins > 0) {
      await wallet.reserve(session, {userId: user.id, orderId, coins: walletCoins, idempotencyKey: `checkout:${orderId}`});
    }
    return order;
  });
}

/** What the gateway must collect: the order's value less anything coins paid. */
export const payableOf = (order) => order.total - (order.wallet_applied ?? 0);

export async function paymentOrder(orderId) {
  const p = await transaction(async (session) => {
    // LOCK 3 (was the order `FOR UPDATE`). The state is re-read inside the
    // transaction and the unique index on payments.order_id is what actually
    // prevents two payment documents for one order.
    const o = await orders().findOne({_id: orderId}, {session});
    assert(o && o.status === 'pending' && o.payment_status === 'pending' && new Date(o.expires_at) > new Date(),
      409, 'This order cannot accept a payment.');
    assert(payableOf(o) > 0, 409, 'This order is paid in full with wallet coins and needs no card payment.');

    const row = await payments().findOne({order_id: orderId}, {session});
    if (row) {
      assert(row.gateway_order_id, 409, 'Payment setup is awaiting provider reconciliation. Your order is saved in your account.');
      return {...row, existing: true};
    }
    const paymentId = id();
    const created = {
      _id: paymentId, id: paymentId, order_id: orderId,
      gateway_order_id: null, gateway_payment_id: null,
      status: 'creating', amount: payableOf(o), currency: o.currency,
      method: null, authorized_at: null, captured_at: null, refunded_amount: 0,
      created_at: new Date(),
    };
    await payments().insertOne(created, {session});
    return created;
  });
  if (p.existing) return p;

  // Outside the transaction, deliberately: withTransaction retries on
  // transient errors and a retry would create a second Razorpay order.
  try {
    const remote = await razorpay('/orders', {
      amount: p.amount, currency: p.currency, receipt: orderId,
      notes: {store_order_id: orderId}, partial_payment: false,
    });
    assert(remote.id && remote.amount === p.amount && remote.currency === p.currency, 502, 'Payment order response did not match.');
    return payments().findOneAndUpdate(
      {_id: p._id},
      {$set: {gateway_order_id: remote.id, status: 'pending'}},
      {returnDocument: 'after'},
    );
  } catch (e) {
    await payments().updateOne({_id: p._id}, {$set: {status: 'reconciliation_required'}});
    throw e;
  }
}

export async function acceptCapturedPayment(payment) {
  assert(payment.status === 'captured' && payment.captured === true, 409, 'Payment is not captured yet.');
  return transaction(async (session) => {
    const p = await payments().findOne({gateway_order_id: payment.order_id}, {session});
    assert(p, 409, 'Payment order has not been reconciled yet.');
    const o = await orders().findOne({_id: p.order_id}, {session});

    // Compared against the PAYABLE amount: when coins paid part of the order
    // the gateway was only ever asked for the remainder.
    assert(payment.amount === payableOf(o) && payment.currency === o.currency, 400,
      'Payment amount or currency does not match the order.');

    // Recorded before the early return, so a redelivered capture still leaves
    // an accurate attempt history.
    await recordAttempt(payment, o._id, session);

    // LOCK 4 (was the payment `FOR UPDATE` plus a read-then-write of
    // gateway_payment_id). Claimed with a conditional update instead: only the
    // first caller matches `gateway_payment_id: null`, so a webhook racing the
    // browser callback cannot both fulfil. A null result means someone else
    // claimed it, and the assert then proves it was the same payment.
    const claimed = await payments().findOneAndUpdate(
      {_id: p._id, gateway_payment_id: null},
      {$set: {gateway_payment_id: payment.id, status: 'captured', method: payment.method ?? null, captured_at: new Date()}},
      {returnDocument: 'after', session},
    );
    if (!claimed) {
      const current = await payments().findOne({_id: p._id}, {session});
      assert(current.gateway_payment_id === payment.id, 409, 'A different payment is already attached.');
      return o;
    }

    if (o.status !== 'pending' || !o.reserved) {
      await orders().updateOne({_id: o._id}, {$set: {payment_status: 'paid', status: 'review'}}, {session});
      await enqueue('refund', `refund:${o._id}`, {orderId: o._id, reason: 'Payment captured after order cancellation or reservation expiry.'}, session);
      // A capture that arrived after the reservation lapsed is money taken for
      // an order that will not ship. An operator needs to know now.
      await queueAdminEmail(`review:${o._id}`, `Payment needs attention — order #${o.number}`,
        {template: 'admin_payment_attention', orderId: o._id, data: {detail: 'Payment captured after the order was cancelled or its reservation expired. A refund has been queued automatically and the order will not ship.'}}, session);
      return {...o, status: 'review', payment_status: 'paid'};
    }

    const items = await orderItems().find({order_id: o._id}, {session}).sort({variant_id: 1}).toArray();
    for (const i of items) {
      await variants().updateOne({_id: i.variant_id}, {$inc: {reserved: -i.quantity, stock: -i.quantity}}, {session});
    }
    // The coins are spent here and nowhere else: inside the transaction that
    // records a capture verified against the gateway.
    await wallet.consumeReservation(session, {orderId: o._id});
    await orders().updateOne({_id: o._id}, {$set: {payment_status: 'paid', status: 'confirmed', reserved: false}}, {session});

    // Remove purchased quantities without deleting items added after checkout.
    for (const i of items) {
      await cartItems().deleteOne({user_id: o.user_id, variant_id: i.variant_id, quantity: {$lte: i.quantity}}, {session});
      await cartItems().updateOne({user_id: o.user_id, variant_id: i.variant_id, quantity: {$gt: i.quantity}}, {$inc: {quantity: -i.quantity}}, {session});
    }

    await enqueue('invoice', `invoice:${o._id}`, {orderId: o._id}, session);
    // Queued here and only here, inside the transaction that records a capture
    // verified against Razorpay — never from a browser callback.
    await queueEmail(`paid:${o._id}`, o.email, `Order confirmed — #${o.number}`, {template: 'paid', orderId: o._id, userId: o.user_id}, session);
    await queueAdminEmail(`order:${o._id}`, `New paid order #${o.number}`, {template: 'admin_order', orderId: o._id}, session);
    if (process.env.AUTO_FULFILL === 'true') await enqueue('shipment', `shipment:${o._id}`, {orderId: o._id}, session);
    return {...o, status: 'confirmed', payment_status: 'paid'};
  });
}

/**
 * Settles an order that coins paid for in full.
 *
 * The wallet equivalent of acceptCapturedPayment, mirroring it step for step.
 * Razorpay is not involved and no payment document is created, because there
 * was nothing to collect.
 */
export async function completeWalletOrder(orderId) {
  return transaction(async (session) => {
    const o = await orders().findOne({_id: orderId}, {session});
    assert(o, 404, 'Order not found.');
    assert(payableOf(o) === 0, 409, 'This order still has an amount to collect and cannot be settled from the wallet alone.');
    if (o.payment_status === 'paid') return o;
    assert(o.status === 'pending' && o.payment_status === 'pending', 409, 'This order cannot be settled.');
    assert(new Date(o.expires_at) > new Date(), 409, 'This checkout has expired. Start a new one.');

    // LOCK 5. consumeReservation claims the hold with a conditional update, so
    // two concurrent settlements cannot both spend it; the loser gets null.
    const spent = await wallet.consumeReservation(session, {orderId});
    assert(spent, 409, 'The wallet coins for this order are no longer held. Start a new checkout.');

    const items = await orderItems().find({order_id: orderId}, {session}).sort({variant_id: 1}).toArray();
    for (const i of items) {
      await variants().updateOne({_id: i.variant_id}, {$inc: {reserved: -i.quantity, stock: -i.quantity}}, {session});
    }
    await orders().updateOne({_id: orderId}, {$set: {payment_status: 'paid', status: 'confirmed', reserved: false}}, {session});
    for (const i of items) {
      await cartItems().deleteOne({user_id: o.user_id, variant_id: i.variant_id, quantity: {$lte: i.quantity}}, {session});
      await cartItems().updateOne({user_id: o.user_id, variant_id: i.variant_id, quantity: {$gt: i.quantity}}, {$inc: {quantity: -i.quantity}}, {session});
    }

    await enqueue('invoice', `invoice:${orderId}`, {orderId}, session);
    await queueEmail(`paid:${orderId}`, o.email, `Order confirmed — #${o.number}`, {template: 'paid', orderId, userId: o.user_id}, session);
    await queueAdminEmail(`order:${orderId}`, `New paid order #${o.number}`, {template: 'admin_order', orderId}, session);
    if (process.env.AUTO_FULFILL === 'true') await enqueue('shipment', `shipment:${orderId}`, {orderId}, session);
    return {...o, status: 'confirmed', payment_status: 'paid'};
  });
}

export async function releaseOrder(orderId, client = undefined) {
  const options = withSession(client);
  const o = await orders().findOne({_id: orderId}, options);
  assert(o, 404, 'Order not found.');

  // LOCK 6 (was the order `FOR UPDATE` followed by a status check). Claimed
  // with a conditional update: only one caller can move a pending order to
  // cancelled, so the stock below is released exactly once however many
  // expiry sweeps and customer cancellations arrive together.
  const claimed = await orders().findOneAndUpdate(
    {_id: orderId, status: 'pending', payment_status: 'pending'},
    {$set: {status: 'cancelled', reserved: false}},
    {returnDocument: 'before', ...options},
  );
  if (!claimed) return false;

  if (claimed.reserved) {
    const items = await orderItems().find({order_id: orderId}, options).sort({variant_id: 1}).toArray();
    for (const i of items) {
      await variants().updateOne({_id: i.variant_id}, {$inc: {reserved: -i.quantity}}, options);
    }
  }
  // The held coins go back to being spendable. No ledger entry, because they
  // were never spent.
  await wallet.releaseReservation(client, {orderId});

  await queueEmail(`cancelled:${orderId}`, o.email, `Order #${o.number} cancelled`, {template: 'cancelled', orderId, userId: o.user_id}, client);
  await queueAdminEmail(`cancelled:${orderId}`, `Order #${o.number} cancelled`, {template: 'admin_cancelled', orderId}, client);
  return true;
}

export async function orderDetails(orderId) {
  const order = await orders().findOne({_id: orderId});
  if (!order) return null;
  const [items, payment, shipment, invoice, refundRows] = await Promise.all([
    orderItems().find({order_id: orderId}).toArray(),
    payments().findOne({order_id: orderId}),
    shipments().findOne({order_id: orderId}),
    invoices().findOne({order_id: orderId, status: 'issued'}, {projection: {_id: 1, id: 1, number: 1}}),
    refunds().find({order_id: orderId}).sort({created_at: -1}).toArray(),
  ]);
  const events = shipment
    ? await shippingEvents().find({shipment_id: shipment._id}, {projection: {status: 1, details: 1, created_at: 1, _id: 0}}).sort({created_at: -1}).toArray()
    : [];
  // `refund` is the most recent one, kept so existing callers keep working now
  // that an order can carry several partial refunds.
  return {...order, items, payment, shipment, invoice, refunds: refundRows, refund: refundRows[0] ?? null, events};
}
