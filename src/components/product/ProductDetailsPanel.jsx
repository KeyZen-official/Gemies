'use client';
import { ProductSpecifications } from './ProductSpecifications.jsx';

/**
 * "View product details" — the expandable panel under the summary.
 *
 * A native <details>, so it is keyboard and screen-reader operable and works
 * before hydration. Base styles already give <details> a rule and padding;
 * the arbitrary selectors here override that for this one use.
 */
export function ProductDetailsPanel({ product, color, sizes }) {
  return (
    <details className="group mt-5 [&]:border-0 [&]:p-0">
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-[15px] underline underline-offset-4 [&::-webkit-details-marker]:hidden">
        View product details
        <span aria-hidden="true" className="text-[11px] transition-transform group-open:-rotate-180">▾</span>
      </summary>

      <div className="mt-4">
        <ProductSpecifications product={product} color={color} sizes={sizes} />
      </div>
    </details>
  );
}
