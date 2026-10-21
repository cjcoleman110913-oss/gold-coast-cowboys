import { wrap, send, readJson, HttpError, EVENT_SLUGS, origin } from '../lib/http.js';
import { query, tx } from '../lib/db.js';
import { sendEmail } from '../lib/notify.js';
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
    await sendEmail({ to: r.email, subject: `Update on your ${eventName} request`,
      text: `Hi ${r.name},\n\nThanks for reaching out. ${l.name} has decided to go another direction on their ${l.kind} listing for ${eventName}. Keep an eye on the Roommates & Partners page for more listings.\n\n- Gold Coast Cowboys` });
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
  await sendEmail({ to: r.email, subject: `${l.name} accepted your ${eventName} request!`,
    text: `Hi ${r.name},\n\nGood news: ${l.name} accepted your request on their ${l.kind} listing for ${eventName}.\n\nReach them at ${l.email}${l.instagram ? ` (Instagram: ${l.instagram})` : ''}.\n\n- Gold Coast Cowboys`, replyTo: l.email });
  await sendEmail({ to: l.email, subject: `You accepted ${r.name} for ${eventName}`,
    text: `Hi ${l.name},\n\nYou accepted ${r.name}. Reach them at ${r.email}.\n\n${keepOpen ? 'Your listing is still up.' : 'Your listing has been taken down.'}\n\nManage your listing: ${manageLink(origin(req), l.id)}\n\n- Gold Coast Cowboys`, replyTo: r.email });
  for (const o of others) {
    await sendEmail({ to: o.email, subject: `Update on your ${eventName} request`,
      text: `Hi ${o.name},\n\nThe ${l.kind} listing you reached out to for ${eventName} has been filled. Keep an eye on the Roommates & Partners page for more listings.\n\n- Gold Coast Cowboys` });
  }
  send(res, 200, { ok: true, email: r.email });
});
