# Transactional email (Resend)

GEMIES sends every transactional email through [Resend](https://resend.com).
Sending happens only on the server, only from the background worker, and only
in response to a backend event that has already been verified.

There is one email system. Nothing in `src/` sends email, and no key is ever
present in a browser bundle.

---

## 1. How it fits together

```
verified backend event
        │
        ├─ queueEmail(key, recipient, subject, {template, orderId, userId, data})
        │       ├─ INSERT email_notifications (dedupe_key UNIQUE)   ← the ledger
        │       └─ INSERT jobs kind='email'   (dedupe_key UNIQUE)   ← the work
        │
   worker (server/jobs.mjs, every 5s)
        │
        ├─ buildEmail()      server/emails/index.mjs   → picks the template
        ├─ renderEmail()     server/emails/templates.mjs → {subject, html, text}
        └─ sendEmail()       server/providers.mjs      → POST api.resend.com/emails
                                                         with Idempotency-Key: key
```

| File | Responsibility |
|---|---|
| `server/queue.mjs` | `queueEmail`, `queueAdminEmail`. Writes the ledger row and the job. |
| `server/jobs.mjs` | The worker: claims a job, renders, sends, records the outcome, retries. |
| `server/emails/layout.mjs` | The one brand layout, HTML escaping, URL safety, money formatting. |
| `server/emails/templates.mjs` | Every email, as data. No markup. |
| `server/emails/index.mjs` | Turns a queued payload into a rendered message. |
| `server/providers.mjs` | `sendEmail` — the only code that talks to Resend. |
| `server/contact.mjs` | The Contact Us endpoint. |
| `scripts/email-preview.mjs` | Renders every template to HTML for review. Sends nothing. |

The worker runs in-process with the API unless `RUN_WORKER=false`. For a
separate worker process (`npm run worker`), PostgreSQL is required — the
embedded PGlite database cannot be opened by two processes.

---

## 2. Resend account setup

1. Create an account at [resend.com](https://resend.com).
2. **Domains → Add Domain.** Enter a domain you control, e.g. `gemies.com`.
   You cannot use a subdomain of someone else's domain, and you cannot verify
   `gmail.com`.
3. Resend shows the DNS records to add. Add them at your DNS host:

   | Type | Name | Purpose | Required |
   |---|---|---|---|
   | `TXT` | `resend._domainkey` | DKIM — signs your mail so it is not forged | Yes |
   | `MX` | `send` | Return path for bounces | Yes |
   | `TXT` | `send` | SPF — authorises Resend to send for you | Yes |
   | `TXT` | `_dmarc` | DMARC policy. Start with `v=DMARC1; p=none; rua=mailto:you@yourdomain` | Strongly recommended |

   Copy the exact values from the Resend dashboard; the names above are the
   shape, not the content. Propagation is usually minutes but can take up to
   48 hours.
4. Wait for the domain to show **Verified**. Until it does, sends are rejected.
5. **API Keys → Create API Key.** Give it *Sending access* only. Copy it once —
   it is not shown again.

### Why a free mailbox will not work

Resend authenticates the sending *domain*. A `gmail.com` or `outlook.com`
address cannot be verified by you, because you do not control its DNS, so mail
from it will be rejected or land in spam. `server/config.mjs` refuses to start
in production with a free-mail sender, to catch this before customers do.

If you do not own a domain yet, use Resend's `onboarding@resend.dev` sender for
development. It can only deliver to the address that owns the Resend account,
which is enough to see real emails while testing.

---

## 3. Environment variables

Add these to `.env` (which is gitignored). `.env.example` documents them with
placeholders; never commit a real key.

```bash
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
RESEND_FROM_EMAIL=orders@yourdomain.com     # must be on the verified domain
RESEND_FROM_NAME=GEMIES
ADMIN_NOTIFICATION_EMAIL=ops@yourdomain.com # optional
APP_BASE_URL=https://yourdomain.com         # link base in every email
BUSINESS_EMAIL=hello@yourdomain.com         # where contact enquiries go
```

| Variable | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | Yes | Server only. Never referenced from `src/`. |
| `RESEND_FROM_EMAIL` | Yes | Bare address or `Name <addr>`. `EMAIL_FROM` is the former name and still works. |
| `RESEND_FROM_NAME` | No | Defaults to `GEMIES`. Ignored if `RESEND_FROM_EMAIL` already has a display name. |
| `ADMIN_NOTIFICATION_EMAIL` | No | Empty switches admin notifications off. Nothing else changes. |
| `APP_BASE_URL` | No | Alias of `APP_URL`. Must be HTTPS in production. |
| `BUSINESS_EMAIL` | No | Contact form recipient. Falls back to `store_settings.support_email`. |

**Startup guards.** Production refuses to boot without a key and a sender, and
refuses a free-mail sender. A malformed address or admin address is rejected in
every environment. Checkout already refuses to run in production without email
configured, so a customer cannot pay for an order that can never be confirmed.

---

## 4. Templates

22 templates, all rendering through one layout. Preview them with:

```bash
npm run email:preview
# then open tmp/email-previews/index.html
```

Design: white surface on a soft neutral page, black typography, beige and grey
accents, 600px wide, one pill call to action, responsive below 620px. Both an
HTML and a plain-text part are sent for every email.

The GEMIES logo is **live text, not an image**. Outlook and Gmail block images
from unknown senders by default, so an image logo would be a grey box for most
first-time recipients. There are zero `<img>` tags in any template.

| Template | Purpose |
|---|---|
| `welcome` | Account created |
| `verify` | Email confirmation link |
| `reset` | Password reset link |
| `password_changed` | Security notice after a password change or reset |
| `paid` | Order confirmation, with line items and totals |
| `invoice` | Invoice, with the PDF attached |
| `cancelled` | Order cancelled, nothing charged |
| `payment_failed` | Payment declined, retry link |
| `refund_started` | Refund initiated |
| `refunded` | Refund settled |
| `partially_refunded` | Partial refund settled |
| `refund_failed` | Refund rejected by the bank |
| `shipment_created` | Courier booked |
| `awb` | Tracking number issued |
| `tracking` | Status change — worded per stage (see below) |
| `contact_ack` | Acknowledgement to the customer |
| `contact_enquiry` | The enquiry, to the business inbox |
| `admin_order` | New paid order |
| `admin_payment_attention` | Payment needs manual review |
| `admin_cancelled` | Order cancelled |
| `admin_refund` | Refund initiated / completed / failed |
| `admin_error` | Integration failure needing action |

`tracking` renders five different messages from the courier's numeric status
code, so "out for delivery" and "delivered" are not the same email:

| Shiprocket code / text | Stage | Subject |
|---|---|---|
| `7`, "Delivered" | `delivered` | Delivered — order #N |
| `19`, "Out For Delivery" | `out_for_delivery` | Out for delivery — order #N |
| `6`, `17`, `18`, "In Transit" | `shipped` | Shipped — order #N |
| "RTO", "Undelivered", "Exception" | `exception` | Delivery needs attention — order #N |
| "Cancel" | `cancelled` | Shipment cancelled — order #N |
| anything else | `update` | Delivery update — order #N |

---

## 5. Triggers

Every row is a backend event. **No email is sent from a frontend action, a
success page, or a payment callback that has not been verified against the
provider.**

### Authentication

| Email | Trigger | Dedupe key |
|---|---|---|
| `welcome` | `POST /auth/register` created a new user | `welcome:{userId}` |
| `verify` | Registration, or `POST /auth/resend` | `verify:{tokenHash}` |
| `reset` | `POST /auth/forgot` | `reset:{tokenHash}` |
| `password_changed` | `POST /auth/password`, or a completed `POST /auth/reset` | `password-changed:{newHash}` |

Verification and reset links expire after **one hour** and are **single-use**
(the row is deleted by the same statement that reads it). A completed reset
deletes every session for that user. No email ever contains a password.

A per-login security notification is **not** implemented — see §9.

### Orders and payments

| Email | Trigger | Dedupe key |
|---|---|---|
| `paid` | `acceptCapturedPayment()` — inside the transaction that records a capture re-read from Razorpay | `paid:{orderId}` |
| `admin_order` | same | `admin:order:{orderId}` |
| `invoice` | the `invoice` job, after the order is paid | `invoice-email:{orderId}` |
| `payment_failed` | `payment.failed` webhook that actually moved the payment to failed | `payment-failed:{razorpayPaymentId}` |
| `cancelled` | `releaseOrder()` — reservation expiry or customer cancellation | `cancelled:{orderId}` |
| `admin_payment_attention` | capture arrived after the order lapsed (order → `review`) | `admin:review:{orderId}` |

`acceptCapturedPayment` is the only path that marks an order paid. It is
reached from the verified browser callback, the signed `payment.captured`
webhook, and the `payment_sync` reconciliation job — and all three re-read the
payment from Razorpay's API rather than trusting the request body. Because the
key is the order id, those three racing each other still produce one email.

`payment_failed` is deliberately skipped when the update is a no-op, so a late
`payment.failed` for a superseded attempt cannot tell a customer whose payment
succeeded that it failed.

### Refunds

| Email | Trigger | Dedupe key |
|---|---|---|
| `refund_started` | Razorpay accepted the refund request | `refund-started:{orderId}:{refundKey}` |
| `refunded` | reconciliation shows the full captured amount returned | `refunded:{orderId}` |
| `partially_refunded` | reconciliation settled part of the amount | `refunded:{orderId}:{refundKey}` |
| `refund_failed` | the gateway reported the refund failed | `refund-failed:{orderId}:{refundKey}` |
| `admin_refund` | alongside initiated, completed and failed | `admin:refund-*` |

### Shipping

| Email | Trigger | Dedupe key |
|---|---|---|
| `shipment_created` | Shiprocket returned shipment identifiers | `shipment-created:{orderId}` |
| `awb` | courier assigned an AWB | `awb:{orderId}` |
| `tracking` | `syncTracking()` saw the status actually change | `tracking:{shippingEventKey}` |
| `admin_error` | AWB assignment needs reconciliation; delivery exception or cancellation | `admin:awb-review:*`, `admin:delivery-*` |

Tracking is driven by the `tracking` job, which `maintenance()` re-enqueues on
a 15-minute bucket for every shipment that is not yet delivered or cancelled.
Polling the same status twice sends nothing: the email is queued only when
`before.status !== status`, and the key is the shipping event key.

Order status never regresses — delivery is set only from the authoritative
code and a delivered order is never moved backwards.

### Contact form

`POST /api/contact` → stores the enquiry, then queues `contact_enquiry` to
`BUSINESS_EMAIL` (reply-to: the customer) and `contact_ack` to the customer
(reply-to: the business). Keys are `contact:{id}` and `contact-ack:{id}`.

---

## 6. Duplicate prevention and retries

**One key is one email, forever.** The same string is used three times:

1. `jobs.dedupe_key` — `UNIQUE`, so a second enqueue is a no-op.
2. `email_notifications.dedupe_key` — `UNIQUE`, the permanent ledger.
3. Resend's `Idempotency-Key` header — Resend itself refuses a repeat for 24h.

`jobs.dedupe_key` is a single namespace across every job kind, so a new email
key must not collide with a non-email job key. This is why the invoice *job*
is `invoice:{id}` and the invoice *email* is `invoice-email:{id}`.

**Retries.** Up to 8 attempts, backing off `min(3600, 15 × 2^attempts)`
seconds: 30s, 1m, 2m, 4m, 8m, 16m, 32m, then hourly — about 2 hours of
attempts. After that the job is `failed` and the ledger row is `failed` with a
redacted reason.

An error whose message contains `reconciliation` is terminal immediately,
because retrying it would be unsafe or pointless. Two cases matter:

- the Resend idempotency window (23h) has elapsed while a send was `sending`,
  so a retry could deliver a duplicate;
- the order the email describes no longer exists.

**Failures never affect the operation.** Emails are queued inside the
transaction that records the state change, and sent afterwards by the worker.
A payment is captured, an order is confirmed, stock is consumed and the invoice
is generated whether or not the email ever sends. A customer is never shown an
email error.

**Ledger.** `email_notifications` records `template`, `recipient`, `subject`,
`user_id`, `order_id`, `status` (`pending` → `sending` → `sent` | `failed`),
`attempts`, `provider_id` (Resend's message id), `last_error`, `created_at`,
`updated_at`. Useful queries:

```sql
-- anything that never arrived
SELECT template, recipient, subject, attempts, last_error
  FROM email_notifications WHERE status <> 'sent' ORDER BY created_at DESC;

-- every email about one order
SELECT template, status, provider_id, created_at
  FROM email_notifications WHERE order_id = '...' ORDER BY created_at;

-- jobs that gave up
SELECT kind, dedupe_key, attempts, last_error FROM jobs WHERE status = 'failed';
```

A job's payload is wiped on success, because a verification payload contains a
live token. Use the ledger, not the job, for history.

---

## 7. Security

- The API key is read only in `server/providers.mjs`, from `process.env`. It is
  in no client bundle — verified by a case-sensitive scan of `.next/static`.
- Every dynamic value is HTML-escaped (`escape()` in `layout.mjs`), so customer
  input cannot open a tag or break out of an attribute.
- Call-to-action URLs are dropped unless they are `http(s)`, so a malformed
  value cannot become a `javascript:` link.
- Recipients come from `users.email` or a zod-validated form field.
- Order emails are addressed to the email recorded on the order. Order reads
  are guarded by `ownOrder`, so one customer cannot obtain another's order
  details.
- Rate limits: register 5, forgot 5, resend-verification 5, reset 10,
  password 5, contact 5 — each per IP per 15 minutes.
- Logs record a template name, the recipient's **domain**, and Resend's message
  id. Never an address, a body, a token or a credential. `last_error` is the
  same redacted string the job stores.
- The contact form has a honeypot field, a link-density check and a
  header-injection check. Spam is answered `202`, exactly like a success, so a
  bot learns nothing.

---

## 8. Testing

```bash
npm test                 # 44 tests, including 14 email tests
npm run email:preview    # render all templates to tmp/email-previews/
```

The suite stubs `api.resend.com`, so **no email is sent during tests**. It
asserts on the queue and the ledger, which is where correctness lives:

- registration queues one welcome and one verification, and re-registering
  queues neither again;
- a completed reset notifies the owner;
- a verified capture queues one confirmation, and replaying the capture queues
  none;
- an unpaid order queues no confirmation;
- a failed payment emails once per attempt and leaves the order retryable;
- shipping stages map correctly and an unchanged status sends nothing;
- refund initiation and completion do not duplicate;
- admin notifications are skipped when no admin address is set, and nothing is
  ever queued to an empty recipient;
- a permanently failed send is recorded as `failed` with a reason containing no
  credential;
- the contact form validates, stores, acknowledges, deduplicates and
  rate-limits, and rejects honeypot, link-spam and header injection;
- every email about an order goes only to the order's own address;
- no template leaks the API key or renders unescaped input.

### Sending a real email in development

1. Put a real `RESEND_API_KEY` in `.env` and set
   `RESEND_FROM_EMAIL=onboarding@resend.dev`.
2. Register with the address that owns your Resend account — `onboarding@resend.dev`
   can only deliver there.
3. `npm run dev`, then watch the worker log for
   `{"event":"email_sent",...}` and check **Resend → Logs**.

Do not point a development environment at a production key and real customer
addresses.

---

## 9. Not implemented

**Per-login security notification.** The brief lists it as conditional on the
existing authentication flow supporting it, and it does not: there is no device
or IP fingerprinting, and login deletes the previous session rather than
tracking a new one. Implemented as-is it would email on *every* sign-in, which
trains people to ignore it. Adding it needs a decision about what counts as a
new device, plus somewhere to record known ones. `password_changed` covers the
security notification that matters most.

---

## 10. Production deployment

1. Verify your domain in Resend; confirm it shows **Verified**.
2. Create a sending-only API key.
3. Set `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (on the verified domain),
   `RESEND_FROM_NAME`, `ADMIN_NOTIFICATION_EMAIL`, `BUSINESS_EMAIL`, and an
   HTTPS `APP_BASE_URL`. Also set `BUSINESS_NAME` and `BUSINESS_ADDRESS`, which
   invoices require.
4. `npm run migrate`.
5. Start the app. It will refuse to boot if email is unconfigured, if the
   sender is a free mailbox, or if `APP_BASE_URL` is not HTTPS.
6. Ensure a worker is running: in-process by default, or `npm run worker` as a
   separate process with PostgreSQL.
7. Place one test order end to end and confirm the confirmation and invoice
   arrive, then check **Resend → Logs** for delivery and bounce status.
8. Watch `SELECT * FROM email_notifications WHERE status <> 'sent'` for the
   first days.
9. Tighten DMARC to `p=quarantine` once you see clean delivery.

### Deliverability

- Keep the sending domain the same as the site's domain.
- Transactional mail only. Nothing here is marketing, which is why none of the
  templates carry an unsubscribe link; if you add marketing email, it needs
  one and should use a separate subdomain.
- Monitor bounces in Resend. A hard bounce means the address is wrong; the
  ledger will show `sent` because Resend accepted it, so bounces are only
  visible in the dashboard.
