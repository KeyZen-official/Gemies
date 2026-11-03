// Downloads men's apparel blanks from the MWW On Demand blank-images library.
//
// MWW is the only source checked for this task that carries an explicit,
// written grant for this use. Its repository page states: "You're free to use
// our library of blank images for your online store or marketing needs."
// (https://mwwondemand.com/blank-images/)
//
// Assets are hosted as public Google Drive files. Nothing here bypasses a
// login, a paywall or a rate limit: these are public links published on that
// page for exactly this purpose.
//
// The mapping below is deliberately conservative. Only items that genuinely
// belong in the requested subcategory are listed; a swim trunk is not a casual
// short, and a fleece crew neck is not a T-shirt. Items MWW does not stock at
// all — jeans, cargo pants, formal trousers, denim shorts, linen and formal
// shirts — are absent and are reported as gaps rather than filled with
// something approximate.
//
//   node scripts/fetch-product-images.mjs --dry-run
//   node scripts/fetch-product-images.mjs
import {mkdir, writeFile, access} from 'node:fs/promises';
import path from 'node:path';

const PAGE = 'https://mwwondemand.com/blank-images/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const ROOT = 'public/products';

/**
 * [product line as printed on the page, which link, destination, filename]
 *
 * `which` is matched against the anchor text, so "Front PNG" picks the flat
 * front view rather than the back or an on-model shot.
 */
const WANTED = [
  // ---- T-shirts
  [/^T-shirt, DTG Bella\+Canvas 3001 Black/i, 'Front PNG', 'tshirts/plain', 'plain-black-bella-canvas-3001-01.png'],
  [/^T-shirt, DTG Bella\+Canvas 3001 White/i, 'Front PNG', 'tshirts/plain', 'plain-white-bella-canvas-3001-01.png'],
  [/^T-shirt, DTG Bella\+Canvas 3413 Grey/i, 'Front PNG', 'tshirts/plain', 'plain-grey-triblend-bella-canvas-3413-01.png'],
  // The product name is parsed up to the dash, so this one is an exact match.
  [/^T-shirt, Men’s$/i, 'PNG', 'tshirts/regular', 'regular-mens-tee-flat-01.png'],
  [/^T-shirt, Men’s Long Sleeve Tee/i, 'Front PNG', 'tshirts/regular', 'regular-mens-long-sleeve-tee-01.png'],
  [/^Shirt, Polo/i, 'Front PNG', 'tshirts/polo', 'polo-flat-front-01.png'],
  // ---- Shirts
  [/^Denim, DTG Western Shirt/i, 'Men’s Front PNG', 'shirts/casual', 'casual-denim-western-shirt-01.png'],
  [/^Shirt, Hawaiian\/Camp/i, 'Front PNG', 'shirts/casual', 'casual-camp-collar-shirt-01.png'],
  [/^Shirt, Hooded Raglan UV Shirt/i, 'Front PNG', 'shirts/full-sleeve', 'full-sleeve-hooded-raglan-shirt-01.png'],
  // ---- Bottoms
  [/^Joggers, Men’s/i, 'PNG', 'bottoms/joggers', 'joggers-mens-on-model-01.png'],
  [/^Pajama Pants, Men’s/i, 'PNG', 'bottoms/joggers', 'joggers-mens-lounge-pant-01.png'],
  [/^Shorts, Basketball\/Training/i, 'PNG', 'bottoms/casual-shorts', 'casual-shorts-training-01.png'],
  [/^Woven Shorts/i, 'Front PNG', 'bottoms/casual-shorts', 'casual-shorts-woven-01.png'],
];

const decode = (s) => s
  .replace(/&#8217;|&#8216;/g, '\u2019')
  .replace(/&#8211;|&#8212;/g, '\u2013')
  .replace(/&#038;|&amp;/g, '&')
  .replace(/&#8221;|&#8220;/g, '"')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ');

/**
 * Parses the apparel section into one entry per downloadable asset.
 *
 * Each product is an `<li>` shaped like:
 *
 *   Denim, DTG Western Shirt – Men's Front [PNG] | [JPG], Women's Back [PNG] …
 *
 * The anchor text is usually just "PNG", and which view it is lives in the
 * plain text *before* the link. So the variant name is that preceding text
 * joined to the anchor text, giving "Men's Front PNG".
 */
function parse(html) {
  const start = html.indexOf('APPAREL BLANK IMAGES');
  if (start < 0) throw new Error('apparel section not found on the page');
  const section = html.slice(start);

  const out = [];
  // The markup in this section arrives with unbalanced tags, so split on the
  // list-item boundary textually rather than trying to match elements.
  for (const block of section.split(/li>/).slice(1)) {
    const name = decode(block.split(/&#8211;|&#8212;|–/)[0].replace(/<[^>]*>/g, '')).trim();
    if (!name || name.length < 3) continue;

    const tokens = [...block.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|([^<]+)/gi)];
    let qualifier = '';
    for (const t of tokens) {
      if (t[1]) {
        const anchor = decode(t[2].replace(/<[^>]*>/g, '')).trim();
        const variant = `${qualifier} ${anchor}`.replace(/\s+/g, ' ').trim();
        out.push({product: name, variant, anchor, href: t[1]});
        qualifier = '';
      } else if (t[3]) {
        const text = decode(t[3]);
        // Strip the separators between links; what is left describes the view.
        const cleaned = text.replace(/[|,]/g, ' ').replace(/\s+/g, ' ').trim();
        // Text after the product name and before a link is the view name.
        qualifier = cleaned === '' ? '' : cleaned.split(/\u2013|–/).pop().trim();
      }
    }
  }
  return out;
}

const driveId = (href) => href.match(/\/file\/d\/([\w-]+)/)?.[1] ?? null;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function download(id) {
  const res = await fetch(`https://drive.usercontent.google.com/download?id=${id}&export=download`, {
    headers: {'User-Agent': UA},
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    const type = res.headers.get('content-type') ?? 'unknown';
    throw new Error(`not a PNG (content-type ${type}, ${buffer.length} bytes)`);
  }
  return buffer;
}

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

// ------------------------------------------------------------------- run
const dryRun = process.argv.includes('--dry-run');
console.log(`Fetching the MWW blank-images index: ${PAGE}`);
const res = await fetch(PAGE, {headers: {'User-Agent': UA}});
if (!res.ok) throw new Error(`index page returned HTTP ${res.status}`);
const links = parse(await res.text());
console.log(`${links.length} apparel links parsed\n`);

let got = 0;
let skipped = 0;
const failures = [];

for (const [productRe, label, dest, filename] of WANTED) {
  const match = links.find((l) => productRe.test(l.product) && l.variant.toLowerCase() === label.toLowerCase());
  if (!match) {
    failures.push(`${dest}/${filename}: no "${label}" link found for ${productRe}`);
    console.log(`  MISS  ${dest}/${filename}`);
    continue;
  }
  const id = driveId(match.href);
  if (!id) {
    failures.push(`${dest}/${filename}: link is not a Google Drive file (${match.href})`);
    continue;
  }

  const target = path.join(ROOT, dest, filename);
  if (await exists(target)) { console.log(`  have  ${dest}/${filename}`); skipped += 1; continue; }
  if (dryRun) { console.log(`  would ${dest}/${filename}  <- ${match.product.slice(0, 48)} [${label}]`); continue; }

  try {
    const buffer = await download(id);
    await mkdir(path.join(ROOT, dest), {recursive: true});
    await writeFile(target, buffer);
    console.log(`  got   ${dest}/${filename}  ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
    got += 1;
  } catch (error) {
    failures.push(`${dest}/${filename}: ${error.message}`);
    console.log(`  FAIL  ${dest}/${filename}  ${error.message}`);
  }
}

console.log(`\n${got} downloaded, ${skipped} already present, ${failures.length} failed`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(`  ${f}`); }
console.log('\nRun scripts/verify-product-images.mjs next.');
