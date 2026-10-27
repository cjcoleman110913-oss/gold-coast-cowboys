// Branded HTML emails that match the website (black, cream, serif). Table-based with inline styles
// so they hold up in Gmail, Outlook and Apple Mail. Every email also gets a plain-text version.
const SITE = () => (process.env.SITE_URL || 'https://goldcoastcowboys.com').replace(/\/$/, '');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const C = { bg: '#0A0A0A', card: '#151515', line: '#2f2f2f', cream: '#F2EDDD', dim: '#CFC7AE', ink: '#161616', muted: '#9C9689' };
const SERIF = "Georgia, 'Times New Roman', serif";
const MONO = "'Courier New', Courier, monospace";

/**
 * renderEmail({ preheader, eyebrow, heading, intro: [text], details: [[label, value]], quote, button: {label, url}, outro: [text] })
 * Returns { html, text }. All text passed in is escaped; links are only used in href/plain text.
 */
export function renderEmail({ preheader = '', eyebrow = '', heading, intro = [], details = [], quote = '', button = null, outro = [] }) {
  const p = (t, color = C.cream) => `<p style="margin:0 0 16px;font-family:${SERIF};font-size:16px;line-height:1.6;color:${color};">${esc(t)}</p>`;
  const rows = details.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:6px 16px 6px 0;font-family:${MONO};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${C.muted};vertical-align:top;white-space:nowrap;">${esc(k)}</td>` +
    `<td style="padding:6px 0;font-family:${SERIF};font-size:16px;color:${C.cream};">${esc(v)}</td></tr>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><style>:root{color-scheme:dark only;supported-color-schemes:dark only}body,.bg{background:#0A0A0A !important}</style><title>${esc(heading)}</title></head>
<body bgcolor="#0A0A0A" style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader || heading)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0A0A0A" style="background:${C.bg};"><tr><td align="center" bgcolor="#0A0A0A" style="padding:32px 16px;background:${C.bg};">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
    <tr><td align="center" style="padding:0 0 24px;">
      <img src="${SITE()}/assets/img/gcc-logo.png?v=2" width="88" height="88" alt="Gold Coast Cowboys" style="display:block;border:0;width:88px;height:88px;">
      <div style="margin-top:12px;font-family:${MONO};font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${C.dim};">Gold Coast Cowboys</div>
    </td></tr>
    <tr><td bgcolor="#151515" style="background:${C.card};border:1px solid ${C.line};border-radius:6px;padding:36px 32px;">
      ${eyebrow ? `<div style="font-family:${MONO};font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:${C.muted};margin:0 0 12px;">${esc(eyebrow)}</div>` : ''}
      <h1 style="margin:0 0 20px;font-family:${SERIF};font-size:28px;line-height:1.2;font-weight:700;color:${C.cream};">${esc(heading)}</h1>
      ${intro.map((t) => p(t)).join('')}
      ${quote ? `<div style="margin:4px 0 20px;padding:14px 18px;border-left:3px solid ${C.dim};background:${C.bg};font-family:${SERIF};font-size:16px;font-style:italic;line-height:1.5;color:${C.dim};">&ldquo;${esc(quote)}&rdquo;</div>` : ''}
      ${rows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;width:100%;border-top:1px solid ${C.line};border-bottom:1px solid ${C.line};padding:6px 0;">${rows}</table>` : ''}
      ${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;"><tr><td style="background:${C.cream};border-radius:2px;"><a href="${esc(button.url)}" style="display:inline-block;padding:14px 28px;font-family:${MONO};font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:${C.ink};text-decoration:none;font-weight:700;">${esc(button.label)}</a></td></tr></table>` : ''}
      ${outro.map((t) => p(t, C.dim)).join('')}
    </td></tr>
    <tr><td align="center" style="padding:24px 8px 0;font-family:${MONO};font-size:11px;letter-spacing:1px;line-height:1.8;color:${C.muted};">
      <a href="${SITE()}" style="color:${C.dim};text-decoration:none;">goldcoastcowboys.com</a> &nbsp;&bull;&nbsp;
      <a href="mailto:dance@goldcoastcowboys.com" style="color:${C.dim};text-decoration:none;">dance@goldcoastcowboys.com</a> &nbsp;&bull;&nbsp;
      <a href="https://www.instagram.com/goldcoastcowboys/" style="color:${C.dim};text-decoration:none;">@goldcoastcowboys</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  const text = [heading, '', ...intro.flatMap((t) => [t, '']),
    ...(quote ? [`"${quote}"`, ''] : []),
    ...details.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), ...(details.some(([, v]) => v) ? [''] : []),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []),
    ...outro.flatMap((t) => [t, '']), '- Gold Coast Cowboys', 'dance@goldcoastcowboys.com'].join('\n');
  return { html, text };
}
