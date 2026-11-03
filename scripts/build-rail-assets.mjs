// Builds the hanging-garment assets for the clothing rail hero, and the data
// file that drives it.
//
//   npm run dev          (in another terminal -- this reads the live catalogue)
//   node scripts/build-rail-assets.mjs
//
// It reads over HTTP rather than opening the database. That was once a hard
// requirement -- the embedded development database could not be opened by a
// second process while the dev server held it -- and it is now simply the
// simpler option: the catalogue is already served at /api/products, so this
// asks for it and needs no connection string of its own.
//
// What it produces
// ----------------
// public/assets/products/rail/<slug>.webp
//   Every garment cut out of its square catalogue frame and re-seated on one
//   shared 600x930 canvas -- the 200x310 portrait the component documents, at
//   3x. This matters more than it sounds. The catalogue assets are 1400x1400
//   with the garment floating at whatever size the original shoot gave it, so
//   dropped straight onto the rail a polo would hang half the height of a
//   shirt and every hem would land at a different place. Normalising puts
//   every shoulder line at the same height, under the drawn hanger bar, and
//   scales each garment to a common shoulder width.
//
// src/data/rail-items.js
//   Real names, colourways, prices, fits and fabrics from the catalogue. No
//   invented copy and no stock photography.
//
// Only tops are included. The rail hangs garments from a shoulder hanger, and
// the component's own garment kinds are all tops (tee, knit, hoodie, shirt,
// jacket, coat). Joggers and shorts would hang from the waist off a shoulder
// hanger, which looks broken, so bottom wear is left to its own section
// further down the homepage.
import sharp from 'sharp';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const API = process.env.RAIL_API ?? 'http://localhost:3000/api';
const SRC_DIR = 'public/assets/products';
const OUT_DIR = 'public/assets/products/rail';
const DATA_FILE = 'src/data/rail-items.js';

// The canvas the component asks for: "a 200 x 310 portrait canvas". At 3x so a
// garment still resolves on a 400px-tall rail on a 2x display.
const CW = 600;
const CH = 930;

// Where the garment sits on that canvas.
//
// The component places the photo in the lower 92% of its box and draws the
// hanger behind it, with the bar running across y=36..57 of the 200x310
// viewBox. Converting: the photo box starts at y=24.8 and is 285.2 tall, so
// the bar sits 7.1% down the photo. Putting the garment's shoulders at 7%
// leaves the bar and its hook visible above the collar instead of buried
// behind the chest.
const TOP = 0.07;
// Shoulder width as a share of the canvas. The hanger bar spans 124 of 200
// viewBox units, which works out at 404 of these 600 -- so 0.80 lets the
// sleeves of a tee drape a little wider than the bar, the way they do on a
// real hanger, without the bar ends poking out past the garment.
const WIDTH = 0.80;
const BOTTOM_PAD = 0.03;

/** Tight bounding box of everything that is not fully transparent. */
async function alphaBounds(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] < 12) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Human colour name from a swatch hex, for telling three identical names apart. */
function colourName(hex) {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const light = (max + min) / 2 / 255;
  const chroma = (max - min) / 255;
  if (chroma < 0.1) {
    if (light > 0.86) return 'White';
    if (light > 0.62) return 'Light grey';
    if (light > 0.3) return 'Grey';
    return 'Black';
  }
  if (r > g && r > b) return light < 0.45 ? 'Deep red' : 'Red';
  if (g > r && g > b) return 'Green';
  if (b > r && b > g) return 'Blue';
  return 'Natural';
}

/** The component's garment kinds, from the store's category segments. */
function kindFor(product) {
  const slug = product.category_slug ?? '';
  if (slug.startsWith('shirts')) return 'shirt';
  if (slug.includes('full-sleeve')) return 'knit';
  return 'tee';
}

const money = (paise) => `\u20B9${Math.round(paise / 100)}`;

/**
 * How distinctive a colourway is, for choosing which variant of a style goes
 * on the rail. Chroma dominates, so a red tee beats a white one; lightness
 * breaks ties towards the darker variant, so a black tee beats a white one.
 * Both because the rail sits on cream and pale garments disappear into it.
 */
function distinctiveness(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return -1;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  const light = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
  return chroma * 3 + (1 - light);
}

/**
 * One garment per style, in its most distinctive colourway.
 *
 * The catalogue carries three products called "Classic Crew T-Shirt" and two
 * called "Essential Cotton T-Shirt", differing only by colour. All eleven on
 * the rail meant four near-identical pale tees in a row, which is both dull
 * and, at a resting angle, impossible to tell apart. It also cost the width
 * that lets each garment rest at a shallower, more readable angle.
 *
 * The colourways are not lost -- they are on the product page, which is where
 * a colour is chosen.
 */
function oneVariantPerStyle(products) {
  const byStyle = new Map();
  for (const product of products) {
    const style = product.name.trim();
    const best = byStyle.get(style);
    if (!best || distinctiveness(product.swatches?.[0]) > distinctiveness(best.swatches?.[0])) {
      byStyle.set(style, product);
    }
  }
  return [...byStyle.values()];
}

async function main() {
  const tops = [];
  for (const category of ['t-shirts', 'shirts']) {
    const res = await fetch(`${API}/products?category=${category}&limit=48`);
    if (!res.ok) throw new Error(`GET /products?category=${category} -> ${res.status}. Is the dev server running?`);
    const { products } = await res.json();
    tops.push(...products);
  }
  if (!tops.length) throw new Error('no tops returned from the catalogue');

  await mkdir(OUT_DIR, { recursive: true });

  const chosen = oneVariantPerStyle(tops);
  const items = [];
  console.log(`${tops.length} tops in the catalogue, ${chosen.length} styles on the rail`);
  const dropped = tops.filter((p) => !chosen.includes(p));
  if (dropped.length) {
    console.log(`  not on the rail (a more distinctive colourway of the same style won):`);
    for (const p of dropped) console.log(`    ${p.slug.padEnd(42)} ${p.name} ${p.swatches?.[0] ?? ''}`);
  }
  console.log('');

  for (const product of chosen) {
    const src = `${SRC_DIR}/${product.slug}.webp`;
    if (!existsSync(src)) { console.log(`  SKIP ${product.slug} -- no asset at ${src}`); continue; }

    const box = await alphaBounds(src);
    if (!box) { console.log(`  SKIP ${product.slug} -- fully transparent`); continue; }

    // Scale to a common shoulder width, but never past the canvas height.
    const byWidth = (CW * WIDTH) / box.width;
    const roomH = CH * (1 - TOP - BOTTOM_PAD);
    const scale = Math.min(byWidth, roomH / box.height);
    const w = Math.max(1, Math.round(box.width * scale));
    const h = Math.max(1, Math.round(box.height * scale));

    const garment = await sharp(src)
      .extract(box)
      .resize(w, h, { fit: 'fill' })
      .toBuffer();

    const out = `${OUT_DIR}/${product.slug}.webp`;
    await sharp({ create: { width: CW, height: CH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: garment, left: Math.round((CW - w) / 2), top: Math.round(CH * TOP) }])
      .webp({ quality: 86, effort: 6, alphaQuality: 100 })
      .toFile(out);

    const colour = colourName(product.swatches?.[0]);
    const base = product.name.replace(/\s+T-Shirt$/, ' T-Shirt');
    const name = colour ? `${base} \u00B7 ${colour}` : base;
    const details = [product.fit, product.fabric, product.category].filter(Boolean);

    items.push({
      id: product.slug,
      name,
      href: `/product/${product.slug}`,
      description: product.description?.split(/(?<=\.)\s/)[0] ?? undefined,
      kind: kindFor(product),
      color: product.swatches?.[0] ?? undefined,
      image: `/assets/products/rail/${product.slug}.webp`,
      tag: money(product.price),
      details,
    });

    console.log(`  ${product.slug.padEnd(42)} bbox ${String(box.width).padStart(4)}x${String(box.height).padStart(4)}`
      + ` -> ${String(w).padStart(3)}x${String(h).padStart(3)} on ${CW}x${CH}`
      + `  scale ${scale.toFixed(3)}  ${name}`);
  }

  // Drop assets for garments no longer on the rail, so narrowing the selection
  // does not leave orphans being served out of public/.
  const keep = new Set(items.map((item) => `${item.id}.webp`));
  const orphans = (await readdir(OUT_DIR)).filter((file) => file.endsWith('.webp') && !keep.has(file));
  for (const file of orphans) await rm(`${OUT_DIR}/${file}`);
  if (orphans.length) console.log(`\npruned ${orphans.length} asset(s) no longer on the rail: ${orphans.join(', ')}`);

  const body = `// GENERATED by scripts/build-rail-assets.mjs -- do not edit by hand.
//
// The garments on the homepage clothing rail, taken from the live catalogue:
// real names, colourways, prices, fits and fabrics. Re-run the script after
// changing the catalogue, or the prices on the hang tags will drift.
//
// \`image\` points at the normalised rail asset, not the catalogue asset. Every
// garment is re-seated on one shared 600x930 canvas so they all hang from the
// same shoulder line at a common scale -- see the script for why.
//
// \`backImage\` and \`sideImage\` are deliberately absent. The store has one
// photograph per garment, so there is no honest back or side view to show. The
// component's documented fallbacks cover it: the back face reuses the front
// photograph, and with no side photo a resting garment is the front view turned
// away from the viewer, which is what the rail wants anyway.
export const railItems = ${JSON.stringify(items, null, 2).replace(/"([a-zA-Z_$][\w$]*)":/g, '$1:')};
`;
  await writeFile(DATA_FILE, body, 'utf8');
  console.log(`\n${items.length} items -> ${DATA_FILE}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
