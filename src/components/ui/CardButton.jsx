'use client';
import Link from 'next/link';

/**
 * The pill button used by the three homepage promotional cards.
 *
 * Deliberately separate from `Button` in ./Button.jsx rather than a set of
 * overrides on it. That component is 44px tall with 24px padding and 12px
 * text; this design calls for 48px, 30px and 13px. Passing those as extra
 * classes would put two utilities for the same property (`min-h-11` against
 * `h-12`, `px-6` against `px-[30px]`) on one element, and Tailwind utilities
 * share a specificity, so which one wins depends on their order in the
 * generated stylesheet rather than on the order in the class string. That is
 * not something to rely on, so the card button owns its own complete set.
 *
 * `Link` is reused, so routing and prefetching behave exactly as elsewhere.
 */
const base =
  'inline-flex h-12 items-center justify-center gap-2.5 rounded-full px-[30px] '
  + 'font-manrope text-[13px] font-semibold leading-none '
  + 'transition-colors duration-200';

const tones = {
  // Cards one and two: black pill on a light card.
  dark: 'bg-[#111111] text-white hover:bg-[#2b2a28]',
  // Card three: white pill on the terracotta.
  light: 'bg-white text-card-ink hover:bg-[#f1ebe3]',
};

export function CardButton({ href, tone = 'dark', children }) {
  return (
    <Link href={href} className={`${base} ${tones[tone] ?? tones.dark}`}>
      {children}
      {/* Inline arrow rather than the shared Icon: at 13px text the design
          calls for a hairline arrow that sits on the text baseline, and it
          must not carry the Icon component's own sizing. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
      </svg>
    </Link>
  );
}
