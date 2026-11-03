# Razorpay dashboard setup

**Everything in this document is manual work in the Razorpay dashboard. None of
it can be done from code, and none of it has been done for you.** The
integration will not take a payment until steps 1–6 are complete.

Where a step changes something the application reads, the environment variable
is named. After changing `.env`, restart the API: configuration is validated at
startup and the process refuses to boot on a mismatch.

---

## Test mode

### 1. Generate test API keys

Dashboard → **Settings → API Keys** → *Generate Test Key*.

The secret is shown **once**. Put both into `.env`:

```
RAZORPAY_MODE=test
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

Startup checks that the key prefix matches `RAZORPAY_MODE`. A live key with
`RAZORPAY_MODE=test` (or the reverse) will not boot.

### 2. Enable automatic payment capture

Dashboard → **Settings → Payment Configuration → Auto-capture**, set to capture
payments automatically.

**This is a dashboard setting and the only thing that makes capture automatic.**
The code cannot enable it, and does not try to: it never sends `capture: 1` and
never calls the capture endpoint itself. It only ever *reads* whether Razorpay
captured the payment.

If you leave auto-capture off, payments will authorise and never capture. The
application handles that safely — the order stays `pending_payment`, no stock is
consumed and nothing is fulfilled — but no order will ever complete. Verify this
setting before testing.

### 3. Create the webhook endpoint

Dashboard → **Settings → Webhooks** → *Add New Webhook*.

Webhook URL: `https://your-domain/api/webhooks/razorpay`

Must be HTTPS and publicly reachable. For local testing, tunnel it:

```
ngrok http 3000
# then use https://<id>.ngrok-free.app/api/webhooks/razorpay
```

The route is mounted ahead of the JSON body parser so it receives the raw
bytes Razorpay signed. Nothing about that needs configuring.

### 4. Set the webhook secret

On the same screen, set a **webhook secret**. Generate a long random value:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put it in `.env`:

```
RAZORPAY_WEBHOOK_SECRET=<the value you just set in the dashboard>
```

**This is not your API key secret.** They are separate values and startup fails
if you set them to the same thing. Confusing the two is the single most common
way this integration is misconfigured: every webhook would fail its signature
check, and captured payments whose browser callback never arrived would never
reconcile.

To rotate it later without downtime, put the old value in
`RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, change the dashboard secret, then remove the
old one once no further deliveries are signed with it.

### 5. Subscribe to events

Tick exactly these on the webhook:

| Event | Why it is needed |
|---|---|
| `payment.authorized` | Records the attempt. Does **not** fulfil. |
| `payment.captured` | The event that marks the order paid. |
| `payment.failed` | Records the failed attempt; leaves the order open for a retry. |
| `order.paid` | Backstop for `payment.captured`. |
| `refund.created` | Picks up a refund started outside the admin. |
| `refund.processed` | Settles the refund and the order's payment state. |
| `refund.failed` | Releases the order from `refunding`. |

Any other event is accepted, recorded and ignored, so subscribing to more is
harmless but pointless.

### 6. Test webhook delivery

Use *Send Test Webhook* on the webhook screen. A correct setup returns **200**
with `{"ok":true}`.

- **401/400 invalid signature** → `RAZORPAY_WEBHOOK_SECRET` does not match the
  dashboard value.
- **409 awaiting reconciliation** on a refund event → expected for a refund this
  database has no record of. Razorpay will retry.
- **Timeout** → the URL is not reachable from the internet.

Then run a real test payment with a [test card](https://razorpay.com/docs/payments/payments/test-card-details/)
(`4111 1111 1111 1111`, any future expiry, any CVV) and confirm in the admin
order screen that:

- payment status is `captured`, with a `pay_...` reference
- order status is `confirmed`
- the payment attempt is listed
- stock dropped by exactly the quantity ordered

### 7. Verify captured, not just authorised

Dashboard → **Transactions → Payments**. The payment must read **Captured**, not
*Authorized*. If it reads *Authorized*, step 2 is not done.

---

## Live mode

Do not start this until test mode works end to end.

### 8. Complete KYC and generate live keys

Razorpay requires business verification before live keys are issued. Once
approved: **Settings → API Keys**, switch to **Live** mode, generate the key.

Keep live credentials in a separate `.env` for the production deployment. Never
put live keys in the development `.env`.

```
NODE_ENV=production
RAZORPAY_MODE=live
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=<the live webhook's own secret>
```

Live mode additionally requires `NODE_ENV=production` and an `https://` `APP_URL`;
startup refuses otherwise. A live key in a development environment is rejected
outright.

### 9. Create the live webhook separately

Webhooks are **per mode**. The test webhook does not carry over. Repeat steps
3–5 in live mode, against your production domain, with its **own** secret.

### 10. Enable auto-capture in live mode

Repeat step 2 in live mode. It is a separate setting from the test one. This is
the step most likely to be missed, and missing it means no live order ever
completes.

### 11. Verify a live transaction

Take one real low-value payment. Confirm the payment reads **Captured** in the
dashboard, the order reads `confirmed`, the invoice was generated and the
confirmation email was sent. Then refund it from the admin screen and confirm
the refund reaches **processed**.

---

## Checklist

| | Step | Mode |
|---|---|---|
| ☐ | Test API keys generated and in `.env` | test |
| ☐ | **Auto-capture enabled** | test |
| ☐ | Webhook endpoint created | test |
| ☐ | Webhook secret set, different from the API secret | test |
| ☐ | Seven events subscribed | test |
| ☐ | Test delivery returns 200 | test |
| ☐ | Test payment reads *Captured* | test |
| ☐ | KYC approved, live keys issued | live |
| ☐ | Live webhook created with its own secret | live |
| ☐ | **Auto-capture enabled in live mode** | live |
| ☐ | One live payment captured, then refunded | live |

## Also required before taking real money

These are outside Razorpay but block a real checkout:

- `BUSINESS_NAME`, `BUSINESS_ADDRESS`, `BUSINESS_EMAIL` — checkout refuses in
  production without them, because an invoice cannot be issued.
- `RESEND_API_KEY`, `EMAIL_FROM` — same; no confirmation email can be sent.
- `store_settings.tax_bps` — tax is added on top of listed prices at this rate.
  It is currently `0`, so prices are treated as final.
- `store_settings.returns_policy` — empty, so the product page states that no
  policy is published.

See `docs/RAZORPAY_PAYMENT_INTEGRATION.md` for what the code does with all of
this.
