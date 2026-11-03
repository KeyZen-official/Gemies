'use client';
import { useState } from 'react';
import { RefreshCcw, Package, Coins, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { api, money } from '../../api.js';
import { useStore, useResource } from '../../components.jsx';
import {
  Card, PageHeading, Btn, Badge, SearchField, Segmented, EmptyState, Modal,
  Skeleton, TablePagination, INPUT, usePagedResource,
} from './kit.jsx';

/**
 * The exchange queue.
 *
 * Every status change goes through POST /admin/exchanges/:id/transition, which
 * validates the move against the server's state machine. The buttons below are
 * built from the `nextStates` the server reports for that request, so this
 * screen cannot offer a transition the server would refuse.
 *
 * The coin figure shown on the detail panel is the server's live
 * recomputation, not the number stored when the customer raised the request --
 * a cash refund issued in the meantime reduces it, and an operator approving a
 * credit needs to see what will actually be posted.
 */

const STATUS_TONES = {
  requested: 'info', under_review: 'info', approved: 'success',
  pickup_scheduled: 'warning', picked_up: 'warning', received: 'warning',
  inspection_passed: 'success', coins_credited: 'success',
  inspection_failed: 'danger', rejected: 'danger', cancelled: 'neutral',
};

const REASON_LABELS = {
  size_too_small: 'Size too small', size_too_large: 'Size too large',
  damaged: 'Damaged product', wrong_product: 'Wrong product received', other: 'Other',
};

const label = (value) => String(value ?? '').replace(/_/g, ' ');

/** Transitions that the server requires a written reason for. */
const NEEDS_NOTE = new Set(['rejected', 'inspection_failed']);

export function Exchanges({ search, onSearch }) {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState('');

  const list = usePagedResource('/admin/exchanges', { limit: 20, params: { q: search, status } });
  const counts = list.meta?.byStatus ?? {};

  const filters = [
    ['', 'All', list.meta?.total],
    ['requested', 'New', counts.requested],
    ['approved', 'Approved', counts.approved],
    ['received', 'Received', counts.received],
    ['inspection_passed', 'Awaiting credit', counts.inspection_passed],
    ['coins_credited', 'Credited', counts.coins_credited],
  ];

  // Requests sitting at inspection_passed are money the customer is waiting
  // for, so they are called out rather than buried in the list.
  const awaitingCredit = counts.inspection_passed ?? 0;

  return (
    <>
      <PageHeading
        title="Exchange requests"
        subtitle="Review returns and release store coins once an item has passed inspection."
        action={
          <SearchField
            value={search}
            onSubmit={onSearch}
            placeholder="Customer or order number"
            label="Search exchange requests"
            className="w-full sm:w-[300px]"
          />
        }
      />

      {awaitingCredit > 0 && (
        <Card className="mb-4 flex flex-wrap items-center gap-3 border-[#bbf7d0] bg-[#f0fdf4] p-4">
          <Coins size={17} strokeWidth={2} className="shrink-0 text-admin-accent" />
          <p className="m-0 flex-1 text-[14px] text-[#166534]">
            {awaitingCredit} {awaitingCredit === 1 ? 'request has' : 'requests have'} passed inspection and{' '}
            {awaitingCredit === 1 ? 'is' : 'are'} waiting for a coin credit.
          </p>
          <Btn size="sm" onClick={() => setStatus('inspection_passed')}>Show them</Btn>
        </Card>
      )}

      <div className="mb-4 overflow-x-auto">
        <Segmented
          label="Filter by status"
          value={status}
          onChange={setStatus}
          options={filters.map(([value, text, count]) => [value, text, count ?? 0])}
        />
      </div>

      <Card className="overflow-hidden">
        {list.error ? (
          <div className="p-5">
            <p className="m-0 mb-3 text-[14px] text-admin-danger">{list.error}</p>
            <Btn onClick={list.reload}>Try again</Btn>
          </div>
        ) : list.loading ? (
          <div className="px-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-admin-border py-4 last:border-b-0">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-[30%]" />
                <Skeleton className="ml-auto h-6 w-24 rounded-full" />
              </div>
            ))}
          </div>
        ) : !list.rows.length ? (
          <EmptyState
            icon={RefreshCcw}
            title={search || status ? 'No requests match' : 'No exchange requests yet'}
            text={search || status
              ? 'Try a different search term or status.'
              : 'When a customer asks to exchange an item, it will appear here for review.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left">
              <thead>
                <tr className="border-b border-admin-border">
                  {['Request', 'Customer', 'Order', 'Reason', 'Eligible credit', 'Status', ''].map((head, i) => (
                    <th key={i} className="px-4 py-3 text-[12px] font-semibold tracking-[0.06em] whitespace-nowrap text-admin-muted uppercase">
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <tr key={row.id} className="border-b border-admin-border last:border-b-0 hover:bg-admin-bg">
                    <td className="px-4 py-3.5">
                      <span className="block text-[14px] font-semibold text-admin-text">#{row.number}</span>
                      <span className="mt-0.5 block text-[12px] text-admin-text-2">
                        {new Date(row.created_at).toLocaleDateString()} · {row.line_count} {row.line_count === 1 ? 'item' : 'items'}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="block text-[14px] font-medium text-admin-text">{row.customer_name}</span>
                      <span className="mt-0.5 block text-[12px] text-admin-text-2">{row.customer_email}</span>
                    </td>
                    <td className="px-4 py-3.5 text-[14px] whitespace-nowrap">
                      <span className="font-medium">#{row.order_number}</span>
                      <span className="mt-0.5 block text-[12px] text-admin-text-2">{money(row.order_total, row.currency)}</span>
                    </td>
                    <td className="px-4 py-3.5 text-[14px]">{REASON_LABELS[row.reason] ?? label(row.reason)}</td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      {row.eligible_coins == null ? (
                        <span className="text-[13px] text-admin-muted">Not calculated</span>
                      ) : (
                        <>
                          <span className="text-[14px] font-medium text-admin-text">
                            {row.eligible_coins.toLocaleString('en-IN')} coins
                          </span>
                          <span className="mt-0.5 block text-[12px] text-admin-text-2">
                            {money(row.eligible_inr, row.currency)}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <Badge tone={STATUS_TONES[row.status] ?? 'neutral'} dot>{label(row.status)}</Badge>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <Btn size="sm" onClick={() => setOpen(row.id)}>Review</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!list.loading && !list.error && (
          <TablePagination
            page={list.page} pages={list.pages} total={list.total} limit={list.limit}
            onPage={list.setPage} onLimit={list.setLimit}
            options={[10, 20, 50]}
            unit={list.total === 1 ? 'request' : 'requests'}
          />
        )}
      </Card>

      {open && <ExchangeDetail id={open} onClose={() => setOpen('')} onChange={list.reload} />}
    </>
  );
}

/* --------------------------------------------------------------- the detail */

function ExchangeDetail({ id, onClose, onChange }) {
  const { data, loading, error, reload } = useResource(`/admin/exchanges/${id}`);
  const { notify } = useStore();
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  async function move(next) {
    if (NEEDS_NOTE.has(next) && note.trim().length < 5) {
      notify('Enter a reason of at least 5 characters first.');
      return;
    }
    setBusy(next);
    try {
      const result = await api(`/admin/exchanges/${id}/transition`, {
        method: 'POST',
        body: { status: next, note: note.trim() },
      });
      notify(result.transaction
        ? `${result.transaction.coins.toLocaleString('en-IN')} coins credited.`
        : `Marked ${label(next)}.`);
      setNote('');
      reload();
      onChange();
    } catch (requestError) {
      notify(requestError.message);
    } finally {
      setBusy('');
    }
  }

  const credit = data?.credit;
  const willCredit = (data?.nextStates ?? []).includes('coins_credited');

  return (
    <Modal
      open
      onClose={onClose}
      title={data ? `Exchange #${data.number}` : 'Exchange'}
      subtitle={data ? `Order #${data.order_number} · ${data.customer_email}` : undefined}
      width="max-w-[720px]"
    >
      {loading ? (
        <><Skeleton className="h-4 w-2/3" /><Skeleton className="mt-3 h-4 w-1/2" /><Skeleton className="mt-6 h-28 w-full" /></>
      ) : error ? (
        <p className="m-0 text-[14px] text-admin-danger">{error}</p>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Badge tone={STATUS_TONES[data.status] ?? 'neutral'} dot>{label(data.status)}</Badge>
            <span className="text-[13px] text-admin-text-2">
              {REASON_LABELS[data.reason] ?? label(data.reason)}
            </span>
            {data.credited_transaction_id && <Badge tone="success">Coins credited</Badge>}
          </div>

          {data.reason_note && (
            <p className="m-0 mb-5 rounded-[10px] border border-admin-border bg-admin-bg px-3.5 py-3 text-[13px] leading-relaxed text-admin-text">
              “{data.reason_note}”
            </p>
          )}

          <h3 className="m-0 mb-2.5 text-[11px] font-semibold tracking-[0.06em] text-admin-muted uppercase">
            Items coming back
          </h3>
          <ul className="m-0 mb-5 grid list-none gap-2 p-0">
            {data.items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 rounded-[10px] border border-admin-border px-3.5 py-3">
                {item.image
                  ? <img src={item.image} alt="" className="size-11 shrink-0 rounded-[8px] border border-admin-border bg-[#f3f4f6] object-contain" />
                  : <span className="grid size-11 shrink-0 place-items-center rounded-[8px] border border-admin-border bg-[#f3f4f6] text-admin-muted"><Package size={15} /></span>}
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-admin-text">{item.name}</span>
                  <span className="mt-0.5 block text-[12px] text-admin-text-2">
                    {item.size} / {item.color} · SKU {item.sku}
                  </span>
                  <span className="mt-1 block text-[12px] text-admin-text-2">
                    Returning {item.quantity} of {item.ordered_quantity} · {money(item.unit_price, 'INR')} each
                    {item.eligible_inr != null && <> · eligible {money(item.eligible_inr, 'INR')}</>}
                  </span>
                  {item.replacement_sku && (
                    <span className="mt-1 block text-[12px] font-medium text-admin-blue">
                      Prefers {item.replacement_size} / {item.replacement_color} ({item.replacement_sku})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {/* The live figure, recomputed by the server on every open. */}
          {credit && (
            <div className="mb-5 rounded-[12px] border border-admin-border bg-admin-bg p-4">
              <p className="m-0 text-[11px] font-semibold tracking-[0.06em] text-admin-muted uppercase">
                Eligible credit, recalculated now
              </p>
              <p className="m-0 mt-1.5 flex flex-wrap items-baseline gap-x-3">
                <span className="text-[24px] leading-none font-bold text-admin-text">
                  {credit.coins.toLocaleString('en-IN')}
                </span>
                <span className="text-[13px] text-admin-text-2">coins · {money(credit.eligibleInr, 'INR')}</span>
              </p>
              <dl className="m-0 mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px] [&_dd]:m-0 [&_dt]:text-admin-text-2">
                <dt>Items</dt><dd>{money(credit.calculation.subtotalEligible, 'INR')}</dd>
                {credit.calculation.shipping > 0 && (
                  <><dt>Shipping</dt><dd>{money(credit.calculation.shipping, 'INR')}</dd></>
                )}
                {credit.calculation.alreadyRefunded > 0 && (
                  <><dt>Already refunded</dt><dd>−{money(credit.calculation.alreadyRefunded, 'INR')}</dd></>
                )}
                {credit.calculation.alreadyCredited > 0 && (
                  <><dt>Already credited</dt><dd>−{money(credit.calculation.alreadyCredited, 'INR')}</dd></>
                )}
                {credit.remainderPaise > 0 && (
                  <><dt>Rounded off</dt><dd>{money(credit.remainderPaise, 'INR')}</dd></>
                )}
              </dl>
              {credit.calculation.cappedByHeadroom && (
                <p className="m-0 mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-[#92400e]">
                  <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
                  Capped: this order has already been refunded or credited, so only{' '}
                  {money(credit.calculation.headroom, 'INR')} of its value remains.
                </p>
              )}
              <p className="m-0 mt-3 text-[12px] leading-relaxed text-admin-text-2">
                Calculated from what the customer paid for these lines — the order's own prices with
                its discount and tax allocated — not from current catalogue prices.
              </p>
            </div>
          )}

          <h3 className="m-0 mb-2.5 text-[11px] font-semibold tracking-[0.06em] text-admin-muted uppercase">
            History
          </h3>
          <ol className="m-0 mb-5 grid list-none gap-0 p-0">
            {data.history.map((event) => (
              <li key={event.id} className="flex gap-3 border-l border-admin-border pb-3 pl-4 last:pb-0">
                <span className="-ml-[21px] mt-1 size-2 shrink-0 rounded-full bg-admin-border" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-admin-text">{label(event.to_status)}</span>
                  <span className="mt-0.5 block text-[12px] text-admin-text-2">
                    {new Date(event.created_at).toLocaleString()}
                    {event.actor_email && ` · ${event.actor_email}`}
                  </span>
                  {event.note && <span className="mt-1 block text-[12px] text-admin-text-2">{event.note}</span>}
                </span>
              </li>
            ))}
          </ol>

          {data.nextStates.length === 0 ? (
            <p className="m-0 rounded-[10px] border border-admin-border bg-admin-bg px-3.5 py-3 text-[13px] text-admin-text-2">
              This request is closed. No further action is possible.
            </p>
          ) : (
            <div className="border-t border-admin-border pt-5">
              <label className="mb-1.5 block text-[13px] font-medium text-admin-text">
                Note {data.nextStates.some((s) => NEEDS_NOTE.has(s)) && (
                  <span className="font-normal text-admin-text-2">— required to reject or fail an inspection</span>
                )}
              </label>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={1000}
                placeholder="Recorded against the request and shown to the customer."
                className={`${INPUT} mb-4 h-auto min-h-[72px] py-2.5`}
              />
              <div className="flex flex-wrap gap-2">
                {data.nextStates.map((next) => {
                  const credits = next === 'coins_credited';
                  const bad = next === 'rejected' || next === 'inspection_failed';
                  return (
                    <Btn
                      key={next}
                      variant={credits ? 'primary' : bad ? 'danger' : 'secondary'}
                      icon={credits ? Coins : next === 'inspection_passed' ? CheckCircle2 : bad ? XCircle : undefined}
                      busy={busy === next}
                      disabled={Boolean(busy)}
                      onClick={() => move(next)}
                    >
                      {credits ? `Credit ${credit?.coins?.toLocaleString('en-IN') ?? ''} coins` : label(next)}
                    </Btn>
                  );
                })}
              </div>
              {willCredit && (
                <p className="m-0 mt-3 text-[12px] leading-relaxed text-admin-text-2">
                  Crediting writes one wallet transaction and cannot be undone or repeated. To correct
                  a mistake afterwards, make a compensating adjustment on the customer's wallet.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
