import {webhookEvents, shipments, orders} from './mongo.mjs';
import {refunds} from './mongo.mjs';
import {assert, validSignature, hash, id} from './security.mjs';
import {razorpay} from './providers.mjs';
import {acceptCapturedPayment} from './commerce.mjs';
import {syncRefundById} from './fulfillment.mjs';
import {markAuthorized, markFailed} from './payments.mjs';
import {webhookSecretMatches, webhookReference} from './shiprocket.mjs';
import {enqueue} from './queue.mjs';
import {config} from './config.mjs';

/**
 * Razorpay webhook endpoint.
 *
 * Four properties this has to hold, in order of how much damage getting them
 * wrong would do:
 *
 * 1. **Signature over the raw body.** `express.raw` gives us the exact bytes
 *    Razorpay signed; re-serialising parsed JSON would change them and every
 *    signature would fail. The webhook secret is a separate dashboard value
 *    from the API key secret, and config.mjs refuses to start if they match.
 *
 * 2. **Exactly-once processing.** Keyed on `x-razorpay-event-id`, which is
 *    stable across redeliveries of the same event. A body hash was used before
 *    and is kept as a fallback for deliveries without the header, but it is
 *    weaker: any byte-level difference in a redelivery would read as new.
 *
 * 3. **Capture is authoritative.** Events arrive out of order. A
 *    `payment.failed` for an earlier attempt, or a late `payment.authorized`,
 *    must never move a captured payment backwards or unpick fulfilment.
 *
 * 4. **Only a capture fulfils.** Authorisation is recorded and nothing else.
 *
 * The event is marked processed only after its side effect succeeds, so a
 * transient failure returns non-2xx and Razorpay retries rather than the event
 * being silently swallowed.
 */
export async function razorpayWebhook(req, res) {
  assert(Buffer.isBuffer(req.body), 400, 'Raw webhook body required.');
  const signature = req.headers['x-razorpay-signature'];
  assert(
    validSignature(req.body, signature, process.env.RAZORPAY_WEBHOOK_SECRET)
    || validSignature(req.body, signature, process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS),
    400, 'Invalid webhook signature.',
  );

  const event = JSON.parse(req.body.toString());
  const bodyHash = hash(req.body);
  const eventId = typeof req.headers['x-razorpay-event-id'] === 'string'
    ? req.headers['x-razorpay-event-id'] : null;
  const key = eventId ?? bodyHash;

  // Already handled: acknowledge so Razorpay stops retrying.
  const seen = eventId
    ? await webhookEvents().findOne({$or: [{event_id: eventId}, {_id: key}]}, {projection: {_id: 1}})
    : await webhookEvents().findOne({_id: key}, {projection: {_id: 1}});
  if (seen) return res.json({ok: true, duplicate: true});

  const kind = event.event || 'unknown';
  const paymentEntity = event.payload?.payment?.entity;
  const refundEntity = event.payload?.refund?.entity;

  if (kind === 'payment.captured' || kind === 'order.paid') {
    const paymentId = paymentEntity?.id;
    assert(/^pay_[a-zA-Z0-9]+$/.test(paymentId), 400, 'Payment identifier is missing.');
    // Re-read from the API rather than trusting the payload, so capture is
    // confirmed against Razorpay itself.
    await acceptCapturedPayment(await razorpay(`/payments/${paymentId}`));
  } else if (kind === 'payment.authorized') {
    const paymentId = paymentEntity?.id;
    assert(/^pay_[a-zA-Z0-9]+$/.test(paymentId), 400, 'Payment identifier is missing.');
    const payment = await razorpay(`/payments/${paymentId}`);
    // An authorisation that has already been captured by the time we look is
    // treated as the capture it now is; otherwise it is only recorded.
    if (payment.status === 'captured' && payment.captured === true) await acceptCapturedPayment(payment);
    else await markAuthorized(payment);
  } else if (kind === 'payment.failed') {
    await markFailed(paymentEntity ?? {});
  } else if (kind === 'refund.created' || kind === 'refund.processed' || kind === 'refund.failed') {
    const remoteId = refundEntity?.id;
    // Found by the provider's own refund id, which is only ever written after
    // Razorpay returned it. The payload's claimed status is not used: the
    // refund is reconciled by re-reading it from the API inside
    // syncRefundById, which also asserts the payment id and amount match.
    const refund = typeof remoteId === 'string' && remoteId
      ? await refunds().findOne({provider_id: remoteId}, {projection: {_id: 1}})
      : null;
    // A refund we have no record of means our own write failed after Razorpay
    // accepted it. Returning non-2xx keeps the event coming back until the
    // reconciliation path has caught up.
    assert(refund, 409, 'Refund is awaiting reconciliation.');
    await syncRefundById(refund._id);
  }
  // Any other event type is acknowledged and recorded without a side effect.

  // `ON CONFLICT DO NOTHING`: an upsert carrying only $setOnInsert, so a
  // redelivery that raced the read above records nothing and changes nothing.
  // `_id` comes from the filter and so is not repeated in the update.
  await webhookEvents().updateOne(
    {_id: key},
    {$setOnInsert: {id: key, kind, event_id: eventId, body_hash: bodyHash, processed_at: new Date()}},
    {upsert: true},
  );
  res.json({ok: true});
}

/**
 * Shiprocket tracking webhook.
 *
 * ## Why this does not verify a signature
 *
 * Shiprocket does not sign its webhook bodies. The tracking webhook is
 * configured in Settings -> API -> Webhooks with a URL and, optionally, custom
 * HTTP headers; there is no HMAC over the payload to recompute. Inventing one
 * would be security theatre, so this authenticates the *sender* with a shared
 * secret instead -- the value set against `x-api-key` (or another header name
 * you choose) in their dashboard, compared in constant time.
 *
 * That proves the caller knows the secret. It does not prove the body is
 * intact, fresh or unreplayed. So the body is never trusted to change an
 * order:
 *
 *   1. The delivery is authenticated and deduplicated.
 *   2. The event is recorded, including the status it claimed, for diagnostics.
 *   3. A reconciliation job is queued, and that job reads the real state from
 *      the authenticated tracking API. Only the API can move a shipment.
 *
 * This is the reconciliation fallback the integration is built around, and it
 * is why a forged or stale payload can never mark an order delivered. The
 * worker's periodic tracking sweep does the same work on a timer, so the
 * webhook only makes updates faster -- with it switched off, or with the
 * secret unset, tracking still converges.
 *
 * Processing is deliberately not done inline. The handler records and queues,
 * then returns, so Shiprocket is never kept waiting on our provider call or on
 * an email, and a slow reconciliation cannot cause a retry storm.
 */
export async function shiprocketWebhook(req, res) {
  assert(Buffer.isBuffer(req.body), 400, 'Raw webhook body required.');

  // With no secret configured there is no way to tell Shiprocket from anyone
  // else who found the URL, so nothing is accepted. Tracking still works
  // through the polled reconciliation job.
  assert(config.shiprocketWebhookSecret, 503,
    'Shiprocket webhooks are not configured. Set SHIPROCKET_WEBHOOK_SECRET and the matching header in the Shiprocket dashboard.');
  assert(webhookSecretMatches(req.headers), 401, 'Invalid webhook credentials.');

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    assert(false, 400, 'Webhook body is not valid JSON.');
  }
  assert(event && typeof event === 'object' && !Array.isArray(event), 400, 'Webhook body must be a JSON object.');

  const reference = webhookReference(event);
  assert(reference.awb || reference.orderId || reference.providerShipmentId, 400,
    'Webhook payload carries no AWB, order id or shipment id.');

  // Deduplication key. Shiprocket sends no event id, so this is built from
  // what identifies a scan: the parcel, the status it claims and its
  // timestamp. A redelivery of the same scan collapses onto one row; a
  // genuinely new scan does not. The body hash is the fallback when no
  // timestamp is present.
  const bodyHash = hash(req.body);
  const key = reference.awb || reference.providerShipmentId || reference.orderId
    ? `sr:${reference.awb ?? reference.providerShipmentId ?? reference.orderId}:${reference.claimedStatus ?? ''}:${reference.scanTime ?? bodyHash.slice(0, 16)}`
    : `sr:${bodyHash}`;

  const seen = await webhookEvents().findOne({_id: key}, {projection: {_id: 1}});
  if (seen) return res.json({ok: true, duplicate: true});

  // Resolve the parcel. Shiprocket echoes `order_id` as whatever we sent,
  // which is our own order id, so all three routes are tried.
  const shipment = reference.awb
    ? await shipments().findOne({awb: reference.awb})
    : reference.providerShipmentId
      ? await shipments().findOne({provider_shipment_id: reference.providerShipmentId})
      : await shipments().findOne({order_id: reference.orderId});

  // An event for a parcel we have no record of. Recorded and acknowledged
  // rather than retried: Shiprocket has no reason to redeliver it, and a 4xx
  // loop on a shipment that will never exist is noise. The periodic sweep
  // picks up anything real.
  if (!shipment) {
    await recordWebhook(key, reference, bodyHash, null);
    console.error(JSON.stringify({event: 'shiprocket_webhook_unmatched', awb: reference.awb, orderId: reference.orderId}));
    return res.json({ok: true, matched: false});
  }

  await recordWebhook(key, reference, bodyHash, shipment.order_id);

  // The reconciliation. Keyed on the parcel and the claimed status so a burst
  // of redeliveries collapses to one job, and the job reads the truth from the
  // tracking API rather than from this payload.
  await enqueue('tracking', `sr-webhook:${shipment._id}:${reference.claimedStatus ?? bodyHash.slice(0, 12)}`, {
    orderId: shipment.order_id,
  });

  res.json({ok: true, queued: true});
}

/** The event log. `kind` is prefixed so Razorpay and Shiprocket never collide. */
async function recordWebhook(key, reference, bodyHash, orderId) {
  await webhookEvents().updateOne(
    {_id: key},
    {$setOnInsert: {
      id: key,
      kind: `shiprocket.tracking`,
      event_id: null,
      body_hash: bodyHash,
      order_id: orderId,
      // What the payload claimed, kept for diagnostics only. Nothing reads
      // this to decide a shipment's state.
      claimed: {
        awb: reference.awb,
        status: reference.claimedStatus,
        code: reference.claimedCode,
        scan_time: reference.scanTime,
      },
      processed_at: new Date(),
    }},
    {upsert: true},
  );
}
