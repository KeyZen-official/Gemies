'use client';
import {useState} from 'react';
import Link from 'next/link';
import {money} from '../../api.js';
import {useResource, Loading, ErrorState, Empty} from '../../components.jsx';
import {Pagination} from '../ui/Pagination.jsx';

/**
 * The customer's GEMIES wallet.
 *
 * Every figure here comes from GET /wallet and GET /wallet/transactions. The
 * balance, the conversion rate and every rupee value are computed on the
 * server; nothing on this screen multiplies coins by a rate it was told by the
 * client, and nothing is hardcoded.
 *
 * Rupee values on a transaction row use that row's own `inr_value`, which was
 * snapshotted when it happened. A later change to the conversion rate
 * therefore cannot restate what a past transaction was worth -- the history
 * shows what the customer actually received at the time.
 */

const TYPE_LABELS = {
  exchange_credit: 'Exchange credit',
  purchase_redemption: 'Purchase redemption',
  redemption_release: 'Redemption released',
  admin_adjustment: 'Account adjustment',
  promotional_credit: 'Promotional credit',
  expiry: 'Coins expired',
};

export function Wallet() {
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState('');
  const [direction, setDirection] = useState('');

  const wallet = useResource('/wallet');
  const search = new URLSearchParams({page: String(page), limit: '10'});
  if (kind) search.set('kind', kind);
  if (direction) search.set('direction', direction);
  const ledger = useResource(`/wallet/transactions?${search}`);

  if (wallet.loading) return <Loading/>;
  if (wallet.error) return <ErrorState message={wallet.error} onRetry={wallet.reload}/>;

  const w = wallet.data;

  // The wallet is off until an operator configures it. Saying so is better
  // than showing a zero balance that looks like a lost balance.
  if (!w.enabled) {
    return (
      <Empty
        title="Wallet coming soon"
        text="GEMIES store coins are not switched on yet. When they are, coins you earn from an exchange will appear here."
        link="/shop"
        label="Continue shopping"
      />
    );
  }

  const rate = `1 coin = ${money(w.paisePerCoin, w.currency)}`;

  return (
    <>
      <div className="my-[22px] flex flex-wrap items-start justify-between gap-5 md:flex-nowrap md:items-center">
        <h2 className="m-0 text-[22px] md:text-2xl">Your wallet</h2>
        <span className="rounded-full border border-rule px-3 py-1.5 text-[11px] font-medium md:text-xs">{rate}</span>
      </div>

      {/* The balance card. Available is the only number that can be spent:
          coins held by a checkout in progress are excluded by the server. */}
      <div className="mb-5 overflow-hidden rounded-lg border border-rule bg-ink text-white md:mb-6">
        <div className="flex flex-wrap items-end justify-between gap-6 p-[22px] md:p-7">
          <div>
            <p className="m-0 text-[11px] font-medium tracking-[0.12em] text-white/60 uppercase md:text-xs">
              Available to spend
            </p>
            <p className="m-0 mt-2 flex flex-wrap items-baseline gap-x-3">
              <span className="text-[34px] leading-none font-bold tracking-[-0.02em] md:text-[42px]">
                {w.availableCoins.toLocaleString('en-IN')}
              </span>
              <span className="text-[13px] font-medium text-white/70 md:text-sm">coins</span>
            </p>
            <p className="m-0 mt-2 text-[14px] font-semibold text-white/90 md:text-[15px]">
              {money(w.availableInr, w.currency)} of GEMIES credit
            </p>
          </div>
          <Link
            href="/shop"
            className="rounded-full bg-white px-5 py-2.5 text-[12px] font-semibold text-ink no-underline md:text-[13px]"
          >
            Shop with coins
          </Link>
        </div>

        <dl className="m-0 grid grid-cols-2 gap-px border-t border-white/15 bg-white/15 md:grid-cols-4">
          {[
            ['Pending', `${w.pendingCoins.toLocaleString('en-IN')} coins`, money(w.pendingInr, w.currency)],
            ['Total earned', `${w.lifetimeCredited.toLocaleString('en-IN')} coins`, null],
            ['Total spent', `${w.lifetimeDebited.toLocaleString('en-IN')} coins`, null],
            ['Held at checkout', `${w.heldCoins.toLocaleString('en-IN')} coins`, null],
          ].map(([label, value, extra]) => (
            <div key={label} className="bg-ink px-[22px] py-4 md:px-7">
              <dt className="m-0 text-[10px] font-medium tracking-[0.1em] text-white/50 uppercase md:text-[11px]">{label}</dt>
              <dd className="m-0 mt-1.5 text-[15px] font-semibold md:text-base">{value}</dd>
              {extra && <dd className="m-0 mt-0.5 text-[11px] text-white/55">{extra}</dd>}
            </div>
          ))}
        </dl>
      </div>

      {/* The rules, read from settings rather than described in prose that
          could drift away from them. */}
      <div className="mb-5 rounded-lg border border-rule bg-white p-[18px] md:mb-6 md:p-5">
        <h3 className="m-0 mb-3 text-[13px] font-semibold md:text-sm">How GEMIES coins work</h3>
        <ul className="m-0 grid list-none gap-2 p-0 text-[12px] leading-relaxed text-ink-soft md:text-[13px]">
          <li>Coins are credited after a returned item is received and passes inspection.</li>
          <li>Coins can only be spent on GEMIES. There is no cash withdrawal.</li>
          {w.limits.maxOrderPercent < 100 && (
            <li>Up to {w.limits.maxOrderPercent}% of an order can be paid with coins.</li>
          )}
          {w.limits.minOrderValue > 0 && (
            <li>Orders of {money(w.limits.minOrderValue, w.currency)} or more can use coins.</li>
          )}
          {w.limits.minRedeemCoins > 0 && (
            <li>At least {w.limits.minRedeemCoins.toLocaleString('en-IN')} coins are needed to redeem.</li>
          )}
          {!w.limits.partialRedemption && <li>Coins must cover the whole order value.</li>}
          {w.expiry && <li>Coins expire {w.expiry.days} days after they are credited.</li>}
        </ul>
      </div>

      <div className="my-[22px] flex flex-wrap items-center justify-between gap-4">
        <h2 className="m-0 text-[22px] md:text-2xl">Wallet activity</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={direction}
            onChange={(event) => { setDirection(event.target.value); setPage(1); }}
            aria-label="Filter by credits or debits"
            className="min-h-10 rounded-full border border-line px-3.5 text-[12px] md:text-[13px]"
          >
            <option value="">All activity</option>
            <option value="credit">Coins in</option>
            <option value="debit">Coins out</option>
          </select>
          <select
            value={kind}
            onChange={(event) => { setKind(event.target.value); setPage(1); }}
            aria-label="Filter by transaction type"
            className="min-h-10 rounded-full border border-line px-3.5 text-[12px] md:text-[13px]"
          >
            <option value="">All types</option>
            {(ledger.data?.kinds ?? []).map((value) => (
              <option key={value} value={value}>{TYPE_LABELS[value] ?? value}</option>
            ))}
          </select>
        </div>
      </div>

      {ledger.loading ? <Loading/>
        : ledger.error ? <ErrorState message={ledger.error} onRetry={ledger.reload}/>
          : !ledger.data.rows.length ? (
            <div className="rounded-lg border border-rule bg-white px-5 py-12 text-center">
              <p className="m-0 text-[14px] font-semibold">
                {kind || direction ? 'Nothing matches those filters' : 'No wallet activity yet'}
              </p>
              <p className="m-0 mt-1.5 text-[12px] text-ink-soft md:text-[13px]">
                {kind || direction
                  ? 'Try a different type, or clear the filters.'
                  : 'Coins from an approved exchange will appear here once the return has been inspected.'}
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-lg border border-rule bg-white">
                {ledger.data.rows.map((row) => <Row key={row.id} row={row} currency={w.currency}/>)}
              </div>
              <Pagination
                page={ledger.data.page}
                pages={ledger.data.pages}
                total={ledger.data.total}
                unit="transactions"
                onPage={setPage}
              />
            </>
          )}
    </>
  );
}

/**
 * One ledger entry.
 *
 * Green for coins in, red for coins out. `balance_after` is the balance the
 * server recorded at the time, not a figure recomputed in the browser.
 */
function Row({row, currency}) {
  const credit = row.direction === 'credit';
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-3 border-b border-rule px-[18px] py-4 last:border-b-0 md:grid-cols-[1.6fr_1fr_auto] md:gap-5 md:px-5 md:py-5">
      <div className="min-w-0">
        <p className="m-0 text-[13px] font-semibold md:text-sm">{TYPE_LABELS[row.kind] ?? row.kind}</p>
        <p className="m-0 mt-1.5 text-[12px] leading-relaxed text-ink-soft [overflow-wrap:anywhere]">
          {row.description}
        </p>
        <p className="m-0 mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-soft">
          <span>{new Date(row.created_at).toLocaleString()}</span>
          {row.order_number && (
            <>
              <span aria-hidden="true">·</span>
              <Link href={`/orders/${row.order_id}`} className="underline underline-offset-2">
                Order #{row.order_number}
              </Link>
            </>
          )}
        </p>
      </div>

      {/* Hidden on the narrowest screens, where the amount matters more. */}
      <p className="m-0 hidden text-[11px] text-ink-soft md:block">
        Balance after
        <span className="mt-0.5 block text-[13px] font-semibold text-ink">
          {row.balance_after.toLocaleString('en-IN')} coins
        </span>
      </p>

      <p className="m-0 text-right">
        <span className={`block text-[15px] font-bold tracking-[-0.01em] ${credit ? 'text-[#15803d]' : 'text-[#b91c1c]'}`}>
          {credit ? '+' : '−'}{row.coins.toLocaleString('en-IN')}
        </span>
        <span className="mt-0.5 block text-[11px] text-ink-soft">
          {/* The row's own snapshot, so a later rate change cannot restate it. */}
          {money(row.inr_value, currency)}
        </span>
      </p>
    </div>
  );
}
