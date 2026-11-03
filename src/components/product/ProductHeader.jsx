'use client';
import { money } from '../../api.js';
import { useStore } from '../../components.jsx';

const NEW_FOR_DAYS = 30;

/**
 * The merchandising label above the product name.
 *
 * Driven by the two signals the catalogue actually holds: the store's own
 * `featured` flag and `created_at`. There is deliberately no "Bestseller",
 * because nothing exposes units sold per product, and inventing it would put
 * a sales claim on the page that no data supports.
 */
export function productStatus(product) {
  if (!product?.featured) return null;
  const created = product.created_at ? new Date(product.created_at) : null;
  const isNew = created && Date.now() - created.getTime() <= NEW_FOR_DAYS * 86400000;
  return isNew ? 'Just In' : 'Featured';
}

/**
 * Status, name, brand/category line and price.
 *
 * The tax line is computed from the store's configured `tax_bps` rather than
 * copied from the reference screenshot. Checkout adds tax on top of the listed
 * price, so "Inclusive of all taxes" is only printed when the configured rate
 * is actually zero; with a rate set, the page says tax is added instead.
 */
export function ProductHeader({ product }) {
  const { config } = useStore();
  const status = productStatus(product);

  const reduced = product.compare_price > product.price;
  const discount = reduced ? Math.round((1 - product.price / product.compare_price) * 100) : 0;

  const taxBps = Number(config.settings?.tax_bps ?? 0);
  const taxNote = taxBps > 0
    ? `Plus ${(taxBps / 100).toFixed(taxBps % 100 === 0 ? 0 : 2)}% tax, added at checkout`
    : 'Inclusive of all taxes';

  return (
    <header>
      {status && (
        <p className="m-0 text-[13px] font-medium text-[#b04a2f]">{status}</p>
      )}

      <h1 className="mt-1.5 mb-1 text-[22px] leading-[1.2] md:text-[26px] lg:text-[28px]">{product.name}</h1>

      <p className="m-0 text-[15px] text-ink-soft">
        {product.brand} {product.audience}{product.audience === 'Unisex' ? '' : '’s'} {product.category}
      </p>

      <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <strong className="text-base tracking-[-0.01em] md:text-[17px]">
          {money(product.price, config.currency)}
        </strong>
        {reduced && (
          <>
            <del className="text-[15px] text-ink-soft">{money(product.compare_price, config.currency)}</del>
            <span className="text-[15px] font-medium text-[#3d6b35]">{discount}% off</span>
          </>
        )}
      </div>

      <p className="mt-1 mb-0 text-xs text-ink-soft">{taxNote}</p>
    </header>
  );
}
