// Writes every email template to tmp/email-previews/ as HTML and .txt, using
// representative sample data, so the design can be reviewed in a browser
// without sending anything.
//
//   node scripts/email-preview.mjs
//   then open tmp/email-previews/index.html
//
// Nothing here touches the database or the network. It is the quickest way to
// check a copy or layout change, and the only way to review an email without
// a real order.
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

// renderEmail reads nothing from the environment, but config.mjs is imported
// transitively and validates what it finds, so give it a usable sender.
process.env.RESEND_API_KEY ||= 'preview';
process.env.RESEND_FROM_EMAIL ||= 'no-reply@example.com';

const {templates, renderEmail} = await import('../server/emails/templates.mjs');
// Shared with scripts/email-doctor.mjs, so a preview and a test send of the
// same template show the same content.
const {sampleData} = await import('./email-sample-data.mjs');

const OUT = 'tmp/email-previews';
const base = sampleData(process.env.APP_BASE_URL || process.env.APP_URL || 'http://localhost:3000');

/** Per-template overrides, where one sample cannot represent every case. */
const variants = {
  tracking: [
    ['tracking-shipped', {stage: 'shipped'}],
    ['tracking-out-for-delivery', {stage: 'out_for_delivery'}],
    ['tracking-delivered', {stage: 'delivered'}],
    ['tracking-exception', {stage: 'exception'}],
    ['tracking-cancelled', {stage: 'cancelled'}],
  ],
  admin_refund: [
    ['admin_refund-initiated', {phase: 'initiated'}],
    ['admin_refund-completed', {phase: 'completed'}],
    ['admin_refund-failed', {phase: 'failed'}],
  ],
};

await mkdir(OUT, {recursive: true});
const written = [];

for (const name of Object.keys(templates)) {
  for (const [slug, extra] of variants[name] ?? [[name, {}]]) {
    const rendered = renderEmail(name, {...base, ...extra});
    await writeFile(path.join(OUT, `${slug}.html`), rendered.html);
    await writeFile(path.join(OUT, `${slug}.txt`), rendered.text);
    written.push({slug, name, subject: rendered.subject});
  }
}

// A contact sheet, so the whole set can be reviewed in one pass.
const index = `<!doctype html><meta charset="utf-8">
<title>GEMIES email previews</title>
<style>
  body{margin:0;background:#f6f4f0;font:15px/1.6 Helvetica,Arial,sans-serif;color:#171615}
  header{padding:28px 24px;max-width:900px;margin:0 auto}
  h1{margin:0 0 6px;font-size:24px}
  p{margin:0;color:#77716b;font-size:14px}
  ul{max-width:900px;margin:0 auto;padding:0 24px 40px;list-style:none}
  li{background:#fff;border-radius:10px;margin:0 0 10px;padding:16px 18px;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
  code{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#77716b}
  .s{flex:1;min-width:260px;font-weight:600}
  a{color:#171615;font-size:13px}
</style>
<header>
  <h1>GEMIES email previews</h1>
  <p>${written.length} rendered templates, sample data only. Nothing here was sent.</p>
</header>
<ul>
${written.map((w) => `  <li><span class="s">${w.subject}</span><code>${w.name}</code><a href="${w.slug}.html">HTML</a><a href="${w.slug}.txt">text</a></li>`).join('\n')}
</ul>`;
await writeFile(path.join(OUT, 'index.html'), index);

console.log(`${written.length} previews written to ${OUT}`);
console.log(`Open ${path.join(OUT, 'index.html')}`);
