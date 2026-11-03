'use client';
import Link from 'next/link';
import { Icon } from '../components.jsx';

/**
 * A photographic category tile with a real label and call to action.
 *
 * The whole tile is one link and the pill is a styled <span>, since a nested
 * <a> or <button> inside a link is invalid. The gradient scrim keeps the label
 * readable over any photograph.
 *
 * `area` positions the tile in the mosaic; the grid itself is declared in
 * RecommendedCollections.
 */
const placement = {
  tall: 'aspect-[1.15] lg:aspect-auto lg:col-start-1 lg:row-span-2',
  top: 'aspect-[1.5] lg:aspect-[1.48] lg:col-start-2 lg:row-start-1',
  bottom: 'aspect-[1.5] lg:aspect-[1.48] lg:col-start-2 lg:row-start-2',
};

export function CategoryCard({ tile }) {
  return (
    <Link
      href={tile.href ?? `/shop?category=${tile.slug}`}
      className={`group relative block min-w-0 overflow-hidden rounded-lg bg-[#d9d9d5] lg:rounded-xl ${placement[tile.area] ?? ''}`}
    >
      <img
        src={tile.image}
        alt=""
        loading="lazy"
        className="absolute inset-0 size-full object-cover transition-transform duration-[450ms] group-hover:scale-[1.04] motion-reduce:transition-none"
      />
      <span className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-2 bg-gradient-to-b from-transparent to-[rgba(10,12,8,0.72)] px-4 pt-[50px] pb-4 text-white to-55% md:gap-3 md:px-5 md:pt-[70px] md:pb-5">
        <span className="text-base font-semibold tracking-[-0.01em] md:text-[19px]">{tile.label}</span>
        <span className="inline-flex min-h-8 items-center justify-center gap-2 rounded-full bg-white px-3.5 py-2 text-[10px] font-semibold text-ink transition-colors hover:bg-[#eeeeeb] md:min-h-[38px] md:px-[18px] md:py-2.5 md:text-[11px]">
          {tile.cta}
          <Icon name="arrow" size={14} />
        </span>
      </span>
    </Link>
  );
}
