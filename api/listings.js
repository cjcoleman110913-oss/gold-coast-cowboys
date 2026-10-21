import { wrap, send, readJson, HttpError, EMAIL_RE, EVENT_SLUGS, origin } from '../lib/http.js';
import { query } from '../lib/db.js';
import { sendEmail } from '../lib/notify.js';
import { manageLink, KINDS, ROLES_NEEDED, OPEN_SQL, clean } from '../lib/listings.js';

async function list(req, res) {
  const { rows } = await query(
    `SELECT id, kind, event_slug, name, nights, gender_pref, competition, level, role_needed, notes, instagram, created_at
       FROM listings WHERE ${OPEN_SQL} ORDER BY created_at DESC LIMIT 500`);
  send(res, 200, { listings: rows.map((r) => ({
    id: r.id, type: r.kind, event: EVENT_SLUGS[r.event_slug] || r.event_slug, name: r.name,
    nights: r.nights || '', genderPref: r.gender_pref || '', competition: r.competition || '', level: r.level || '',
    leadFollow: r.role_needed || '', message: r.notes || '', instagram: r.instagram || '', createdAt: r.created_at
  })) });
}

async function create(req, res, b) {
  const kind = clean(b.kind, 20);
  const event = clean(b.event, 60);
  const name = clean(b.name, 80);
  const email = clean(b.email, 200).toLowerCase();
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Choose Roommate or Partner.');
  if (!EVENT_SLUGS[event]) throw new HttpError(400, 'Choose an event.');
  if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address. It stays private.');
  const f = {
    nights: clean(b.nights, 120), genderPref: clean(b.genderPref, 60), competition: clean(b.competition, 120),
    level: clean(b.level, 60), roleNeeded: clean(b.roleNeeded, 20), notes: clean(b.notes, 600), instagram: clean(b.instagram, 120)
  };
  if (kind === 'partner' && f.roleNeeded && !ROLES_NEEDED.includes(f.roleNeeded)) throw new HttpError(400, 'Choose Lead, Follow, or Either.');
  if (kind === 'roommate') { f.competition = ''; f.level = ''; f.roleNeeded = ''; } else { f.nights = ''; f.genderPref = ''; }
  if (/^https?:\/\//i.test(f.instagram) && !/^https:\/\/(www\.)?instagram\.com\//i.test(f.instagram)) throw new HttpError(400, 'The Instagram field should be a handle or an instagram.com link.');

  const { rows: [{ mine, all }] } = await query(
    `SELECT count(*) FILTER (WHERE email = $1)::int AS mine, count(*)::int AS all
       FROM listings WHERE created_at > now() - interval '1 day'`, [email]);
  if (mine >= 5 || all >= 300) throw new HttpError(429, 'Too many listings right now. Please try again later.');

  const { rows: [row] } = await query(
    `INSERT INTO listings (kind, event_slug, name, email, nights, gender_pref, competition, level, role_needed, notes, instagram)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [kind, event, name, email, f.nights || null, f.genderPref || null, f.competition || null, f.level || null, f.roleNeeded || null, f.notes || null, f.instagram || null]);
  const link = manageLink(origin(req), row.id);
  await sendEmail({
    to: email, subject: 'Your Gold Coast Cowboys listing is live',
    text: `Hi ${name},\n\nYour ${kind} listing for ${EVENT_SLUGS[event]} is live on the Roommates & Partners page.\n\nThis is your private link. Use it to see who wants to connect, accept or decline requests, or take your listing down once you've found someone. Please don't share it.\n\n${link}\n\nListings come down on their own after 60 days.\n\n- Gold Coast Cowboys`
  });
  send(res, 200, { ok: true, id: row.id, manageUrl: link });
}

async function apply(req, res, b) {
  const id = Number.parseInt(b.listingId, 10);
  const name = clean(b.name, 80);
  const email = clean(b.email, 200).toLowerCase();
  const message = clean(b.message, 600);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Listing not found.');
  if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  const { rows: [l] } = await query(`SELECT * FROM listings WHERE id = $1 AND ${OPEN_SQL}`, [id]);
  if (!l) throw new HttpError(404, 'This listing is no longer available.');
  if (l.email === email) throw new HttpError(400, 'That’s your own listing.');
  const { rows: [{ n, recent }] } = await query(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int AS n,
            (SELECT count(*)::int FROM listing_requests WHERE email = $2 AND created_at > now() - interval '1 day') AS recent
       FROM listing_requests WHERE listing_id = $1`, [id, email]);
  if (n >= 30) throw new HttpError(429, 'This listing already has a lot of requests. Try another one or check back later.');
  if (recent >= 10) throw new HttpError(429, 'You’ve sent a lot of requests today. Please try again tomorrow.');
  const { rows: ins } = await query(
    `INSERT INTO listing_requests (listing_id, name, email, message) VALUES ($1,$2,$3,$4)
     ON CONFLICT (listing_id, email) DO NOTHING RETURNING id`, [id, name, email, message || null]);
  if (!ins.length) throw new HttpError(409, 'You already sent a request to this listing.');
  await sendEmail({
    to: l.email, subject: `${name} wants to connect on your ${EVENT_SLUGS[l.event_slug]} listing`,
    text: `Hi ${l.name},\n\n${name} sent a request on your ${l.kind} listing for ${EVENT_SLUGS[l.event_slug]}.${message ? `\n\nTheir message: "${message}"` : ''}\n\nAccept or decline here (this is your private link):\n${manageLink(origin(req), l.id)}\n\n- Gold Coast Cowboys`
  });
  send(res, 200, { ok: true });
}

export default wrap(async (req, res) => {
  if (req.method === 'GET') return list(req, res);
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const b = await readJson(req);
  if (clean(b.website, 50)) return send(res, 200, { ok: true, honeypot: true }); // bots fill the hidden field
  if (b.action === 'create') return create(req, res, b);
  if (b.action === 'apply') return apply(req, res, b);
  throw new HttpError(400, 'Unknown action.');
});
