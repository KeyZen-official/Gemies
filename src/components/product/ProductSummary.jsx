'use client';

/**
 * Description, colour shown and style code.
 *
 * The style code is the selected variant's real SKU once a size is chosen.
 * Before that there is no single SKU to show, because the catalogue keys SKUs
 * per size *and* colour, so the colourway's shared prefix is shown instead of
 * picking one size's code arbitrarily.
 */
export function ProductSummary({ product, color, variant, sizes }) {
  // Every SKU in a colourway starts with the same product + colour segment;
  // the size is the tail. Trimming the tail gives the colourway's code.
  const colourCode = (() => {
    const codes = sizes.map((entry) => entry.sku).filter(Boolean);
    if (!codes.length) return null;
    if (codes.length === 1) return codes[0];
    let shared = codes[0];
    for (const code of codes.slice(1)) {
      let i = 0;
      while (i < shared.length && i < code.length && shared[i] === code[i]) i += 1;
      shared = shared.slice(0, i);
    }
    return shared.replace(/[-_\s]+$/, '') || null;
  })();

  const style = variant?.sku ?? colourCode;

  return (
    <section className="pt-1">
      {product.description && (
        <p className="m-0 text-[15px] leading-[1.75] text-body">{product.description}</p>
      )}

      <ul className="mt-5 mb-0 list-disc pl-[18px] text-[15px] leading-[1.75] text-body">
        {color && (
          <li>
            Colour shown: <span className="text-ink-soft">{color}</span>
          </li>
        )}
        {style && (
          <li>
            Style: <span className="text-ink-soft">{style}</span>
          </li>
        )}
        {product.audience && (
          <li>
            Collection: <span className="text-ink-soft">
              {product.audience}{product.audience === 'Unisex' ? '' : '’s'} {product.category}
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}
