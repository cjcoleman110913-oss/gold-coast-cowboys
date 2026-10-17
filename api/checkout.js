import { wrap, send, readJson, HttpError, EMAIL_RE, EVENT_SLUGS, origin } from '../lib/http.js';
import { tx, query } from '../lib/db.js';
import { getStripe } from '../lib/stripe.js';
import { currentPriceCents } from '../lib/passes.js';

const HOLD_MINUTES = 32; // Stripe sessions must live >= 30 min; hold the spot a bit longer

export default wrap(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const body = await readJson(req);
  const passTypeId = Number.parseInt(body.passTypeId, 10);
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  if (!Number.isInteger(passTypeId)) throw new HttpError(400, 'Choose a pass.');
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email.');

  // Atomically reserve a spot: lock the pass row so concurrent buyers can't oversell the cap.
  const order = await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT pt.*, c.title, c.style, c.level, c.event_slug, c.active
         FROM pass_types pt JOIN competitions c ON c.id = pt.competition_id
        WHERE pt.id = $1 FOR UPDATE OF pt`, [passTypeId]);
    const pt = rows[0];
    if (!pt || !pt.active) throw new HttpError(404, 'That pass is not available.');
    if (pt.cap != null) {
      const { rows: [{ n }] } = await db.query(
        `SELECT count(*)::int AS n FROM orders WHERE pass_type_id = $1
          AND (status = 'paid' OR (status = 'pending' AND expires_at > now()))`, [passTypeId]);
      if (n >= pt.cap) throw new HttpError(409, 'Sorry, this pass is sold out.');
    }
    const amount = currentPriceCents(pt);
    const { rows: [o] } = await db.query(
      `INSERT INTO orders (pass_type_id, email, buyer_name, amount_cents, status, expires_at)
       VALUES ($1,$2,$3,$4,'pending', now() + ($5 || ' minutes')::interval) RETURNING id`,
      [passTypeId, email, name, amount, String(HOLD_MINUTES)]);
    return { id: o.id, amount, pt };
  });

  const { pt } = order;
  const roleLabel = { lead: 'Lead', follow: 'Follow', any: 'Open' }[pt.role];
  const base = origin(req);
  try {
    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      client_reference_id: String(order.id),
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: order.amount,
          product_data: { name: `${pt.event_slug ? (EVENT_SLUGS[pt.event_slug] || pt.event_slug) + ': ' : ''}${pt.title} (${roleLabel})`,
            description: `${pt.style} · ${pt.level}` }
        }
      }],
      metadata: { order_id: String(order.id) },
      payment_intent_data: { metadata: { order_id: String(order.id) } },
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: `${base}/pass-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: pt.event_slug ? `${base}/passes.html?event=${pt.event_slug}` : `${base}/passes.html`
    });
    await query('UPDATE orders SET stripe_session_id = $1 WHERE id = $2', [session.id, order.id]);
    send(res, 200, { url: session.url });
  } catch (e) {
    await query(`UPDATE orders SET status = 'expired' WHERE id = $1`, [order.id]);
    console.error('Stripe checkout failed', e);
    throw new HttpError(502, 'Could not start checkout. Please try again.');
  }
});
