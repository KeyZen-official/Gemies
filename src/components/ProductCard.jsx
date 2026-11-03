'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { money } from '../api.js';
import { useStore, Icon } from '../components.jsx';
import { storeMark, storeName, storeMarkRatio } from '../data/store-mark.js';

// Beyond this the swatch row would wrap, so the remainder becomes a +N.
const MAX_SWATCHES = 4;

/**
 * The single product tile used by every grid on the site.
 *
 * Top-left is the Gemies monogram, top-right the colours the product comes in,
 * then the photograph, then name with price, then category.
 *
 * The colour dots are information only: they are spans inside a list, with no
 * handler, no cursor and no hover state, and `pointer-events-none` so a click
 * passes through to the card's link. Selecting a colour happens on the product
 * page, not here.
 */
export function ProductCard({ product, priority = false }) {
  const { config, user, wishlist, toggleWishlist } = useStore();
  const router = useRouter();
  const [markFailed, setMarkFailed] = useState(false);

  const href = `/product/${product.slug}`;
  const saved = wishlist.has(product.id);
  const soldOut = product.available === 0;
  const reduced = product.compare_price > product.price;
  const discount = reduced ? Math.round((1 - product.price / product.compare_price) * 100) : 0;

  const swatches = (Array.isArray(product.swatches) ? product.swatches : []).filter(Boolean);
  const shown = swatches.slice(0, MAX_SWATCHES);
  const overflow = swatches.length - shown.length;

  function onToggleSave() {
    if (!user) return router.push(`/login?next=${encodeURIComponent(href)}`);
    return toggleWishlist(product.id);
  }

  return (
    <article className="group min-w-0">
      <div className="relative aspect-[1/1.02] overflow-hidden rounded-[5px] bg-panel md:rounded-md">
        <Link href={href} className="block size-full" tabIndex={-1} aria-hidden="true">
          <img
            src={product.images[0]}
            alt=""
            width="375"
            height="321"
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            className="size-full object-contain object-center px-[9%] pt-[16%] pb-[9%] transition-transform duration-500 ease-out group-hover:scale-[1.06] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
          />
        </Link>

        {/* The store's own monogram, the same on every card: Gemies sells one
            label, so there is nothing per-product to distinguish here. The
            box is square because the monogram is slightly taller than wide,
            and object-contain keeps its proportions inside it. The dark tone
            is the one that reads on the panel grey behind it. */}
        <span className="pointer-events-none absolute top-2.5 left-2.5 md:top-3.5 md:left-3.5">
          {markFailed ? (
            <span className="text-[9px] font-bold tracking-[0.06em] uppercase text-[#2b2b28] md:text-[10px]">
              {storeName}
            </span>
          ) : (
            <img
              src={storeMark.dark}
              alt={storeName}
              width={storeMarkRatio.width}
              height={storeMarkRatio.height}
              onError={() => setMarkFailed(true)}
              className="size-5 object-contain object-left md:size-6"
            />
          )}
        </span>

        {shown.length > 0 && (
          <ul
            className="pointer-events-none absolute top-2.5 right-2.5 m-0 flex list-none items-center gap-[5px] p-0 md:top-3.5 md:right-3.5"
            aria-hidden="true"
          >
            {/* Keyed by position as well as colour: the hexes come from the
                database and two colourways could share one. */}
            {shown.map((colour, i) => (
              <li
                key={`${colour}-${i}`}
                style={{ background: colour }}
                className="size-2.5 rounded-full ring-1 ring-black/15 md:size-3"
              />
            ))}
            {overflow > 0 && (
              <li className="ml-0.5 text-[9px] leading-none font-medium text-ink-soft md:text-[10px]">
                +{overflow}
              </li>
            )}
          </ul>
        )}

        {/* The colour count is announced once, instead of per dot. */}
        {swatches.length > 0 && (
          <span className="sr-only">
            Available in {swatches.length} colour{swatches.length === 1 ? '' : 's'}
          </span>
        )}

        <button
          type="button"
          aria-pressed={saved}
          aria-label={saved ? `Remove ${product.name} from your wishlist` : `Save ${product.name} to your wishlist`}
          onClick={onToggleSave}
          className={
            'absolute right-2 bottom-2 grid size-7 place-items-center rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.12)] ' +
            'transition-[opacity,transform] hover:scale-110 motion-reduce:transition-none md:right-2.5 md:bottom-2.5 md:size-8 ' +
            'focus-visible:opacity-100 md:group-hover:opacity-100 ' +
            (saved ? 'opacity-100' : 'opacity-100 md:opacity-0')
          }
        >
          <Icon name="heart" size={17} className={saved ? 'fill-[#c2342a] stroke-[#c2342a]' : undefined} />
        </button>

        {soldOut && (
          <span className="absolute bottom-[11px] left-[11px] rounded-[15px] bg-white px-2.5 py-[7px] text-[11px]">Sold out</span>
        )}
        {!soldOut && discount > 0 && (
          <span className="absolute bottom-[11px] left-[11px] rounded-[15px] bg-ink px-2.5 py-[7px] text-[11px] font-semibold text-white">
            {discount}% off
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-baseline justify-between gap-2 md:mt-3">
        <Link href={href} className="truncate text-[11px] font-medium hover:underline hover:underline-offset-[3px] md:text-xs lg:text-[13px]">
          {product.name}
        </Link>
        <strong className="shrink-0 text-[11px] whitespace-nowrap md:text-xs lg:text-[13px]">
          {money(product.price, config.currency)}
        </strong>
      </div>

      <p className="m-0 mt-1 flex justify-between gap-2.5 text-[9px] text-ink-soft md:text-[10px] lg:text-[11px]">
        <span className="truncate">
          {product.audience}{product.audience === 'Unisex' ? '' : '’s'} {product.category || 'collection'}
        </span>
        {reduced && <del className="shrink-0">{money(product.compare_price, config.currency)}</del>}
      </p>
    </article>
  );
}
