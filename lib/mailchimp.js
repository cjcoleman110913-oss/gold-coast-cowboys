import { createHash } from 'node:crypto';

// Pushes a newsletter signup into Mailchimp. Best-effort: the signup is always saved in our own database first,
// so a Mailchimp hiccup never loses an email or shows the visitor an error.
// Needs MAILCHIMP_API_KEY (ends in -usXX) and MAILCHIMP_AUDIENCE_ID in the environment; does nothing if either is missing.
export async function addToMailchimp(email, source) {
  const key = process.env.MAILCHIMP_API_KEY, list = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!key || !list) return false;
  const dc = key.split('-')[1];
  if (!dc) return false;
  const hash = createHash('md5').update(email.toLowerCase()).digest('hex');
  try {
    const r = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(list)}/members/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from('gcc:' + key).toString('base64') },
      // status_if_new leaves anyone who previously unsubscribed unsubscribed
      body: JSON.stringify({ email_address: email, status_if_new: 'subscribed', tags: ['Website', source === 'popup' ? 'Pop-up' : 'Footer form'] }),
    });
    if (!r.ok) console.error('mailchimp error', r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) {
    console.error('mailchimp failed', e);
    return false;
  }
}
