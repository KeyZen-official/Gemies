'use client';
import { useState } from 'react';
import { Wallet as WalletIcon, Coins, ShieldCheck, AlertTriangle, Plus, Minus } from 'lucide-react';
import { api, money } from '../../api.js';
import { useStore, useResource } from '../../components.jsx';
import {
  Card, PageHeading, Btn, Badge, SearchField, EmptyState, Modal, AdminField,
  Skeleton, TablePagination, INPUT, SELECT, usePagedResource,
} from './kit.jsx';

/**
 * Customer wallets.
 *
 * Read-only apart from one action: a manual adjustment, which appends a
 * compensating entry to the ledger. There is deliberately no way to edit or
 * delete a transaction from this screen, because the ledger is append-only --
 * a mistake is corrected by a new entry that says so, not by rewriting
 * history.
 *
 * The integrity line on the detail panel is the server's check that the cached
 * balance still equals the sum of the ledger. If it ever disagrees, that is a
 * bug worth seeing rather than hiding.
 */

const TYPE_LABELS = {
  exchange_credit: 'Exchange credit',
  purchase_redemption: 'Purchase redemption',
  redemption_release: 'Redemption released',
  admin_adjustment: 'Account adjustment',
  promotional_credit: 'Promotional credit',
  expiry: 'Coins expired',
};

export function WalletAdmin({ search, onSearch }) {
  const [open, setOpen] = useState('');
  const list = usePagedResource('/admin/wallet/accounts', { limit: 20, params: { q: search } });
  const integrity = useResource('/admin/wallet/integrity');
  const summary = list.meta?.summary;

  const drifted = integrity.data?.drifted?.length ?? 0;

  return (
    <>
      <PageHeading
        title="Customer wallets"
        subtitle="Store coin balances, their full history, and authorised manual adjustments."
        action={
          <SearchField
            value={search}
            onSubmit={onSearch}
            placeholder="Name or email"
            label="Search customer wallets"
            className="w-full sm:w-[300px]"
          />
        }
      />

      {/* A drift between the cache and the ledger is a correctness problem, so
          it is reported loudly rather than left to a log. */}
      {drifted > 0 && (
        <Card className="mb-4 flex items-start gap-3 border-[#fecaca] bg-[#fef2f2] p-4">
          <AlertTriangle size={17} strokeWidth={2} className="mt-0.5 shrink-0 text-admin-danger" />
          <p className="m-0 text-[14px] leading-relaxed text-[#991b1b]">
            {drifted} wallet {drifted === 1 ? 'balance does' : 'balances do'} not match{' '}
            {drifted === 1 ? 'its' : 'their'} ledger. This should never happen — do not make
            adjustments until it is investigated.
          </p>
        </Card>
      )}

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Wallets in use', summary?.accounts, null, WalletIcon, 'bg-[#dbeafe] text-admin-blue'],
          ['Coins outstanding', summary?.outstanding_coins, 'Store liability', Coins, 'bg-[#ffedd5] text-[#ea580c]'],
          ['Coins ever credited', summary?.credited, null, Plus, 'bg-[#dcfce7] text-admin-accent'],
          ['Coins ever spent', summary?.debited, null, Minus, 'bg-[#ede9fe] text-admin-purple'],
        ].map(([title, value, note, Icon, tint]) => (
          <div key={title} className="flex items-center gap-3.5 rounded-[14px] border border-admin-border bg-admin-surface p-[18px]">
            <span className={`grid size-11 shrink-0 place-items-center rounded-[11px] ${tint}`}>
              <Icon size={19} strokeWidth={2} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-admin-text-2">{title}</span>
              {value == null
                ? <Skeleton className="mt-1.5 h-7 w-16" />
                : <span className="mt-0.5 block text-[28px] leading-none font-bold tracking-[-0.02em] text-admin-text">
                  {value.toLocaleString('en-IN')}
                </span>}
              {note && <span className="mt-1 block text-[12px] text-admin-muted">{note}</span>}
            </span>
          </div>
        ))}
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
                <Skeleton className="h-4 w-[30%]" />
                <Skeleton className="ml-auto h-4 w-20" />
              </div>
            ))}
          </div>
        ) : !list.rows.length ? (
          <EmptyState
            icon={WalletIcon}
            title={search ? 'No wallets match that search' : 'No wallets yet'}
            text={search
              ? 'Search by customer name or email address.'
              : 'A wallet is created the first time a customer earns or spends coins, so this fills up once exchanges start being credited.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-left">
              <thead>
                <tr className="border-b border-admin-border">
                  {['Customer', 'Balance', 'Held', 'Earned', 'Spent', 'Activity', ''].map((head, i) => (
                    <th key={i} className="px-4 py-3 text-[12px] font-semibold tracking-[0.06em] whitespace-nowrap text-admin-muted uppercase">
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <tr key={row.user_id} className="border-b border-admin-border last:border-b-0 hover:bg-admin-bg">
                    <td className="px-4 py-3.5">
                      <span className="block text-[14px] font-medium text-admin-text">{row.name}</span>
                      <span className="mt-0.5 block text-[12px] text-admin-text-2">{row.email}</span>
                    </td>
                    <td className="px-4 py-3.5 text-[14px] font-semibold whitespace-nowrap text-admin-text">
                      {row.balance_coins.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3.5 text-[14px] whitespace-nowrap text-admin-text-2">
                      {row.held_coins > 0 ? row.held_coins.toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="px-4 py-3.5 text-[14px] whitespace-nowrap text-admin-text-2">
                      {row.lifetime_credited.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3.5 text-[14px] whitespace-nowrap text-admin-text-2">
                      {row.lifetime_debited.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3.5 text-[13px] whitespace-nowrap text-admin-text-2">
                      {row.transactions} {row.transactions === 1 ? 'entry' : 'entries'}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <Btn size="sm" onClick={() => setOpen(row.user_id)}>Open</Btn>
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
            unit={list.total === 1 ? 'wallet' : 'wallets'}
          />
        )}
      </Card>

      {open && (
        <WalletDetail
          userId={open}
          onClose={() => setOpen('')}
          onChange={() => { list.reload(); integrity.reload(); }}
        />
      )}
    </>
  );
}

/* --------------------------------------------------------------- the detail */

function WalletDetail({ userId, onClose, onChange }) {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useResource(`/admin/wallet/accounts/${userId}?page=${page}&limit=10`);
  const [adjusting, setAdjusting] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title={data ? data.user.name : 'Wallet'}
      subtitle={data?.user.email}
      width="max-w-[720px]"
      footer={
        data && (
          <>
            <Btn onClick={onClose}>Close</Btn>
            <Btn variant="primary" icon={Coins} onClick={() => setAdjusting(true)}>Adjust balance</Btn>
          </>
        )
      }
    >
      {loading && !data ? (
        <><Skeleton className="h-20 w-full" /><Skeleton className="mt-4 h-32 w-full" /></>
      ) : error ? (
        <p className="m-0 text-[14px] text-admin-danger">{error}</p>
      ) : (
        <>
          <div className="mb-5 rounded-[12px] border border-admin-border bg-admin-bg p-4">
            <dl className="m-0 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4 [&_dd]:m-0 [&_dt]:text-[11px] [&_dt]:font-semibold [&_dt]:tracking-[0.06em] [&_dt]:text-admin-muted [&_dt]:uppercase">
              <div>
                <dt>Available</dt>
                <dd className="mt-1 text-[18px] font-bold text-admin-text">
                  {data.summary.availableCoins.toLocaleString('en-IN')}
                </dd>
                <dd className="text-[12px] text-admin-text-2">{money(data.summary.availableInr, data.summary.currency)}</dd>
              </div>
              <div>
                <dt>Pending</dt>
                <dd className="mt-1 text-[18px] font-bold text-admin-text">
                  {data.summary.pendingCoins.toLocaleString('en-IN')}
                </dd>
                <dd className="text-[12px] text-admin-text-2">awaiting inspection</dd>
              </div>
              <div>
                <dt>Held</dt>
                <dd className="mt-1 text-[18px] font-bold text-admin-text">
                  {data.summary.heldCoins.toLocaleString('en-IN')}
                </dd>
                <dd className="text-[12px] text-admin-text-2">in checkout</dd>
              </div>
              <div>
                <dt>Rate</dt>
                <dd className="mt-1 text-[18px] font-bold text-admin-text">
                  {money(data.summary.paisePerCoin, data.summary.currency)}
                </dd>
                <dd className="text-[12px] text-admin-text-2">per coin</dd>
              </div>
            </dl>
            {data.integrity && (
              <p className={`m-0 mt-4 flex items-center gap-2 text-[12px] ${data.integrity.balanced ? 'text-admin-text-2' : 'text-admin-danger'}`}>
                {data.integrity.balanced
                  ? <><ShieldCheck size={13} strokeWidth={2} className="text-admin-accent" /> Balance matches the ledger exactly.</>
                  : <><AlertTriangle size={13} strokeWidth={2} /> Balance {data.integrity.cached} does not match the ledger total {data.integrity.ledger}.</>}
              </p>
            )}
          </div>

          <h3 className="m-0 mb-2.5 text-[11px] font-semibold tracking-[0.06em] text-admin-muted uppercase">
            Ledger — {data.total} {data.total === 1 ? 'entry' : 'entries'}
          </h3>

          {!data.rows.length ? (
            <p className="m-0 rounded-[10px] border border-admin-border bg-admin-bg px-3.5 py-3 text-[13px] text-admin-text-2">
              No wallet activity yet.
            </p>
          ) : (
            <>
              <ul className="m-0 grid list-none gap-0 overflow-hidden rounded-[10px] border border-admin-border p-0">
                {data.rows.map((row) => {
                  const isCredit = row.direction === 'credit';
                  return (
                    <li key={row.id} className="flex items-start justify-between gap-3 border-b border-admin-border px-3.5 py-3 last:border-b-0">
                      <span className="min-w-0">
                        <span className="block text-[13px] font-semibold text-admin-text">
                          {TYPE_LABELS[row.kind] ?? row.kind}
                        </span>
                        <span className="mt-0.5 block text-[12px] leading-relaxed text-admin-text-2 [overflow-wrap:anywhere]">
                          {row.description}
                        </span>
                        <span className="mt-1 block text-[11px] text-admin-muted">
                          {new Date(row.created_at).toLocaleString()}
                          {row.order_number ? ` · order #${row.order_number}` : ''}
                          {' · '}at {money(row.paise_per_coin, data.summary.currency)}/coin
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={`block text-[14px] font-bold ${isCredit ? 'text-[#15803d]' : 'text-[#b91c1c]'}`}>
                          {isCredit ? '+' : '−'}{row.coins.toLocaleString('en-IN')}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-admin-text-2">
                          {money(row.inr_value, data.summary.currency)}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-admin-muted">
                          bal {row.balance_after.toLocaleString('en-IN')}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <TablePagination
                page={data.page} pages={data.pages} total={data.total} limit={data.limit}
                onPage={setPage}
                unit={data.total === 1 ? 'entry' : 'entries'}
                className="border-t-0 px-0"
              />
            </>
          )}

          {adjusting && (
            <AdjustForm
              userId={userId}
              onClose={() => setAdjusting(false)}
              onSaved={() => { setAdjusting(false); reload(); onChange(); }}
            />
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * A manual adjustment.
 *
 * The idempotency key is generated once when the form opens and reused for
 * every submit of that form, so a double-clicked button adjusts once. Opening
 * the form again produces a new key, which is how a genuinely separate second
 * adjustment is expressed -- the same pattern the refund panel uses.
 */
function AdjustForm({ userId, onClose, onSaved }) {
  const { notify } = useStore();
  const [coins, setCoins] = useState('');
  const [direction, setDirection] = useState('credit');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => `adj-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`);

  const amount = Number(coins);
  const valid = Number.isInteger(amount) && amount > 0 && reason.trim().length >= 5;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api(`/admin/wallet/accounts/${userId}/adjust`, {
        method: 'POST',
        body: { coins: amount, direction, reason: reason.trim(), idempotencyKey: key },
      });
      notify(result.existing
        ? 'That adjustment was already applied.'
        : `${direction === 'credit' ? 'Credited' : 'Debited'} ${amount.toLocaleString('en-IN')} coins.`);
      onSaved();
    } catch (requestError) {
      notify(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Adjust wallet balance"
      subtitle="Appends a new ledger entry. Existing history is never changed."
      width="max-w-[520px]"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" busy={busy} disabled={busy || !valid} onClick={submit}>Apply adjustment</Btn>
        </>
      }
    >
      <form onSubmit={submit}>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <AdminField label="Direction">
            <select value={direction} onChange={(event) => setDirection(event.target.value)} className={SELECT}>
              <option value="credit">Credit — add coins</option>
              <option value="debit">Debit — remove coins</option>
            </select>
          </AdminField>
          <AdminField
            label="Coins"
            type="number" min="1" step="1"
            value={coins}
            onChange={(event) => setCoins(event.target.value)}
            error={coins !== '' && !(Number.isInteger(amount) && amount > 0) ? 'A whole number above zero.' : undefined}
            required
          />
        </div>
        <AdminField
          label="Reason"
          hint="Mandatory, at least 5 characters. Shown to the customer in their own wallet history."
          error={reason && reason.trim().length < 5 ? 'At least 5 characters.' : undefined}
        >
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={300}
            className={`${INPUT} h-auto min-h-[72px] py-2.5`}
            required
          />
        </AdminField>
        <p className="m-0 text-[12px] leading-relaxed text-admin-text-2">
          A debit cannot take a balance below zero. Resubmitting this form reuses idempotency key{' '}
          <code className="rounded bg-admin-bg px-1.5 py-0.5 text-[11px]">{key}</code>, so it cannot
          apply twice. Every adjustment is written to the audit log.
        </p>
      </form>
    </Modal>
  );
}
