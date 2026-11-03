'use client';
import {useState} from 'react';
import {api, money} from '../../api.js';
import {useStore, useResource, Loading} from '../../components.jsx';
import {Button, buttonClasses} from '../ui/Button.jsx';

/**
 * Request an exchange on one order.
 *
 * Eligibility is asked of the server before the form is shown, so a customer
 * is never offered a form the server would refuse, and the returnable
 * quantities come from the server too -- units already committed to another
 * live request are excluded.
 *
 * The coin figure quoted here is the server's calculation from what was
 * actually paid for those lines. It is explicitly labelled as an estimate
 * subject to inspection, because it is: nothing is credited until the item
 * comes back and passes.
 */

const REASONS = [
  ['size_too_small', 'Size too small'],
  ['size_too_large', 'Size too large'],
  ['damaged', 'Damaged product'],
  ['wrong_product', 'Wrong product received'],
  ['other', 'Something else'],
];

/** Reasons where a different size is the point of the exchange. */
const SIZE_REASONS = new Set(['size_too_small', 'size_too_large']);

export function ExchangeRequest({orderId, onClose, onCreated}) {
  const {data, loading, error} = useResource(`/orders/${orderId}/exchange-eligibility`);
  const {notify} = useStore();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState({});
  const [replacements, setReplacements] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  if (loading) return <Loading/>;

  if (error || !data?.eligible) {
    return (
      <div className="rounded-lg border border-rule bg-white p-[22px] md:p-7">
        <h3 className="m-0 text-[18px] md:text-xl">Exchange not available</h3>
        <p className="m-0 mt-2.5 text-[13px] leading-relaxed text-ink-soft md:text-sm">
          {error || data?.reason || 'This order cannot be exchanged.'}
        </p>
        <button className={`${buttonClasses('outline')} mt-5`} onClick={onClose}>Close</button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="rounded-lg border border-rule bg-white p-[22px] md:p-7">
        <h3 className="m-0 text-[18px] md:text-xl">Exchange request received</h3>
        <p className="m-0 mt-2.5 text-[13px] leading-relaxed text-ink-soft md:text-sm">
          We will review it and email you. If it is approved we will arrange collection, and{' '}
          <strong className="text-ink">
            {done.coins.toLocaleString('en-IN')} GEMIES coins ({money(done.eligibleInr, 'INR')})
          </strong>{' '}
          will be added to your wallet once the item reaches us and passes inspection.
        </p>
        <button className={`${buttonClasses('dark')} mt-5`} onClick={onClose}>Done</button>
      </div>
    );
  }

  const items = data.items ?? [];
  const chosen = items.filter((item) => (picked[item.id] ?? 0) > 0);
  const needsNote = reason === 'other';
  const valid = reason && chosen.length > 0 && (!needsNote || note.trim().length >= 5);

  const setQuantity = (item, value) => setPicked((old) => ({...old, [item.id]: value}));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api(`/orders/${orderId}/exchange`, {
        method: 'POST',
        body: {
          reason,
          note: note.trim(),
          images: [],
          items: chosen.map((item) => ({
            order_item_id: item.id,
            quantity: picked[item.id],
            ...(replacements[item.id] ? {replacement_variant_id: replacements[item.id]} : {}),
          })),
        },
      });
      setDone(result);
      onCreated?.();
    } catch (requestError) {
      notify(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rounded-lg border border-rule bg-white p-[22px] md:p-7" onSubmit={submit}>
      <h3 className="m-0 text-[18px] md:text-xl">Request an exchange</h3>

      {/* The policy, stated before anything is submitted, and built from the
          configured window rather than from fixed prose. */}
      <div className="mt-4 rounded-md border border-[#e6ddcb] bg-[#f5efe4] px-4 py-3.5">
        <p className="m-0 text-[12px] leading-relaxed text-[#765e35] md:text-[13px]">
          <strong>GEMIES does not issue cash refunds.</strong> An approved exchange is credited as
          GEMIES store coins, which you can spend on your next order. Coins are added only after the
          returned item reaches us and passes inspection — not when you submit this request.
          {data.closesAt && (
            <> Your {data.windowDays}-day exchange window closes on{' '}
              {new Date(data.closesAt).toLocaleDateString()}.</>
          )}
        </p>
      </div>

      <fieldset className="mt-6 border-0 p-0">
        <legend className="mb-2.5 p-0 text-[13px] font-semibold md:text-sm">What would you like to send back?</legend>
        <div className="grid gap-2">
          {items.map((item) => {
            const quantity = picked[item.id] ?? 0;
            return (
              <div key={item.id} className="rounded-md border border-rule px-4 py-3.5">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={quantity > 0}
                    onChange={(event) => setQuantity(item, event.target.checked ? 1 : 0)}
                    className="mt-1 size-4 shrink-0"
                  />
                  {item.image && (
                    <img src={item.image} alt="" className="size-14 shrink-0 rounded-md border border-rule bg-panel object-contain"/>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold md:text-sm">{item.name}</span>
                    <span className="mt-0.5 block text-[12px] text-ink-soft">
                      {item.size} / {item.color} · {money(item.unit_price, 'INR')}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-ink-soft">
                      {item.returnable} of {item.quantity} available to exchange
                    </span>
                  </span>
                </label>

                {quantity > 0 && (
                  <div className="mt-3 flex flex-wrap items-end gap-4 pl-7">
                    <label className="text-[12px]">
                      <span className="mb-1 block font-medium">Quantity</span>
                      <select
                        value={quantity}
                        onChange={(event) => setQuantity(item, Number(event.target.value))}
                        className="min-h-10 rounded-md border border-line px-2.5 text-[13px]"
                      >
                        {Array.from({length: item.returnable}, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </label>

                    {/* Only asked where a different size is the point of the
                        exchange. A damaged item does not need one. */}
                    {SIZE_REASONS.has(reason) && (
                      <label className="text-[12px]">
                        <span className="mb-1 block font-medium">Preferred size</span>
                        <ReplacementPicker
                          productSlug={item.product_slug}
                          value={replacements[item.id] ?? ''}
                          onChange={(value) => setReplacements((old) => ({...old, [item.id]: value}))}
                        />
                      </label>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      <label className="mt-6 block">
        <span className="mb-1.5 block text-[13px] font-semibold md:text-sm">Why are you exchanging it?</span>
        <select
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
          className="min-h-11 w-full max-w-[360px] rounded-md border border-line px-3 text-[13px] md:text-sm"
        >
          <option value="">Choose a reason</option>
          {REASONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </label>

      <label className="mt-4 block">
        <span className="mb-1.5 block text-[13px] font-semibold md:text-sm">
          Anything else we should know?{needsNote && <span className="font-normal text-ink-soft"> — required</span>}
        </span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={1000}
          rows={3}
          className="w-full rounded-md border border-line px-3 py-2.5 text-[13px] md:text-sm"
        />
      </label>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-rule pt-5">
        <Button variant="dark" type="submit" disabled={busy || !valid}>
          {busy ? 'Submitting…' : 'Submit exchange request'}
        </Button>
        <button type="button" className={buttonClasses('outline')} onClick={onClose}>Cancel</button>
        {chosen.length > 0 && (
          <span className="text-[12px] text-ink-soft">
            {chosen.reduce((n, item) => n + picked[item.id], 0)} item(s) selected
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * The sizes a customer could have instead.
 *
 * Reads the public product endpoint, which reports `available` per variant, so
 * a size that is out of stock is not offered as a replacement.
 */
function ReplacementPicker({productSlug, value, onChange}) {
  const {data} = useResource(productSlug ? `/products/${productSlug}` : null);
  const variants = (data?.variants ?? []).filter((variant) => variant.available > 0);

  if (!productSlug) {
    return <span className="block min-h-10 text-[12px] text-ink-soft">We will confirm sizes with you.</span>;
  }
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="min-h-10 rounded-md border border-line px-2.5 text-[13px]"
    >
      <option value="">No preference</option>
      {variants.map((variant) => (
        <option key={variant.id} value={variant.id}>{variant.size} / {variant.color}</option>
      ))}
    </select>
  );
}

/* ------------------------------------------------------- on the order page */

const STATUS_COPY = {
  requested: ['Requested', 'We have your request and will review it shortly.'],
  under_review: ['Under review', 'Our team is looking at your request.'],
  approved: ['Approved', 'We will arrange collection of the item.'],
  rejected: ['Not approved', 'This request was not approved.'],
  pickup_scheduled: ['Pickup scheduled', 'A courier will collect the item.'],
  picked_up: ['Collected', 'The item is on its way back to us.'],
  received: ['Received', 'The item has reached us and is waiting to be inspected.'],
  inspection_passed: ['Inspection passed', 'Your coins are being released.'],
  coins_credited: ['Coins credited', 'The coins are in your wallet.'],
  inspection_failed: ['Inspection failed', 'The item did not pass inspection.'],
  cancelled: ['Cancelled', 'This request was cancelled.'],
};

/** The order of the workflow as a customer experiences it. */
const PROGRESS = ['requested', 'approved', 'picked_up', 'received', 'coins_credited'];

/**
 * The exchange block on an order page: existing requests and their progress,
 * plus the button to raise a new one.
 *
 * The button only appears when the server says the order is eligible, so it is
 * never offered for an order outside its window or with nothing left to
 * return.
 */
export function OrderExchange({order, onChange}) {
  const [open, setOpen] = useState(false);
  const eligibility = useResource(`/orders/${order.id}/exchange-eligibility`);
  const mine = useResource('/exchanges?limit=50');
  const {notify} = useStore();
  const [busy, setBusy] = useState('');

  const requests = (mine.data?.rows ?? []).filter((row) => row.order_id === order.id);
  const canRequest = eligibility.data?.eligible === true;

  // Nothing to say on an order that can neither be exchanged nor already has
  // a request, rather than an empty panel on every order.
  if (!canRequest && requests.length === 0) return null;

  async function cancel(id) {
    setBusy(id);
    try {
      await api(`/exchanges/${id}/cancel`, {method: 'POST'});
      notify('Exchange request cancelled.');
      mine.reload();
      eligibility.reload();
      onChange?.();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="mt-6 md:mt-8">
      <h2 className="m-0 mb-4 text-[20px] md:text-[22px]">Exchanges</h2>

      {requests.length > 0 && (
        <ul className="m-0 mb-5 grid list-none gap-3 p-0">
          {requests.map((row) => {
            const [title, text] = STATUS_COPY[row.status] ?? [row.status, ''];
            const step = PROGRESS.indexOf(row.status);
            const dead = ['rejected', 'cancelled', 'inspection_failed'].includes(row.status);
            return (
              <li key={row.id} className="rounded-lg border border-rule bg-white p-[18px] md:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="m-0 text-[14px] font-semibold md:text-[15px]">
                      Request #{row.number} — {title}
                    </p>
                    <p className="m-0 mt-1 text-[12px] leading-relaxed text-ink-soft md:text-[13px]">{text}</p>
                  </div>
                  {row.eligible_coins != null && (
                    <p className="m-0 text-right">
                      <span className="block text-[15px] font-bold">{row.eligible_coins.toLocaleString('en-IN')}</span>
                      <span className="text-[11px] text-ink-soft">
                        coins {row.status === 'coins_credited' ? 'credited' : 'if approved'}
                      </span>
                    </p>
                  )}
                </div>

                {/* A plain five-step bar. Nothing is shown as complete that the
                    workflow has not actually reached. */}
                {!dead && (
                  <div className="mt-4 flex gap-1" aria-hidden="true">
                    {PROGRESS.map((stage, index) => (
                      <span
                        key={stage}
                        className={`h-1 flex-1 rounded-full ${index <= step ? 'bg-ink' : 'bg-line'}`}
                      />
                    ))}
                  </div>
                )}

                {['requested', 'under_review', 'approved'].includes(row.status) && (
                  <button
                    type="button"
                    disabled={busy === row.id}
                    onClick={() => cancel(row.id)}
                    className="mt-4 text-[12px] underline underline-offset-4 disabled:opacity-50"
                  >
                    {busy === row.id ? 'Cancelling…' : 'Cancel this request'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {open ? (
        <ExchangeRequest
          orderId={order.id}
          onClose={() => setOpen(false)}
          onCreated={() => { mine.reload(); eligibility.reload(); onChange?.(); }}
        />
      ) : canRequest && (
        <button className={buttonClasses('outline')} onClick={() => setOpen(true)}>
          Request an exchange
        </button>
      )}
    </section>
  );
}
