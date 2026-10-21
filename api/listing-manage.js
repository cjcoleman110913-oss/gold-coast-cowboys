import { wrap, send, readJson, HttpError, EVENT_SLUGS, origin } from '../lib/http.js';
import { query, tx } from '../lib/db.js';
import { sendEmail } from '../lib/notify.js';
import { renderEmail } from '../lib/email.js';
import { tokenOk, manageLink } from '../lib/listings.js';

async function load(id, token) {
  id = Number.parseInt(id, 10);
  if (!Number.isInteger(id) || !tokenOk(id, token)) throw new HttpError(403, 'This link isn’t valid.');
  const { rows: [l] } = await query('SELECT * FROM listings WHERE id = $1', [id]);
  if (!l) throw new HttpError(404, 'Listing not found.');
  return l;
}

export default wrap(async (req, res) => {
  if (req.method === 'GET') {
    const sp = new URL(req.url, 'http://x').searchParams;
    const l = await load(sp.get('id'), sp.get('token'));
    const { rows } = await query('SELECT id, name, email, message, status, created_at FROM listing_requests WHERE listing_id = $1 ORDER BY created_at DESC', [l.id]);
    const expired = l.status === 'open' && new Date(l.expires_at) <= new Date();
    return send(res, 200, {
      listing: { id: l.id, kind: l.kind, event: EVENT_SLUGS[l.event_slug], name: l.name, status: expired ? 'expired' : l.status, expiresAt: l.expires_at,
        nights: l.nights, genderPref: l.gender_pref, competition: l.competition, level: l.level, roleNeeded: l.role_needed, notes: l.notes },
      // An applicant's email is only revealed after you accept them.
      requests: rows.map((r) => ({ id: r.id, name: r.name, message: r.message, status: r.status, createdAt: r.created_at, email: r.status === 'accepted' ? r.email : undefined }))
    });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const b = await readJson(req);
  const l = await load(b.id, b.token);
  const eventName = EVENT_SLUGS[l.event_slug];

  if (b.action === 'close') {
    await query(`UPDATE listings SET status = 'filled', closed_at = now() WHERE id = $1 AND status = 'open'`, [l.id]);
    return send(res, 200, { ok: true });
  }

  const rid = Number.parseInt(b.requestId, 10);
  if (!Number.isInteger(rid) || !['accept', 'decline'].includes(b.action)) throw new HttpError(400, 'Invalid request.');
  const { rows: [r] } = await query('SELECT * FROM listing_requests WHERE id = $1 AND listing_id = $2', [rid, l.id]);
  if (!r) throw new HttpError(404, 'Request not found.');
  if (r.status !== 'pending') throw new HttpError(409, `You already ${r.status} this request.`);

  if (b.action === 'decline') {
    await query(`UPDATE listing_requests SET status = 'declined' WHERE id = $1`, [rid]);
    await sendEmail({ to: r.email, subject: `Update on your ${eventName} request`, ...renderEmail({
      eyebrow: eventName, heading: 'Update on your request',
      intro: [`Hi ${r.name}, thanks for reaching out. ${l.name} has decided to go another direction on their ${l.kind} listing.`, 'There are other dancers looking too, so keep an eye on the listings.'],
      button: { label: 'Browse listings', url: `${origin(req)}/partner-finder.html` } }) });
    return send(res, 200, { ok: true });
  }

  if (l.status !== 'open') throw new HttpError(409, 'This listing is already closed.');
  const keepOpen = b.keepOpen === true;
  const others = await tx(async (db) => {
    await db.query(`UPDATE listing_requests SET status = 'accepted' WHERE id = $1`, [rid]);
    if (keepOpen) return [];
    await db.query(`UPDATE listings SET status = 'filled', closed_at = now() WHERE id = $1`, [l.id]);
    const { rows } = await db.query(`SELECT name, email FROM listing_requests WHERE listing_id = $1 AND status = 'pending'`, [l.id]);
    await db.query(`UPDATE listing_requests SET status = 'declined' WHERE listing_id = $1 AND status = 'pending'`, [l.id]);
    return rows;
  });
  await sendEmail({ to: r.email, subject: `${l.name} accepted your ${eventName} request!`, replyTo: l.email, ...renderEmail({
    preheader: `${l.name} said yes. Here's how to reach them.`, eyebrow: `${l.kind === 'roommate' ? 'Roommate' : 'Partner'} · ${eventName}`, heading: 'You’re connected!',
    intro: [`Hi ${r.name}, good news: ${l.name} accepted your request. Reach out and get it planned.`],
    details: [['Name', l.name], ['Email', l.email], ['Instagram', l.instagram]],
    button: { label: `Email ${l.name}`, url: `mailto:${l.email}` } }) });
  await sendEmail({ to: l.email, subject: `You accepted ${r.name} for ${eventName}`, replyTo: r.email, ...renderEmail({
    eyebrow: `${l.kind === 'roommate' ? 'Roommate' : 'Partner'} · ${eventName}`, heading: `You accepted ${r.name}`,
    intro: ['Here’s how to reach them. We sent them your contact info too.'],
    details: [['Name', r.name], ['Email', r.email]],
    button: { label: `Email ${r.name}`, url: `mailto:${r.email}` },
    outro: [keepOpen ? 'Your listing is still up for more people.' : 'Your listing has been taken down.', `Manage your listing: ${manageLink(origin(req), l.id)}`] }) });
  for (const o of others) {
    await sendEmail({ to: o.email, subject: `Update on your ${eventName} request`, ...renderEmail({
      eyebrow: eventName, heading: 'This listing has been filled',
      intro: [`Hi ${o.name}, the ${l.kind} listing you reached out to has been filled.`, 'There are other dancers looking too, so keep an eye on the listings.'],
      button: { label: 'Browse listings', url: `${origin(req)}/partner-finder.html` } }) });
  }
  send(res, 200, { ok: true, email: r.email });
});
