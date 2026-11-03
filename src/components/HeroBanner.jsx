'use client';
import { hero } from '../data/home-content.js';
import { Container } from './ui/Container.jsx';
import { Button } from './ui/Button.jsx';

/**
 * Full-bleed hero. Deliberately not inside Container: the photograph spans the
 * viewport while the copy sits on the same centred grid as every section
 * below, so the headline lines up with the content rather than the screen edge.
 *
 * The photograph is a real <img> under CSS scrims; the eyebrow, headline, copy
 * and call to action are real elements on top, never baked into the image.
 * Top padding clears the sticky navbar, which is pulled over this section by
 * its own -mb-nav.
 *
 * `font-manrope` matches the promotional cards immediately below. Without it
 * the hero inherits the site-wide Arial of --font-sans, and the first two
 * screens of the homepage read as two different brands.
 *
 * Two scrims, because the copy needs a dark backing in two different places:
 *
 *  - Left to right, at every width. This is the reference's treatment: dark at
 *    the headline, clear by two thirds across so the model stays lit.
 *  - Bottom to top, below lg only. At phone and tablet widths object-cover can
 *    only show a narrow slice of a 2.81-ratio frame, and in that slice the
 *    model stands where the headline would be. So below lg the copy drops to
 *    the bottom of the band and this scrim backs it, keeping his face clear
 *    above the text instead of behind it.
 *
 * The bottom scrim's 72% / 0.9 / 0.6 are not taste. His T-shirt is in full sun
 * and its raw pixels are nearly white, so at 390px a lighter scrim left the
 * headline at 2.1:1 against the brightest pixel it covered. These values are
 * the weakest ones that clear 3:1 for the headline and 4.5:1 for the sentence
 * at both 390 and 768, which they do with room to spare (4.8:1 and 7.0:1).
 */
export function HeroBanner() {
  return (
    <section className="relative isolate bg-[#2b3026] font-manrope">
      <div className="absolute inset-0 z-0">
        <img
          src={hero.image}
          alt=""
          width={hero.width}
          height={hero.height}
          fetchPriority="high"
          className={`size-full object-cover ${hero.focal}`}
        />
        <div className="absolute inset-0 bg-linear-to-r from-[rgba(12,10,8,0.84)] via-[rgba(12,10,8,0.48)] via-38% to-transparent to-70%" />
        <div className="absolute inset-x-0 bottom-0 h-[72%] bg-linear-to-t from-[rgba(12,10,8,0.9)] via-[rgba(12,10,8,0.6)] to-transparent lg:hidden" />
      </div>

      {/* From lg the band follows the frame's own 2.81 ratio as 36vw, but
          clamped at both ends: a 760px cap so an ultrawide monitor does not get
          a 900px-tall hero, and a 540px floor because bare 36vw is 369px at
          1024, which is a letterbox strip with no room for four stacked
          elements and the navbar above them. Both limits sit inside the one
          min-height, not in a separate max-h -- min-height beats max-height in
          the cascade, so a max-h-[760px] here would do nothing. */}
      <Container className="relative z-[2] flex min-h-[470px] flex-col items-start justify-end gap-4 pt-[calc(var(--spacing-nav)+28px)] pb-12 text-left text-white md:min-h-[540px] md:gap-5 md:pb-14 lg:min-h-[max(540px,min(36vw,760px))] lg:justify-center lg:pt-[calc(var(--spacing-nav)+40px)] lg:pb-10">
        <p className="m-0 text-[11px] leading-none font-bold tracking-[0.2em] text-white/75 uppercase md:text-xs">
          {hero.eyebrow}
        </p>
        {/* clamp, not a plain 3.6vw: viewport-relative type alone is 37px at
            1024, which is *smaller* than the 44px this same headline gets at
            768. The floor keeps the ramp going one way as the screen grows. */}
        <h1 className="m-0 max-w-[560px] text-[32px] leading-[1.06] font-bold tracking-[-0.03em] text-balance md:text-[44px] lg:text-[clamp(44px,3.8vw,54px)]">
          {hero.heading}
        </h1>
        <p className="m-0 max-w-[440px] text-[13px] leading-relaxed text-white/80 md:text-sm lg:text-[15px]">
          {hero.text}
        </p>
        <Button
          href={hero.cta.href}
          className="mt-2 min-h-12 px-[30px] tracking-[0.14em] uppercase md:text-[13px]"
        >
          {hero.cta.label}
          {/* Decorative: the label already says where the button goes. */}
          <svg width="17" height="10" viewBox="0 0 17 10" fill="none" aria-hidden="true">
            <path
              d="M1 5h14M11.5 1 15.5 5l-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      </Container>
    </section>
  );
}
