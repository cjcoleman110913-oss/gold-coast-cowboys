import { readRaw, send, HttpError } from '../lib/http.js';
import { verifyWebhook } from '../lib/stripe.js';
import { query } from '../lib/db.js';
import { notify, sendEmail } from '../lib/notify.js';
import { renderEmail } from '../lib/email.js';

export const config = { api: { bodyParser: false } };

async function bundleEmails(bo) {
  const { rows: [b] } = await query('SELECT name FROM bundles WHERE slug = $1', [bo.bundle_slug]);
  const label = b?.name || bo.bundle_slug;
  const paid = '$' + (bo.amount_cents / 100).toFixed(2);
  try {
    await sendEmail({ to: bo.email, subject: 'You’re in: Gold Coast Cowboys 2027 Season Pass',
      ...renderEmail({ preheader: `Your ${label} pass is confirmed.`, eyebrow: 'Season pass', heading: `You’re in, ${bo.buyer_name.split(' ')[0]}!`,
        intro: ['Your payment went through and your 2027 season pass is locked in.'],
        details: [['Pass', label], ['Paid', paid], ['Events', 'Boots on the Coast, St. Louis Stomp, Tails California']],
        outro: ['We’ll email you the details for each event as they get closer. Questions? Just reply to this email.'] }) });
    await notify({ subject: `Season pass sold: ${label} (${bo.buyer_name})`, replyTo: bo.email,
      ...renderEmail({ preheader: `${bo.buyer_name} bought ${label}.`, eyebrow: 'Season pass sold', heading: `${bo.buyer_name} bought ${label}`,
        details: [['Name', bo.buyer_name], ['Email', bo.email], ['Pass', label], ['Paid', paid]] }) });
  } catch (e) { console.error('bundle email failed', e); }
}

export async function applyEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (obj.payment_status === 'paid') {
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id || null;
        await query(
          `UPDATE orders SET status = 'paid', paid_at = now(), stripe_payment_intent = $2
            WHERE stripe_session_id = $1 AND status IN ('pending','expired')`, [obj.id, pi]);
        const { rows: [bo] } = await query(
          `UPDATE bundle_orders SET status = 'paid', paid_at = now(), stripe_payment_intent = $2
            WHERE stripe_session_id = $1 AND status IN ('pending','expired')
            RETURNING bundle_slug, buyer_name, email, amount_cents`, [obj.id, pi]);
        if (bo) await bundleEmails(bo);
      }
      break;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      await query(`UPDATE orders SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'`, [obj.id]);
      await query(`UPDATE bundle_orders SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'`, [obj.id]);
      break;
    case 'charge.refunded':
      if (obj.refunded && obj.payment_intent) {
        await query(`UPDATE orders SET status = 'refunded' WHERE stripe_payment_intent = $1 AND status = 'paid'`, [obj.payment_intent]);
        await query(`UPDATE bundle_orders SET status = 'refunded' WHERE stripe_payment_intent = $1 AND status = 'paid'`, [obj.payment_intent]);
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
