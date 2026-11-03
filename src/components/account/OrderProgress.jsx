'use client';
import {Icon} from '../../components.jsx';

/**
 * The two progress trackers on the order details page.
 *
 * `OrderProgress` is the headline one: the four states an order moves through
 * in this shop. `ShipmentSteps` is the small one inside the shipping card and
 * follows the parcel instead, which is a different journey -- an order is
 * "shipped" the moment dispatch is confirmed, whereas the parcel has a pickup,
 * a transit and a delivery run under that single word.
 *
 * Neither invents a position. Both are given a value the server already
 * decided and only choose how to draw it.
 */

/*
  The four order states, in order.

  This array *is* the ranking. server/fulfillment.mjs holds the same sequence
  as `ORDER_RANK = {confirmed: 1, processing: 2, shipped: 3, delivered: 4}` and
  uses it to refuse to move an order backwards; here the index does the same
  job, so there is no second copy of those numbers to fall out of step with it
  -- adding a state in one place is a visible omission in the other rather than
  a silent disagreement.

  The caption under each label is the customer-facing promise for that state,
  and is the only text on this page that is not derived from order data.
*/
const STEPS = [
  {status: 'confirmed', label: 'Confirmed', caption: 'Your order is received', icon: 'check'},
  {status: 'processing', label: 'Processing', caption: 'We’re preparing your order', icon: 'box'},
  {status: 'shipped', label: 'Shipped', caption: 'Your order is on the way', icon: 'truck'},
  {status: 'delivered', label: 'Delivered', caption: 'Order completed', icon: 'bag'},
];

/**
 * How many of the four steps the given order status has completed.
 *
 * Anything not in the sequence returns 0 and the tracker draws as entirely
 * upcoming. That is deliberate rather than a gap: `pending` and `review` have
 * not been confirmed, and `cancelled` and `refunded` have left the sequence
 * altogether. In every one of those cases the page shows a notice above the
 * tracker saying so, and a tracker with a green tick on it would contradict
 * that notice.
 */
export const stepsReached = (status) => STEPS.findIndex((s) => s.status === status) + 1;

export function OrderProgress({status}) {
  const reached = stepsReached(status);

  return (
    <ol
      className="m-0 mb-8 flex list-none items-start gap-0 p-0 md:mb-10"
      aria-label="Order progress"
    >
      {STEPS.map((step, i) => {
        const done = i < reached;
        // The furthest completed step is where the order actually is, so it
        // carries the emphasis. Without this every completed step looks
        // equally current and the customer has to count circles.
        const current = i === reached - 1;
        return (
          <li
            key={step.status}
            className="relative flex min-w-0 flex-1 flex-col items-center text-center"
            aria-current={current ? 'step' : undefined}
          >
            {/* The connector into this step, drawn from the previous circle's
                centre to this one's. Laid out relative to the step it leads
                *into* so its colour is that step's business: a segment is
                green only once the step on its right has been reached. */}
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`absolute top-[17px] right-1/2 -left-1/2 h-0.5 ${
                  done ? 'bg-track-green' : 'bg-track-border'
                }`}
              />
            )}

            {/* The background is set in one branch or the other, never both.
                A `bg-white` out here plus a `bg-track-green` in the branch is
                two competing `bg-*` utilities on one element, and which one
                wins is decided by their order in the generated stylesheet,
                not by their order in this string -- `.bg-white` is emitted
                later, so it silently took every completed circle back to
                white and left a white tick invisible on it. */}
            <span
              className={`relative z-10 grid size-9 shrink-0 place-items-center rounded-full border-2 ${
                done
                  ? 'border-track-green bg-track-green text-white'
                  : 'border-track-border bg-white text-[#9ca3af]'
              } ${current ? 'ring-4 ring-track-green-soft' : ''}`}
            >
              <Icon name={done ? 'check' : step.icon} size={done ? 18 : 16} strokeWidth={done ? 2.6 : 1.7} />
            </span>

            <span
              className={`mt-2.5 block text-[11px] leading-tight md:text-[13px] ${
                done ? 'font-semibold text-track-ink' : 'font-medium text-track-muted'
              }`}
            >
              {step.label}
            </span>
            {/* Four captions do not fit beside one another on a phone, and
                truncating them would leave four half-sentences. The labels
                alone still carry the state. */}
            <span className="mt-1 hidden text-[11px] leading-snug text-track-muted sm:block">
              {step.caption}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------- parcel journey */

/*
  The parcel's milestones, each with the stage rank that satisfies it.

  The numbers are the ranks in sr.STAGES (server/shiprocket.mjs): picked_up is
  30, out_for_delivery 50, delivered 60. They are thresholds rather than
  equality tests, which is what makes this robust to the stages in between --
  a parcel sitting at `in_transit` (40) has self-evidently been picked up, and
  one that went straight to `delivered` without an out-for-delivery scan still
  shows both. The tracking endpoint sends `rank` for exactly this comparison.

  "Order Placed" is rank 0: it is true as soon as there is an order at all, so
  it is always complete and is dated from the order itself, not from a courier
  scan.
*/
const SHIP_STEPS = [
  {label: 'Order Placed', rank: 0, icon: 'check'},
  {label: 'Shipped', rank: 30, icon: 'truck'},
  {label: 'Out for Delivery', rank: 50, icon: 'box'},
  {label: 'Delivered', rank: 60, icon: 'check'},
];

const shortDate = (value) =>
  new Date(value).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});

/**
 * When a milestone was first met, from the stored history.
 *
 * `history` arrives newest-first, so the *last* entry at or above the
 * threshold is the earliest one -- the scan that first satisfied this step.
 * The later ones are the parcel moving on from it.
 */
function reachedAt(history, threshold) {
  const matches = history.filter((entry) => (entry.rank ?? 0) >= threshold && entry.at);
  return matches.length ? matches.at(-1).at : null;
}

export function ShipmentSteps({rank = 0, history = [], placedAt}) {
  return (
    <ol className="m-0 flex list-none items-start gap-0 p-0" aria-label="Shipment progress">
      {SHIP_STEPS.map((step, i) => {
        const done = rank >= step.rank;
        const at = step.rank === 0 ? placedAt : reachedAt(history, step.rank);
        return (
          <li key={step.label} className="relative flex min-w-0 flex-1 flex-col items-center text-center">
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`absolute top-[11px] right-1/2 -left-1/2 border-t-2 border-dashed ${
                  done ? 'border-track-green' : 'border-track-border'
                }`}
              />
            )}
            <span
              className={`relative z-10 grid size-6 shrink-0 place-items-center rounded-full border-2 ${
                done ? 'border-track-green bg-track-green text-white' : 'border-track-border bg-white text-[#9ca3af]'
              }`}
            >
              <Icon name={done ? 'check' : step.icon} size={done ? 13 : 12} strokeWidth={done ? 2.8 : 1.8} />
            </span>
            <span
              className={`mt-2 block text-[10px] leading-tight ${
                done ? 'font-semibold text-track-ink' : 'text-track-muted'
              }`}
            >
              {step.label}
            </span>
            {/* Only dated when it has actually happened. An undated future
                milestone is honest; an estimated one on a tracker reads as a
                promise the courier has not made. */}
            {at && <span className="mt-0.5 block text-[10px] text-track-muted">{shortDate(at)}</span>}
          </li>
        );
      })}
    </ol>
  );
}
