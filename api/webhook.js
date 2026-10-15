import { readRaw, send, HttpError } from '../lib/http.js';
import { verifyWebhook } from '../lib/stripe.js';
import { query } from '../lib/db.js';

export const config = { api: { bodyParser: false } };

export async function applyEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (obj.payment_status === 'paid') {
        await query(
          `UPDATE orders SET status = 'paid', paid_at = now(), stripe_payment_intent = $2
            WHERE stripe_session_id = $1 AND status IN ('pending','expired')`,
          [obj.id, typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id || null]);
      }
      break;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      await query(`UPDATE orders SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'`, [obj.id]);
      break;
    case 'charge.refunded':
      if (obj.refunded && obj.payment_intent) {
        await query(`UPDATE orders SET status = 'refunded' WHERE stripe_payment_intent = $1 AND status = 'paid'`, [obj.payment_intent]);
      }
      break;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const raw = await readRaw(req);
    let event;
    try { event = verifyWebhook(raw, req.headers['stripe-signature']); }
    catch { throw new HttpError(400, 'Invalid signature'); }
    await applyEvent(event);
    send(res, 200, { received: true });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('webhook error', e);
    send(res, 500, { error: 'webhook failed' }); // Stripe will retry
  }
}
