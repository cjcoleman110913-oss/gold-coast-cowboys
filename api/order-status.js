import { wrap, send, HttpError, EVENT_SLUGS } from '../lib/http.js';
import { query } from '../lib/db.js';

export default wrap(async (req, res) => {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const sid = new URL(req.url, 'http://x').searchParams.get('session_id') || '';
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw new HttpError(400, 'Bad session');
  const { rows } = await query(
    `SELECT o.status, o.buyer_name, o.email, o.amount_cents, pt.role, c.title, c.style, c.level, c.event_slug
       FROM orders o JOIN pass_types pt ON pt.id = o.pass_type_id JOIN competitions c ON c.id = pt.competition_id
      WHERE o.stripe_session_id = $1`, [sid]);
  const o = rows[0];
  if (!o) throw new HttpError(404, 'Order not found');
  send(res, 200, { status: o.status, name: o.buyer_name, email: o.email, amountCents: o.amount_cents,
    role: o.role, title: o.title, style: o.style, level: o.level, event: EVENT_SLUGS[o.event_slug] });
});
