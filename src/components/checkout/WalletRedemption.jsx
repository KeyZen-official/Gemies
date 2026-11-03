'use client';
import {money} from '../../api.js';

/**
 * The wallet row on the checkout summary.
 *
 * Every number here is the server's. `offer` is the `wallet` block from
 * POST /checkout/quote, which computes what this customer may actually redeem
 * against this order: the real ledger balance, the configured conversion rate,
 * and the configured caps. This component multiplies nothing and decides
 * nothing -- it renders what it was told and sends back a single boolean.
 *
 * That split is the whole point. If the browser calculated the discount, the
 * discount would be whatever the browser said it was.
 */
export function WalletRedemption({offer, total, currency, checked, onChange, disabled}) {
  // Nothing to show when the wallet is switched off for the store, or when
  // this customer has never earned a coin.
  if (!offer?.enabled || offer.availableCoins <= 0) return null;

  const covers = offer.allowed && offer.inr >= total;
  const remaining = Math.max(0, total - (checked ? offer.inr : 0));

  return (
    <div className="my-5 rounded-[6px] border border-[#d6d6ce] bg-white p-4">
      <label className={`flex items-start gap-3 ${offer.allowed ? '' : 'opacity-60'}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || !offer.allowed}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 h-4 min-h-4 w-4 shrink-0 accent-ink"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold">Use GEMIES coins</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-ink-soft">
            You have <strong className="text-ink">{offer.availableCoins.toLocaleString('en-IN')} coins</strong>
            {' '}worth {money(offer.availableCoins * offer.paisePerCoin, currency)}.
          </span>
        </span>
      </label>

      {/* When coins cannot be used, say why rather than showing a dead
          checkbox. The reason is the server's. */}
      {!offer.allowed && offer.reason && (
        <p className="m-0 mt-2.5 pl-7 text-[11px] leading-relaxed text-[#765e35]">{offer.reason}</p>
      )}

      {offer.allowed && (
        <dl className="m-0 mt-3 grid grid-cols-[1fr_auto] gap-y-1.5 border-t border-[#ededea] pt-3 pl-7 text-[11px] [&_dd]:m-0 [&_dd]:text-right [&_dd]:font-medium [&_dt]:text-ink-soft">
          <dt>Coins to redeem</dt>
          <dd>{checked ? offer.coins.toLocaleString('en-IN') : '0'}</dd>
          <dt>Wallet discount</dt>
          <dd>{checked ? `− ${money(offer.inr, currency)}` : money(0, currency)}</dd>
          <dt className="font-semibold text-ink">
            {covers && checked ? 'Payable now' : 'Remaining to pay'}
          </dt>
          <dd className="font-semibold text-ink">{money(remaining, currency)}</dd>
        </dl>
      )}

      {checked && covers && (
        <p className="m-0 mt-3 rounded-[5px] bg-[#eaf0e6] px-3 py-2.5 text-[11px] leading-relaxed text-[#3d5b2d]">
          Your coins cover this order in full, so there is nothing to pay by card.
        </p>
      )}

      {checked && offer.allowed && !covers && (
        <p className="m-0 mt-3 text-[11px] leading-relaxed text-ink-soft">
          The remaining {money(remaining, currency)} is collected by card. Your coins are only
          deducted once that payment succeeds.
        </p>
      )}
    </div>
  );
}
