// Optional email notification through Resend (https://resend.com).
// Does nothing unless RESEND_API_KEY is set. Never throws: a failed email must not fail a form.
export async function notify({ subject, text, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const to = process.env.NOTIFY_EMAIL || 'dance@goldcoastcowboys.com';
  const from = process.env.NOTIFY_FROM || 'GCC Website <noreply@goldcoastcowboys.com>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    if (!r.ok) console.error('notify failed', r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('notify error', e); return false; }
}
