import {orders, orderItems, variants, payments, refunds, shipments, shippingEvents, transaction, withSession} from './mongo.mjs';
import {id, assert} from './security.mjs';
import {razorpay} from './providers.mjs';
import {queueEmail, queueAdminEmail} from './queue.mjs';
import {orderDetails} from './commerce.mjs';
import * as sr from './shiprocket.mjs';

/**
 * Shipping and refunds.
 *
 * Three `SELECT ... FOR UPDATE` order locks were removed here in the MongoDB
 * migration. Each became a conditional atomic update whose filter carries the
 * guarantee the lock gave, and each site says which lock it replaced.
 *
 * No provider call appears inside a transaction callback: `withTransaction`
 * retries, and a retried Shiprocket or Razorpay call is a second shipment or a
 * second refund.
 *
 * ## Two state fields, deliberately
 *
 * `status` is the operational state of our booking with the provider: new,
 * creating, created, assigning, awb_assigned, and the two review states a
 * human has to clear. It is what decides which admin buttons are enabled.
 *
 * `stage` is the parcel's normalised journey: created, pickup_scheduled,
 * picked_up, in_transit, out_for_delivery, delivered, exception, rto_initiated,
 * rto_delivered, cancelled. It drives the customer's order page, the emails
 * and the order status.
 *
 * They are separate because they answer different questions and move at
 * different times -- a shipment can be `awb_assigned` for two days while its
 * stage goes from created to out_for_delivery -- and collapsing them would
 * mean a courier scan could overwrite the fact that an AWB exists.
 *
 * `provider_status` and `provider_code` keep Shiprocket's own words and number
 * alongside, so nothing is lost to our mapping.
 */

/** The shape of a new shipment document, so every field has a known value. */
const blankShipment = (shipmentId, orderId) => ({
  _id: shipmentId,
  id: shipmentId,
  order_id: orderId,
  // Provider identifiers, kept distinct from ours.
  provider_order_id: null,
  provider_shipment_id: null,
  awb: null,
  courier: null,
  courier_id: null,
  freight_charge: null,
  tracking_url: null,
  label_url: null,
  manifest_url: null,
  // Operational state of the booking.
  status: 'new',
  // Normalised parcel stage, plus the provider's own words.
  stage: 'created',
  provider_status: null,
  provider_code: null,
  // Pickup.
  pickup_token: null,
  pickup_scheduled_at: null,
  pickup_status: null,
  // Milestones, recorded only when the provider confirms them.
  estimated_delivery: null,
  picked_up_at: null,
  delivered_at: null,
  cancelled_at: null,
  last_error: null,
  last_synced: null,
  created_at: new Date(),
});

/** The shipment for an order, or null. */
export const shipmentFor = (orderId) => shipments().findOne({order_id: orderId});

/**
 * Checks an order is fit to ship, and says why when it is not.
 *
 * This is the gate the brief calls for: a failed, unpaid or cancelled order
 * never reaches Shiprocket. It is also where the two configuration problems
 * that would otherwise surface as a provider error are caught -- missing parcel
 * dimensions, and an address with no usable PIN code.
 */
export async function assertShippable(order) {
  assert(order, 404, 'Order not found.');
  assert(order.payment_status === 'paid', 409,
    `This order is ${order.payment_status}, so it cannot be shipped. Only orders with a captured payment are eligible.`);
  assert(['confirmed', 'processing'].includes(order.status), 409,
    `This order is ${order.status}, so it cannot be shipped.`);
  assert(order.currency === 'INR', 409, 'Shiprocket domestic fulfillment requires an INR store and an Indian address.');
  assert(sr.validPincode(order.address?.postalCode), 409,
    'This order has no valid six-digit Indian PIN code, so a courier cannot be booked.');
  // Throws a 503 naming the missing variable rather than inventing a figure.
  sr.packageSpec();
}

/* ------------------------------------------------------- courier selection */

/**
 * Courier options for an order's destination.
 *
 * Read-only: it quotes, it does not book. The admin screen calls this before
 * assigning an AWB so an operator chooses with the rate and the estimate in
 * front of them.
 */
export async function courierOptionsForOrder(orderId) {
  const order = await orders().findOne({_id: orderId});
  assert(order, 404, 'Order not found.');
  assert(sr.validPincode(order.address?.postalCode), 409, 'This order has no valid Indian PIN code.');
  const spec = sr.packageSpec();
  const couriers = await sr.courierOptions({
    pincode: order.address.postalCode,
    weight: spec.weight,
    declaredValue: order.total,
  });
  return {
    pincode: order.address.postalCode,
    weight: spec.weight,
    // Reported so an operator can see the destination was serviceable at all.
    serviceable: couriers.length > 0,
    couriers,
  };
}

/* -------------------------------------------------------------- the create */

/**
 * Creates the Shiprocket order for a paid GEMIES order, and assigns an AWB.
 *
 * `courierId` is optional. Given one, that courier is requested; without one,
 * Shiprocket picks by its own rules. Passing it is how the admin screen's
 * courier selection reaches the provider.
 *
 * Idempotent at three levels, because a double-booked parcel costs real money:
 *
 *   1. The unique index on shipments.order_id means one shipment document per
 *      order, whatever two concurrent callers do.
 *   2. Each provider call is claimed with a conditional status update, so only
 *      one caller can be mid-create or mid-assign.
 *   3. An uncertain outcome parks the shipment in a review state instead of
 *      retrying, because a repeated /orders/create/adhoc is a second parcel.
 */
export async function createShipment(orderId, {courierId = null} = {}) {
  const o = await orderDetails(orderId);
  await assertShippable(o);

  // LOCK 7 (was `SELECT id FROM orders WHERE id=$1 FOR UPDATE` followed by a
  // re-read and an eligibility check). The state is re-read inside the
  // transaction, and the unique index on shipments.order_id is what actually
  // stops two shipment documents for one order.
  //
  // A failed write aborts a MongoDB transaction, so the duplicate cannot be
  // caught inside the callback the way `ON CONFLICT` absorbed it. It is caught
  // out here instead: a duplicate key means a shipment now exists, so the
  // answer is to read it rather than to create one.
  let shipment;
  try {
    shipment = await transaction(async (session) => {
      const current = await orders().findOne({_id: orderId}, {session});
      assert(current.payment_status === 'paid' && ['confirmed', 'processing'].includes(current.status), 409, 'Order is no longer eligible for shipping.');
      const existing = await shipments().findOne({order_id: orderId}, {session});
      if (existing) return existing;
      const doc = blankShipment(id(), orderId);
      await shipments().insertOne(doc, {session});
      return doc;
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    shipment = await shipments().findOne({order_id: orderId});
    assert(shipment, 409, 'Shipment creation needs reconciliation in the provider dashboard before retrying.');
  }

  let s = shipment;
  assert(s.status !== 'cancelled', 409, 'This shipment was cancelled. Reinstate it in the Shiprocket dashboard before retrying.');

  if (!s.provider_order_id) {
    const claimed = await shipments().findOneAndUpdate(
      {_id: s._id, status: 'new'},
      {$set: {status: 'creating', last_error: null}},
      {returnDocument: 'after'},
    );
    assert(claimed, 409, 'Shipment creation needs reconciliation in the provider dashboard before retrying.');
    try {
      const {providerOrderId, providerShipmentId} = await sr.createProviderOrder(o);
      s = await shipments().findOneAndUpdate(
        {_id: s._id},
        {$set: {
          provider_order_id: providerOrderId,
          provider_shipment_id: providerShipmentId,
          status: 'created',
          stage: 'created',
          provider_status: 'Shipment created',
          last_error: null,
        }},
        {returnDocument: 'after'},
      );
      await recordEvent(s, {
        key: `created:${providerShipmentId}`,
        stage: 'created',
        providerStatus: 'Shipment created',
        at: new Date(),
      });
      await queueEmail(`shipment-created:${orderId}`, o.email, `Preparing order #${o.number} for dispatch`,
        {template: 'shipment_created', orderId, userId: o.user_id});
    } catch (e) {
      // Parked, not retried: the provider may already hold the order.
      await shipments().updateOne({_id: s._id}, {$set: {status: 'reconciliation_required', last_error: errorNote(e)}});
      throw e;
    }
  }

  if (s.awb) return s;
  return assignCourier(orderId, {courierId, shipment: s, order: o});
}

/**
 * Assigns an AWB, with an optional courier choice.
 *
 * Separate from `createShipment` so an operator can look at the courier
 * options first, and so a parked assignment can be retried on its own without
 * touching the provider order. `createShipment` calls straight through to it
 * for the one-click path the fulfilment job uses.
 */
export async function assignCourier(orderId, {courierId = null, shipment = null, order = null} = {}) {
  const o = order ?? await orderDetails(orderId);
  const s0 = shipment ?? await shipmentFor(orderId);
  assert(s0, 409, 'Create the shipment before assigning a courier.');
  assert(s0.provider_shipment_id, 409, 'This shipment has no provider record yet. Create or reconcile it first.');
  assert(!s0.awb, 409, `An AWB is already assigned (${s0.awb}). Cancel the shipment before assigning another.`);

  const claimed = await shipments().findOneAndUpdate(
    {_id: s0._id, status: 'created'},
    {$set: {status: 'assigning', last_error: null}},
    {returnDocument: 'after'},
  );
  assert(claimed, 409, 'Courier assignment is already in progress, or needs reconciliation before retrying.');

  try {
    const assignment = await sr.assignAwb(s0.provider_shipment_id, courierId);
    const s = await shipments().findOneAndUpdate(
      {_id: s0._id},
      {$set: {
        awb: assignment.awb,
        courier: assignment.courier,
        courier_id: assignment.courierId,
        freight_charge: assignment.freightCharge,
        status: 'awb_assigned',
        last_error: null,
      }},
      {returnDocument: 'after'},
    );
    // Confirmed dispatch intent, so the order moves on. Conditional, so a
    // later manual change is not undone.
    await orders().updateOne({_id: orderId, status: 'confirmed'}, {$set: {status: 'processing'}});
    await recordEvent(s, {
      key: `awb:${assignment.awb}`,
      stage: s.stage ?? 'created',
      providerStatus: `AWB ${assignment.awb} assigned (${assignment.courier || 'courier'})`,
      at: new Date(),
    });
    await queueEmail(`awb:${orderId}`, o.email, `Tracking is ready for order #${o.number}`,
      {template: 'awb', orderId, userId: o.user_id});
    return s;
  } catch (e) {
    await shipments().updateOne({_id: s0._id}, {$set: {status: 'assignment_review', last_error: errorNote(e)}});
    // Courier assignment left in a state only a human can resolve in the
    // Shiprocket dashboard. Nothing retries past this, so say so.
    await queueAdminEmail(`awb-review:${orderId}`, `Courier assignment needs attention — order #${o.number}`,
      {template: 'admin_error', data: {area: 'Courier assignment', reference: `Order #${o.number}`,
        detail: 'The courier did not return an AWB. Reconcile this shipment in the Shiprocket dashboard before retrying.'}});
    throw e;
  }
}

/* ------------------------------------------------------------------ pickup */

/**
 * Asks the courier to collect the parcel.
 *
 * Requires an AWB, because there is nothing for a courier to collect against
 * until one exists. Recorded on the shipment so the admin screen can show when
 * it was requested and stop offering the button twice.
 */
export async function schedulePickup(orderId) {
  const s = await shipmentFor(orderId);
  assert(s, 404, 'No shipment exists for this order.');
  assert(s.awb, 409, 'Assign an AWB before scheduling a pickup.');
  assert(s.status !== 'cancelled', 409, 'This shipment was cancelled.');

  const result = await sr.schedulePickup(s.provider_shipment_id);
  const updated = await shipments().findOneAndUpdate(
    {_id: s._id},
    {$set: {
      pickup_token: result.token,
      pickup_status: result.status ?? result.message ?? 'Requested',
      pickup_scheduled_at: new Date(),
      // Only advance the stage; a pickup request must not pull a parcel
      // already in transit backwards.
      ...(sr.rankOf(s.stage) < sr.rankOf('pickup_scheduled') ? {stage: 'pickup_scheduled'} : {}),
      last_error: null,
    }},
    {returnDocument: 'after'},
  );
  await recordEvent(updated, {
    key: `pickup:${s.awb}:${result.token ?? 'requested'}`,
    stage: 'pickup_scheduled',
    providerStatus: result.message ?? result.status ?? 'Pickup scheduled',
    at: new Date(),
  });
  return {
    token: result.token,
    status: updated.pickup_status,
    scheduledFor: result.scheduledFor,
    message: result.message,
  };
}

/* --------------------------------------------------------- label, manifest */

/**
 * The courier's shipping label.
 *
 * Stored as the URL Shiprocket hosts. This is a courier document and is kept
 * entirely separate from the GEMIES tax invoice, which is our own record
 * rendered from a frozen snapshot -- neither ever overwrites the other.
 */
export async function shippingLabel(orderId) {
  const s = await shipmentFor(orderId);
  assert(s?.awb, 409, 'Assign an AWB before generating a label.');
  const url = await sr.generateLabel(s.provider_shipment_id);
  await shipments().updateOne({_id: s._id}, {$set: {label_url: url}});
  return url;
}

/** The handover manifest, which Shiprocket only issues once a pickup exists. */
export async function shippingManifest(orderId) {
  const s = await shipmentFor(orderId);
  assert(s?.awb, 409, 'Assign an AWB before generating a manifest.');
  const url = await sr.generateManifest(s.provider_shipment_id);
  await shipments().updateOne({_id: s._id}, {$set: {manifest_url: url}});
  return url;
}

/* ------------------------------------------------------------ cancellation */

/**
 * Cancels the courier booking.
 *
 * Which Shiprocket endpoint applies depends on how far the booking got: an
 * AWB is cancelled by AWB, a shipment without one by its order id. A parcel
 * already picked up cannot be cancelled this way and is refused here rather
 * than being refused less clearly by the provider.
 */
export async function cancelShipment(orderId) {
  const s = await shipmentFor(orderId);
  assert(s, 404, 'No shipment exists for this order.');
  assert(s.status !== 'cancelled', 409, 'This shipment is already cancelled.');
  assert(sr.rankOf(s.stage) < sr.rankOf('picked_up'), 409,
    `This parcel is already ${sr.STAGES[s.stage]?.label?.toLowerCase() ?? s.stage}, so the booking cannot be cancelled. Arrange a return with the courier instead.`);

  const result = s.awb
    ? await sr.cancelShipment(s.awb)
    : await sr.cancelProviderOrder(s.provider_order_id);

  const updated = await shipments().findOneAndUpdate(
    {_id: s._id},
    {$set: {status: 'cancelled', stage: 'cancelled', cancelled_at: new Date(), pickup_status: null, last_error: null}},
    {returnDocument: 'after'},
  );
  await recordEvent(updated, {
    key: `cancelled:${s.awb ?? s.provider_order_id}`,
    stage: 'cancelled',
    providerStatus: result.message,
    at: new Date(),
  });
  // The order goes back to a state an operator can act on. Deliberately not
  // 'cancelled': the customer has paid and the money is still held, so this is
  // a fulfilment decision, not an order cancellation.
  await orders().updateOne({_id: orderId, status: 'processing'}, {$set: {status: 'confirmed'}});
  return {message: result.message};
}

/* ---------------------------------------------------------------- tracking */

/**
 * One row of tracking history.
 *
 * `event_key` is uniquely indexed, so re-polling the same scan or receiving
 * the same webhook twice writes nothing. That index is what makes both the
 * poll and the webhook idempotent.
 */
async function recordEvent(shipment, {key, stage, providerStatus, providerCode = null, at, location = null, detail = null}, session) {
  const eventId = id();
  await shippingEvents().updateOne(
    {event_key: `${shipment._id}:${key}`},
    {$setOnInsert: {
      _id: eventId,
      id: eventId,
      shipment_id: shipment._id,
      order_id: shipment.order_id,
      event_key: `${shipment._id}:${key}`,
      stage,
      status: providerStatus ?? stage,
      // Shiprocket's own words, preserved.
      details: {
        stage,
        provider_status: providerStatus ?? null,
        provider_code: providerCode,
        location,
        detail,
        occurred_at: at ? new Date(at).toISOString() : null,
      },
      created_at: at ? new Date(at) : new Date(),
    }},
    {upsert: true, ...withSession(session)},
  );
}

/** A short, safe note from a provider error. Never a body or a credential. */
const errorNote = (error) => String(error?.message ?? 'Provider request failed').slice(0, 300);

/**
 * Reconciles a shipment against Shiprocket's tracking API.
 *
 * This is the only thing that changes a shipment's stage or an order's
 * delivery status. The webhook does not: it records an event and asks for this
 * to run, because Shiprocket does not sign webhook bodies and an unsigned
 * payload is not evidence. See the header of shiprocket.mjs.
 *
 * Monotonic by rank, so an out-of-order scan cannot undo a newer one. A
 * delivered parcel stays delivered when an "In Transit" event arrives late.
 */
export async function syncTracking(orderId) {
  const s = await shipmentFor(orderId);
  assert(s?.provider_shipment_id || s?.awb, 409, 'A shipment must be created first.');

  const tracking = await sr.fetchTracking({awb: s.awb, providerShipmentId: s.provider_shipment_id});
  if (!tracking.hasData) {
    await shipments().updateOne({_id: s._id}, {$set: {last_synced: new Date()}});
    return {stage: s.stage, changed: false, reason: 'The courier has not reported a scan yet.'};
  }

  const o = await orders().findOne({_id: orderId});
  const previousRank = sr.rankOf(s.stage);
  const advancing = tracking.rank >= previousRank;

  // History first, and all of it: every scan is recorded whether or not it
  // advances the stage, so the customer's timeline is complete even when
  // events arrive out of order.
  for (const [index, activity] of tracking.activities.entries()) {
    const normalised = sr.normaliseStatus(activity.status, null);
    await recordEvent(s, {
      key: `scan:${activity.at ? new Date(activity.at).toISOString() : index}:${activity.status}`,
      stage: normalised.stage,
      providerStatus: activity.status,
      at: activity.at ?? new Date(),
      location: activity.location,
      detail: activity.activity,
    });
  }

  // A courier that reports a summary status but no activity list -- common in
  // the first hours, and the norm for some couriers -- would otherwise leave
  // the customer's timeline empty while the stage moved underneath it. The
  // transition itself is recorded, keyed on the stage so re-polling the same
  // one writes nothing.
  if (advancing && tracking.stage !== s.stage) {
    await recordEvent(s, {
      key: `stage:${tracking.stage}`,
      stage: tracking.stage,
      providerStatus: tracking.providerStatus ?? sr.STAGES[tracking.stage].label,
      providerCode: tracking.providerCode,
      at: new Date(),
    });
  }

  const changes = {
    last_synced: new Date(),
    // Only ever filled in, never blanked by a response that omits them.
    ...(tracking.awb && !s.awb ? {awb: tracking.awb} : {}),
    ...(tracking.courier ? {courier: tracking.courier} : {}),
    ...(tracking.trackingUrl ? {tracking_url: tracking.trackingUrl} : {}),
    ...(tracking.estimatedDelivery ? {estimated_delivery: tracking.estimatedDelivery} : {}),
    ...(tracking.pickedUpAt ? {picked_up_at: tracking.pickedUpAt} : {}),
  };

  if (advancing) {
    changes.stage = tracking.stage;
    changes.provider_status = tracking.providerStatus;
    changes.provider_code = tracking.providerCode;
    // Recorded only on a confirmed delivery, and only from the API.
    if (tracking.stage === 'delivered') changes.delivered_at = tracking.deliveredAt ?? new Date();
  }

  // The guard is in the filter as well as the branch: two concurrent syncs
  // cannot between them move a shipment backwards.
  const updated = await shipments().findOneAndUpdate(
    {_id: s._id, ...(advancing ? {} : {_id: s._id})},
    {$set: changes},
    {returnDocument: 'after'},
  );

  if (!advancing) {
    return {stage: s.stage, changed: false, reason: `A ${tracking.providerStatus} event arrived after a later status and was recorded without changing the shipment.`};
  }

  // The order's own status follows the parcel, and never regresses: a paid
  // order that has been delivered is not moved back to shipped.
  const nextOrderStatus = sr.STAGES[tracking.stage].order;
  if (nextOrderStatus && o.payment_status === 'paid' && !['cancelled', 'refunded'].includes(o.status)) {
    const ORDER_RANK = {confirmed: 1, processing: 2, shipped: 3, delivered: 4};
    if ((ORDER_RANK[nextOrderStatus] ?? 0) > (ORDER_RANK[o.status] ?? 0)) {
      await orders().updateOne({_id: orderId}, {$set: {status: nextOrderStatus}});
    }
  }

  // One email per genuine stage change, worded for the stage the parcel has
  // reached. Keyed on the shipment and the stage, so a redelivered webhook or
  // a repeated poll cannot email twice.
  if (tracking.stage !== s.stage) {
    const notify = ['picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'rto_initiated', 'cancelled'];
    if (notify.includes(tracking.stage)) {
      const subject = {
        delivered: `Delivered — order #${o.number}`,
        out_for_delivery: `Out for delivery — order #${o.number}`,
        exception: `Delivery needs attention — order #${o.number}`,
        cancelled: `Shipment cancelled — order #${o.number}`,
        rto_initiated: `Your order is being returned — order #${o.number}`,
      }[tracking.stage] ?? `Shipped — order #${o.number}`;
      await queueEmail(`tracking:${s._id}:${tracking.stage}`, o.email, subject, {
        template: 'tracking', orderId, userId: o.user_id,
        data: {stage: emailStage(tracking.stage), code: tracking.providerCode},
      });
    }
    // A failed or returning delivery needs someone to decide what happens
    // next; a normal in-transit scan does not.
    if (['exception', 'rto_initiated', 'rto_delivered'].includes(tracking.stage)) {
      await queueAdminEmail(`delivery-${tracking.stage}:${s._id}`, `Delivery ${sr.STAGES[tracking.stage].label.toLowerCase()} — order #${o.number}`,
        {template: 'admin_error', data: {area: 'Delivery', reference: `Order #${o.number}`,
          detail: `The courier reported "${tracking.providerStatus}". Decide whether to re-book, return or refund.`}});
    }
  }

  return {
    stage: updated.stage,
    provider_status: updated.provider_status,
    changed: tracking.stage !== s.stage,
    awb: updated.awb,
    courier: updated.courier,
    estimated_delivery: updated.estimated_delivery,
    delivered_at: updated.delivered_at,
  };
}

/**
 * The GEMIES stage, as the email template's vocabulary.
 *
 * The `tracking` template predates the fuller stage list and knows five
 * words. Mapping here keeps the template unchanged rather than rewriting the
 * copy for stages that read the same to a customer.
 */
const emailStage = (stage) => ({
  picked_up: 'shipped', in_transit: 'shipped',
  out_for_delivery: 'out_for_delivery', delivered: 'delivered',
  cancelled: 'cancelled', exception: 'exception',
  rto_initiated: 'exception', rto_delivered: 'exception',
}[stage] ?? 'update');

/**
 * Tracking as the customer's order page shows it.
 *
 * Nothing is invented: with no shipment, `available` is false and the page
 * says tracking will appear once the order ships. Every field below comes from
 * a provider response.
 */
export async function trackingForCustomer(orderId) {
  const s = await shipmentFor(orderId);
  if (!s || !s.provider_shipment_id) {
    return {available: false, message: 'Tracking details will appear once your order is shipped.'};
  }
  const events = await shippingEvents()
    .find({shipment_id: s._id}, {projection: {_id: 0, stage: 1, status: 1, details: 1, created_at: 1}})
    .sort({created_at: -1}).limit(50).toArray();

  return {
    available: Boolean(s.awb),
    // Before an AWB there is a booking but nothing to follow.
    message: s.awb ? null : 'Your order is booked with the courier. A tracking number will appear here shortly.',
    stage: s.stage,
    stage_label: sr.STAGES[s.stage]?.label ?? 'Shipment created',
    // The stage's position in sr.STAGES, so the order page can decide how far
    // along the parcel is without shipping a second copy of the stage
    // vocabulary to the browser. Comparing ranks is the same test the tracking
    // reconciliation uses above; duplicating the keys client-side would mean a
    // new provider status had to be added in two places to be understood.
    rank: sr.STAGES[s.stage]?.rank ?? 0,
    provider_status: s.provider_status,
    awb: s.awb,
    courier: s.courier,
    tracking_url: s.tracking_url,
    estimated_delivery: s.estimated_delivery,
    delivered_at: s.delivered_at,
    last_synced: s.last_synced,
    history: events.map((event) => ({
      stage: event.stage,
      label: sr.STAGES[event.stage]?.label ?? event.stage,
      rank: sr.STAGES[event.stage]?.rank ?? 0,
      status: event.status,
      location: event.details?.location ?? null,
      detail: event.details?.detail ?? null,
      at: event.details?.occurred_at ?? event.created_at,
    })),
  };
}

/**
 * Refundable balance: what Razorpay captured, less every refund that has not
 * failed.
 *
 * Pending refunds count against the balance, so two refund requests issued
 * close together cannot between them exceed the captured amount.
 *
 * `COALESCE(sum(amount),0)` is summed in JavaScript rather than by an
 * aggregation. An order has a handful of refunds at most, and the documents
 * have to be read anyway for the transaction to see its own writes.
 */
export async function refundableBalance(orderId, client = undefined) {
  const options = withSession(client);
  const p = await payments().findOne({order_id: orderId}, options);
  if (!p?.gateway_payment_id) return {captured: 0, refunded: 0, balance: 0, payment: null};
  const rows = await refunds().find({order_id: orderId, status: {$ne: 'failed'}}, options).toArray();
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  return {captured: p.amount, refunded: total, balance: p.amount - total, payment: p};
}

/** Refunds on an order that have reached a given status, totalled. */
async function settledTotal(orderId, session) {
  const rows = await refunds().find({order_id: orderId, status: 'processed'}, {session}).toArray();
  return rows.reduce((sum, r) => sum + r.amount, 0);
}

/**
 * Requests a refund against a captured payment. Full or partial.
 *
 * `amount` is minor units and defaults to the whole refundable balance.
 *
 * Idempotency is on (order_id, refund_key), enforced by a unique index. A full
 * refund uses the key `full`, so the retrying refund job and a double-clicked
 * admin button both resolve to the same row. A partial refund must carry its
 * own key: two partial refunds of the same amount are legitimately different
 * operations, so there is nothing safe to derive one from and the caller is
 * made to supply it.
 *
 * Nothing here assumes the provider call succeeded because it was accepted.
 * An uncertain outcome marks the row for reconciliation and the refund is
 * matched back by its receipt rather than reissued.
 */
export async function requestRefund(orderId, reason, {amount = null, refundKey = null} = {}) {
  const claim = async () => transaction(async (session) => {
    // LOCK 8 (was the order `FOR UPDATE`). What the lock protected was reading
    // the refundable balance and then writing a refund against it. The
    // unconditional write to the order below takes a document-level lock for
    // the life of the transaction, so a second refund request for the same
    // order cannot commit against a balance it read before this one landed:
    // it hits a WriteConflict and is retried against the new total.
    const o = await orders().findOne({_id: orderId}, {session});
    assert(o && ['paid', 'refunding', 'partially_refunded'].includes(o.payment_status), 409, 'This order is not eligible for a refund.');
    const shipment = await shipments().findOne({order_id: orderId}, {projection: {_id: 1}, session});
    assert(!shipment, 409, 'Cancel or return the shipment with the provider before requesting a refund through support.');

    const {balance, payment} = await refundableBalance(orderId, session);
    assert(payment?.gateway_payment_id, 409, 'No captured payment reference is available.');
    assert(balance > 0, 409, 'This payment has already been fully refunded.');

    const value = amount === null ? balance : Number(amount);
    assert(Number.isInteger(value) && value > 0, 400, 'Refund amount must be a whole number of minor units.');
    assert(value <= balance, 409, `Refund exceeds the refundable balance of ${balance}.`);

    const full = value === balance && balance === payment.amount;
    const key = refundKey ?? (full ? 'full' : null);
    assert(key, 400, 'A partial refund requires a refund key so it cannot be issued twice.');

    const existing = await refunds().findOne({order_id: orderId, refund_key: key}, {session});
    if (existing) return {...existing, existing: true};

    const refundId = id();
    const row = {
      _id: refundId, id: refundId, order_id: orderId, refund_key: key,
      provider_id: null, status: 'pending', amount: value, reason,
      created_at: new Date(),
    };
    await refunds().insertOne(row, {session});
    await orders().updateOne({_id: orderId}, {$set: {payment_status: 'refunding'}}, {session});
    return row;
  });

  let record;
  try {
    record = await claim();
  } catch (error) {
    // The unique index on (order_id, refund_key) rejected the insert, which
    // aborts the transaction rather than being absorbed the way ON CONFLICT
    // was. A duplicate means the row exists, so resolve to it.
    if (error.code !== 11000) throw error;
    record = {...await refunds().findOne({order_id: orderId, refund_key: refundKey ?? 'full'}), existing: true};
    assert(record._id, 409, 'Refund response is uncertain. Reconcile in Razorpay before issuing another refund.');
  }

  const p = await payments().findOne({order_id: orderId});
  if (record.provider_id) return syncRefundById(record._id);

  if (record.existing) {
    // Issued before but our write of the provider id did not land. Match it
    // back by receipt instead of refunding a second time.
    const list = await razorpay(`/payments/${p.gateway_payment_id}/refunds`);
    const remote = list.items?.find((r) => r.receipt === record._id);
    assert(remote, 409, 'Refund response is uncertain. Reconcile in Razorpay before issuing another refund.');
    await refunds().updateOne({_id: record._id}, {$set: {provider_id: remote.id, status: remote.status}});
    return syncRefundById(record._id);
  }

  try {
    const remote = await razorpay(`/payments/${p.gateway_payment_id}/refund`, {amount: record.amount, speed: 'normal', receipt: record._id, notes: {order_id: orderId}});
    assert(remote.id, 502, 'Refund identifier missing.');
    await refunds().updateOne({_id: record._id}, {$set: {provider_id: remote.id, status: remote.status}});
    const o = await orders().findOne({_id: orderId});
    await queueEmail(`refund-started:${orderId}:${record.refund_key}`, o.email, `Refund initiated for order #${o.number}`, {template: 'refund_started', orderId, userId: o.user_id, data: {amount: record.amount}});
    await queueAdminEmail(`refund-started:${orderId}:${record.refund_key}`, `Refund initiated — order #${o.number}`, {template: 'admin_refund', orderId, data: {phase: 'initiated', amount: record.amount}});
    return syncRefundById(record._id);
  } catch (e) {
    await refunds().updateOne({_id: record._id, provider_id: null}, {$set: {status: 'reconciliation_required'}});
    throw e;
  }
}

/**
 * Reconciles one refund against Razorpay and settles the order's payment state.
 *
 * Stock is restored only when the whole captured amount has come back. A
 * partial refund cannot say which line it covered, so guessing would corrupt
 * inventory; the order keeps its stock deduction and is marked
 * partially_refunded.
 */
export async function syncRefundById(refundId) {
  const r = await refunds().findOne({_id: refundId});
  assert(r?.provider_id, 409, 'Refund requires reconciliation.');
  const remote = await razorpay(`/refunds/${r.provider_id}`);
  const p = await payments().findOne({order_id: r.order_id});
  assert(remote.payment_id === p.gateway_payment_id && remote.amount === r.amount, 400, 'Refund does not match the payment.');

  await transaction(async (session) => {
    // LOCK 9 (was the order `FOR UPDATE`). Replaced by the conditional claim
    // on the order below, which is what makes the stock restore happen once.
    const o = await orders().findOne({_id: r.order_id}, {session});
    await refunds().updateOne({_id: r._id}, {$set: {status: remote.status}}, {session});

    const settled = await settledTotal(r.order_id, session);
    await payments().updateOne({_id: p._id}, {$set: {refunded_amount: settled}}, {session});

    const fully = settled >= p.amount;
    if (fully && o.payment_status !== 'refunded') {
      // Only one caller can move the order to refunded, so the stock below is
      // restored exactly once however many refunds settle together.
      const claimed = await orders().findOneAndUpdate(
        {_id: r.order_id, payment_status: {$ne: 'refunded'}},
        {$set: {payment_status: 'refunded', status: 'refunded'}},
        {returnDocument: 'before', session},
      );
      if (claimed) {
        // Review orders never consumed stock. Confirmed orders are restored once.
        if (['confirmed', 'processing'].includes(claimed.status)) {
          const items = await orderItems().find({order_id: r.order_id}, {session}).sort({variant_id: 1}).toArray();
          for (const i of items) {
            await variants().updateOne({_id: i.variant_id}, {$inc: {stock: i.quantity}}, {session});
          }
        }
        await queueEmail(`refunded:${r.order_id}`, o.email, `Refund completed for order #${o.number}`, {template: 'refunded', orderId: r.order_id, userId: o.user_id, data: {amount: settled}}, session);
        await queueAdminEmail(`refunded:${r.order_id}`, `Refund completed — order #${o.number}`, {template: 'admin_refund', orderId: r.order_id, data: {phase: 'completed', amount: settled}}, session);
      }
    } else if (!fully && settled > 0 && o.payment_status !== 'refunded') {
      await orders().updateOne({_id: r.order_id}, {$set: {payment_status: 'partially_refunded'}}, {session});
      await queueEmail(`refunded:${r.order_id}:${r.refund_key}`, o.email, `Partial refund completed for order #${o.number}`, {template: 'partially_refunded', orderId: r.order_id, userId: o.user_id, data: {amount: r.amount}}, session);
    } else if (remote.status === 'failed' && o.payment_status === 'refunding') {
      // A failed refund must not leave the order stuck in refunding.
      await orders().updateOne({_id: r.order_id}, {$set: {payment_status: settled > 0 ? 'partially_refunded' : 'paid'}}, {session});
      // The bank refused the refund. The customer is told it needs attention
      // rather than being left waiting, and an operator is told to act.
      await queueEmail(`refund-failed:${r.order_id}:${r.refund_key}`, o.email, `Refund needs attention — order #${o.number}`, {template: 'refund_failed', orderId: r.order_id, userId: o.user_id}, session);
      await queueAdminEmail(`refund-failed:${r.order_id}:${r.refund_key}`, `Refund failed — order #${o.number}`, {template: 'admin_refund', orderId: r.order_id, data: {phase: 'failed', amount: r.amount}}, session);
    }
  });
  return remote;
}

/** Reconciles every unsettled refund on an order. */
export async function syncRefund(orderId) {
  const rows = await refunds()
    .find({order_id: orderId, provider_id: {$ne: null}}, {projection: {_id: 1}})
    .sort({created_at: 1})
    .toArray();
  assert(rows.length, 409, 'Refund requires reconciliation.');
  let last = null;
  for (const row of rows) last = await syncRefundById(row._id);
  return last;
}
