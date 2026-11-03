# Razorpay payment integration

## Scope of this document

Much of this lifecycle already existed in the codebase. This records the whole
system, and marks what was added in the most recent pass so you can see what to
re-check:

- **[existing]** — already implemented and already covered by tests.
- **[added]** — new in this pass.

---

## Architecture

```
Browser                    Express API (:3001)              Razorpay
───────                    ────────────────────              ────────
POST /api/checkout  ──────▶ createOrder()                   
  Idempotency-Key           ├ lock customer row             
                            ├ quote from DB prices          
                            ├ reserve stock atomically      
                            └ INSERT orders                 
                           paymentOrder()                   
                            └ INSERT payments ──────────────▶ POST /v1/orders
                                                            ◀── order_xxx
  ◀── {key, gatewayOrderId, amount}
                                                            
Razorpay Checkout opens (key id only; the secret never leaves the server)
Customer pays. Razorpay auto-captures per the dashboard setting.
                                                            
POST /api/payments/verify ─▶ HMAC over our stored order id  
                            ├ GET /v1/payments/:id ─────────▶ (re-read, not trusted)
                            └ acceptCapturedPayment()       
POST /api/webhooks/razorpay▶ signature over raw body        
                            └ acceptCapturedPayment()       
                                                            
Either path, whichever wins, settles the order exactly once.
```

Two independent confirmation paths, because the browser callback is unreliable:
the customer may close the tab, lose connection, or never return. The webhook is
the authoritative path; the callback is a latency optimisation. A `payment_sync`
job sweeps pending orders for up to seven days as a third backstop.

Nothing is confirmed from a frontend callback alone. The browser's claim is
verified by HMAC against the Razorpay order id **we** stored, and then the
payment is re-read from the Razorpay API before anything is settled.

### Files

| File | Responsibility |
|---|---|
| `server/commerce.mjs` | Quote, order creation, `paymentOrder`, `acceptCapturedPayment`, release |
| `server/payments.mjs` | **[added]** Attempt history, `markAuthorized`, `markFailed` |
| `server/webhooks.mjs` | Webhook signature, idempotency, event routing |
| `server/fulfillment.mjs` | Refunds (full and partial), refund reconciliation, shipping |
| `server/invoices.mjs` | Invoice record and PDF |
| `server/jobs.mjs` | Retrying worker: invoice, email, refund sync, payment sync |
| `server/providers.mjs` | Razorpay HTTP client (Basic auth, 20s timeout) |
| `server/config.mjs` | **[added]** Startup validation of mode and keys |

---

## Payment lifecycle

1. **Place order.** `POST /api/checkout` with an `Idempotency-Key` header.
2. **Validate.** Cart re-read from the database; every price, discount, tax and
   shipping figure recomputed server-side in integer paise. The client cannot
   submit a total — `checkoutSchema` is `.strict()` and rejects unknown keys.
3. **Reserve stock.** `UPDATE variants SET reserved=reserved+$1 WHERE id=$2 AND
   stock-reserved>=$1`. The conditional update is what prevents overselling:
   two concurrent buyers of the last unit cannot both succeed.
4. **Internal order.** `orders` row, `status='pending'`,
   `payment_status='pending'`, `expires_at=now()+30 minutes`.
5. **Razorpay order.** `POST /v1/orders` for the verified total, with
   `partial_payment: false`. The response amount and currency are checked
   against ours before being stored.
6. **Checkout opens** with the key id, the Razorpay order id and the amount.
7. **Razorpay captures** automatically, per the dashboard setting.
8. **Confirm.** Browser callback or webhook, whichever arrives first.
9. **Order becomes paid** only when the payment reads `status === 'captured'`
   **and** `captured === true`. At that point, and only then: stock moves from
   reserved to deducted, the cart lines are cleared, and the invoice and
   confirmation email are queued.
10. **Fulfilment** is separate and manual by default (`AUTO_FULFILL=false`).

### What capture-only means in practice

`acceptCapturedPayment` opens with:

```js
assert(payment.status==='captured' && payment.captured===true, 409, 'Payment is not captured yet.')
```

An authorised payment therefore cannot fulfil an order through any path. A
`payment.authorized` webhook records the attempt, sets `payments.status` to
`authorized`, and stops. Stock is untouched. If capture never follows, the
reservation expires and `maintenance()` releases it.

### Late capture after cancellation

If a capture lands after the order was cancelled or its reservation expired, the
order is **not** fulfilled. It is set to `status='review'`,
`payment_status='paid'`, and a refund job is queued. The customer's money is not
kept against goods that were released back to stock.

---

## API endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/checkout/quote` | customer | Server-computed totals, no side effects |
| POST | `/api/checkout` | customer | Rate limited 20/window. Requires `Idempotency-Key` |
| POST | `/api/payments/verify` | customer | Rate limited 30/window. HMAC + API re-read |
| POST | `/api/webhooks/razorpay` | signature | Raw body. Mounted before the JSON parser |
| POST | `/api/orders/:id/cancel` | owner | Pending orders only; releases the reservation |
| GET | `/api/orders/:id/invoice` | owner | PDF; 404 for anyone else |
| GET | `/api/admin/orders/:id/payment` | admin | **[added]** Payment, attempts, refunds, balance |
| POST | `/api/admin/orders/:id/refund` | admin | **[added]** `amount` optional; partial needs `refundKey` |
| POST | `/api/admin/orders/:id/sync-refund` | admin | Reconciles every refund on the order |
| POST | `/api/admin/orders/:id/reconcile-payment` | admin | Attaches a Razorpay order after an uncertain create |

---

## Database

Money is `INT` paise everywhere. No floating point touches an amount.

### `orders` [existing]
`checkout_key`, `request_hash`, `status`, `payment_status`, `currency`,
`subtotal`, `discount`, `tax`, `shipping`, `total`, `address`, `email`,
`expires_at`, `reserved`.

`UNIQUE(user_id, checkout_key)` is the checkout idempotency constraint.

### `payments` [existing, extended]
One row per order: the Razorpay order the customer pays against, reused across
retries.

`order_id UNIQUE`, `gateway_order_id UNIQUE`, `gateway_payment_id UNIQUE`.

**[added]** `method`, `authorized_at`, `captured_at`, `refunded_amount`.

### `payment_attempts` [added]
One row per Razorpay payment, so a retry after a failure is visible rather than
overwriting the previous outcome.

`gateway_payment_id UNIQUE` — the same payment can never be recorded twice, nor
against two different internal orders.

### `refunds` [existing, reshaped]
**[added]** `order_id UNIQUE` was dropped so an order can carry several partial
refunds. Idempotency moved to `UNIQUE(order_id, refund_key)`.

### `webhook_events` [existing, extended]
**[added]** `event_id` with a unique partial index, plus `body_hash`.

### `invoices`, `jobs`, `email_notifications` [existing]
`invoices.order_id UNIQUE`; `jobs.dedupe_key UNIQUE`;
`email_notifications.dedupe_key UNIQUE`.

### States

| Payment (`payments.status`) | Order (`orders.status`) | Payment status (`orders.payment_status`) |
|---|---|---|
| `creating`, `pending` | `pending` | `pending` |
| `authorized` **[added]** | `confirmed` | `paid` |
| `captured` | `processing`, `shipped`, `delivered` | `refunding` |
| `failed` | `cancelled`, `review` | `partially_refunded` **[added]** |
| `reconciliation_required` | `refunded` | `refunded`, `failed` |

Order fulfilment status and payment status are separate columns and move
independently. The spec's names map onto these: `PENDING_PAYMENT` is
`status='pending'` with `payment_status='pending'`; `REFUND_PENDING` is
`payment_status='refunding'`. The existing vocabulary was kept rather than
renamed, because renaming would have touched every query, the CHECK constraints
and the admin UI for no behavioural gain.

---

## Idempotency strategy

Every guarantee is a database constraint, not a code convention. Nothing relies
on an `Idempotency-Key` header being honoured by Razorpay, because Razorpay does
not document one for these endpoints.

### Checkout [existing]
`UNIQUE(user_id, checkout_key)`. The customer row is locked `FOR UPDATE` first,
so two concurrent checkouts for one customer serialise. A repeat with the same
key returns the existing order. The request body is fingerprinted into
`request_hash`: the same key with *different* contents is a 409, not a silent
return of the wrong order.

A refresh mid-payment therefore cannot create a second order or a second
Razorpay order. *Tested.*

### Payment [existing]
`payments.gateway_order_id` and `gateway_payment_id` are both unique, so one
Razorpay payment cannot attach to two internal orders. `acceptCapturedPayment`
locks the payment row, then the order row, before deciding anything. If a
payment is already attached and a different one arrives, it is rejected rather
than overwritten.

### Webhook [added, was body-hash]
Keyed on `x-razorpay-event-id`, which is stable across redeliveries. The body
hash is kept as a fallback for deliveries without the header, but it is weaker:
a redelivery differing by a byte would read as new. Both are stored.

The event is recorded as processed **after** its side effect succeeds, so a
transient failure returns non-2xx and Razorpay retries, rather than the event
being marked done and lost.

### Refund [added for partial]
`UNIQUE(order_id, refund_key)`. A full refund uses the key `full`, so the
retrying refund job and a double-clicked admin button resolve to the same row. A
partial refund must supply its own key — two partial refunds of the same amount
are legitimately different operations, so there is nothing safe to derive a key
from, and the API refuses without one.

The refundable balance counts **pending** refunds as well as processed ones, so
two requests issued together cannot between them exceed the captured amount.

### Out-of-order events [added]
`captured` is terminal. A `payment.failed` for an earlier attempt, or a late
`payment.authorized`, cannot move a captured payment or a captured attempt
backwards. The guard is in SQL, not a branch:

```sql
status = CASE WHEN payment_attempts.status='captured'
              THEN payment_attempts.status ELSE excluded.status END
```

---

## Signature verification

**Checkout callback** — HMAC-SHA256 of `<razorpay_order_id>|<razorpay_payment_id>`
with the API key secret. The order id is matched against the row we stored for
*this customer's* order before the HMAC is even computed:

```sql
SELECT p.* FROM payments p JOIN orders o ON o.id=p.order_id
 WHERE p.order_id=$1 AND o.user_id=$2
```

So a browser cannot submit someone else's order id, and cannot submit one we
never created. After the signature passes, the payment is **re-read from the
Razorpay API** and checked for captured status, amount and currency. The
browser's word is never the basis for settling an order.

Rejected: invalid signature, unknown payment or order id, amount mismatch,
currency mismatch, a payment belonging to another customer, and an authorised
but uncaptured payment.

**Webhook** — HMAC-SHA256 over the **raw request body** with the webhook secret.
`express.raw` is mounted for this route ahead of the JSON parser, because
re-serialising parsed JSON changes the bytes and every signature would fail.
Both the current and a previous secret are accepted, so rotation needs no
downtime. Comparison is constant-time.

---

## Stock protection [existing]

| Point | Action |
|---|---|
| Checkout | `reserved += qty` under `stock-reserved >= qty` |
| Capture | `reserved -= qty`, `stock -= qty`, in the same transaction as the order update |
| Cancel / expiry | `reserved -= qty`, order `cancelled` |
| Full refund | `stock += qty`, once |
| Partial refund | **stock untouched** |

A partial refund cannot say which line it covered, so restocking would be a
guess that corrupts inventory. The order keeps its deduction and is marked
`partially_refunded`. If you need stock back on a partial refund, adjust it
explicitly in the admin.

`maintenance()` releases reservations for orders past `expires_at` every minute.

---

## Environment variables

```
RAZORPAY_MODE=test          # 'test' or 'live'
RAZORPAY_KEY_ID=            # rzp_test_... or rzp_live_...
RAZORPAY_KEY_SECRET=        # server-side only, never sent to the browser
RAZORPAY_WEBHOOK_SECRET=    # a SEPARATE dashboard value
RAZORPAY_WEBHOOK_SECRET_PREVIOUS=   # optional, during rotation
```

**[added]** Validated at startup. The process refuses to boot when:

- `RAZORPAY_MODE` is not `test` or `live`
- `RAZORPAY_KEY_ID` is not a well-formed Razorpay key id
- the key prefix contradicts `RAZORPAY_MODE` (either direction)
- live mode without `NODE_ENV=production`
- keys are set but `RAZORPAY_WEBHOOK_SECRET` is missing
- the webhook secret equals the API key secret

Secrets reach the browser nowhere: `/api/config` exposes only
`payments: boolean`, and `/api/checkout` returns the **key id**, which is public
by design. Error logs carry a request id, an HTTP status and an error code —
never a payment payload or a credential.

---

## Testing results

`npm test` — **30 passed, 0 failed.** No network: the Razorpay and Shiprocket
APIs are replaced by an in-process stub, and the database is PGlite in-memory.

Against the 18 scenarios requested:

| # | Scenario | Status |
|---|---|---|
| 1 | Successful payment | ✅ existing |
| 2 | Failed payment | ✅ **added** — order stays open, reservation survives, retry captures |
| 3 | Invalid signature | ✅ existing |
| 4 | Incorrect amount | ✅ **added** explicit case (was covered indirectly) |
| 5 | Incorrect currency | ✅ **added** explicit case |
| 6 | Duplicate checkout request | ✅ existing |
| 7 | Duplicate webhook | ✅ existing, plus **added** event-id redelivery with a differing body |
| 8 | Out-of-order webhook | ✅ **added** — `failed` after `captured` does not downgrade |
| 9 | Authorised but not captured | ✅ existing rejection, plus **added** `payment.authorized` records without fulfilling |
| 10 | Payment captured | ✅ existing |
| 11 | Delayed payment success | ✅ existing — held in `review`, refund queued |
| 12 | Duplicate refund request | ✅ existing, plus **added** same-key partial |
| 13 | Partial refund | ✅ **added** |
| 14 | Full refund | ✅ existing |
| 15 | Concurrent checkout | ✅ existing — oversell test asserts exactly one winner |
| 16 | Stock reservation and release | ✅ existing |
| 17 | Browser refresh during payment | ✅ **added** — one Razorpay order, asserted by provider call count |
| 18 | Webhook before checkout callback | ✅ **added** — settles once, callback is a no-op |

Also verified in this pass:

- Production build clean, no warnings.
- Schema introspected: `refunds.order_id` UNIQUE dropped and replaced by
  `UNIQUE(order_id, refund_key)`; `payment_attempts.gateway_payment_id` UNIQUE;
  `webhook_events.event_id` UNIQUE partial index; `partially_refunded` accepted
  by the CHECK constraint; all pre-existing idempotency constraints intact.
- Admin transaction view returns payment, attempts, refunds and balance, is 403
  for a non-admin, and contains neither secret.
- Cart, checkout, authentication, wishlist, product and order routes unaffected.

### What is *not* tested

**No request has ever been made to Razorpay from this codebase.** No keys are
configured here, so `config.paymentEnabled` is `false` and checkout returns 503.
Every test runs against a stub that mimics the documented response shapes.

That means these remain unverified against the real provider:

- that auto-capture is enabled on your account (a dashboard setting)
- the real response shape of `/v1/orders`, `/v1/payments/:id`, `/v1/refunds/:id`
- real webhook signature headers and delivery behaviour
- real partial-refund behaviour and `speed: 'normal'` settlement timing
- Checkout.js behaviour in a browser

**No browser was available either**, so the admin panel and the checkout UI were
verified from server-rendered markup and assertions, not by looking at them.

---

## Remaining production configuration

Ordered by what blocks a real payment first.

### Blocking

1. **Razorpay dashboard setup** — all of `docs/RAZORPAY_DASHBOARD_SETUP.md`.
   Auto-capture (steps 2 and 10) is the one that silently breaks everything.
2. **Keys in `.env`** — nothing is configured here now.
3. **Business details** — `BUSINESS_NAME`, `BUSINESS_ADDRESS`, `BUSINESS_EMAIL`.
   Checkout refuses in production without them.
4. **Email** — `RESEND_API_KEY`, `EMAIL_FROM`, with a verified sending domain.
   Checkout refuses in production without them.
5. **HTTPS** — live mode requires `NODE_ENV=production` and an `https://`
   `APP_URL`; startup enforces it.
6. **PostgreSQL** — `DATABASE_URL`. The embedded PGlite database is development
   only and a single process owns it.

### GST invoicing — partially implemented

The invoice carries everything the brief listed: order number, items with SKU,
size, colour and quantity, subtotal, discount, tax, shipping, total, the
delivery address and the payment reference. It prints your tax registration
number when `BUSINESS_TAX_ID` is set. Invoice and email are both deduplicated —
`invoices.order_id` is unique and the email has a dedupe key.

**It is not a GST-compliant tax invoice.** Four things are missing and none can
be invented:

- **HSN/SAC code per item.** No column exists on `products`.
- **Place of supply.** Not derived from the delivery state.
- **CGST/SGST/IGST split.** `store_settings.tax_bps` is a single flat rate
  producing one `tax` figure. A compliant invoice needs the components, which
  depend on whether the supply is intra- or inter-state.
- **Buyer GSTIN** for B2B orders. Not collected at checkout.

Tell me to add these and I will: it needs an `hsn` column on products, a seller
state in settings, a GSTIN field on the address, and the tax calculation split
by place of supply.

### Operational

- `PACKAGE_WEIGHT_KG` and dimensions, before any Shiprocket fulfilment.
- `store_settings.tax_bps` — currently `0`, so listed prices are treated as
  final and the product page says "inclusive of all taxes".
- `store_settings.returns_policy` — empty, so the product page states that no
  policy is published. A refund policy is a legal requirement for a payment
  aggregator account.
- Run `npm run worker` as a separate process in production
  (`RUN_WORKER=false` on the API) so invoice, email and reconciliation jobs are
  not competing with request handling.

### Not production-ready until

The code-level work is complete and tested as described above. **This should not
be called production-ready until the dashboard steps are done and one real
captured transaction, followed by one real refund, has been verified in live
mode.** Nothing in code can confirm either.
