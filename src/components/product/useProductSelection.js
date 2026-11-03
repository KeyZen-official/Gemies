'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Owns colour / size / quantity selection for the product detail page.
 *
 * All of it is local component state, so changing colour re-renders this
 * subtree only: no navigation, no refetch, no remount, no scroll reset. The
 * page passes the resolved variant straight to the existing cart and checkout
 * calls, which re-validate price and stock server side.
 */
export function useProductSelection(product) {
  const variants = product?.variants ?? [];

  // Prefer the product's declared colourways, so swatch colour and ordering
  // come from the catalogue. Fall back to the distinct colours present on the
  // variant rows, which is all older products have.
  const colorways = useMemo(() => {
    const declared = Array.isArray(product?.colorways) ? product.colorways : [];
    if (declared.length) return declared;
    return [...new Set(variants.map((v) => v.color))].map((name) => ({ name, hex: null, images: [] }));
  }, [product?.colorways, variants]);

  const stockByColor = useMemo(() => {
    const totals = new Map();
    for (const variant of variants) {
      totals.set(variant.color, (totals.get(variant.color) ?? 0) + variant.available);
    }
    return totals;
  }, [variants]);

  // Open on a colourway the customer can actually buy.
  const [color, setColor] = useState(() => {
    const inStock = colorways.find((c) => (stockByColor.get(c.name) ?? 0) > 0);
    return (inStock ?? colorways[0])?.name ?? '';
  });
  const [size, setSize] = useState('');

  const colorway = colorways.find((c) => c.name === color) ?? colorways[0] ?? null;

  // Sizes are per colourway: never assume every colour runs the same range.
  const sizes = useMemo(
    () => variants
      .filter((variant) => variant.color === color)
      .map((variant) => ({
        size: variant.size,
        variantId: variant.id,
        available: variant.available,
        // Carried through so the information column can show the real style
        // code for the selected size.
        sku: variant.sku,
      })),
    [variants, color],
  );

  const variant = sizes.find((entry) => entry.size === size) ?? null;
  const soldOut = sizes.length > 0 && sizes.every((entry) => entry.available === 0);

  // A single size means the size is not a real choice (accessories), so select
  // it automatically rather than blocking Add to Bag on it.
  const sizeRequired = sizes.length > 1;
  useEffect(() => {
    if (!sizeRequired && sizes.length === 1 && sizes[0].available > 0) setSize(sizes[0].size);
  }, [sizeRequired, sizes]);

  // Keep the chosen size across a colour change when that colour stocks it,
  // otherwise clear it so the customer is asked again.
  const selectColor = useCallback((next) => {
    setColor(next);
    setSize((current) => {
      if (!current) return '';
      const match = variants.find((v) => v.color === next && v.size === current);
      return match && match.available > 0 ? current : '';
    });
  }, [variants]);

  // Gallery follows the colourway when it has its own photography, otherwise
  // the product's. Reported through `galleryIsColorway` so the page can say so.
  const images = colorway?.images?.length ? colorway.images : (product?.images ?? []);

  // Warm every colourway's images so switching colour does not wait on a fetch.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const all = new Set([...(product?.images ?? []), ...colorways.flatMap((c) => c.images ?? [])]);
    for (const src of all) {
      const preload = new window.Image();
      preload.src = src;
    }
  }, [product?.images, colorways]);

  return {
    colorways,
    color,
    colorway,
    selectColor,
    colorInStock: (name) => (stockByColor.get(name) ?? 0) > 0,
    sizes,
    size,
    setSize,
    sizeRequired,
    variant,
    soldOut,
    images,
    galleryIsColorway: Boolean(colorway?.images?.length),
  };
}
