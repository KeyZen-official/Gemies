// Preflight check for transactional email.
//
//   npm run email:doctor                  checks configuration and the provider
//   npm run email:doctor -- you@your.com  also sends one real test email
//
// Answers, in order, the questions that actually block delivery:
//   1. Is a key and a sender configured at all?
//   2. Does Resend accept the key?
//   3. Which domains does this account have, and are they verified?
//   4. Is the sender on one of those verified domains?
//   5. Does a real send succeed, with a real template?
//
// Runs without opening the database at all, so it needs no connection string
// and answers the same way whether or not the app is running. The send below
// is therefore a local fetch rather than a call to sendEmail() in
// server/providers.mjs, which would pull in the database modules for a script
// that only needs to talk to Resend.
//
// The request shape below therefore mirrors sendEmail() and must stay in step
// with it. The fields are asserted against that module at the end of this
// script, so the two cannot drift silently.
//
// The API key is never printed, logged, or written anywhere.
import {readFile} from 'node:fs/promises';
import {config} from '../server/config.mjs';
import {renderEmail} from '../server/emails/templates.mjs';

const recipient = process.argv[2] ?? null;
// Which template to send. `all` sends every one, for reviewing the set in a
// real client; anything else must be a template name.
const requested = process.argv[3] ?? 'welcome';
const API = 'https://api.resend.com';
let failed = false;

const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); failed = true; };
const note = (m) => console.log(`        ${m}`);

/** Authenticated GET against the Resend API. */
async function get(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {Authorization: `Bearer ${process.env.RESEND_API_KEY}`},
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  return {status: res.status, body};
}

console.log('\n1. Configuration (.env)');
if (!process.env.RESEND_API_KEY) {
  bad('RESEND_API_KEY is not set');
  note('Add it to .env and save the file, then run this again.');
} else if (!/^re_[A-Za-z0-9_]{15,}$/.test(process.env.RESEND_API_KEY)) {
  bad(`RESEND_API_KEY is set (${process.env.RESEND_API_KEY.length} chars) but is not shaped like a Resend key`);
  note('Resend keys start "re_". Check for a stray quote, space, or a truncated paste.');
} else {
  ok(`RESEND_API_KEY is set (${process.env.RESEND_API_KEY.length} chars, starts "re_")`);
}

if (!config.emailFrom) bad('RESEND_FROM_EMAIL is not set');
else ok(`sender: ${config.emailFrom}`);
console.log(`        display name: ${config.emailFromName}`);
console.log(`        link base (APP_URL): ${config.origin}`);
console.log(`        admin notifications: ${config.adminEmail || 'off (ADMIN_NOTIFICATION_EMAIL empty)'}`);
console.log(`        contact form inbox: ${config.businessEmail || 'falls back to store_settings.support_email'}`);
console.log(`        config.emailEnabled: ${config.emailEnabled}`);

if (!config.emailEnabled) {
  console.log('\nEmail is not configured, so the provider checks are skipped.');
  console.log('Nothing will be queued that cannot be sent, and the contact form will say so.');
  process.exit(1);
}

// The address inside "Name <addr>", or the whole value.
const fromAddress = (/<([^>]+)>\s*$/.exec(config.emailFrom)?.[1] ?? config.emailFrom).trim();
const fromDomain = fromAddress.split('@')[1] ?? '';

console.log('\n2. Does Resend accept the key?');
const domains = await get('/domains');
if (domains.status === 401 || domains.status === 403) {
  bad(`Resend rejected the key (HTTP ${domains.status})`);
  note('Regenerate the key in Resend -> API Keys, and give it Sending access.');
  process.exit(1);
} else if (domains.status !== 200) {
  bad(`Unexpected response from Resend (HTTP ${domains.status})`);
  note(typeof domains.body?.message === 'string' ? domains.body.message : 'No message returned.');
  process.exit(1);
} else {
  ok('the key is accepted');
}

console.log('\n3. Domains on this account');
const list = Array.isArray(domains.body?.data) ? domains.body.data : [];
if (!list.length) {
  bad('this account has no domains');
  note('Add and verify a domain in Resend -> Domains before sending.');
} else {
  for (const d of list) {
    const verified = d.status === 'verified';
    console.log(`  ${verified ? 'PASS' : 'WARN'}  ${String(d.name).padEnd(28)} status=${d.status}${d.region ? `  region=${d.region}` : ''}`);
  }
}
const verifiedNames = list.filter((d) => d.status === 'verified').map((d) => d.name);

console.log('\n4. Is the sender on a verified domain?');
if (!fromDomain) {
  bad('could not read a domain from the sender address');
} else if (verifiedNames.includes(fromDomain)) {
  ok(`${fromDomain} is verified, so ${fromAddress} can send`);
} else if (fromAddress.endsWith('@resend.dev')) {
  ok('using Resend\'s shared onboarding sender');
  note('onboarding@resend.dev only delivers to the address that owns the Resend account.');
} else {
  bad(`${fromDomain} is not a verified domain on this account`);
  note(verifiedNames.length ? `Verified here: ${verifiedNames.join(', ')}` : 'No verified domains on this account.');
  note('Set RESEND_FROM_EMAIL to an address on a verified domain.');
}

console.log('\n5. Real send');
if (!recipient) {
  note('skipped. Pass an address to send real test email:');
  note('  npm run email:doctor -- you@your-domain.com            (welcome)');
  note('  npm run email:doctor -- you@your-domain.com paid       (one template)');
  note('  npm run email:doctor -- you@your-domain.com all        (every template)');
} else if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(recipient)) {
  bad(`"${recipient}" is not a valid email address`);
} else {
  // Rendered through the real templates, so this proves the template, the
  // sender, the key and the HTML/text parts all work together.
  const {templateNames} = await import('../server/emails/templates.mjs');
  const {sampleData} = await import('./email-sample-data.mjs');

  /** Mirrors sendEmail() in server/providers.mjs. See the note at the top. */
  const postEmail = async ({recipient: to, subject, text, html, replyTo, key}) => {
    const from = config.emailFrom.includes('<')
      ? config.emailFrom
      : `${config.emailFromName} <${config.emailFrom}>`;
    const res = await fetch(`${API}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({
        from, to: [to], subject, text,
        ...(html ? {html} : {}),
        ...(replyTo ? {reply_to: [replyTo]} : {}),
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}${body?.message ? ` — ${body.message}` : ''}`);
    return body;
  };

  const names = requested === 'all' ? templateNames : [requested];
  const unknown = names.filter((n) => !templateNames.includes(n));
  if (unknown.length) {
    bad(`unknown template: ${unknown.join(', ')}`);
    note(`Available: ${templateNames.join(', ')}`);
    note('Or pass "all" to send every one.');
  } else {
    const data = sampleData(config.origin);
    // Admin templates name internal state and are not meant for a customer,
    // so they are called out rather than silently mixed in.
    for (const name of names) {
      // A fresh key per send, so Resend's 24h idempotency window does not
      // swallow a repeat test of the same template.
      const key = `doctor:${name}:${Date.now()}`;
      try {
        const built = renderEmail(name, data);
        const result = await postEmail({...built, recipient, key});
        ok(`${name.padEnd(24)} sent  (${result.id})`);
      } catch (e) {
        bad(`${name.padEnd(24)} failed: ${e.message}`);
        note('403 usually means the sender domain is not verified; 422 means a malformed field.');
      }
      // Resend's default rate limit is 2 requests/second; pace the batch.
      if (names.length > 1) await new Promise((r) => setTimeout(r, 600));
    }
    note(`Recipient: ${recipient}. Check the inbox and Resend -> Logs.`);
    if (names.length > 1) note('The admin_* ones are operator notifications, not customer mail.');
  }
}

// The local send above duplicates the request shape of sendEmail(). Read that
// module as text — importing it would boot the database — and confirm the two
// still agree on every field Resend is given, so a change there cannot leave
// this check silently testing a different request.
console.log('\n6. Does this check still match the real sender?');
const providerSource = await readFile(new URL('../server/providers.mjs', import.meta.url), 'utf8');
const sendBlock = providerSource.slice(providerSource.indexOf('export async function sendEmail'));
const expected = ['from', 'to:[payload.recipient]', 'subject', 'text', 'html', 'reply_to', 'Idempotency-Key'];
const missing = expected.filter((f) => !sendBlock.includes(f));
if (missing.length) {
  bad(`server/providers.mjs no longer matches this check: ${missing.join(', ')}`);
  note('Update postEmail() in this script to mirror sendEmail() again.');
} else {
  ok('the fields sent here are the fields the worker sends');
}

console.log(failed ? '\nSomething above needs fixing.\n' : '\nAll checks passed. Transactional email is ready.\n');
process.exit(failed ? 1 : 0);
