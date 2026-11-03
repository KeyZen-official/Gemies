/**
 * Shiprocket domain operations.
 *
 * `providers.mjs` owns the transport: authentication, the token cache, the
 * 401 retry and the rate-limit wait. This module owns everything above it --
 * what GEMIES sends, what it stores, and how a provider status becomes an
 * order status.
 *
 * Shipment creation and tracking reconciliation stay in `fulfillment.mjs`,
 * which already had them and also owns the refund path they interact with.
 * This file is what that module calls into, so there is one place each
 * Shiprocket endpoint is described.
 *
 * ## The one thing to know about Shiprocket webhooks
 *
 * Shiprocket's tracking webhook has no payload-signing scheme. You enable it
 * in Settings -> API -> Webhooks, give it a URL, and may add custom HTTP
 * headers; there is no HMAC over the body to verify, so there is nothing to
 * recompute. That is a weaker position than Razorpay, which signs the raw
 * body, and it is not something to paper over with an invented scheme.
 *
 * So the webhook is treated as a *notification*, not as evidence:
 *
 *   1. The request is authenticated by a shared secret in a header, compared
 *      in constant time (see `webhookSecretMatches`). That proves the sender
 *      knows the secret. It does NOT prove the body is intact or unreplayed.
 *   2. Nothing in the body is written to an order. The event is recorded and
 *      the real state is then read back from the authenticated tracking API,
 *      which is the only source trusted to change an order.
 *
 * That is the reconciliation fallback, and it is why a delivery can never be
 * recorded from a forged or stale payload.
 */
import {shiprocket} from './providers.mjs';
import {assert, equal} from './security.mjs';
import {config} from './config.mjs';

/* --------------------------------------------------------------- statuses */

/**
 * Shiprocket's shipment status codes, mapped to GEMIES stages.
 *
 * The numeric code is the reliable half of a tracking response; the text is
 * free-form and varies by courier. Both are kept: `provider_status` stores
 * Shiprocket's own words verbatim so nothing is lost, and `stage` is what the
 * storefront, the emails and the order status are driven from.
 *
 * `rank` exists to stop a delayed event undoing a newer one. Events arrive out
 * of order routinely -- an "In Transit" scan can land after "Delivered" -- so
 * a transition is only applied when it ranks at least as high as what is
 * already stored. RTO and cancellation are ranked above delivery because they
 * are later facts about the same parcel, not regressions.
 */
export const STAGES = {
  created: {rank: 10, order: null, label: 'Shipment created'},
  pickup_scheduled: {rank: 20, order: null, label: 'Pickup scheduled'},
  picked_up: {rank: 30, order: 'shipped', label: 'Picked up'},
  in_transit: {rank: 40, order: 'shipped', label: 'In transit'},
  out_for_delivery: {rank: 50, order: 'shipped', label: 'Out for delivery'},
  delivered: {rank: 60, order: 'delivered', label: 'Delivered', terminal: true},
  exception: {rank: 55, order: null, label: 'Delivery exception'},
  rto_initiated: {rank: 70, order: null, label: 'Return to origin initiated'},
  rto_delivered: {rank: 80, order: null, label: 'Returned to origin', terminal: true},
  cancelled: {rank: 90, order: 'cancelled', label: 'Shipment cancelled', terminal: true},
};

/**
 * Shiprocket's documented status codes.
 *
 * Only codes whose meaning is unambiguous are listed. Anything else falls
 * through to the text match below and then to `created`, rather than being
 * guessed at from a number this code does not recognise.
 */
const CODE_STAGE = {
  6: 'in_transit', 17: 'in_transit', 18: 'in_transit', 42: 'in_transit',
  19: 'out_for_delivery',
  7: 'delivered',
  8: 'cancelled', 5: 'cancelled',
  9: 'rto_initiated', 21: 'rto_initiated', 22: 'rto_initiated',
  10: 'rto_delivered', 23: 'rto_delivered',
  12: 'exception', 13: 'exception', 14: 'exception', 15: 'exception',
  16: 'exception', 20: 'exception', 38: 'exception', 39: 'exception',
  4: 'picked_up', 44: 'picked_up',
  2: 'pickup_scheduled', 3: 'pickup_scheduled',
  1: 'created',
};

/** Normalises a provider status into a stage, without discarding the original. */
export function normaliseStatus(status, code) {
  const text = String(status ?? '').toLowerCase();
  const numeric = Number(code);
  const byCode = Number.isFinite(numeric) ? CODE_STAGE[numeric] : null;

  // The text is consulted first only where it is unambiguous and the code set
  // is known to be inconsistent between couriers.
  const stage = text.includes('rto') && text.includes('deliver') ? 'rto_delivered'
    : text.includes('rto') ? 'rto_initiated'
      : text.includes('out for delivery') ? 'out_for_delivery'
        : byCode
          ?? (text.includes('cancel') ? 'cancelled'
            : text.includes('undeliver') || text.includes('exception') || text.includes('lost') || text.includes('damage') ? 'exception'
              : text.includes('deliver') ? 'delivered'
                : text.includes('transit') || text.includes('shipped') || text.includes('dispatch') ? 'in_transit'
                  : text.includes('picked') ? 'picked_up'
                    : text.includes('pickup') ? 'pickup_scheduled'
                      : 'created');

  return {
    stage,
    rank: STAGES[stage].rank,
    orderStatus: STAGES[stage].order,
    terminal: Boolean(STAGES[stage].terminal),
    // Shiprocket's own words and number, stored as given.
    providerStatus: status == null ? null : String(status),
    providerCode: Number.isFinite(numeric) ? numeric : null,
  };
}

/** The stage currently recorded against a shipment, as a rank. */
export const rankOf = (stage) => STAGES[stage]?.rank ?? 0;

/* ------------------------------------------------------------- the package */

/**
 * Packed weight and dimensions, from configuration.
 *
 * There is deliberately no default and no estimate. Shiprocket prices on
 * volumetric weight, so an invented figure becomes a real billing dispute and
 * a courier that refuses the parcel at pickup. A missing value is an operator
 * error with a message that names the variable to set.
 */
export function packageSpec() {
  const spec = {
    weight: Number(process.env.PACKAGE_WEIGHT_KG),
    length: Number(process.env.PACKAGE_LENGTH_CM),
    breadth: Number(process.env.PACKAGE_BREADTH_CM),
    height: Number(process.env.PACKAGE_HEIGHT_CM),
  };
  const missing = Object.entries(spec)
    .filter(([, value]) => !Number.isFinite(value) || value <= 0)
    .map(([key]) => ({
      weight: 'PACKAGE_WEIGHT_KG', length: 'PACKAGE_LENGTH_CM',
      breadth: 'PACKAGE_BREADTH_CM', height: 'PACKAGE_HEIGHT_CM',
    }[key]));
  assert(missing.length === 0, 503,
    `Packed parcel dimensions are not configured: set ${missing.join(', ')} to the real packed values. Shiprocket prices on volumetric weight, so these are not estimated.`);
  return spec;
}

/** An Indian PIN code, which is what Shiprocket's domestic API accepts. */
export const validPincode = (value) => /^[1-9]\d{5}$/.test(String(value ?? '').trim());

/* ---------------------------------------------------------- serviceability */

/**
 * Courier options for a destination, cheapest first.
 *
 * Returned as GEMIES-shaped records rather than Shiprocket's raw rows, so the
 * admin screen is not coupled to their field names. `rate` is converted to
 * integer paise, like every other amount in this application -- their API
 * quotes rupees as a float.
 */
export async function courierOptions({pincode, weight, declaredValue, cod = false}) {
  assert(validPincode(pincode), 400, 'A valid six-digit Indian PIN code is required.');
  const pickup = process.env.SHIPROCKET_PICKUP_PINCODE;
  assert(validPincode(pickup), 503, 'SHIPROCKET_PICKUP_PINCODE is not configured.');

  const query = new URLSearchParams({
    pickup_postcode: String(pickup),
    delivery_postcode: String(pincode),
    weight: String(weight),
    cod: cod ? '1' : '0',
    ...(declaredValue ? {declared_value: String(Math.round(declaredValue / 100))} : {}),
  });
  const data = await shiprocket(`/courier/serviceability/?${query}`);
  const rows = data?.data?.available_courier_companies ?? [];

  return rows.map((row) => ({
    // Shiprocket's id for the courier, kept separate from anything of ours.
    courier_id: String(row.courier_company_id ?? ''),
    name: row.courier_name ?? '',
    // Rupees in their response; paise everywhere in ours.
    rate: Math.round(Number(row.rate ?? 0) * 100),
    estimated_days: row.estimated_delivery_days ?? null,
    etd: row.etd ?? null,
    rating: row.rating ?? null,
    cod_available: Boolean(row.cod),
    recommended: Boolean(row.is_custom_rate === 0 && row.recommendation_tag),
  })).sort((a, b) => a.rate - b.rate);
}

/* ---------------------------------------------------------------- shipment */

/**
 * The /orders/create/adhoc payload for one GEMIES order.
 *
 * Every value comes from the order or from configuration. `order_items` is
 * built from `order_items`, which already snapshots the name, SKU, size,
 * colour and unit price as they were when the order was placed -- so a later
 * catalogue edit cannot change what was declared to the courier.
 *
 * Amounts are divided by 100 at this boundary only, because Shiprocket's API
 * is in rupees. Nothing is rounded up.
 */
export function shipmentPayload(order) {
  const spec = packageSpec();
  const a = order.address ?? {};
  assert(validPincode(a.postalCode), 409, 'This order has no valid Indian PIN code, so it cannot be shipped domestically.');
  assert(a.phone && String(a.phone).replace(/\D/g, '').length >= 10, 409, 'This order has no usable contact phone number for the courier.');
  assert(order.items?.length, 409, 'This order has no lines to ship.');

  const [first, ...rest] = String(a.name ?? '').trim().split(/\s+/);
  return {
    // Our order id, so a Shiprocket record can always be traced back. Their
    // `channel_order_id` is what reconcile-shipment matches on.
    order_id: order.id,
    order_date: new Date(order.created_at).toISOString().slice(0, 19).replace('T', ' '),
    pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION,
    // GEMIES order number, for the operator reading the Shiprocket panel.
    comment: `GEMIES order #${order.number}`,
    billing_customer_name: first || 'Customer',
    billing_last_name: rest.join(' '),
    billing_address: a.line1,
    billing_address_2: a.line2 ?? '',
    billing_city: a.city,
    billing_pincode: a.postalCode,
    billing_state: a.state,
    billing_country: a.country || 'India',
    billing_email: order.email,
    billing_phone: String(a.phone).replace(/\D/g, '').slice(-10),
    shipping_is_billing: true,
    order_items: order.items.map((item) => ({
      name: item.name,
      sku: item.sku,
      units: item.quantity,
      selling_price: item.unit_price / 100,
      discount: 0,
      tax: '',
      hsn: '',
    })),
    // Prepaid always: GEMIES captures through Razorpay before an order becomes
    // eligible for fulfilment, so there is nothing for the courier to collect.
    payment_method: 'Prepaid',
    shipping_charges: order.shipping / 100,
    total_discount: order.discount / 100,
    sub_total: (order.subtotal + order.tax) / 100,
    length: spec.length,
    breadth: spec.breadth,
    height: spec.height,
    weight: spec.weight,
  };
}

/** Creates the Shiprocket order. Returns their two identifiers. */
export async function createProviderOrder(order) {
  const data = await shiprocket('/orders/create/adhoc', shipmentPayload(order));
  assert(data?.order_id && data?.shipment_id, 502, 'Shiprocket did not return shipment identifiers.');
  return {providerOrderId: String(data.order_id), providerShipmentId: String(data.shipment_id)};
}

/**
 * Assigns an AWB, optionally with a chosen courier.
 *
 * `courierId` is optional because not every account has courier selection
 * enabled, and Shiprocket picks by its own rules when none is given. A courier
 * that cannot service the parcel is refused by their API with a message, which
 * `shiprocket()` surfaces rather than swallowing.
 */
export async function assignAwb(providerShipmentId, courierId = null) {
  const resolved = courierId ?? (process.env.SHIPROCKET_COURIER_ID || null);
  const data = await shiprocket('/courier/assign/awb', {
    shipment_id: Number(providerShipmentId),
    ...(resolved ? {courier_id: Number(resolved)} : {}),
  });
  // Their response nests the useful part, and the shape differs between a
  // fresh assignment and one that already existed.
  const assignment = data?.response?.data ?? data?.data ?? {};
  const awb = assignment.awb_code ?? assignment.awb ?? null;
  assert(awb, 502, 'Shiprocket accepted the request but returned no AWB. Check the shipment in their dashboard before retrying.');
  return {
    awb: String(awb),
    courier: assignment.courier_name ?? '',
    courierId: assignment.courier_company_id ? String(assignment.courier_company_id) : (resolved ? String(resolved) : null),
    // Present on some responses; recorded when it is.
    appliedWeight: assignment.applied_weight ?? null,
    freightCharge: assignment.freight_charges != null ? Math.round(Number(assignment.freight_charges) * 100) : null,
  };
}

/**
 * Asks the courier to collect.
 *
 * Shiprocket treats a repeated request as already-scheduled rather than as an
 * error, so this is safe to retry; the caller still guards on state so an
 * operator is not told it worked twice.
 */
export async function schedulePickup(providerShipmentId) {
  const data = await shiprocket('/courier/generate/pickup', {shipment_id: [Number(providerShipmentId)]});
  const response = data?.response ?? {};
  return {
    scheduled: true,
    // Their field names vary between accounts; all three are reported when
    // present rather than one being assumed.
    token: response.pickup_token_number ?? data?.pickup_token_number ?? null,
    scheduledFor: response.pickup_scheduled_date ?? data?.pickup_scheduled_date ?? null,
    status: response.pickup_status ?? data?.pickup_status ?? null,
    message: typeof data?.message === 'string' ? data.message : null,
  };
}

/** The courier's shipping label, as a URL Shiprocket hosts. */
export async function generateLabel(providerShipmentId) {
  const data = await shiprocket('/courier/generate/label', {shipment_id: [Number(providerShipmentId)]});
  const url = data?.label_url ?? '';
  assert(/^https:\/\//.test(url), 502, 'Shiprocket did not return a valid label URL.');
  return url;
}

/**
 * The manifest, which is the handover document for a pickup.
 *
 * Separate from the GEMIES tax invoice and never written over it: the invoice
 * is our own document, rendered from a frozen snapshot, and a courier
 * document has no business replacing it.
 */
export async function generateManifest(providerShipmentId) {
  const data = await shiprocket('/manifests/generate', {shipment_id: [Number(providerShipmentId)]});
  const url = data?.manifest_url ?? '';
  assert(/^https:\/\//.test(url), 502, 'Shiprocket did not return a manifest URL. Manifests are only available once a pickup has been scheduled.');
  return url;
}

/** Cancels the courier booking for one or more AWBs. */
export async function cancelShipment(awbs) {
  const list = [].concat(awbs).filter(Boolean);
  assert(list.length, 400, 'An AWB is required to cancel a shipment.');
  const data = await shiprocket('/orders/cancel/shipment/awbs', {awbs: list});
  return {message: typeof data?.message === 'string' ? data.message : 'Cancellation requested.'};
}

/** Cancels the Shiprocket order itself, for a shipment with no AWB yet. */
export async function cancelProviderOrder(providerOrderIds) {
  const list = [].concat(providerOrderIds).filter(Boolean).map(Number);
  assert(list.length, 400, 'A Shiprocket order id is required.');
  const data = await shiprocket('/orders/cancel', {ids: list});
  return {message: typeof data?.message === 'string' ? data.message : 'Cancellation requested.'};
}

/* ---------------------------------------------------------------- tracking */

/**
 * Normalises a tracking response into what GEMIES stores.
 *
 * Shiprocket returns `tracking_data` with a `shipment_track` summary and a
 * `shipment_track_activities` list. Both shapes are handled, because the AWB
 * and shipment-id endpoints differ slightly and an account with no scans yet
 * returns the summary alone.
 */
export function normaliseTracking(payload) {
  const data = payload?.tracking_data ?? payload ?? {};
  // track_status 0 with an error message means "no information yet", which is
  // normal for the first hour after an AWB is issued and is not a failure.
  const summary = Array.isArray(data.shipment_track) ? data.shipment_track[0] : data.shipment_track;
  const activities = Array.isArray(data.shipment_track_activities) ? data.shipment_track_activities : [];

  const current = normaliseStatus(
    summary?.current_status ?? data.shipment_status_text ?? data.shipment_status,
    summary?.current_status_code ?? data.shipment_status,
  );

  return {
    ...current,
    awb: summary?.awb_code ? String(summary.awb_code) : null,
    courier: summary?.courier_name ?? null,
    trackingUrl: typeof data.track_url === 'string' && /^https:\/\//.test(data.track_url) ? data.track_url : null,
    // Shiprocket gives dates as 'YYYY-MM-DD HH:mm:ss' strings in IST with no
    // offset. Parsed as UTC would be wrong by 5.5 hours, so the offset is
    // applied explicitly rather than left to the runtime's locale.
    estimatedDelivery: parseIst(summary?.edd ?? data.etd),
    deliveredAt: current.stage === 'delivered' ? parseIst(summary?.delivered_date ?? activities[0]?.date) : null,
    pickedUpAt: parseIst(summary?.pickup_date),
    // Newest first, as their API returns it.
    activities: activities.map((entry) => ({
      status: entry.status ?? entry['sr-status-label'] ?? '',
      activity: entry.activity ?? '',
      location: entry.location ?? '',
      at: parseIst(entry.date),
    })).filter((entry) => entry.status || entry.activity),
    hasData: Number(data.track_status) === 1 || activities.length > 0 || Boolean(summary),
  };
}

/** 'YYYY-MM-DD HH:mm:ss' in IST, which is what Shiprocket sends. */
function parseIst(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  // Already an ISO instant.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const direct = new Date(text);
    return Number.isNaN(direct.getTime()) ? null : direct;
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) {
    const loose = new Date(text);
    return Number.isNaN(loose.getTime()) ? null : loose;
  }
  const [, y, m, d, hh = '00', mm = '00', ss = '00'] = match;
  // IST is UTC+5:30 with no daylight saving.
  const utc = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)) - (5.5 * 3600000);
  return new Date(utc);
}

/** Tracking by AWB, which is the endpoint with activity history. */
export const trackByAwb = (awb) => shiprocket(`/courier/track/awb/${encodeURIComponent(awb)}`);

/** Tracking by Shiprocket shipment id, for a parcel with no AWB yet. */
export const trackByShipment = (shipmentId) => shiprocket(`/courier/track/shipment/${encodeURIComponent(shipmentId)}`);

/**
 * Reads the authoritative state of a shipment.
 *
 * Prefers the AWB endpoint, which carries the scan history. Falls back to the
 * shipment endpoint when no AWB has been issued, so a freshly created
 * shipment still reports something.
 */
export async function fetchTracking({awb, providerShipmentId}) {
  if (awb) return normaliseTracking(await trackByAwb(awb));
  assert(providerShipmentId, 409, 'A shipment must be created before it can be tracked.');
  return normaliseTracking(await trackByShipment(providerShipmentId));
}

/* ---------------------------------------------------------------- webhooks */

/**
 * Authenticates a Shiprocket webhook request.
 *
 * This is a shared-secret comparison, not a signature check, because
 * Shiprocket does not sign the body. The secret is whatever is configured in
 * their dashboard against the header below, and is compared in constant time
 * so a timing difference cannot be used to guess it.
 *
 * What this proves: the caller knows the secret.
 * What it does not prove: that the body is intact, fresh, or unreplayed.
 *
 * The caller therefore must not trust the payload -- see the module header.
 * Several header names are accepted because the dashboard lets an operator
 * name the header, and `x-api-key` is the convention their docs use.
 */
export function webhookSecretMatches(headers) {
  const expected = config.shiprocketWebhookSecret;
  if (!expected) return false;
  const candidates = [
    headers['x-api-key'],
    headers['x-shiprocket-token'],
    headers['x-webhook-secret'],
    typeof headers.authorization === 'string' ? headers.authorization.replace(/^Bearer\s+/i, '') : undefined,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  // `equal` is length-checked and constant-time.
  return candidates.some((value) => equal(value, expected));
}

/**
 * The parts of a webhook body GEMIES will act on.
 *
 * Only identifiers are taken. The status in the payload is deliberately
 * ignored for anything that changes an order: it is recorded on the event for
 * diagnostics, and the real status comes from the tracking API.
 */
export function webhookReference(body) {
  const payload = body ?? {};
  const awb = payload.awb ?? payload.awb_code ?? payload.data?.awb ?? null;
  const orderId = payload.order_id ?? payload.channel_order_id ?? payload.data?.order_id ?? null;
  const shipmentId = payload.shipment_id ?? payload.data?.shipment_id ?? null;
  return {
    awb: awb == null ? null : String(awb),
    // Shiprocket echoes whatever we sent as order_id, which is our own id.
    orderId: orderId == null ? null : String(orderId),
    providerShipmentId: shipmentId == null ? null : String(shipmentId),
    // Recorded, never acted on.
    claimedStatus: payload.current_status ?? payload.shipment_status ?? payload.status ?? null,
    claimedCode: payload.current_status_id ?? payload.shipment_status_id ?? null,
    scanTime: payload.current_timestamp ?? payload.scan_date ?? null,
  };
}
