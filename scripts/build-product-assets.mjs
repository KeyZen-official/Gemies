// Turns the verified source PNGs in public/products/ into web assets.
//
// The sources are 0.3-24 MB each, which is fine for a source library and
// unusable on a product page. This writes a web-sized WebP per garment with
// its alpha intact, samples the garment's own colour for the swatch, and
// composes a category tile per top-level category.
//
// Source of truth stays public/products/. Nothing here writes back to it.
//
//   node scripts/build-product-assets.mjs
import sharp from 'sharp';
import {readdir, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const SOURCE = 'public/products';
const OUT = 'public/assets/products';
const TILES = 'public/assets';
// Twice the largest on-page use (the product page's ~700px frame), which is
// enough for a retina display without shipping a multi-megabyte file.
const MAX_SIDE = 1400;

/**
 * The catalogue. Each entry ties a verified source file to the category it
 * belongs in and the copy that goes with it.
 *
 * Category slugs are the ones scripts/taxonomy.mjs creates. Note there is no
 * "plain" subcategory in that taxonomy, so plain crew tees are filed under
 * regular-fit, which is what they are.
 *
 * Names are descriptive and carry no brand or model claim. The garments
 * photographed are blanks from MWW On Demand; see docs/PRODUCT_IMAGE_SOURCES.md.
 */
export const catalogue = [
  // ---- T-shirts
  ['tshirts/plain/plain-black-bella-canvas-3001-01.png', 't-shirts-regular-fit',
    'Essential Cotton T-Shirt', 'Black', 79900, 'tops'],
  ['tshirts/plain/plain-white-bella-canvas-3001-01.png', 't-shirts-regular-fit',
    'Essential Cotton T-Shirt', 'White', 79900, 'tops'],
  ['tshirts/plain/plain-grey-triblend-bella-canvas-3413-01.png', 't-shirts-regular-fit',
    'Tri-Blend T-Shirt', 'Grey Marl', 89900, 'tops'],
  ['tshirts/plain/plain-white-01.png', 't-shirts-regular-fit',
    'Everyday Crew T-Shirt', 'White', 69900, 'tops'],
  ['tshirts/regular/regular-mens-tee-flat-01.png', 't-shirts-regular-fit',
    'Classic Crew T-Shirt', 'White', 74900, 'tops'],
  ['tshirts/regular/regular-black-02.png', 't-shirts-regular-fit',
    'Classic Crew T-Shirt', 'Black', 74900, 'tops'],
  ['tshirts/regular/regular-red-03.png', 't-shirts-regular-fit',
    'Classic Crew T-Shirt', 'Red', 74900, 'tops'],
  ['tshirts/regular/regular-mens-long-sleeve-tee-01.png', 't-shirts-full-sleeve',
    'Long Sleeve T-Shirt', 'White', 99900, 'tops'],
  ['tshirts/polo/polo-flat-front-01.png', 't-shirts-polo',
    'Piqué Polo Shirt', 'White', 129900, 'tops'],
  // ---- Shirts
  ['shirts/casual/casual-camp-collar-shirt-01.png', 'shirts-casual',
    'Camp Collar Shirt', 'White', 149900, 'tops'],
  // Filed under casual: the taxonomy's only full-sleeve subcategory belongs to
  // T-shirts, and a hooded knit top is a casual shirt rather than a tee.
  ['shirts/full-sleeve/full-sleeve-hooded-raglan-shirt-01.png', 'shirts-casual',
    'Hooded Raglan Shirt', 'White', 159900, 'tops'],
  // ---- Bottom wear
  ['bottoms/joggers/joggers-mens-lounge-pant-01.png', 'bottom-wear-joggers',
    'Lounge Jogger', 'White', 139900, 'waist'],
  ['bottoms/casual-shorts/casual-shorts-training-01.png', 'bottom-wear-shorts',
    'Training Shorts', 'White', 109900, 'tops'],
  ['bottoms/casual-shorts/casual-shorts-woven-01.png', 'bottom-wear-shorts',
    'Woven Shorts', 'Natural', 119900, 'tops'],
];

/**
 * Garments used by the three homepage promotional cards.
 *
 * These get a second, tight-cropped asset in public/assets/products/promo/.
 * The normal web asset pads every garment into a square frame so the product
 * grid shows them all at one scale, but a square frame is wrong for a promo
 * card: a pair of trousers is roughly 1:2, so inside a square canvas it is
 * height-bound and leaves ~58% of the card's width empty, and the garment
 * renders far smaller than the card can display.
 *
 * The promo variant keeps each garment's own aspect ratio, so a card can set
 * the image width directly and get the percentage of card width the design
 * asks for.
 */
const PROMO_SOURCES = [
  'tshirts/plain/plain-black-bella-canvas-3001-01.png',
  'shirts/casual/casual-camp-collar-shirt-01.png',
  'bottoms/joggers/joggers-mens-lounge-pant-01.png',
];

/** One tile per top-level category, built from a representative garment. */
const TILE_SOURCES = [
  ['t-shirts', 'tshirts/plain/plain-black-bella-canvas-3001-01.png', 'T-Shirts', '#e7e5e1'],
  ['shirts', 'shirts/casual/casual-camp-collar-shirt-01.png', 'Shirts', '#dcdbd6'],
  ['bottom-wear', 'bottoms/casual-shorts/casual-shorts-woven-01.png', 'Bottom Wear', '#e3e0d9'],
];

/** Mean colour of the garment itself, ignoring everything transparent. */
async function garmentColour(file) {
  const {data, info} = await sharp(file)
    .ensureAlpha()
    .resize(160, 160, {fit: 'inside'})
    .raw()
    .toBuffer({resolveWithObject: true});
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const at = i * info.channels;
    if (data[at + 3] < 200) continue;
    r += data[at]; g += data[at + 1]; b += data[at + 2]; n += 1;
  }
  if (!n) return '#cccccc';
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Trims the transparent margin, then re-pads to a consistent frame.
 *
 * Source files have wildly different amounts of empty space around the
 * garment. Without normalising, one tee would fill its card while the next sat
 * tiny in the middle of it. Trim to the garment, then give every garment the
 * same 6% breathing room in a square frame.
 */
async function webAsset(file) {
  const trimmed = await sharp(file).trim({threshold: 1}).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const side = Math.max(meta.width, meta.height);
  const frame = Math.min(MAX_SIDE, Math.round(side * 1.12));
  const inner = Math.round(frame * 0.88);
  return sharp({create: {width: frame, height: frame, channels: 4, background: '#00000000'}})
    .composite([{
      input: await sharp(trimmed).resize(inner, inner, {fit: 'inside'}).png().toBuffer(),
      gravity: 'center',
    }])
    .webp({quality: 86, alphaQuality: 100, effort: 5})
    .toBuffer();
}

/**
 * Tight crop of the garment, keeping its own aspect ratio.
 *
 * A 1.5% transparent margin is kept on each side so the edge antialiasing is
 * not clipped; without it a hard-trimmed garment shows a faint cut line when
 * composited on a saturated background like the terracotta card.
 */
async function promoAsset(file) {
  const trimmed = await sharp(file).trim({threshold: 1}).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const scale = Math.min(1, MAX_SIDE / Math.max(meta.width, meta.height));
  const width = Math.round(meta.width * scale);
  const height = Math.round(meta.height * scale);
  const pad = Math.round(Math.max(width, height) * 0.015);
  return sharp({
    create: {width: width + pad * 2, height: height + pad * 2, channels: 4, background: '#00000000'},
  })
    .composite([{input: await sharp(trimmed).resize(width, height).png().toBuffer(), gravity: 'center'}])
    .webp({quality: 90, alphaQuality: 100, effort: 5})
    .toBuffer();
}

/** A photographic-style category tile: garment on a tinted panel. */
async function categoryTile(file, background, width, height) {
  const trimmed = await sharp(file).trim({threshold: 1}).png().toBuffer();
  const garment = await sharp(trimmed)
    .resize(Math.round(height * 0.78), Math.round(height * 0.78), {fit: 'inside'})
    .png()
    .toBuffer();
  return sharp({create: {width, height, channels: 3, background}})
    .composite([{input: garment, gravity: 'center'}])
    .webp({quality: 84})
    .toBuffer();
}

// ------------------------------------------------------------------- run
await mkdir(OUT, {recursive: true});

const manifest = [];
console.log('Web assets:');
for (const [relative, category, name, colour, price, sizing] of catalogue) {
  const file = path.join(SOURCE, relative);
  const slug = path.basename(relative, '.png');
  const buffer = await webAsset(file);
  await writeFile(path.join(OUT, `${slug}.webp`), buffer);
  const out = await sharp(buffer).metadata();
  const source = await sharp(file).metadata();
  const hex = await garmentColour(file);

  manifest.push({
    slug, name, colour, hex, price, category, sizing,
    image: `/assets/products/${slug}.webp`,
    source: `public/products/${relative}`,
  });
  console.log(`  ${slug.padEnd(46)} ${source.width}x${source.height} -> ${out.width}x${out.height}` +
    `  ${(buffer.length / 1024).toFixed(0)} KB  ${hex}`);
}

console.log('\nPromo card assets (tight crop, natural aspect):');
await mkdir(path.join(OUT, 'promo'), {recursive: true});
for (const relative of PROMO_SOURCES) {
  const slug = path.basename(relative, '.png');
  const buffer = await promoAsset(path.join(SOURCE, relative));
  await writeFile(path.join(OUT, 'promo', `${slug}.webp`), buffer);
  const out = await sharp(buffer).metadata();
  console.log(`  promo/${slug}.webp`.padEnd(54)
    + `${out.width}x${out.height}  aspect ${(out.width / out.height).toFixed(3)}`
    + `  ${(buffer.length / 1024).toFixed(0)} KB`);
}

console.log('\nCategory tiles:');
for (const [slug, relative, label, background] of TILE_SOURCES) {
  // The mosaic uses one tall tile and two wide ones.
  const [width, height] = slug === 't-shirts' ? [760, 1000] : [760, 520];
  const buffer = await categoryTile(path.join(SOURCE, relative), background, width, height);
  await writeFile(path.join(TILES, `collection-${slug}.webp`), buffer);
  console.log(`  collection-${slug}.webp`.padEnd(34) + `${width}x${height}  ${(buffer.length / 1024).toFixed(0)} KB  (${label})`);
}

await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} products written to ${OUT}`);
console.log('Run: npm run seed');
