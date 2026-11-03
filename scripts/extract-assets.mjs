// Extracts photography from the supplied reference screenshots.
//
// The reference is a set of page screenshots, so every photograph arrives with
// the design's own headings, captions and buttons burned into it. Those must
// never reach the site as UI: the site renders its own real headings, links and
// buttons. This script therefore does two things beyond cropping:
//
//   1. "erase" - replaces the rectangles holding baked text with a heavily
//      blurred copy of the same pixels, blended through a feathered mask. On
//      the flat card backgrounds this removes the text completely; over
//      photographs it leaves soft bokeh that the component's own gradient
//      scrim covers.
//   2. product crops - the product tiles carry a brand logo and colour dots in
//      the top band. That band is cropped away so ProductCard can render the
//      brand and the colour swatches as real elements. The dot colours are
//      sampled first (this no longer runs; see the note above the store mark)
//      the reference's actual colours instead of invented ones.
//
// No generated or substituted photography is used. Run: node scripts/extract-assets.mjs
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'public/assets');
await mkdir(output, { recursive: true });

const files = [
  'WhatsApp Image 2026-10-29 at 4.21.52 PM (1).jpeg',
  'WhatsApp Image 2026-10-29 at 4.21.52 PM.jpeg',
  'WhatsApp Image 2026-10-29 at 4.21.53 PM (1).jpeg',
  'WhatsApp Image 2026-10-29 at 4.21.53 PM (2).jpeg',
  'WhatsApp Image 2026-10-29 at 4.21.53 PM (3).jpeg',
  'WhatsApp Image 2026-10-29 at 4.21.53 PM.jpeg',
];

// Every screenshot except index 1 (the full-page overview) is stored sideways.
const sources = await Promise.all(files.map(async (file, index) => {
  let image = sharp(path.join(root, 'LayoutPhoto', file));
  if (index !== 1) image = image.rotate(90);
  return image.png().toBuffer();
}));

const manifest = [];

function region(source, [left, top, width, height]) {
  return sharp(sources[source]).extract({ left, top, width, height }).png().toBuffer();
}

/** Joins vertically adjacent screenshot strips into one card image. */
async function stitch(segments, width) {
  const pieces = await Promise.all(segments.map(async ([source, left, top, w, h]) => ({
    input: await sharp(sources[source]).extract({ left, top, width: w, height: h }).resize({ width }).png().toBuffer(),
    height: Math.round((h * width) / w),
  })));
  let top = 0;
  const layers = pieces.map((piece) => {
    const layer = { input: piece.input, left: 0, top };
    top += piece.height;
    return layer;
  });
  return sharp({ create: { width, height: top, channels: 3, background: '#f2f2f2' } })
    .composite(layers).png().toBuffer();
}

/** Grows a mask by `radius` pixels so anti-aliased glyph edges are covered. */
function dilate(mask, width, height, radius) {
  const out = Buffer.alloc(mask.length, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < width) out[ny * width + nx] = 255;
        }
      }
    }
  }
  return out;
}

/**
 * Removes the design's baked text while keeping the photograph sharp.
 *
 * The baked headings, captions and pill buttons are all near-white. So instead
 * of blurring whole regions, this masks only the bright pixels inside the text
 * rectangles and then diffuses the surrounding colour inward over several
 * passes. Because only the glyph strokes and the pill shapes are replaced, the
 * sneakers and the rest of the frame stay at full sharpness.
 *
 * Two earlier approaches were rejected: patching tight rectangles with a heavy
 * blur left visible grey boxes, and blurring the whole frame removed the text
 * but also removed the product the hero exists to show.
 */
async function inpaintText(buffer, rects, { threshold = 237, grow = 4, radii = [26, 22, 18, 15, 12, 10, 8, 7, 6, 5, 4] } = {}) {
  const { width, height } = await sharp(buffer).metadata();
  const { data } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  // Each rect may carry its own brightness cut-off. A bold headline sits near
  // pure white, while the lighter-weight body copy is dimmer and needs a lower
  // cut-off to be caught at all.
  let mask = Buffer.alloc(width * height, 0);
  for (const [rx, ry, rw, rh, rectThreshold = threshold] of rects) {
    for (let y = Math.max(0, ry); y < Math.min(height, ry + rh); y++) {
      for (let x = Math.max(0, rx); x < Math.min(width, rx + rw); x++) {
        const i = (y * width + x) * 3;
        const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (luminance > rectThreshold) mask[y * width + x] = 255;
      }
    }
  }
  mask = dilate(mask, width, height, grow);

  // Carry the mask as the alpha channel so `dest-in` can clip the diffused
  // copy to exactly the masked pixels.
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = 255;
    rgba[p * 4 + 1] = 255;
    rgba[p * 4 + 2] = 255;
    rgba[p * 4 + 3] = mask[p];
  }
  const maskImage = await sharp(rgba, { raw: { width, height, channels: 4 } }).blur(1.4).png().toBuffer();

  // Coarse to fine: the first wide passes drag distant colour across the solid
  // pill shapes, the later narrow ones settle the thin glyph strokes.
  let current = await sharp(buffer).removeAlpha().png().toBuffer();
  for (const radius of radii) {
    const spread = await sharp(current).blur(radius).ensureAlpha().png().toBuffer();
    const patch = await sharp(spread).composite([{ input: maskImage, blend: 'dest-in' }]).png().toBuffer();
    current = await sharp(current).composite([{ input: patch }]).png().toBuffer();
  }
  return current;
}

async function save(name, buffer, notes, extra = {}) {
  const { width, height } = await sharp(buffer).metadata();
  await sharp(buffer).webp({ quality: 92 }).toFile(path.join(output, `${name}.webp`));
  manifest.push({ name, width, height, notes, ...extra });
}

/**
 * Samples the reference colour dots from a product tile's top-right band.
 *
 * The dots are a row of equal circles, inset from the band's edges, and
 * neighbours of a similar colour touch. Two earlier approaches failed on that:
 * clustering colours along one row merged touching neighbours and
 * under-counted, and measuring the dot diameter down a single column broke
 * whenever that column fell in a gap or the product photograph intruded into
 * the band and offered a longer row of non-background pixels than the dots.
 *
 * So the band is masked, split into blobs, and every blob that reaches an edge
 * is discarded as scenery, since the photograph always enters from the left or
 * the bottom while the dots never touch a side. The median blob height is the
 * dot diameter, which holds whether the dots merged into one blob or stayed
 * separate, and each blob then yields round(width / diameter) dots.
 */
async function sampleSwatches(buffer) {
  const meta = await sharp(buffer).metadata();
  const left = Math.round(meta.width * 0.5);
  const band = { left, top: 0, width: meta.width - left, height: Math.round(meta.height * 0.17) };
  const { data, info } = await sharp(buffer).extract(band).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const at = (x, y) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const spread = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  // The card background is whatever colour dominates the band; sampling a
  // fixed corner breaks whenever a dot happens to sit there. Colours are
  // bucketed to find the dominant one, then averaged over the pixels in that
  // bucket: the bucket's midpoint is up to 8 per channel out, which would eat
  // most of the mask cut-off below.
  const buckets = new Map();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = at(x, y);
      const key = pixel.map((v) => v >> 4).join(',');
      const bucket = buckets.get(key) ?? [0, 0, 0, 0];
      bucket[0] += pixel[0];
      bucket[1] += pixel[1];
      bucket[2] += pixel[2];
      bucket[3] += 1;
      buckets.set(key, bucket);
    }
  }
  const dominant = [...buckets.values()].sort((a, b) => b[3] - a[3])[0];
  const background = [dominant[0] / dominant[3], dominant[1] / dominant[3], dominant[2] / dominant[3]];

  // The cut-off has to stay low enough for a near-white dot, since one tile
  // opens with cream on pale grey, yet high enough to ignore the studio
  // vignette. Anything the vignette does leak through spans the whole band and
  // is dropped by the edge test below.
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (spread(at(x, y), background) > 30) mask[y * width + x] = 1;
    }
  }

  const seen = new Uint8Array(width * height);
  const blobs = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const origin = y * width + x;
      if (!mask[origin] || seen[origin]) continue;
      seen[origin] = 1;
      const stack = [origin];
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;
      while (stack.length) {
        const point = stack.pop();
        const px = point % width;
        const py = (point - px) / width;
        area += 1;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const next = ny * width + nx;
            if (mask[next] && !seen[next]) {
              seen[next] = 1;
              stack.push(next);
            }
          }
        }
      }
      // JPEG noise leaves specks a few pixels across. Keeping them would drag
      // the diameter estimate below any real dot.
      const touchesEdge = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
      if (!touchesEdge && area >= 16) blobs.push({ minX, maxX, minY, maxY, area });
    }
  }
  if (!blobs.length) return [];

  // The run of dots is far and away the largest surviving blob, and its height
  // is the dot diameter whether the dots merged into one blob or stayed apart.
  const largest = blobs.reduce((a, b) => (b.area > a.area ? b : a));
  const diameter = largest.maxY - largest.minY + 1;
  if (diameter < 6) return [];

  // Averaging a patch well inside the circle keeps the anti-aliased rim, and
  // any neighbour bleeding through it, out of the sampled colour.
  const sampleAt = (cx, cy) => {
    const radius = Math.max(1, Math.floor(diameter / 6));
    const total = [0, 0, 0];
    let n = 0;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const pixel = at(x, y);
        total[0] += pixel[0];
        total[1] += pixel[1];
        total[2] += pixel[2];
        n += 1;
      }
    }
    return n ? [total[0] / n, total[1] / n, total[2] / n] : null;
  };

  // Neighbouring dots overlap, so a run of n of them is not n diameters wide:
  // it is (n - 1) * pitch + diameter. The reference art uses one constant
  // pitch on every tile, measured at 0.69 of the dot diameter, and that
  // recovers the count on all twelve tiles. Dividing the span by the diameter
  // instead, as if the dots were merely tangent, under-counts every run.
  const pitch = diameter * 0.69;
  const swatches = [];
  const dots = blobs
    .filter((blob) => {
      const h = blob.maxY - blob.minY + 1;
      return h >= diameter * 0.6 && h <= diameter * 1.6;
    })
    .sort((a, b) => a.minX - b.minX);
  for (const blob of dots) {
    const span = blob.maxX - blob.minX + 1;
    const count = Math.max(1, Math.round((span - diameter) / pitch) + 1);
    // The first and last centres sit one radius inside the run, so spacing the
    // rest evenly between them keeps the pitch estimate out of the positions.
    const step = count > 1 ? (span - diameter) / (count - 1) : 0;
    const cy = Math.round((blob.minY + blob.maxY) / 2);
    for (let i = 0; i < count; i++) {
      const cx = Math.round(blob.minX + diameter / 2 + step * i);
      const colour = sampleAt(cx, cy);
      if (colour) swatches.push(hex(colour));
    }
  }
  return swatches;
}

// ---------------------------------------------------------------- hero banner
// The only supplied hero photograph. Crop excludes the baked navigation and
// carousel controls; inpainting removes the burned-in headline, body copy and
// CTA so HeroBanner can render those as real elements over a sharp photograph.
// The white sneaker and the white headline share the same brightness where
// they overlap, so a higher cut-off is used on the headline bands to spare the
// shoe, and a lower one on the thinner body copy and the solid pill.
await save('hero', await inpaintText(await region(0, [80, 170, 1284, 548]), [
  [172, 100, 946, 102, 208],  // headline line one
  [336, 192, 618, 96, 208],   // headline line two
  [236, 284, 812, 80, 186],   // supporting copy
  [532, 366, 222, 88, 186],   // Shop Now pill
]), 'Hero photograph. Baked navigation and carousel cropped out; baked headline, copy and CTA inpainted away, leaving the sneakers sharp. HeroBanner renders the real text.');

// ----------------------------------------------------------- promotional cards
// The two photographic promo tiles this script used to produce (promo-puma and
// promo-nike) are gone. Both were sneaker pictures, and the second was a
// lifestyle shot of a man wearing a shirt. The store sells its own men's
// clothing, so the promo cards now show isolated garments on a flat tint,
// taken from the verified transparent images in public/products/ and turned
// into web assets by scripts/build-product-assets.mjs. See `promoCards` in
// src/data/home-content.js.

// Card three is pure typography on a gradient, rebuilt entirely in CSS, so only
// its gradient endpoints are sampled. Nothing reads them at runtime — the card
// uses the tint the brand asked for — but they stay in the manifest as the
// record of what the reference artwork actually used.
const offer = await stitch([[0, 927, 858, 375, 321], [5, 911, 0, 374, 208]], 375);
const offerPixel = async (x, y) => {
  const { data } = await sharp(offer).extract({ left: x, top: y, width: 2, height: 2 }).raw().toBuffer({ resolveWithObject: true });
  return '#' + [data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
};
const offerGradient = { from: await offerPixel(6, 6), to: await offerPixel(360, 500) };

// The four collection tiles this script used to produce (sneakers, bags,
// headwear, sunglasses) are gone. The store sells men's clothing, so the
// category tiles are now composed from the garment photography by
// scripts/build-product-assets.mjs and written to
// public/assets/collection-{t-shirts,shirts,bottom-wear}.webp.

// -------------------------------------------------------- bottom promo banner
await save('footer-banner', await inpaintText(await region(4, [134, 660, 1160, 464]), [
  [106, 82, 952, 170, 208],   // headline
  [220, 236, 718, 80, 186],   // supporting copy
  [484, 322, 202, 88, 186],   // Shop Now pill
]), 'Closing banner photograph; baked headline, copy and CTA inpainted away, leaving the photograph sharp. BottomPromoBanner renders the real text.');

// The twelve footwear and accessory product tiles this script used to cut out
// of the reference screenshots are gone, along with the colour-dot sampling
// that fed products.swatches. The catalogue is men's clothing now: its
// products come from the verified garment images in public/products/, turned
// into web assets by scripts/build-product-assets.mjs and seeded by
// scripts/seed.mjs. `sampleSwatches` above is retained because it is the only
// record of how those swatches were derived, but nothing calls it.

// --------------------------------------------------------------- store mark
// The Gemies monogram, from brand-logos/gemies.png.
//
// The store sells its own label, so there is one mark rather than a logo per
// product brand. The earlier per-brand marks (Nike, Adidas, Puma, New Balance)
// are no longer generated; their source files stay in brand-logos/ but nothing
// ships them.
//
// Two tones come out of the one source. The supplied artwork is cream ink
// (#fdfaf5) on transparency, made for a dark background: it is all but
// invisible on the white navbar and on the card's #f1f1f1 panel. The mark is
// monochrome, so recolouring the ink while keeping the alpha channel is a
// faithful tone variant, not a redesign.
//
//   gemies.webp        near-black ink, for light surfaces
//   gemies-light.webp  the supplied cream ink, for dark surfaces
//
// Rastered at 120px tall, comfortably above twice the largest on-screen use
// (the 30px navbar lockup), and trimmed first so the artwork's padding does
// not decide its on-screen size.
const MARK_RASTER_HEIGHT = 120;
const MARK_INK = '#111111';

await mkdir(path.join(output, 'brands'), { recursive: true });
console.log('Store mark from brand-logos/gemies.png:');

const markSource = path.join(root, 'brand-logos', 'gemies.png');
const markBefore = await sharp(markSource).metadata();
// threshold 1 trims fully transparent padding without eating anti-aliasing.
const markTrimmed = await sharp(markSource).trim({ threshold: 1 }).png().toBuffer();
const markAfter = await sharp(markTrimmed).metadata();
const markScaled = await sharp(markTrimmed)
  .resize({ height: MARK_RASTER_HEIGHT })
  .png()
  .toBuffer();
const scaledMeta = await sharp(markScaled).metadata();

// `blend: 'in'` keeps the source alpha and takes the colour from the overlay,
// which is exactly an ink swap on a monochrome mark.
const recoloured = await sharp(markScaled)
  .composite([{
    input: { create: { width: scaledMeta.width, height: scaledMeta.height, channels: 3, background: MARK_INK } },
    blend: 'in',
  }])
  .webp({ quality: 94, alphaQuality: 100 })
  .toBuffer();
const asSupplied = await sharp(markScaled).webp({ quality: 94, alphaQuality: 100 }).toBuffer();

await writeFile(path.join(output, 'brands', 'gemies.webp'), recoloured);
await writeFile(path.join(output, 'brands', 'gemies-light.webp'), asSupplied);

const marks = {
  gemies: {
    width: scaledMeta.width,
    height: scaledMeta.height,
    source: 'brand-logos/gemies.png',
    dark: '/assets/brands/gemies.webp',
    light: '/assets/brands/gemies-light.webp',
    note: `Store monogram. The dark variant recolours the supplied cream ink to ${MARK_INK} for light surfaces; the light variant is the artwork as supplied. Alpha preserved in both.`,
  },
};

console.log(
  `  ${markBefore.width}x${markBefore.height} source` +
    ` -> ${markAfter.width}x${markAfter.height} trimmed` +
    ` -> ${scaledMeta.width}x${scaledMeta.height} webp` +
    `  dark ${(recoloured.length / 1024).toFixed(1)} KB, light ${(asSupplied.length / 1024).toFixed(1)} KB`,
);


await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ offerGradient, brandMarks: marks, assets: manifest }, null, 2));
console.log(`\nWrote ${manifest.length} text-free assets to ${output}`);
console.log('Offer gradient sampled from reference:', offerGradient);

