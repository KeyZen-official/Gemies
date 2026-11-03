import {payments, paymentAttempts, orders, transaction, withSession} from './mongo.mjs';
import {id} from './security.mjs';
import {queueEmail} from './queue.mjs';

/**
 * Payment attempt history and the non-fulfilling payment states.
 *
 * Capture is handled by `acceptCapturedPayment` in commerce.mjs and nowhere
 * else. Everything here deliberately stops short of fulfilment: an authorised
 * or failed payment records what happened and changes nothing about the order.
 *
 * One Razorpay Order is reused across retries, so a customer who fails and
 * tries again produces several payment attempts against the same
 * `gateway_order_id`. Each is recorded rather than overwriting the last.
 */

// A captured payment is the authoritative outcome. Once an attempt is captured,
// no later event may move it to any other state: webhooks can arrive out of
// order, and a payment.failed for an earlier attempt must not undo a capture.
const TERMINAL = 'captured';

/**
 * Records or updates one payment attempt.
 *
 * Keyed on the Razorpay payment id, which is uniquely indexed, so a
 * redelivered webhook or a concurrent verify request updates the existing
 * document instead of inserting a duplicate.
 *
 * The SQL was one `ON CONFLICT ... DO UPDATE` carrying a CASE that refused to
 * move a captured attempt backwards. That becomes an insert-if-missing
 * followed by a pipeline update: the pipeline can express the CASE, and the
 * unique index resolves the race if two callers insert at once. Both halves
 * are idempotent, so running it twice is the same as running it once.
 */
export async function recordAttempt(payment, orderId, client = undefined) {
  const options = withSession(client);
  const gatewayOrderId = payment.order_id ?? '';
  const status = String(payment.status ?? 'created');
  const now = new Date();

  const existing = await paymentAttempts().findOne({gateway_payment_id: payment.id}, options);
  if (!existing) {
    const attemptId = id();
    try {
      await paymentAttempts().insertOne({
        _id: attemptId,
        id: attemptId,
        order_id: orderId,
        gateway_order_id: gatewayOrderId,
        gateway_payment_id: payment.id,
        status,
        method: payment.method ?? null,
        amount: Number(payment.amount ?? 0),
        error_code: payment.error_code ?? null,
        error_description: payment.error_description ?? null,
        created_at: now,
        updated_at: now,
      }, options);
      return paymentAttempts().findOne({gateway_payment_id: payment.id}, options);
    } catch (error) {
      // 11000 means another caller inserted it first; fall through and update.
      if (error?.code !== 11000) throw error;
    }
  }

  const row = await paymentAttempts().findOneAndUpdate(
    {gateway_payment_id: payment.id},
    [{$set: {
      // A captured attempt keeps its status whatever arrives later.
      status: {$cond: [{$eq: ['$status', TERMINAL]}, '$status', status]},
      method: {$ifNull: [payment.method ?? null, '$method']},
      error_code: {$ifNull: [payment.error_code ?? null, '$error_code']},
      error_description: {$ifNull: [payment.error_description ?? null, '$error_description']},
      updated_at: now,
    }}],
    {returnDocument: 'after', ...options},
  );
  return row;
}

/** Resolves the payment behind a Razorpay order id, or null. */
export async function orderForGatewayOrder(gatewayOrderId, client = undefined) {
  if (!gatewayOrderId) return null;
  return payments().findOne({gateway_order_id: gatewayOrderId}, withSession(client));
}

/**
 * An authorised, not yet captured payment.
 *
 * Recorded and nothing more. The order stays pending and no stock is consumed,
 * because an authorisation can still be dropped or fail to capture. Fulfilment
 * waits for the capture event or for the payment_sync reconciliation job.
 */
export async function markAuthorized(payment) {
  return transaction(async (session) => {
    const p = await orderForGatewayOrder(payment.order_id, session);
    if (!p) return {recorded: false, reason: 'unreconciled'};
    await recordAttempt(payment, p.order_id, session);
    // The filter is the guard that replaces the SQL WHERE clause: a captured
    // payment, or one that already has a gateway payment id, is not touched.
    await payments().updateOne(
      {_id: p._id, status: {$ne: 'captured'}, gateway_payment_id: null},
      [{$set: {
        status: 'authorized',
        method: {$ifNull: [payment.method ?? null, '$method']},
        authorized_at: {$ifNull: ['$authorized_at', new Date()]},
      }}],
      {session},
    );
    return {recorded: true, orderId: p.order_id};
  });
}

/**
 * A failed payment.
 *
 * The order is left alone: a failed attempt is not a cancelled order, and the
 * customer may retry against the same Razorpay Order. The reservation keeps
 * running until it expires, which is what makes a retry possible at all.
 */
export async function markFailed(payment) {
  return transaction(async (session) => {
    const p = await orderForGatewayOrder(payment.order_id, session);
    if (!p) return {recorded: false, reason: 'unreconciled'};
    if (payment.id) await recordAttempt(payment, p.order_id, session);

    const updated = await payments().updateOne(
      {_id: p._id, status: {$ne: 'captured'}, gateway_payment_id: null},
      {$set: {status: 'failed'}},
      {session},
    );

    // Tell the customer only when this actually moved the payment to failed.
    // The filter above is what makes a late payment.failed for a superseded
    // attempt a no-op, and emailing on a no-op would tell someone whose
    // payment succeeded that it did not.
    //
    // Keyed on the Razorpay payment id, so each distinct failed attempt gets
    // one email and a redelivered webhook gets none.
    if (updated.modifiedCount > 0 && payment.id) {
      const o = await orders().findOne(
        {_id: p.order_id},
        {projection: {_id: 1, id: 1, number: 1, email: 1, user_id: 1}, session},
      );
      if (o) {
        await queueEmail(
          `payment-failed:${payment.id}`, o.email,
          `Payment could not be completed — order #${o.number}`,
          {
            template: 'payment_failed', orderId: o._id, userId: o.user_id,
            // Razorpay's customer-facing description only. Never the internal
            // error code or the raw gateway response.
            data: {reason: typeof payment.error_description === 'string' ? payment.error_description.slice(0, 200) : ''},
          },
          session,
        );
      }
    }
    return {recorded: true, orderId: p.order_id};
  });
}

/** Attempts for one order, newest first, for the admin transaction view. */
export async function attemptsForOrder(orderId) {
  return paymentAttempts()
    .find({order_id: orderId}, {projection: {
      gateway_payment_id: 1, status: 1, method: 1, amount: 1,
      error_code: 1, error_description: 1, created_at: 1, updated_at: 1, _id: 0,
    }})
    .sort({created_at: -1})
    .toArray();
}
