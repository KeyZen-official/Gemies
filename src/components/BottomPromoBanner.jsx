'use client';
import { bottomBanner } from '../data/home-content.js';
import { Button } from './ui/Button.jsx';

/**
 * Closing promotional banner: real photograph, CSS scrim, real heading, copy
 * and button. Aligned to the content container like every other section, not
 * full bleed.
 */
export function BottomPromoBanner() {
  return (
    <section className="relative mt-[38px] overflow-hidden rounded-lg bg-[#6d7a84] md:mt-[60px] md:rounded-xl">
      <img src={bottomBanner.image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-b from-[rgba(12,16,20,0.42)] to-[rgba(12,16,20,0.58)]" />

      <div className="relative z-[2] flex min-h-[250px] flex-col items-center justify-center gap-3 px-[8%] pt-11 pb-10 text-center text-white md:min-h-[300px] md:gap-4 md:pt-[55px] md:pb-12 lg:min-h-[26vw] lg:max-h-[460px] lg:pt-[70px] lg:pb-15">
        <h2 className="m-0 max-w-[22ch] text-[22px] leading-tight font-bold tracking-[-0.03em] text-balance md:max-w-[24ch] md:text-[27px] lg:text-[2.6vw] xl:text-[40px]">
          {bottomBanner.heading}
        </h2>
        <p className="m-0 max-w-[58ch] text-[11px] leading-relaxed text-white/85 md:text-[13px]">{bottomBanner.text}</p>
        <Button href={bottomBanner.cta.href}>{bottomBanner.cta.label}</Button>
      </div>
    </section>
  );
}
