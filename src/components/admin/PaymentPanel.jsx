'use client';
import { useState } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';
import { api, money } from '../../api.js';
import { useStore, useResource } from '../../components.jsx';
import { AdminField, Badge, Btn, Skeleton, StatusBadge } from './kit.jsx';

/**
 * Transaction detail and refund action for one order.
 *
 * Reads /admin/orders/:id/payment, which selects named columns only, so no
 * credential can reach this screen through a later column addition.
 *
 * The refund key is generated once when the form is opened and reused for
 * every submit of that form. That is deliberate: a double-clicked or retried
 * submit carries the same key and the server returns the existing refund
 * instead of issuing a second one. Opening the form again produces a new key,
 * which is how a genuinely separate partial refund is expressed.
 *
 * Rendered inside the order Modal, so it uses flat tinted tiles rather than
 * nested Cards -- a card inside a dialog reads as a second dialog.
 */
export function PaymentPanel({ orderId, onChange, blocked = false }) {
  const { data, loading, error, reload } = useResource(`/admin/orders/${orderId}/payment`);
  const { notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [refundKey, setRefundKey] = useState('');

  if (loading) {
    return (
      <section className="mt-5 border-t border-admin-border pt-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-4 h-20 w-full" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="mt-5 border-t border-admin-border pt-5">
        <p className="m-0 mb-3 text-[14px] text-admin-danger">{error}</p>
        <Btn icon={RefreshCw} onClick={reload}>Retry</Btn>
      </section>
    );
  }

  const { order, payment, attempts, refunds, refundable, mode } = data;
  const currency = payment?.currency ?? order.currency;
  const overRefund = amount.trim() !== '' && Math.round(Number(amount) * 100) > refundable;

  function openForm() {
    setRefundKey(`adm-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`);
    setAmount('');
    setReason('');
    setOpen(true);
  }

  async function submitRefund(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const whole = amount.trim() === '';
      const minor = whole ? undefined : Math.round(Number(amount) * 100);
      const result = await api(`/admin/orders/${orderId}/refund`, {
        method: 'POST',
        body: { reason, ...(whole ? {} : { amount: minor, refundKey }) },
      });
      notify(`Refund ${result.status} for ${money(result.amount, currency)}.`);
      setOpen(false);
      reload();
      onChange?.();
    } catch (requestError) {
      notify(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    try {
      await api(`/admin/orders/${orderId}/sync-refund`, { method: 'POST' });
      notify('Refund status synchronised.');
      reload();
      onChange?.();
    } catch (requestError) {
      notify(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-5 border-t border-admin-border pt-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 text-[18px] leading-tight font-semibold tracking-[-0.01em] text-admin-text">Transaction</h3>
        <Badge tone={mode === 'live' ? 'info' : 'neutral'}>Razorpay {mode} mode</Badge>
      </div>

      {!payment ? (
        <p className="m-0 text-[14px] text-admin-text-2">No payment has been created for this order yet.</p>
      ) : (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-[14px] [&_dd]:m-0 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-admin-text-2">
          <dt>Payment status</dt><dd><StatusBadge value={payment.status} /></dd>
          <dt>Method</dt><dd>{payment.method || 'Not recorded'}</dd>
          <dt>Amount</dt><dd className="font-medium">{money(payment.amount, currency)}</dd>
          <dt>Razorpay order</dt><dd>{payment.gateway_order_id || 'Not created'}</dd>
          <dt>Razorpay payment</dt><dd>{payment.gateway_payment_id || 'Not captured'}</dd>
          <dt>Authorised</dt><dd>{payment.authorized_at ? new Date(payment.authorized_at).toLocaleString() : '—'}</dd>
          <dt>Captured</dt><dd>{payment.captured_at ? new Date(payment.captured_at).toLocaleString() : '—'}</dd>
          <dt>Refunded</dt><dd>{money(payment.refunded_amount, currency)}</dd>
          <dt>Refundable</dt><dd className="font-medium">{money(refundable, currency)}</dd>
        </dl>
      )}

      <h4 className="mt-6 mb-2.5 text-[11px] font-semibold tracking-[0.06em] text-admin-muted uppercase">
        Payment attempts ({attempts.length})
      </h4>
      {attempts.length === 0 ? (
        <p className="m-0 text-[14px] text-admin-text-2">No attempts recorded.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {attempts.map((a) => (
            <li key={a.gateway_payment_id} className="rounded-[10px] border border-admin-border bg-admin-bg px-4 py-3 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusBadge value={a.status} />
                <span className="text-admin-text-2">{new Date(a.created_at).toLocaleString()}</span>
              </div>
              <div className="mt-1.5 text-admin-text-2 [overflow-wrap:anywhere]">
                {a.gateway_payment_id}{a.method ? ` · ${a.method}` : ''} · {money(a.amount, currency)}
              </div>
              {a.error_code && (
                <div className="mt-1.5 text-admin-danger">{a.error_code}: {a.error_description}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-5 mb-2.5 text-[11px] font-semibold tracking-[0.06em] text-admin-muted uppercase">
        Refunds ({refunds.length})
      </h4>
      {refunds.length === 0 ? (
        <p className="m-0 text-[14px] text-admin-text-2">No refunds issued.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {refunds.map((r) => (
            <li key={r.refund_key} className="rounded-[10px] border border-admin-border bg-admin-bg px-4 py-3 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <strong className="text-[14px] font-semibold">{money(r.amount, currency)}</strong>
                  <StatusBadge value={r.status} />
                </span>
                <span className="text-admin-text-2">{new Date(r.created_at).toLocaleString()}</span>
              </div>
              <div className="mt-1.5 text-admin-text-2 [overflow-wrap:anywhere]">
                {r.provider_id || 'Awaiting provider reference'} · {r.reason}
              </div>
            </li>
          ))}
        </ul>
      )}

      {blocked && refundable > 0 && (
        <p className="mt-4 mb-0 flex gap-3 rounded-[10px] border border-[#fde68a] bg-[#fffbeb] px-4 py-3.5 text-[14px] leading-relaxed text-[#92400e]">
          <AlertTriangle size={17} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>
            A shipment exists for this order. Cancel or return it with the courier first; refunding a
            dispatched order would send the money back while the goods are still in transit.
          </span>
        </p>
      )}

      {(refundable > 0 || refunds.length > 0) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {refundable > 0 && !blocked && !open && (
            <Btn icon={RotateCcw} disabled={busy} onClick={openForm}>Refund…</Btn>
          )}
          {refunds.some((r) => r.provider_id && r.status !== 'processed' && r.status !== 'failed') && (
            <Btn icon={RefreshCw} busy={busy} disabled={busy} onClick={sync}>Sync refund status</Btn>
          )}
        </div>
      )}

      {open && (
        <form className="mt-4 rounded-[12px] border border-admin-border bg-admin-bg p-4" onSubmit={submitRefund}>
          <AdminField
            label={`Amount in whole ${currency}`}
            hint={overRefund ? undefined : `Leave blank to refund the full ${money(refundable, currency)}.`}
            error={overRefund ? `More than the ${money(refundable, currency)} available.` : undefined}
            type="number" step="0.01" min="0.01" max={(refundable / 100).toFixed(2)}
            value={amount} onChange={(event) => setAmount(event.target.value)}
          />
          {/* Echoes back what will actually be sent. This is the one money field
              in the admin that takes major units -- every other one asks for
              minor units -- so an administrator in the habit of typing 49900
              for 499.00 would otherwise only discover the 100x error from the
              server's "exceeds refundable balance" rejection. */}
          {amount.trim() !== '' && (
            <p className={`m-0 -mt-2 mb-4 text-[13px] ${overRefund ? 'text-admin-danger' : 'text-admin-text-2'}`}>
              {Number.isFinite(Number(amount)) && Number(amount) > 0
                ? <>Refunding <strong className="font-semibold text-admin-text">{money(Math.round(Number(amount) * 100), currency)}</strong></>
                : 'Enter an amount.'}
            </p>
          )}
          <AdminField
            label="Reason"
            hint="Recorded against the refund and shown in the list above."
            minLength="5" value={reason}
            onChange={(event) => setReason(event.target.value)} required
          />
          <p className="m-0 mb-4 text-[13px] leading-relaxed text-admin-text-2">
            This submits a real refund when live keys are configured. Resubmitting this form reuses
            idempotency key <code className="rounded bg-admin-surface px-1.5 py-0.5 text-[12px] text-admin-text">{refundKey}</code>,
            so it cannot refund twice.
          </p>
          <div className="flex flex-wrap gap-2">
            <Btn variant="primary" type="submit" busy={busy} disabled={busy}>
              {busy ? 'Submitting…' : 'Submit refund'}
            </Btn>
            <Btn variant="ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Btn>
          </div>
        </form>
      )}
    </section>
  );
}
