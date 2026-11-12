import { wrap, send, readJson, HttpError, EMAIL_RE } from '../lib/http.js';
import { query } from '../lib/db.js';
import { addToMailchimp } from '../lib/mailchimp.js';

// Newsletter signup (home-page form and the welcome pop-up). Emails are stored for the admin to export.
export default wrap(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const b = await readJson(req);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  const source = ['popup', 'footer'].includes(b.source) ? b.source : 'site';
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM subscribers WHERE created_at > now() - interval '1 hour'`);
  if (n >= 500) throw new HttpError(429, 'Too many signups right now. Please try again later.');
  await query('INSERT INTO subscribers (email, source) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING', [email, source]);
  await addToMailchimp(email, source);
  send(res, 200, { ok: true });
});
