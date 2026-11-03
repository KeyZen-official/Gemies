// Turns the supplied hero photograph into a web asset.
//
//   node scripts/build-hero-asset.mjs
//
// Source: public/assets/herosection image.png — 2103x748, a male model in a
// taupe overshirt against beige stone architecture. 1.86 MB as PNG, which is
// far too heavy for the first thing above the fold, and PNG is the wrong
// container for a photograph: being lossless it cannot discard the sensor
// noise and soft gradients that dominate the frame.
//
// The filename also contains a space. That survives in a URL only as %20, and
// anything that forgets to encode it gets a 404, so the output drops it.
//
// Output: public/assets/hero-everyday-edit.webp at native width. 2103px covers
// a 1440 viewport at ~1.5x and a 2103 viewport at 1x, which is the right place
// to stop for a background photograph.
//
// It also reports the crop window at each breakpoint, because the frame is
// 2.8:1 and every layout narrower than that discards width — and where it
// discards from decides whether the model is in the picture.
import sharp from 'sharp';
import {stat} from 'node:fs/promises';

const SOURCE = 'public/assets/herosection image.png';
const OUT = 'public/assets/hero-everyday-edit.webp';

const meta = await sharp(SOURCE).metadata();
const before = (await stat(SOURCE)).size;

await sharp(SOURCE)
  .webp({quality: 82, effort: 6})
  .toFile(OUT);

const after = (await stat(OUT)).size;
console.log(`${SOURCE}`);
console.log(`  ${meta.width}x${meta.height}  aspect ${(meta.width / meta.height).toFixed(3)}  ${(before / 1048576).toFixed(2)} MB`);
console.log(`${OUT}`);
console.log(`  ${meta.width}x${meta.height}  ${(after / 1024).toFixed(0)} KB  (${(100 - (after / before) * 100).toFixed(1)}% smaller)`);

// ----------------------------------------------- where the model actually is
// Measured by eye, from crops of the real frame, and hard-coded.
//
// Two attempts at finding it from the pixels both failed, and the failures are
// worth recording so nobody writes a third. Looking for the darkest sustained
// band in the right half returns 50-55%: that is the open doorway, not the
// model. Restricting the scan to the bottom fifth, where his dark trousers
// should be the only dark thing against lit stone, returns 77-96%, because the
// trousers merge into the shadow running down the right edge of the frame.
// Luminance alone cannot separate a man in dark trousers from the shadows
// around him in this photograph, so the honest thing is to look.
const SUBJECT = {from: 0.62, to: 0.85};
console.log(`\nmodel spans ${(SUBJECT.from * 100).toFixed(0)}%-${(SUBJECT.to * 100).toFixed(0)}%`
  + ` of the width (measured by eye); the dark doorway is at 48%-56%`);

// -------------------------------------------- what each breakpoint will show
const HEIGHTS = [
  ['1920 desktop', 1920, 683],
  ['1440 desktop', 1440, 520],
  ['1280 desktop', 1280, 520],
  ['1024 tablet', 1024, 540],
  ['768 tablet', 768, 540],
  ['390 mobile', 390, 470],
  ['360 mobile', 360, 470],
];
console.log('\nobject-cover window, and whether the model survives it:');
for (const [label, w, h] of HEIGHTS) {
  const scale = Math.max(w / meta.width, h / meta.height);
  const span = w / scale / meta.width;
  // object-position x that keeps the subject band centred in the window.
  const wanted = (SUBJECT.from + SUBJECT.to) / 2 - span / 2;
  const posX = span >= 1 ? 0.5 : Math.min(1, Math.max(0, wanted / (1 - span)));
  const from = posX * (1 - span);
  console.log(`  ${label.padEnd(14)} ${w}x${h}  shows ${(span * 100).toFixed(0)}% of the width`
    + `  (centred on the model needs object-position x=${(posX * 100).toFixed(0)}%`
    + ` -> window ${(from * 100).toFixed(0)}%-${((from + span) * 100).toFixed(0)}%)`);
}
