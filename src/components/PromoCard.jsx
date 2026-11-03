'use client';
import { CardButton } from './ui/CardButton.jsx';

/**
 * One of the two garment promotional cards (T-shirts, Shirts).
 *
 * Structure, top to bottom: optional store mark, the garment filling the
 * upper-middle region, then the heading and button anchored to the bottom
 * left. Cards one and two share this component so their text and buttons
 * cannot drift out of alignment with each other.
 *
 * Height comes from `aspect-[452/708]`, the proportion of the design
 * reference, rather than a fixed pixel height. A fixed height would hold at
 * one viewport and distort at every other, whereas the ratio keeps the
 * composition intact from a 320px phone to a capped 1320px container. All
 * three cards in a row therefore resolve to the same height, because the grid
 * gives them the same width.
 *
 * The garment is a tight-cropped transparent WebP drawn with `object-contain`,
 * so it keeps its own proportions and is never cropped. `max-h-full` lets it
 * shrink rather than overflow if the card is short, and because the asset is
 * cropped to the garment, `w-[76%]` really is 76% of the card width rather
 * than 76% of a mostly-empty square canvas.
 */
export function PromoCard({ card }) {
  return (
    <article
      className={
        // max-h is the design's stated 708px height, acting as a ceiling on
        // the ratio. Without it a full-width single-column card at a 640px
        // viewport resolves to 616x965, which is taller than the screen for
        // one card. All three cards share a width, so they share a height
        // whether the ratio or the ceiling is binding.
        'group relative flex aspect-[452/708] max-h-[708px] flex-col overflow-hidden rounded-xl '
        + `font-manrope ${card.tint}`
      }
    >
      {/*
        Fixed-height header band, rendered on both cards whether or not they
        carry the store mark. Only the first card shows the mark, matching the
        reference, but if the band collapsed on the second one that card's
        garment track would be ~60px taller than its neighbour's, and a shirt
        centred in the taller track sits with a visible empty strip beneath it
        while the tee next to it does not. Keeping the band means both
        garments occupy an identical region of an identical card.
      */}
      <div className="flex h-[52px] shrink-0 items-center justify-center md:h-[60px]">
        {card.logo && (
          <img src={card.logo} alt="Gemies" width="89" height="120" className="h-7 w-auto md:h-9" />
        )}
      </div>

      {/* The garment track. min-h-0 is what allows this flex child to be the
          one that gives way when the card is short, instead of pushing the
          heading and button off the bottom. */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-3 md:px-6">
        <img
          src={card.image}
          alt={card.alt}
          loading="lazy"
          decoding="async"
          className={
            `max-h-full ${card.widthPct} object-contain `
            + 'transition-transform duration-500 ease-out '
            + 'group-hover:scale-[1.03] motion-reduce:group-hover:scale-100'
          }
        />
      </div>

      <div className="shrink-0 px-7 pb-8 md:px-[30px] md:pb-[32px]">
        {/* whitespace-pre-line so the copy breaks where it is written in
            home-content.js rather than wherever the card width happens to
            wrap it. */}
        {/* Sizes are set from the measured width of the longest line rather
            than by eye: "Clean Fits. Better Fabrics." in Manrope 600 is 234px
            at 22px, 277px at 26px and 319px at 30px, and each step is the
            largest that still fits the text width the card has at that
            breakpoint without wrapping onto a third line. */}
        <h2 className="m-0 mb-4 text-[22px] leading-[1.3] font-semibold tracking-[-0.02em] whitespace-pre-line text-card-ink sm:text-[26px] md:mb-5 lg:text-[30px]">
          {card.text}
        </h2>
        <CardButton href={card.cta.href} tone="dark">
          {card.cta.label}
        </CardButton>
      </div>
    </article>
  );
}
