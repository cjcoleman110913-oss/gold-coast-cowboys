// Email through Resend (https://resend.com). Does nothing unless RESEND_API_KEY is set.
// Never throws: a failed email must not fail a form or an accept/decline.
let mailer = null;
export function setMailer(fn) { mailer = fn; } // tests capture outgoing mail here

export async function sendEmail({ to, subject, text, html, replyTo }) {
  if (mailer) { await mailer({ to, subject, text, html, replyTo }); return true; }
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  const from = process.env.NOTIFY_FROM || 'GCC Website <noreply@goldcoastcowboys.com>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}), ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    if (!r.ok) console.error('email failed', r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('email error', e); return false; }
}

// Notification to the GCC team inbox.
export const notify = ({ subject, text, html, replyTo }) =>
  sendEmail({ to: process.env.NOTIFY_EMAIL || 'dance@goldcoastcowboys.com', subject, text, html, replyTo });
