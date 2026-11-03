// Turns the colour swatches sampled from the reference tiles into named
// colourways for the product detail page.
//
// The reference shows each product's colour dots but never names them, so the
// label is derived from the swatch itself by nearest match against this
// palette. That keeps the naming reproducible rather than hand-invented.

const palette = [
  ['Black', 0x11, 0x11, 0x11],
  ['Charcoal', 0x3a, 0x3a, 0x3a],
  ['Graphite', 0x5e, 0x5e, 0x5c],
  ['Grey', 0x8a, 0x8a, 0x8a],
  ['Silver', 0xc6, 0xc2, 0xc3],
  ['Bone', 0xe3, 0xe1, 0xda],
  ['White', 0xf5, 0xf5, 0xf3],
  ['Sand', 0xc8, 0xb3, 0x93],
  ['Tan', 0xa6, 0x7c, 0x46],
  ['Brown', 0x6b, 0x4a, 0x2f],
  ['Olive', 0x7b, 0x7d, 0x56],
  ['Pine', 0x27, 0x40, 0x2a],
  ['Teal', 0x24, 0x5b, 0x5e],
  ['Navy', 0x23, 0x39, 0x5b],
  ['Blue', 0x3f, 0x6f, 0xd0],
  ['Lavender', 0x96, 0x8a, 0x97],
  ['Rose', 0x9c, 0x5f, 0x6c],
  ['Magenta', 0xbf, 0x0e, 0x78],
  ['Mustard', 0xcd, 0xab, 0x14],
  ['Orange', 0xe2, 0x67, 0x3a],
  ['Red', 0xb5, 0x34, 0x2c],
];

function channels(hex) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}

/** Nearest palette name for a sampled swatch. */
export function nameForHex(hex) {
  const [r, g, b] = channels(hex);
  let best = palette[0];
  let bestDistance = Infinity;
  for (const entry of palette) {
    const distance = (entry[1] - r) ** 2 + (entry[2] - g) ** 2 + (entry[3] - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return best[0];
}

/**
 * Builds the colourway list for a product.
 *
 * `images` is left empty on every colourway: the reference supplies one
 * photograph per product and there is no way to tell which colourway it shows,
 * so the gallery falls back to products.images and the page says so. Upload
 * colourway photography through the admin variant editor to fill these in.
 */
export function buildColorways(hexes, fallbackName = 'Standard') {
  if (!hexes?.length) return [{ name: fallbackName, hex: null, images: [] }];

  const used = new Map();
  return hexes.map((hex) => {
    const base = nameForHex(hex);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    // Two dots can land on the same palette entry; keep names unique because
    // variants.color is part of a uniqueness constraint.
    return { name: seen ? `${base} ${seen + 1}` : base, hex, images: [] };
  });
}
