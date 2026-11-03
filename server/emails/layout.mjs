/**
 * The one GEMIES email layout.
 *
 * Every transactional email is a `{heading, lede, sections, cta, note}`
 * description rendered through this file. There is no per-email HTML, so the
 * brand, the spacing and the footer cannot drift between messages, and the
 * plain-text alternative is built from the same description rather than being
 * scraped out of the markup.
 *
 * Email client constraints this works within, which are why it looks like
 * markup from 2005:
 *   - Tables for structure. Outlook renders with Word's engine and does not
 *     support flex, grid or float reliably.
 *   - Inline styles only. Gmail strips <style> blocks on some clients, so the
 *     one <style> element carries nothing but the small-screen override and
 *     every rule that matters is also inline.
 *   - No external images. The wordmark is live text: images are blocked by
 *     default in Outlook and in Gmail for unknown senders, so a logo image
 *     would leave most recipients looking at a grey box. Live text is also
 *     sharp on every display and costs no load.
 *   - 600px content width, the widest that survives the Outlook reading pane.
 */

const BRAND = {
  page: '#f6f4f0',       // soft neutral surround
  surface: '#ffffff',
  ink: '#171615',
  body: '#3f3b37',
  muted: '#77716b',
  rule: '#e4dfd7',
  panel: '#f1eee8',
  button: '#111111',
};

/** HTML-escapes any interpolated value. Applied to every dynamic field. */
export function escape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * A URL safe to put in an href.
 *
 * Anything that is not http(s) is dropped rather than rendered, so a malformed
 * or attacker-supplied value cannot become a `javascript:` link in a mail
 * client that still honours one.
 */
export function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  return escape(raw);
}

export const money = (minor, currency) => `${currency} ${(Number(minor || 0) / 100).toFixed(2)}`;

// ----------------------------------------------------------------- sections
// Each builder returns {html, text}. Keeping both in one place is what stops
// the two versions of an email from saying different things.

const paragraph = (value) => ({
  html: `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${BRAND.body};">${escape(value)}</p>`,
  text: `${value}\n`,
});

const panel = ({title, value}) => ({
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:${BRAND.panel};border-radius:8px;">
    <tr><td style="padding:18px 20px;">
      ${title ? `<div style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.muted};">${escape(title)}</div>` : ''}
      <div style="font-size:16px;font-weight:600;color:${BRAND.ink};">${escape(value)}</div>
    </td></tr></table>`,
  text: `${title ? `${title}: ` : ''}${value}\n`,
});

const rows = (list) => ({
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:14px;">
    ${list.map(([label, value]) => `<tr>
      <td style="padding:6px 0;color:${BRAND.muted};">${escape(label)}</td>
      <td style="padding:6px 0;text-align:right;color:${BRAND.ink};font-weight:500;">${escape(value)}</td>
    </tr>`).join('')}
  </table>`,
  text: `${list.map(([label, value]) => `${label}: ${value}`).join('\n')}\n`,
});

const items = (list) => ({
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px;font-size:14px;">
    ${list.map((i) => `<tr>
      <td style="padding:12px 0;border-top:1px solid ${BRAND.rule};">
        <div style="color:${BRAND.ink};font-weight:600;">${escape(i.name)}</div>
        <div style="margin-top:3px;font-size:13px;color:${BRAND.muted};">${escape(i.meta)}</div>
      </td>
      <td style="padding:12px 0;border-top:1px solid ${BRAND.rule};text-align:right;vertical-align:top;color:${BRAND.ink};white-space:nowrap;">${escape(i.amount)}</td>
    </tr>`).join('')}
  </table>`,
  text: `${list.map((i) => `- ${i.name}\n  ${i.meta}\n  ${i.amount}`).join('\n')}\n`,
});

const totals = (list) => ({
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;font-size:14px;border-top:1px solid ${BRAND.rule};">
    ${list.map(([label, value, strong]) => `<tr>
      <td style="padding:${strong ? '12px 0 0' : '6px 0'};${strong ? `border-top:1px solid ${BRAND.rule};` : ''}color:${strong ? BRAND.ink : BRAND.muted};${strong ? 'font-weight:600;font-size:16px;' : ''}">${escape(label)}</td>
      <td style="padding:${strong ? '12px 0 0' : '6px 0'};${strong ? `border-top:1px solid ${BRAND.rule};` : ''}text-align:right;color:${BRAND.ink};${strong ? 'font-weight:700;font-size:16px;' : 'font-weight:500;'}">${escape(value)}</td>
    </tr>`).join('')}
  </table>`,
  text: `${list.map(([label, value]) => `${label}: ${value}`).join('\n')}\n`,
});

const address = ({title, lines}) => ({
  html: `<div style="margin:0 0 20px;">
    <div style="margin:0 0 6px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.muted};">${escape(title)}</div>
    <div style="font-size:14px;line-height:1.6;color:${BRAND.body};">${lines.filter(Boolean).map(escape).join('<br>')}</div>
  </div>`,
  text: `${title}:\n${lines.filter(Boolean).join('\n')}\n`,
});

const divider = () => ({
  html: `<div style="margin:0 0 22px;border-top:1px solid ${BRAND.rule};"></div>`,
  text: '',
});

export const section = {paragraph, panel, rows, items, totals, address, divider};

// ------------------------------------------------------------------- layout

/**
 * Renders one email.
 *
 * `preheader` is the grey preview line mail clients show beside the subject.
 * It is deliberately set per email: left empty, clients fall back to scraping
 * the first visible text, which for an order email is the recipient's name.
 */
export function layout({heading, lede, sections = [], cta, note, preheader, footerAddress}) {
  const body = sections.filter(Boolean);
  const link = cta ? safeUrl(cta.href) : '';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escape(heading)}</title>
<style>
  @media (max-width:620px){
    .gm-shell{padding:16px 12px !important}
    .gm-card{padding:28px 20px !important}
    .gm-h1{font-size:21px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};-webkit-font-smoothing:antialiased;">
<div style="display:none;font-size:1px;color:${BRAND.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escape(preheader || heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page};">
  <tr><td align="center" class="gm-shell" style="padding:32px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">

      <tr><td align="center" style="padding:0 0 22px;">
        <span style="font-family:Helvetica,Arial,sans-serif;font-size:19px;font-weight:700;letter-spacing:5px;color:${BRAND.ink};">GEMIES</span>
      </td></tr>

      <tr><td class="gm-card" style="background:${BRAND.surface};border-radius:12px;padding:36px 34px;font-family:Helvetica,Arial,sans-serif;">
        <h1 class="gm-h1" style="margin:0 0 ${lede ? '10px' : '22px'};font-size:25px;line-height:1.25;font-weight:700;color:${BRAND.ink};">${escape(heading)}</h1>
        ${lede ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:${BRAND.muted};">${escape(lede)}</p>` : ''}
        ${body.map((s) => s.html).join('\n')}
        ${cta && link ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;">
          <tr><td style="background:${BRAND.button};border-radius:999px;">
            <a href="${link}" style="display:inline-block;padding:15px 32px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">${escape(cta.label)}</a>
          </td></tr></table>` : ''}
        ${note ? `<p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:${BRAND.muted};">${escape(note)}</p>` : ''}
      </td></tr>

      <tr><td style="padding:22px 10px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.7;color:${BRAND.muted};text-align:center;">
        <div>GEMIES — men’s everyday essentials.</div>
        ${footerAddress ? `<div style="margin-top:4px;">${escape(footerAddress)}</div>` : ''}
        <div style="margin-top:8px;">This is a transactional message about your account or order.</div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

  const text = [
    'GEMIES',
    '',
    heading,
    ...(lede ? ['', lede] : []),
    '',
    ...body.map((s) => s.text).filter(Boolean),
    ...(cta && link ? [`${cta.label}: ${cta.href}`, ''] : []),
    ...(note ? [note, ''] : []),
    '---',
    'GEMIES — men’s everyday essentials.',
    ...(footerAddress ? [footerAddress] : []),
    'This is a transactional message about your account or order.',
  ].join('\n').replace(/\n{3,}/g, '\n\n');

  return {html, text};
}
