import { wrap, send, readJson, HttpError, EMAIL_RE, EVENT_SLUGS, TICKET_TYPES, origin } from '../lib/http.js';
import { query } from '../lib/db.js';
import { notify } from '../lib/notify.js';
import { renderEmail } from '../lib/email.js';

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export default wrap(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const b = await readJson(req);
  if (clean(b.website, 50)) return send(res, 200, { ok: true }); // honeypot: bots fill this in, people never see it

  const name = clean(b.name, 120);
  const email = clean(b.email, 200).toLowerCase();
  const wonAt = clean(b.wonAt, 200);
  const event = clean(b.event, 60);
  const type = clean(b.ticketType, 30);
  const competition = clean(b.competition, 200);

  if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!wonAt) throw new HttpError(400, 'Tell us where you won the pass.');
  if (!EVENT_SLUGS[event]) throw new HttpError(400, 'Please choose which event you’re redeeming for.');
  if (!TICKET_TYPES[type]) throw new HttpError(400, 'Please choose what kind of ticket it is.');

  // Light abuse protection
  const { rows: [{ mine, all }] } = await query(
    `SELECT count(*) FILTER (WHERE email = $1)::int AS mine, count(*)::int AS all
       FROM redemptions WHERE created_at > now() - interval '1 hour'`, [email]);
  if (mine >= 3 || all >= 200) throw new HttpError(429, 'Too many submissions right now. Please try again later or email dance@goldcoastcowboys.com.');

  await query(
    `INSERT INTO redemptions (name, email, won_at, event_slug, ticket_type, competition) VALUES ($1,$2,$3,$4,$5,$6)`,
    [name, email, wonAt, event, type, type === 'competition_pass' && competition ? competition : null]);

  await notify({
    subject: `Pass redemption: ${name} (${EVENT_SLUGS[event]})`,
    replyTo: email,
    ...renderEmail({
      preheader: `${name} is redeeming a ${TICKET_TYPES[type].toLowerCase()} for ${EVENT_SLUGS[event]}.`,
      eyebrow: 'New redemption', heading: `${name} redeemed a pass`,
      details: [['Name', name], ['Email', email], ['Event', EVENT_SLUGS[event]], ['Ticket', TICKET_TYPES[type]],
        ['Competition', type === 'competition_pass' ? (competition || '(not given)') : ''], ['Won at', wonAt]],
      button: { label: 'Open the dashboard', url: `${origin(req)}/admin/index.html` },
      outro: ['Reply to this email to reach them directly.']
    })
  });

  send(res, 200, { ok: true });
});
