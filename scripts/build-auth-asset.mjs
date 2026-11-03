// Turns the supplied auth panel photograph into a web asset.
//
//   node scripts/build-auth-asset.mjs
//
// Source: public/assets/loginImage.png — a 1024x1536 editorial photograph of an
// oversized black T-shirt on a warm cream wall. 1.9 MB as PNG, which is far too
// large to put in front of a sign-in page, and PNG is the wrong container for a
// photograph in the first place (it is lossless, so it cannot discard the
// sensor noise and soft gradients that dominate this image).
//
// Output: public/assets/login-panel.webp at native resolution. The source is
// only 1024px wide, so there is nothing to gain by upscaling for high-density
// displays; the panel is 45% of the viewport, which is 864px at 1920, so 1024
// covers it at 1x and degrades gracefully at 2x.
//
// This also reports the crop window the panel will actually show at each
// breakpoint, because `object-cover` on a portrait photograph in a short
// landscape band discards a lot, and where it discards from decides whether
// the shirt or the floor is on screen.
import sharp from 'sharp';
import {stat} from 'node:fs/promises';

const SOURCE = 'public/assets/loginImage.png';
const OUT = 'public/assets/login-panel.webp';

const meta = await sharp(SOURCE).metadata();
const before = (await stat(SOURCE)).size;

await sharp(SOURCE)
  // quality 80 is the knee of the curve for a soft-gradient photograph like
  // this; above it the file grows without a visible difference.
  .webp({quality: 80, effort: 6})
  .toFile(OUT);

const after = (await stat(OUT)).size;
console.log(`${SOURCE}  ${meta.width}x${meta.height}  ${(before / 1048576).toFixed(2)} MB`);
console.log(`${OUT}  ${meta.width}x${meta.height}  ${(after / 1024).toFixed(0)} KB`
  + `  (${(100 - (after / before) * 100).toFixed(1)}% smaller)`);

// ------------------------------------------------- crop windows per breakpoint
// The panel is 45% of the viewport and full height from lg; below lg it is a
// band at the top of the page.
const NAV = (vp) => (vp >= 1024 ? 92 : vp >= 768 ? 78 : 68);
const BAND_VH = 0.32;             // min-h-[32vh] on the stacked layout
const POSITION_Y = 0.32;          // object-[50%_32%]

const cases = [
  ['desktop 1920x1080', 1920, 1080],
  ['desktop 1440x900', 1440, 900],
  ['laptop 1280x800', 1280, 800],
  ['tablet 768x1024', 768, 1024],
  ['mobile 390x844', 390, 844],
  ['mobile 360x800', 360, 800],
];

console.log('\nWhat object-cover actually shows, as a fraction of the source height:');
for (const [label, vw, vh] of cases) {
  const isLg = vw >= 1024;
  const boxW = isLg ? vw * 0.45 : vw;
  const boxH = isLg ? vh - NAV(vw) : vh * BAND_VH;
  // object-cover: scale so both dimensions are covered.
  const scale = Math.max(boxW / meta.width, boxH / meta.height);
  const renderedH = meta.height * scale;
  const hiddenH = renderedH - boxH;
  const offset = hiddenH * POSITION_Y;
  const from = offset / scale / meta.height;
  const to = (offset + boxH) / scale / meta.height;
  console.log(`  ${label.padEnd(20)} box ${boxW.toFixed(0)}x${boxH.toFixed(0)}`
    + `  shows ${(from * 100).toFixed(1)}%-${(to * 100).toFixed(1)}%`
    + `  (${((to - from) * 100).toFixed(0)}% of the photo)`);
}
// The shirt occupies roughly 16%-70% of the source height, measured from the
// image: anything that keeps that range keeps the garment whole.
console.log('\n  the shirt occupies roughly 16%-70%; a window covering that keeps it whole');
