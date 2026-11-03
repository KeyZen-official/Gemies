import {
  orders, orderItems, users, variants, products, refunds, shipments, shippingEvents,
  exchangeRequests, exchangeItems, exchangeStatusHistory, walletTransactions,
  transaction as runTransaction, nextSequence, withSession,
} from './mongo.mjs';
import {id, assert, audit} from './security.mjs';
import {queueEmail, queueAdminEmail} from './queue.mjs';
import * as wallet from './wallet.mjs';

/**
 * Exchange requests, and the coins they eventually credit.
 *
 * GEMIES does not return money. An exchange returns an item and credits store
 * coins, so nothing in this module writes to `refunds`, touches
 * `payments.refunded_amount`, or changes `orders.payment_status` -- that is
 * the cash path and it stays separate.
 *
 * The one rule that matters most: coins are credited at exactly one
 * transition, `inspection_passed -> coins_credited`. Submitting a request,
 * approving it, scheduling a pickup and the courier collecting the parcel all
 * credit nothing.
 *
 * On MongoDB, the SQL joins in `eligibility` and `exchangeDetails` are done as
 * explicit follow-up reads rather than as `$lookup` pipelines. Each one is
 * keyed on an indexed field over a handful of documents, and written out it
 * stays legible; a four-stage `$lookup` chain to reproduce one SELECT does
 * not. If an order ever carries hundreds of lines this is worth revisiting.
 */

/* ------------------------------------------------------------ state machine */

/**
 * Permitted transitions. Anything not listed here is refused, so a status can
 * never be set by an admin screen posting an arbitrary string.
 */
export const TRANSITIONS = {
  requested: ['under_review', 'approved', 'rejected', 'cancelled'],
  under_review: ['approved', 'rejected', 'cancelled'],
  approved: ['pickup_scheduled', 'cancelled'],
  pickup_scheduled: ['picked_up', 'cancelled'],
  picked_up: ['received'],
  received: ['inspection_passed', 'inspection_failed'],
  inspection_passed: ['coins_credited'],
  // A failed inspection is not the end: an operator can overturn it after
  // looking again, or close the request. It cannot jump straight to a credit.
  inspection_failed: ['received', 'cancelled'],
  coins_credited: [],
  rejected: [],
  cancelled: [],
};

/** States a customer may move a request to themselves. */
const CUSTOMER_TRANSITIONS = {cancelled: ['requested', 'under_review', 'approved']};

/** Transitions that require a written reason. */
const NEEDS_NOTE = new Set(['rejected', 'inspection_failed']);

/** Requests that still hold the units they asked to return. */
const LIVE_STATUSES = {$nin: ['rejected', 'cancelled']};

export const EXCHANGE_REASONS = ['size_too_small', 'size_too_large', 'damaged', 'wrong_product', 'other'];

/* -------------------------------------------------------- credit calculation */

/**
 * What a returned line is worth, in integer paise.
 *
 * Built from what the customer actually paid, never from the catalogue price:
 * the order's own `unit_price` snapshot is the starting point, and the order's
 * recorded discount and tax are allocated across it in proportion to the
 * line's share of the subtotal.
 *
 * Allocating the *stored* `order.discount` and `order.tax` rather than
 * recomputing them from today's settings is deliberate. The tax rate or a
 * coupon's percentage may have changed since the order was placed; the figures
 * on the order are what the customer was charged, and the sum of the
 * allocations can never exceed them because every share is floored.
 *
 * Shipping is included only when the whole order is coming back and the
 * operator has configured it that way -- crediting the delivery charge on a
 * one-item return out of a five-item order would be crediting it five times.
 */
export function creditForLines({order, items, lines, creditShipping}) {
  const netBase = order.subtotal - order.discount;
  const working = [];
  let eligible = 0;

  for (const line of lines) {
    const item = items.find((i) => i.id === line.order_item_id);
    assert(item, 400, 'That order line is not part of this order.');
    assert(line.quantity >= 1 && line.quantity <= item.quantity, 400,
      `You can return at most ${item.quantity} of ${item.name}.`);

    const gross = item.unit_price * line.quantity;
    // Rounding deliberately favours the store on both halves, because the two
    // pull in opposite directions and the credit must never exceed what was
    // paid. The discount share is CEILED: flooring it removes less discount
    // than the line really carried, and across three lines of an unevenly
    // divided coupon that produced a credit one paise larger than the order
    // total. The tax share is floored for the same reason in reverse.
    const discountShare = order.subtotal > 0
      ? Math.min(gross, Math.ceil((order.discount * gross) / order.subtotal)) : 0;
    const taxable = gross - discountShare;
    const taxShare = netBase > 0 ? Math.floor((order.tax * taxable) / netBase) : 0;
    const lineTotal = taxable + taxShare;

    working.push({
      orderItemId: item.id,
      name: item.name,
      sku: item.sku,
      quantity: line.quantity,
      unitPrice: item.unit_price,
      gross,
      discountShare,
      taxable,
      taxShare,
      eligible: lineTotal,
    });
    eligible += lineTotal;
  }

  // Every unit of every line, and only then is shipping part of the return.
  const wholeOrder = items.every((item) => {
    const line = lines.find((l) => l.order_item_id === item.id);
    return line && line.quantity === item.quantity;
  });
  const shipping = creditShipping && wholeOrder ? order.shipping : 0;
  eligible += shipping;

  // A final backstop. The per-line rounding above is chosen so this can never
  // bite, but an order's total is the most it can ever give back and that is
  // worth asserting rather than trusting.
  const capped = Math.min(eligible, order.total);

  return {
    lines: working,
    shipping,
    wholeOrder,
    subtotalEligible: capped - shipping,
    eligible: capped,
    cappedByOrderTotal: capped < eligible,
    basis: {
      orderSubtotal: order.subtotal,
      orderDiscount: order.discount,
      orderTax: order.tax,
      orderShipping: order.shipping,
      orderTotal: order.total,
    },
  };
}

/**
 * The eligible credit for a request, capped by what the order can still give
 * back.
 *
 * An order cannot return more value than the customer paid for it. Cash
 * already refunded through Razorpay and coins already credited by an earlier
 * exchange both reduce what is left, so a customer cannot be made whole twice
 * by combining the two paths.
 *
 * Both `COALESCE(sum(...),0)` aggregates are summed in JavaScript. An order
 * has a handful of refunds and exchange credits at most, and reading the
 * documents lets a transaction see its own writes without an aggregation
 * pipeline.
 */
export async function computeCredit(exchangeId, client = undefined) {
  const options = withSession(client);
  const request = await exchangeRequests().findOne({_id: exchangeId}, options);
  assert(request, 404, 'Exchange request not found.');
  const order = await orders().findOne({_id: request.order_id}, options);
  const items = await orderItems().find({order_id: request.order_id}, options).toArray();
  const lines = await exchangeItems().find({exchange_id: exchangeId}, options).toArray();
  const settings = await wallet.walletSettings(client);

  const raw = creditForLines({order, items, lines, creditShipping: settings.exchangeCreditShipping});

  const refundRows = await refunds()
    .find({order_id: request.order_id, status: {$ne: 'failed'}}, options).toArray();
  const alreadyRefunded = refundRows.reduce((sum, r) => sum + r.amount, 0);

  const creditRows = await walletTransactions()
    .find({order_id: request.order_id, kind: 'exchange_credit', exchange_id: {$ne: exchangeId}}, options)
    .toArray();
  const alreadyCredited = creditRows.reduce((sum, t) => sum + t.inr_value, 0);

  const headroom = Math.max(0, order.total - alreadyRefunded - alreadyCredited);
  const eligibleInr = Math.min(raw.eligible, headroom);
  const coins = wallet.paiseToCoins(eligibleInr, settings.paisePerCoin);

  return {
    eligibleInr,
    coins,
    // The remainder that floors away when the eligible paise do not divide
    // evenly by the coin rate. Reported, not silently dropped.
    remainderPaise: eligibleInr - wallet.coinsToPaise(coins, settings.paisePerCoin),
    calculation: {
      ...raw,
      alreadyRefunded,
      alreadyCredited,
      headroom,
      cappedByHeadroom: raw.eligible > headroom,
      paisePerCoin: settings.paisePerCoin,
      computedAt: new Date().toISOString(),
    },
  };
}

/* --------------------------------------------------------------- eligibility */

/**
 * Whether an order may be exchanged at all.
 *
 * The window is configured, never assumed: with `exchange_window_days` at its
 * default of zero, nothing is eligible. Delivery date is used when the courier
 * has reported one, because a return window runs from when the customer
 * received the parcel, not from when they paid.
 */
export async function eligibility(orderId, userId, client = undefined) {
  const options = withSession(client);
  const settings = await wallet.walletSettings(client);
  const no = (reason) => ({eligible: false, reason, windowDays: settings.exchangeWindowDays});

  if (!settings.exchangeEnabled) return no('Exchanges are not currently available.');
  if (settings.exchangeWindowDays <= 0) return no('No exchange window is configured.');

  const order = await orders().findOne({_id: orderId, user_id: userId}, options);
  if (!order) return no('Order not found.');
  if (order.payment_status !== 'paid') return no('Only paid orders can be exchanged.');
  if (!['confirmed', 'processing', 'shipped', 'delivered'].includes(order.status)) {
    return no(`An order that is ${order.status} cannot be exchanged.`);
  }

  // From delivery where known, otherwise from the order date. The SQL joined
  // shipping_events to shipments and took max(created_at) where the status
  // matched ILIKE '%deliver%'; here the shipment is resolved first and the
  // newest matching event read with a case-insensitive regex.
  const shipment = await shipments().findOne({order_id: orderId}, {projection: {_id: 1}, ...options});
  const delivered = shipment
    ? await shippingEvents().findOne(
      {shipment_id: shipment._id, status: {$regex: 'deliver', $options: 'i'}},
      {projection: {created_at: 1}, sort: {created_at: -1}, ...options},
    )
    : null;
  const from = delivered?.created_at ? new Date(delivered.created_at) : new Date(order.created_at);
  const closes = new Date(from.getTime() + settings.exchangeWindowDays * 86400000);
  if (Date.now() > closes.getTime()) {
    return no(`The ${settings.exchangeWindowDays}-day exchange window closed on ${closes.toISOString().slice(0, 10)}.`);
  }

  // Units already committed to another live request cannot be sent back twice.
  // `product_slug` comes along so the customer form can offer the sizes that
  // are actually in stock as a replacement.
  const lines = await orderItems().find({order_id: orderId}, options).toArray();
  const variantRows = await variants()
    .find({_id: {$in: lines.map((l) => l.variant_id)}}, {projection: {product_id: 1}, ...options}).toArray();
  const productRows = await products()
    .find({_id: {$in: variantRows.map((v) => v.product_id)}}, {projection: {slug: 1}, ...options}).toArray();
  const productOf = new Map(variantRows.map((v) => [v._id, productRows.find((p) => p._id === v.product_id)?.slug ?? null]));
  const items = lines.map((line) => ({...line, product_slug: productOf.get(line.variant_id) ?? null}));

  // GROUP BY order_item_id over the live requests for this order.
  const liveIds = await exchangeRequests()
    .distinct('_id', {order_id: orderId, status: LIVE_STATUSES}, options);
  const committedRows = liveIds.length
    ? await exchangeItems().find({exchange_id: {$in: liveIds}}, options).toArray()
    : [];
  const committed = new Map();
  for (const row of committedRows) {
    committed.set(row.order_item_id, (committed.get(row.order_item_id) ?? 0) + row.quantity);
  }
  const available = items
    .map((item) => ({...item, returnable: item.quantity - (committed.get(item.id) ?? 0)}))
    .filter((item) => item.returnable > 0);

  if (!available.length) return no('Every item on this order is already part of an exchange.');

  return {
    eligible: true,
    reason: null,
    windowDays: settings.exchangeWindowDays,
    closesAt: closes.toISOString(),
    items: available,
    reasons: EXCHANGE_REASONS,
  };
}

/* ------------------------------------------------------------------ creation */

export async function createExchange(user, orderId, body) {
  // The route's schema already requires at least one line. Asserted here too
  // because insertMany throws on an empty array, and a 500 would be the wrong
  // answer to an empty request.
  assert(body.items?.length, 400, 'An exchange must include at least one item.');
  return runTransaction(async (session) => {
    const check = await eligibility(orderId, user.id, session);
    assert(check.eligible, 409, check.reason);

    for (const line of body.items) {
      const offered = check.items.find((i) => i.id === line.order_item_id);
      assert(offered, 409, 'That item is not available to exchange on this order.');
      assert(line.quantity <= offered.returnable, 409,
        `Only ${offered.returnable} of ${offered.name} can still be exchanged.`);
    }

    const exchangeId = id();
    const now = new Date();
    // `number BIGINT GENERATED ALWAYS AS IDENTITY` becomes the shared counters
    // collection, the same mechanism orders.number uses.
    const number = await nextSequence('exchange_requests', session);
    await exchangeRequests().insertOne({
      _id: exchangeId,
      id: exchangeId,
      number,
      order_id: orderId,
      user_id: user.id,
      status: 'requested',
      reason: body.reason,
      reason_note: body.note ?? '',
      images: body.images ?? [],
      eligible_coins: null,
      eligible_inr: null,
      calculation: null,
      decision_note: '',
      credited_transaction_id: null,
      created_at: now,
      updated_at: now,
    }, {session});

    await exchangeItems().insertMany(body.items.map((line) => {
      const lineId = id();
      return {
        _id: lineId,
        id: lineId,
        exchange_id: exchangeId,
        order_item_id: line.order_item_id,
        quantity: line.quantity,
        replacement_variant_id: line.replacement_variant_id ?? null,
        eligible_inr: null,
      };
    }), {session});

    await appendHistory(exchangeId, null, 'requested', user.id, 'Requested by the customer', session);

    // Computed now so the customer is shown a real figure, and recomputed at
    // the credit step so a later refund cannot be double-counted.
    const credit = await computeCredit(exchangeId, session);
    await exchangeRequests().updateOne(
      {_id: exchangeId},
      {$set: {eligible_coins: credit.coins, eligible_inr: credit.eligibleInr, calculation: credit.calculation}},
      {session},
    );
    for (const line of credit.calculation.lines) {
      await exchangeItems().updateOne(
        {exchange_id: exchangeId, order_item_id: line.orderItemId},
        {$set: {eligible_inr: line.eligible}},
        {session},
      );
    }

    const order = await orders().findOne({_id: orderId}, {projection: {number: 1, email: 1}, session});
    await queueEmail(`exchange-requested:${exchangeId}`, order.email,
      `Exchange request received — order #${order.number}`,
      {template: 'exchange_requested', orderId, userId: user.id, data: {exchangeId}}, session);
    await queueAdminEmail(`exchange-requested:${exchangeId}`,
      `Exchange requested — order #${order.number}`,
      {template: 'admin_error', data: {area: 'Exchange', reference: `Order #${order.number}`,
        detail: 'A customer has requested an exchange. Review it under Exchanges in the admin panel.'}}, session);

    return {id: exchangeId, ...credit};
  });
}

/** One row in the audit trail of a request's states. */
async function appendHistory(exchangeId, from, to, actorId, note, session) {
  const historyId = id();
  await exchangeStatusHistory().insertOne({
    _id: historyId,
    id: historyId,
    exchange_id: exchangeId,
    from_status: from,
    to_status: to,
    actor_id: actorId ?? null,
    note,
    created_at: new Date(),
  }, {session});
}

/* ---------------------------------------------------------------- transitions */

/**
 * Moves a request to `next`, and credits coins if and only if that move is
 * `inspection_passed -> coins_credited`.
 *
 * The whole transition runs in one database transaction, so a request can
 * never be marked credited without the ledger row existing, and the ledger row
 * can never exist without the request being marked.
 */
export async function transition(exchangeId, next, {actor, note = '', isCustomer = false}) {
  return runTransaction(async (session) => {
    const request = await exchangeRequests().findOne({_id: exchangeId}, {session});
    assert(request, 404, 'Exchange request not found.');

    if (isCustomer) {
      assert(request.user_id === actor.id, 404, 'Exchange request not found.');
      assert((CUSTOMER_TRANSITIONS[next] ?? []).includes(request.status), 409,
        `You cannot ${next === 'cancelled' ? 'cancel' : next} this request now.`);
    }

    const allowed = TRANSITIONS[request.status] ?? [];
    assert(allowed.includes(next), 409,
      `An exchange that is ${request.status.replace(/_/g, ' ')} cannot move to ${next.replace(/_/g, ' ')}.`);
    if (NEEDS_NOTE.has(next)) {
      assert(note.trim().length >= 5, 400, 'A reason of at least 5 characters is required.');
    }

    // LOCK 12 (was `SELECT * FROM exchange_requests WHERE id=$1 FOR UPDATE`).
    // The status move is claimed with a conditional update carrying the status
    // this call validated against, so of two concurrent transitions only one
    // can apply; the loser sees the request has moved on. Everything below
    // runs in the same transaction, so if the credit is refused the status
    // change rolls back with it.
    const claimed = await exchangeRequests().findOneAndUpdate(
      {_id: exchangeId, status: request.status},
      {$set: {status: next, decision_note: note.trim(), updated_at: new Date()}},
      {returnDocument: 'after', session},
    );
    assert(claimed, 409, 'This exchange request has already moved on. Reload and try again.');

    let walletEntry = null;
    if (next === 'coins_credited') {
      // Recomputed here, not trusted from the row: a cash refund may have been
      // issued against the order since the request was raised.
      const credit = await computeCredit(exchangeId, session);
      assert(credit.coins > 0, 409,
        credit.calculation.cappedByHeadroom
          ? 'This order has already been refunded or credited in full, so there is nothing left to credit.'
          : 'The eligible amount is too small to convert into any coins.');

      const order = await orders().findOne({_id: request.order_id}, {projection: {number: 1}, session});
      walletEntry = await wallet.post(session, {
        userId: request.user_id,
        kind: 'exchange_credit',
        coins: credit.coins,
        orderId: request.order_id,
        exchangeId,
        actorId: actor.id,
        // The exchange id, so a double-clicked approval is one credit. The
        // partial unique index on (exchange_id) WHERE kind='exchange_credit'
        // is the second, independent guarantee.
        idempotencyKey: `exchange:${exchangeId}`,
        description: `Exchange credit for order #${order.number}`,
      });
      await exchangeRequests().updateOne(
        {_id: exchangeId},
        {$set: {
          eligible_coins: credit.coins,
          eligible_inr: credit.eligibleInr,
          calculation: credit.calculation,
          credited_transaction_id: walletEntry.id,
        }},
        {session},
      );
    }

    await appendHistory(exchangeId, request.status, next, actor.id, note.trim(), session);
    if (!isCustomer) await audit(actor.id, `exchange.${next}`, exchangeId, session);

    const order = await orders().findOne({_id: request.order_id}, {projection: {number: 1, email: 1}, session});
    // One email per genuine state change the customer cares about.
    if (['approved', 'rejected', 'coins_credited', 'inspection_failed'].includes(next)) {
      await queueEmail(`exchange-${next}:${exchangeId}`, order.email,
        `Exchange ${next.replace(/_/g, ' ')} — order #${order.number}`,
        {template: 'exchange_update', orderId: request.order_id, userId: request.user_id,
          data: {exchangeId, status: next, note: note.trim(), coins: walletEntry?.coins ?? null}}, session);
    }

    return {status: next, transaction: walletEntry};
  });
}

/* --------------------------------------------------------------------- reads */

/** One request with its lines and its full history. */
export async function exchangeDetails(exchangeId, client = undefined) {
  const options = withSession(client);
  const request = await exchangeRequests().findOne({_id: exchangeId}, options);
  if (!request) return null;

  const [order, customer, lines, history] = await Promise.all([
    orders().findOne({_id: request.order_id}, {projection: {number: 1}, ...options}),
    users().findOne({_id: request.user_id}, {projection: {name: 1, email: 1}, ...options}),
    exchangeItems().find({exchange_id: exchangeId}, options).toArray(),
    exchangeStatusHistory().find({exchange_id: exchangeId}, options).sort({created_at: 1}).toArray(),
  ]);

  // The SQL joined order_items for the line snapshot and LEFT JOINed variants
  // for the requested replacement. Both are resolved here by id.
  const [orderItemRows, replacementRows, actorRows] = await Promise.all([
    orderItems().find({_id: {$in: lines.map((l) => l.order_item_id)}}, options).toArray(),
    variants().find(
      {_id: {$in: lines.map((l) => l.replacement_variant_id).filter(Boolean)}},
      {projection: {size: 1, color: 1, sku: 1}, ...options},
    ).toArray(),
    users().find(
      {_id: {$in: [...new Set(history.map((h) => h.actor_id).filter(Boolean))]}},
      {projection: {email: 1}, ...options},
    ).toArray(),
  ]);

  const items = lines.map((line) => {
    const oi = orderItemRows.find((r) => r._id === line.order_item_id);
    const replacement = replacementRows.find((r) => r._id === line.replacement_variant_id);
    return {
      ...line,
      name: oi?.name ?? null,
      sku: oi?.sku ?? null,
      size: oi?.size ?? null,
      color: oi?.color ?? null,
      image: oi?.image ?? null,
      unit_price: oi?.unit_price ?? null,
      ordered_quantity: oi?.quantity ?? null,
      replacement_size: replacement?.size ?? null,
      replacement_color: replacement?.color ?? null,
      replacement_sku: replacement?.sku ?? null,
    };
  });

  return {
    ...request,
    order_number: order?.number ?? null,
    customer_name: customer?.name ?? null,
    customer_email: customer?.email ?? null,
    items,
    history: history.map((h) => ({...h, actor_email: actorRows.find((u) => u._id === h.actor_id)?.email ?? null})),
    nextStates: TRANSITIONS[request.status] ?? [],
  };
}
