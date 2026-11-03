// Verifies downloaded product images against the sourcing requirements, and
// builds a contact sheet per category for visual review.
//
//   node scripts/verify-product-images.mjs            verify + contact sheets
//   node scripts/verify-product-images.mjs --json     machine-readable report
//
// Automated checks cannot confirm a picture shows the right garment, or that a
// licence permits use. Those need the contact sheets and
// docs/PRODUCT_IMAGE_SOURCES.md respectively. Everything checkable is checked
// here, against actual pixels rather than metadata.
import sharp from 'sharp';
import {readdir, readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'public/products';
// Durable, because they are a review deliverable: tmp/ is git-ignored.
const OUT = 'docs/contact-sheets';
const MIN_LONGEST_SIDE = 1000;
// A garment touching the frame edge has been cropped. 1% of the side allows for
// the odd stray anti-aliased pixel without accepting a real crop.
const EDGE_TOLERANCE = 0.01;
// Below this, the "transparent" background is really just a few soft edges.
const MIN_TRANSPARENT_SHARE = 0.05;

const TAXONOMY = {
  tshirts: ['oversized', 'regular', 'graphic', 'plain', 'polo', 'heavyweight'],
  shirts: ['casual', 'formal', 'oversized', 'linen', 'printed', 'full-sleeve'],
  bottoms: ['jeans', 'cargo', 'trousers', 'joggers', 'denim-shorts', 'casual-shorts'],
};
const TARGET_PER_CATEGORY = 20;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Every file under the taxonomy, with its category and subcategory. */
async function collect() {
  const found = [];
  for (const [category, subs] of Object.entries(TAXONOMY)) {
    for (const sub of subs) {
      const dir = path.join(ROOT, category, sub);
      let entries = [];
      try {
        entries = await readdir(dir, {withFileTypes: true});
      } catch {
        continue; // directory not created yet
      }
      for (const entry of entries) {
        if (entry.isFile()) found.push({file: path.join(dir, entry.name), category, sub, name: entry.name});
      }
    }
  }
  // Anything filed outside the taxonomy is reported rather than ignored.
  const stray = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await readdir(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!found.some((f) => path.resolve(f.file) === path.resolve(full))) stray.push(full);
    }
  }
  await walk(ROOT);
  return {found, stray};
}

/**
 * Alpha analysis from raw pixels.
 *
 * `sharp`'s `hasAlpha` only reports the colour model, so an opaque RGBA image
 * passes it while having no transparency at all. This reads every alpha byte.
 */
function analyseAlpha(data, info) {
  const {width, height, channels} = info;
  if (channels < 4) return null;

  let clear = 0;
  let opaque = 0;
  let partial = 0;
  // Opaque bounding box, for the crop check.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * channels + 3];
      if (alpha < 16) { clear += 1; continue; }
      if (alpha > 240) opaque += 1; else partial += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const total = width * height;
  return {
    clearShare: clear / total,
    opaqueShare: opaque / total,
    partialShare: partial / total,
    box: maxX < 0 ? null : {minX, minY, maxX, maxY},
  };
}

/** Mean colour of the fully transparent region, to catch a baked-in backdrop. */
function backdropBehindAlpha(data, info) {
  const {width, height, channels} = info;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const at = i * channels;
    if (data[at + 3] >= 16) continue;
    r += data[at]; g += data[at + 1]; b += data[at + 2]; n += 1;
  }
  return n ? {r: r / n, g: g / n, b: b / n, n} : null;
}

/**
 * Detects a checkerboard painted into the pixels, which is what a screenshot of
 * a transparency preview looks like. Samples the top-left corner region and
 * looks for a regular two-tone grid among pixels that are fully opaque.
 */
function looksLikeFakeCheckerboard(data, info) {
  const {width, height, channels} = info;
  const size = Math.min(160, width, height);
  const tones = new Map();
  let opaqueSampled = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * width + x) * channels;
      if (channels === 4 && data[at + 3] < 240) continue;
      opaqueSampled += 1;
      const key = [data[at] >> 4, data[at + 1] >> 4, data[at + 2] >> 4].join(',');
      tones.set(key, (tones.get(key) ?? 0) + 1);
    }
  }
  if (opaqueSampled < size * size * 0.8) return false;
  const ranked = [...tones.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (ranked.length < 2) return false;
  const share = (ranked[0][1] + ranked[1][1]) / opaqueSampled;
  const greys = ranked.every(([key]) => {
    const [r, g, b] = key.split(',').map(Number);
    return Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1 && r >= 10;
  });
  // Two light greys covering nearly the whole corner is the signature.
  return share > 0.9 && greys;
}

/**
 * Duplicate signature: garment silhouette plus garment colour.
 *
 * Shape alone is not enough. Blank apparel of one cut is photographed in many
 * colours, and a greyscale hash of a red tee and a white tee of the same cut
 * is identical — which would reject two legitimately different products. So a
 * duplicate has to match on both the alpha silhouette and the mean colour of
 * the garment itself.
 */
async function signature(file) {
  const {data, info} = await sharp(file)
    .ensureAlpha()
    .resize(16, 16, {fit: 'fill'})
    .raw()
    .toBuffer({resolveWithObject: true});

  let bits = '';
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const at = i * info.channels;
    const opaque = data[at + 3] > 127;
    bits += opaque ? '1' : '0';
    if (opaque) { r += data[at]; g += data[at + 1]; b += data[at + 2]; n += 1; }
  }
  return {shape: bits, colour: n ? [r / n, g / n, b / n] : [0, 0, 0]};
}

const hamming = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d += 1;
  return d;
};
const colourDistance = (a, b) => Math.sqrt(
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
);

async function verify(entry) {
  const result = {...entry, checks: {}, failures: [], warnings: []};
  const add = (name, ok, detail = '') => {
    result.checks[name] = ok;
    if (!ok) result.failures.push(detail || name);
  };

  const bytes = await readFile(entry.file);

  // 1. A real PNG, not something renamed.
  const isPng = bytes.subarray(0, 8).equals(PNG_MAGIC);
  add('validPng', isPng, bytes.subarray(0, 3).equals(JPEG_MAGIC)
    ? 'JPEG renamed to .png'
    : isPng ? '' : 'not a PNG (bad magic bytes)');
  if (!isPng) return result;

  // 7. Decodes.
  let meta;
  let raw;
  try {
    meta = await sharp(entry.file).metadata();
    raw = await sharp(entry.file).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  } catch (error) {
    add('decodes', false, `decode failed: ${error.message}`);
    return result;
  }
  add('decodes', true);
  result.width = meta.width;
  result.height = meta.height;
  result.format = meta.format;
  result.channels = meta.channels;
  result.bytes = bytes.length;

  // 2. Declares an alpha channel.
  add('hasAlphaChannel', meta.hasAlpha === true, 'no alpha channel in the file');

  // 3. Alpha genuinely contains transparent pixels.
  const alpha = analyseAlpha(raw.data, raw.info);
  result.transparentShare = alpha ? Number(alpha.clearShare.toFixed(4)) : 0;
  add('hasTransparentPixels',
    Boolean(alpha) && alpha.clearShare >= MIN_TRANSPARENT_SHARE,
    alpha ? `only ${(alpha.clearShare * 100).toFixed(1)}% of pixels are transparent` : 'no alpha data');

  // A solid non-transparent backdrop behind an alpha channel means the
  // background was never actually removed.
  const backdrop = backdropBehindAlpha(raw.data, raw.info);
  if (backdrop) result.backdrop = `rgb(${backdrop.r.toFixed(0)},${backdrop.g.toFixed(0)},${backdrop.b.toFixed(0)})`;

  // Fake checkerboard.
  add('notFakeCheckerboard', !looksLikeFakeCheckerboard(raw.data, raw.info),
    'corner looks like a painted transparency checkerboard');

  // 4. Resolution.
  const longest = Math.max(meta.width, meta.height);
  result.longestSide = longest;
  add('resolution', longest >= MIN_LONGEST_SIDE,
    `longest side ${longest}px is under ${MIN_LONGEST_SIDE}px`);

  // 5. Garment not cropped: the opaque bounding box must not reach the frame.
  if (alpha?.box) {
    const padX = Math.max(1, Math.round(meta.width * EDGE_TOLERANCE));
    const padY = Math.max(1, Math.round(meta.height * EDGE_TOLERANCE));
    const touching = [];
    if (alpha.box.minX <= padX) touching.push('left');
    if (alpha.box.minY <= padY) touching.push('top');
    if (alpha.box.maxX >= meta.width - 1 - padX) touching.push('right');
    if (alpha.box.maxY >= meta.height - 1 - padY) touching.push('bottom');
    result.contentBox = `${alpha.box.maxX - alpha.box.minX + 1}x${alpha.box.maxY - alpha.box.minY + 1}`;
    add('notCropped', touching.length === 0, `garment touches the ${touching.join(', ')} edge`);
  } else {
    add('notCropped', false, 'no opaque content found');
  }

  result.signature = await signature(entry.file);
  return result;
}

async function contactSheet(category, rows) {
  if (!rows.length) return null;
  const cell = 260;
  const columns = Math.min(5, rows.length);
  const lines = Math.ceil(rows.length / columns);
  const layers = [];
  for (const [index, row] of rows.entries()) {
    // Over mid-grey, so both white and black garments stay visible and any
    // leftover opaque background shows up immediately.
    const tile = await sharp({create: {width: cell, height: cell, channels: 3, background: '#9a9a9a'}})
      .composite([{
        input: await sharp(row.file).resize(cell - 24, cell - 24, {fit: 'inside'}).png().toBuffer(),
        gravity: 'center',
      }])
      .png()
      .toBuffer();
    layers.push({
      input: tile,
      left: (index % columns) * cell,
      top: Math.floor(index / columns) * cell,
    });
  }
  await mkdir(OUT, {recursive: true});
  const target = path.join(OUT, `${category}.png`);
  await sharp({create: {width: columns * cell, height: lines * cell, channels: 3, background: '#ffffff'}})
    .composite(layers)
    .png()
    .toFile(target);
  return target;
}

// ------------------------------------------------------------------- run
const {found, stray} = await collect();
const results = [];
for (const entry of found) results.push(await verify(entry));

// 6. Duplicates, across the whole set rather than per folder. A duplicate has
// to match on silhouette *and* colour: the same cut in a different colour is a
// different product, not a duplicate.
const hashed = results.filter((r) => r.signature);
for (let i = 0; i < hashed.length; i++) {
  for (let j = i + 1; j < hashed.length; j++) {
    const sameShape = hamming(hashed[i].signature.shape, hashed[j].signature.shape) <= 12;
    const sameColour = colourDistance(hashed[i].signature.colour, hashed[j].signature.colour) < 28;
    if (sameShape && sameColour) {
      hashed[j].checks.notDuplicate = false;
      hashed[j].failures.push(`duplicate garment: same cut and colour as ${path.basename(hashed[i].file)}`);
    }
  }
}
for (const r of results) if (r.checks.notDuplicate === undefined) r.checks.notDuplicate = true;

const passed = results.filter((r) => r.failures.length === 0);
const failed = results.filter((r) => r.failures.length > 0);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({results, stray, passed: passed.length, failed: failed.length}, null, 2));
  process.exit(failed.length ? 1 : 0);
}

console.log('PRODUCT IMAGE VERIFICATION');
console.log(`minimum longest side ${MIN_LONGEST_SIDE}px, minimum transparent area ${MIN_TRANSPARENT_SHARE * 100}%\n`);

for (const [category, subs] of Object.entries(TAXONOMY)) {
  const mine = results.filter((r) => r.category === category);
  const ok = mine.filter((r) => r.failures.length === 0);
  console.log(`${category.toUpperCase()}  ${ok.length} verified of ${TARGET_PER_CATEGORY} required  (${mine.length} present)`);
  for (const sub of subs) {
    const rows = mine.filter((r) => r.sub === sub);
    const good = rows.filter((r) => r.failures.length === 0).length;
    console.log(`   ${sub.padEnd(15)} ${good}/${rows.length}`);
  }
  for (const r of mine) {
    const mark = r.failures.length === 0 ? 'ok  ' : 'FAIL';
    const size = r.width ? `${r.width}x${r.height}` : '—';
    const clear = r.transparentShare !== undefined ? `${(r.transparentShare * 100).toFixed(0)}% clear` : '';
    console.log(`   ${mark} ${r.sub}/${r.name}  ${size}  ${clear}${r.backdrop ? `  behind-alpha ${r.backdrop}` : ''}`);
    for (const f of r.failures) console.log(`        - ${f}`);
  }
  const sheet = await contactSheet(category, mine.filter((r) => r.checks.decodes));
  if (sheet) console.log(`   contact sheet: ${sheet}`);
  console.log('');
}

if (stray.length) {
  console.log('Files outside the taxonomy:');
  for (const s of stray) console.log(`   ${s}`);
  console.log('');
}

const total = passed.length;
console.log(`TOTAL VERIFIED ${total} of 60`);
console.log(`  t-shirts ${passed.filter((r) => r.category === 'tshirts').length}/20`);
console.log(`  shirts   ${passed.filter((r) => r.category === 'shirts').length}/20`);
console.log(`  bottoms  ${passed.filter((r) => r.category === 'bottoms').length}/20`);
if (failed.length) console.log(`\n${failed.length} file(s) failed verification.`);
process.exit(total === 60 ? 0 : 1);
