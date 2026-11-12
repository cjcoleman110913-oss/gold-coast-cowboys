import { createHash } from 'node:crypto';

// Pushes a newsletter signup into Mailchimp. Best-effort: the signup is always saved in our own database first,
// so a Mailchimp hiccup never loses an email or shows the visitor an error.
// Needs MAILCHIMP_API_KEY (ends in -usXX) and MAILCHIMP_AUDIENCE_ID in the environment; does nothing if either is missing.
export async function addToMailchimp(email, source) {
  const key = process.env.MAILCHIMP_API_KEY?.trim(), list = process.env.MAILCHIMP_AUDIENCE_ID?.trim();
  if (!key || !list) { const m = `not set up (API key ${key ? 'set' : 'MISSING'}, audience ID ${list ? 'set' : 'MISSING'})`; console.error('mailchimp ' + m); return m; }
  const dc = key.trim().split('-')[1];
  if (!dc) { const m = 'API key looks wrong (should end in a dash and a code like -us1)'; console.error('mailchimp ' + m); return m; }
  const hash = createHash('md5').update(email.toLowerCase()).digest('hex');
  try {
    const r = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(list)}/members/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from('gcc:' + key).toString('base64') },
      // status_if_new leaves anyone who previously unsubscribed unsubscribed
      body: JSON.stringify({ email_address: email, status_if_new: 'subscribed', tags: ['Website', source === 'popup' ? 'Pop-up' : 'Footer form'] }),
    });
    if (r.ok) return 'ok';
    const body = (await r.text()).slice(0, 300);
    console.error('mailchimp error', r.status, body);
    let detail = body; try { detail = JSON.parse(body).detail || JSON.parse(body).title || body; } catch {}
    return `error ${r.status}: ${detail}`.slice(0, 200);
  } catch (e) {
    console.error('mailchimp failed', e);
    return 'error: ' + String(e?.message || e).slice(0, 150);
  }
}
