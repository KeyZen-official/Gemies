'use client';
import { offer } from '../data/home-content.js';
import { CardButton } from './ui/CardButton.jsx';

/**
 * The third promotional card: the bottoms edit.
 *
 * An editorial banner rather than a product card. Reading down: a small
 * letter-spaced label, the promotional heading, a hairline rule, the offer
 * line, then the garment, then the button.
 *
 * The typography sits above the garment and the button below it, all three as
 * separate flex children, so nothing is ever laid over the product. Putting
 * the garment behind the text would have needed an opacity or a scrim to keep
 * the words legible, and both make the product look worse.
 *
 * Background is the flat terracotta of the palette. The reference artwork has
 * a soft gradient and some diagonal light streaks, but the brief gives card
 * three a single colour and says not to introduce others, so this is one
 * token: `--color-card-bottoms`.
 *
 * On tablet this card spans both columns and switches to a wider ratio, since
 * a two-column grid otherwise leaves it stranded beside an empty cell.
 *
 * No discount is claimed here — see the note on `offer` in home-content.js.
 */
export function OfferCard() {
  return (
    <article
      className={
        'group relative flex aspect-[452/708] max-h-[708px] flex-col overflow-hidden rounded-xl '
        + 'bg-card-bottoms font-manrope text-white '
        // On the two-column tablet layout this card takes the whole second
        // row, but is held to one column's width and centred, so it keeps the
        // same proportions and composition as the two above it. Letting it
        // stretch across both columns instead made it wider without making it
        // taller, and since its type block is a fixed height, the garment
        // track collapsed to 104px -- a 7%-of-card-width pair of trousers.
        + 'md:col-span-2 md:mx-auto md:w-[calc(50%-7px)] '
        + 'xl:col-span-1 xl:w-auto'
      }
    >
      <div className="shrink-0 px-6 pt-7 text-center md:pt-8">
        <p className="m-0 text-[10px] leading-none font-bold tracking-[2px] text-white/90">
          {offer.label}
        </p>
        <h2 className="m-0 mt-4 text-[30px] leading-[1.1] font-bold tracking-[-0.01em] whitespace-pre-line md:text-[34px] lg:text-[40px]">
          {/* 40px at lg and up, the top of the 38-42px the design calls for.
              "NEW SEASON" measures 237px there, well inside the 425px this
              card has, so both lines hold without wrapping. */}
          {offer.headline}
        </h2>
        <span aria-hidden="true" className="mx-auto mt-5 block h-px w-11 bg-white/55" />
        <p className="m-0 mt-5 text-[12px] leading-[1.5] font-medium tracking-[1.5px] whitespace-pre-line text-white/90">
          {offer.subhead}
        </p>
      </div>

      {/* py-6 rather than py-4: this garment is tall and narrow, so it is
          bound by the height of this track and grows to fill it. The extra
          padding is what keeps clear air between the trousers and both the
          offer line above and the button below. */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-6">
        <img
          src={offer.image}
          alt={offer.alt}
          loading="lazy"
          decoding="async"
          className={
            `max-h-full ${offer.widthPct} object-contain `
            + 'transition-transform duration-500 ease-out '
            + 'group-hover:scale-[1.03] motion-reduce:group-hover:scale-100'
          }
        />
      </div>

      <div className="shrink-0 px-6 pb-8 text-center md:pb-[32px]">
        <CardButton href={offer.cta.href} tone="light">
          {offer.cta.label}
        </CardButton>
      </div>
    </article>
  );
}
