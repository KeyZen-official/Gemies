// The Gemies monogram.
//
// Gemies sells its own label, so there is one mark everywhere rather than a
// logo per product brand. This replaces the earlier brand-marks lookup, which
// resolved Nike, Adidas, Puma and New Balance from a product's `brand` field.
//
// Two tones, because the supplied artwork is cream ink made for a dark
// background and would be invisible on the white navbar or the card's panel
// grey. Both are generated from one source by scripts/extract-assets.mjs.
export const storeMark = {
  /** Near-black ink: the product card, the navbar on white. */
  dark: '/assets/brands/gemies.webp',
  /** The artwork as supplied: the footer, the navbar over the hero. */
  light: '/assets/brands/gemies-light.webp',
};

export const storeName = 'Gemies';

/** Intrinsic size of the generated files, for reserving layout space. */
export const storeMarkRatio = { width: 89, height: 120 };
