import { wrap, send, HttpError, EVENT_SLUGS } from '../lib/http.js';
import { query } from '../lib/db.js';

export default wrap(async (req, res) => {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const sid = new URL(req.url, 'http://x').searchParams.get('session_id') || '';
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw new HttpError(400, 'Bad session');
  const { rows } = await query(
    `SELECT o.status, o.buyer_name, o.email, o.amount_cents, pt.name AS pass_name, pt.role, c.title, c.style, c.level, c.event_slug, c.event_date, c.end_date, c.location
       FROM orders o JOIN pass_types pt ON pt.id = o.pass_type_id JOIN competitions c ON c.id = pt.competition_id
      WHERE o.stripe_session_id = $1`, [sid]);
  const o = rows[0];
  if (!o) {
    const { rows: [bo] } = await query(
      `SELECT o.status, o.buyer_name, o.email, o.amount_cents, b.name AS bundle_name
         FROM bundle_orders o JOIN bundles b ON b.slug = o.bundle_slug WHERE o.stripe_session_id = $1`, [sid]);
    if (!bo) throw new HttpError(404, 'Order not found');
    return send(res, 200, { status: bo.status, name: bo.buyer_name, email: bo.email, amountCents: bo.amount_cents, bundle: bo.bundle_name });
  }
  send(res, 200, { status: o.status, name: o.buyer_name, email: o.email, amountCents: o.amount_cents,
    passName: o.pass_name, role: o.role, title: o.title, style: o.style, level: o.level,
    location: o.location,
    date: o.event_date ? new Date(o.event_date).toISOString().slice(0, 10) : null,
    endDate: o.end_date ? new Date(o.end_date).toISOString().slice(0, 10) : null,
    event: o.event_slug ? (EVENT_SLUGS[o.event_slug] || o.event_slug) : null });
});
