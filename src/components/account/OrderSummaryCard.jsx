'use client';
import {money} from '../../api.js';
import {Icon} from '../../components.jsx';
import {buttonClasses} from '../ui/Button.jsx';

/**
 * The money panel on the order details page.
 *
 * Deliberately NOT the shared `Summary` from components.jsx, which the cart
 * and the checkout both render. Those two are quoting a total the customer is
 * about to agree to; this one is a receipt for a total already settled, and it
 * carries actions that only exist after the fact -- the invoice and a status
 * refresh. Restyling the shared component to look like this would have
 * redesigned the cart and the checkout as a side effect.
 *
 * Every figure comes from the order document. Nothing is recomputed here: the
 * server's subtotal, discount, shipping, tax and total are what was charged,
 * and a total re-added in the browser could disagree with the invoice.
 */
export function OrderSummaryCard({order, units, onRefresh, refreshing = false, children}) {
  const currency = order.currency;
  const rows = [
    [units === 1 ? 'Subtotal (1 item)' : `Subtotal (${units} items)`, order.subtotal ?? 0],
    ['Discount', order.discount ?? 0, 'negative'],
    ['Shipping', order.shipping ?? 0],
    ['Tax', order.tax ?? 0],
  ];

  return (
    <aside className="overflow-hidden rounded-[14px] border border-track-border bg-white shadow-[0_1px_3px_rgba(17,24,39,0.06)] lg:sticky lg:top-6">
      <header className="flex items-center gap-3 bg-track-green-deep px-5 py-4 text-white md:px-6">
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-white/15">
          <Icon name="bag" size={17} strokeWidth={1.9} />
        </span>
        <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-white md:text-lg">Order summary</h2>
      </header>

      <div className="px-5 py-5 md:px-6">
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-3.5 text-[13px]">
          {rows.map(([label, value, tone]) => (
            <div key={label} className="col-span-2 grid grid-cols-subgrid">
              <dt className="m-0 text-track-muted">{label}</dt>
              <dd className="m-0 text-right font-medium text-track-ink tabular-nums">
                {/* The minus is shown only when something was actually taken
                    off. "- ₹0.00" on an order with no discount reads as a
                    failed coupon. */}
                {tone === 'negative' && value > 0 ? '− ' : ''}
                {money(value, currency)}
              </dd>
            </div>
          ))}

          {/* Coins only appear when coins were spent, and are shown because
              the total above is the order's value, not what the card was
              charged -- without this row the two look like a discrepancy. */}
          {order.wallet_applied > 0 && (
            <div className="col-span-2 grid grid-cols-subgrid">
              <dt className="m-0 text-track-muted">GEMIES coins</dt>
              <dd className="m-0 text-right font-medium text-track-green tabular-nums">
                − {money(order.wallet_applied, currency)}
              </dd>
            </div>
          )}
        </dl>

        <div className="mt-5 flex items-end justify-between gap-4 border-t border-track-border pt-5">
          <span className="text-[17px] font-semibold text-track-ink md:text-lg">Total</span>
          <strong className="text-xl leading-none font-bold text-track-ink tabular-nums md:text-[22px]">
            {money(order.total ?? 0, currency)}
          </strong>
        </div>

        <div className="mt-5 flex flex-col gap-2.5">
          {children}

          {/* A plain anchor, not a Button: the endpoint streams a PDF with a
              Content-Disposition attachment header, and routing that through
              next/link would try to navigate to it. */}
          {order.invoice ? (
            <a
              className={buttonClasses('dark', 'w-full !bg-track-green-deep !border-track-green-deep hover:!bg-[#084a22]')}
              href={`/api/orders/${order.id}/invoice`}
            >
              <Icon name="download" size={16} strokeWidth={2} />
              Download invoice
            </a>
          ) : (
            order.payment_status === 'paid' && (
              <p className="m-0 rounded-[10px] bg-track-surface px-4 py-3 text-center text-[12px] leading-snug text-track-muted">
                Your invoice is being prepared and will appear here shortly.
              </p>
            )
          )}

          <button
            type="button"
            className={buttonClasses('outline', 'w-full !border-track-border !text-track-ink hover:!bg-track-surface')}
            onClick={onRefresh}
            disabled={refreshing}
          >
            <Icon name="refresh" size={16} strokeWidth={2} className={refreshing ? 'animate-spin' : undefined} />
            {refreshing ? 'Refreshing…' : 'Refresh order status'}
          </button>
        </div>

        <p className="mt-3 mb-0 flex items-center justify-center gap-2 rounded-[10px] bg-track-green-soft px-4 py-3 text-[12px] font-medium text-track-green">
          <Icon name="shield" size={15} strokeWidth={1.9} />
          Secure checkout with Razorpay
        </p>
      </div>
    </aside>
  );
}
