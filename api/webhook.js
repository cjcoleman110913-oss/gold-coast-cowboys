import { readRaw, send, HttpError } from '../lib/http.js';
import { verifyWebhook, getStripe } from '../lib/stripe.js';
import { query } from '../lib/db.js';
import { notify, sendEmail } from '../lib/notify.js';
import { renderEmail } from '../lib/email.js';
import { money, paymentDates } from '../lib/bundles.js';

export const config = { api: { bodyParser: false } };

const EVENTS_LINE = 'Boots on the Coast, St. Louis Stomp, Tails California';
const first = (n) => String(n || '').split(' ')[0] || 'there';

async function bundleLabel(slug) {
  const { rows: [b] } = await query('SELECT name FROM bundles WHERE slug = $1', [slug]);
  return b?.name || slug;
}

// Emails never break the webhook: a mail failure must not make Stripe retry a paid order.
async function safely(fn) { try { await fn(); } catch (e) { console.error('bundle email failed', e); } }

async function bundleEmails(bo) {
  const label = await bundleLabel(bo.bundle_slug);
  const monthly = bo.plan === 'monthly';
  const paid = money(bo.amount_cents);
  await safely(async () => {
    await sendEmail({ to: bo.email, subject: 'You’re in: Gold Coast Cowboys 2027 Season Pass',
      ...renderEmail({ preheader: `Your ${label} pass is confirmed.`, eyebrow: 'Season pass', heading: `You’re in, ${first(bo.buyer_name)}!`,
        intro: [monthly ? 'Your down payment went through and your 2027 season pass is locked in. The rest is paid automatically each month.'
                        : 'Your payment went through and your 2027 season pass is locked in.'],
        details: [['Pass', label], [monthly ? 'Paid today' : 'Paid', paid],
          ...(monthly ? [['Then', `${bo.plan_months} monthly payments of ${money(bo.plan_monthly_cents)}`],
            ['Payment dates', paymentDates(bo.plan_months, new Date(bo.created_at)).join(', ')], ['Plan total', `${money(bo.plan_total_cents)} (includes the 4% payment plan fee)`]] : []),
          ['Events', EVENTS_LINE]],
        outro: [...(monthly ? [`You agreed to the Terms & Conditions at checkout: ${(process.env.SITE_URL || 'https://goldcoastcowboys.com').replace(/\/$/, '')}/terms.html. To cancel future payments, email dance@goldcoastcowboys.com with the subject “GCC All Access Pass Cancellation” and include your full name and purchase email.`] : []),
          'We’ll email you the details for each event as they get closer. Questions? Just reply to this email.'] }) });
    await notify({ subject: `Season pass sold: ${label} (${bo.buyer_name})${monthly ? ' · monthly plan' : ''}`, replyTo: bo.email,
      ...renderEmail({ preheader: `${bo.buyer_name} bought ${label}.`, eyebrow: 'Season pass sold', heading: `${bo.buyer_name} bought ${label}`,
        details: [['Name', bo.buyer_name], ['Email', bo.email], ['Pass', label], ['Paid today', paid],
          ...(monthly ? [['Plan', `${bo.plan_months} × ${money(bo.plan_monthly_cents)} monthly (total ${money(bo.plan_total_cents)})`]] : [])] }) });
  });
}

// ---- monthly plans (Stripe subscriptions) ----
const subIdOf = (inv) => inv.subscription || inv.parent?.subscription_details?.subscription || null;
const metaOrderId = (inv) => Number.parseInt(
  inv.subscription_details?.metadata?.bundle_order_id || inv.parent?.subscription_details?.metadata?.bundle_order_id || inv.metadata?.bundle_order_id, 10);

async function findPlanOrder(inv) {
  const sub = subIdOf(inv);
  let rows = [];
  if (sub) ({ rows } = await query('SELECT * FROM bundle_orders WHERE stripe_subscription_id = $1', [sub]));
  if (!rows[0] && Number.isInteger(metaOrderId(inv))) {
    ({ rows } = await query(`SELECT * FROM bundle_orders WHERE id = $1 AND plan = 'monthly'`, [metaOrderId(inv)]));
    if (rows[0] && sub && !rows[0].stripe_subscription_id) await query('UPDATE bundle_orders SET stripe_subscription_id = $1 WHERE id = $2', [sub, rows[0].id]);
  }
  return rows[0] || null;
}

async function invoicePaid(inv) {
  const o = await findPlanOrder(inv);
  if (!o) return;
  const kind = inv.billing_reason === 'subscription_create' ? 'down' : 'monthly';
  // The invoice id makes this idempotent: Stripe may deliver the same event more than once.
  const { rows: ins } = await query(
    `INSERT INTO bundle_payments (invoice_id, order_id, kind, amount_cents) VALUES ($1,$2,$3,$4)
     ON CONFLICT (invoice_id) DO NOTHING RETURNING invoice_id`, [inv.id, o.id, kind, inv.amount_paid ?? 0]);
  if (!ins.length || kind === 'down') return;
  if ((inv.amount_paid ?? 0) === 0) return;
  await query(`UPDATE bundle_orders SET plan_status = 'active', plan_past_due_since = NULL WHERE id = $1 AND plan_status = 'past_due'`, [o.id]);
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM bundle_payments WHERE order_id = $1 AND kind = 'monthly'`, [o.id]);
  if (n < o.plan_months) return;
  // Last payment received: stop the subscription so they're never charged again.
  const { rows: [done] } = await query(
    `UPDATE bundle_orders SET plan_status = 'completed' WHERE id = $1 AND plan_status IN ('active','past_due') RETURNING id`, [o.id]);
  if (!done) return;
  const sub = o.stripe_subscription_id || subIdOf(inv);
  if (sub) {
    try { await getStripe().subscriptions.cancel(sub); }
    catch (e) {
      console.error('could not cancel finished subscription', sub, e);
      await safely(() => notify({ subject: `ACTION NEEDED: cancel Stripe subscription for ${o.buyer_name}`,
        ...renderEmail({ preheader: 'A payment plan finished but the subscription could not be stopped automatically.', eyebrow: 'Action needed',
          heading: 'Please cancel this subscription in Stripe',
          intro: [`${o.buyer_name} has made all ${o.plan_months} monthly payments, but we couldn’t stop the subscription automatically. Cancel it in Stripe so they aren’t charged again.`],
          details: [['Name', o.buyer_name], ['Email', o.email], ['Subscription', sub]] }) }));
    }
  }
  const label = await bundleLabel(o.bundle_slug);
  await safely(async () => {
    await sendEmail({ to: o.email, subject: 'Your Gold Coast Cowboys season pass is paid off',
      ...renderEmail({ preheader: 'That was your last payment. You’re all set.', eyebrow: 'Season pass', heading: `Paid in full, ${first(o.buyer_name)}!`,
        intro: ['That was your final monthly payment. Your season pass is fully paid and you won’t be charged again.'],
        details: [['Pass', label], ['Total paid', money(o.plan_total_cents)], ['Events', EVENTS_LINE]] }) });
    await notify({ subject: `Payment plan finished: ${o.buyer_name} (${label})`, replyTo: o.email,
      ...renderEmail({ preheader: `${o.buyer_name} paid off their ${label} plan.`, eyebrow: 'Plan complete', heading: `${o.buyer_name} paid off ${label}`,
        details: [['Name', o.buyer_name], ['Email', o.email], ['Total paid', money(o.plan_total_cents)]] }) });
  });
}

async function invoiceFailed(inv) {
  const o = await findPlanOrder(inv);
  if (!o || inv.billing_reason === 'subscription_create') return;
  await query(`UPDATE bundle_orders SET plan_status = 'past_due', plan_past_due_since = COALESCE(plan_past_due_since, now()) WHERE id = $1 AND plan_status IN ('active','past_due')`, [o.id]);
  const { rows: [pd] } = await query('SELECT plan_past_due_since FROM bundle_orders WHERE id = $1', [o.id]);
  const graceEnd = new Date(new Date(pd.plan_past_due_since).getTime() + 14 * 86400000).toISOString().slice(0, 10);
  const label = await bundleLabel(o.bundle_slug);
  const attempt = inv.attempt_count || 1;
  const amount = money(inv.amount_due ?? o.plan_monthly_cents);
  const fixUrl = inv.hosted_invoice_url || null;
  await safely(async () => {
    await sendEmail({ to: o.email, subject: 'Your Gold Coast Cowboys payment didn’t go through',
      ...renderEmail({ preheader: 'We’ll try again, but you can update your card now.', eyebrow: 'Season pass', heading: 'Your payment didn’t go through',
        intro: [`Hi ${first(o.buyer_name)}, your ${amount} monthly payment for the ${label} season pass failed. We’ll retry the card automatically, and you can also pay it right now. You have 14 days (until ${graceEnd}) to resolve it before your pass benefits are placed on hold. Once you’re current, benefits can be reinstated.`],
        details: [['Pass', label], ['Amount due', amount], ['Resolve by', graceEnd]],
        ...(fixUrl ? { button: { label: 'Pay now / update card', url: fixUrl } } : {}),
        outro: ['If you’re having trouble, just reply to this email and we’ll help.'] }) });
    await notify({ subject: `PAYMENT FAILED: ${o.buyer_name} (${label})`, replyTo: o.email,
      ...renderEmail({ preheader: `${o.buyer_name}'s ${amount} payment failed (attempt ${attempt}).`, eyebrow: 'Payment failed', heading: `${o.buyer_name}’s payment failed`,
        intro: ['Stripe will keep retrying the card automatically, and the buyer was emailed a link to pay or update their card. Under the terms, they have a 14-day grace period; after that their pass benefits go on hold until they’re current (the Bundles tab flags this).'],
        details: [['Name', o.buyer_name], ['Email', o.email], ['Pass', label], ['Amount', amount], ['Attempt', String(attempt)], ['Grace period ends', graceEnd]] }) });
  });
}

async function subscriptionDeleted(sub) {
  const { rows: [o] } = await query(
    `UPDATE bundle_orders SET plan_status = 'canceled' WHERE stripe_subscription_id = $1 AND plan_status IN ('active','past_due') RETURNING *`, [sub.id]);
  if (!o) return; // already completed, or not ours
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM bundle_payments WHERE order_id = $1 AND kind = 'monthly'`, [o.id]);
  const label = await bundleLabel(o.bundle_slug);
  await safely(() => notify({ subject: `PLAN CANCELED before payoff: ${o.buyer_name} (${label})`, replyTo: o.email,
    ...renderEmail({ preheader: `${o.buyer_name}'s plan was canceled with ${o.plan_months - n} payments left.`, eyebrow: 'Plan canceled', heading: `${o.buyer_name}’s plan was canceled`,
      intro: ['The subscription ended before all payments were made (the card failed every retry, or it was canceled in Stripe). Their spot is still held. Under the terms, future payments stop, no remaining balance is owed, and remaining benefits are forfeited. Follow up if you like, and release the spot in the Bundles tab when you’re ready.'],
      details: [['Name', o.buyer_name], ['Email', o.email], ['Pass', label], ['Monthly payments made', `${n} of ${o.plan_months}`]],
      button: { label: 'Open the Bundles tab', url: `${process.env.SITE_URL || 'https://goldcoastcowboys.com'}/admin/index.html` } }) }));
}

export async function applyEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (obj.payment_status === 'paid') {
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id || null;
        const sub = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id || null;
        await query(
          `UPDATE orders SET status = 'paid', paid_at = now(), stripe_payment_intent = $2
            WHERE stripe_session_id = $1 AND status IN ('pending','expired')`, [obj.id, pi]);
        const { rows: [bo] } = await query(
          `UPDATE bundle_orders SET status = 'paid', paid_at = now(), stripe_payment_intent = $2,
                  stripe_subscription_id = COALESCE($3, stripe_subscription_id)
            WHERE stripe_session_id = $1 AND status IN ('pending','expired')
            RETURNING bundle_slug, buyer_name, email, amount_cents, plan, plan_months, plan_monthly_cents, plan_total_cents, created_at`, [obj.id, pi, sub]);
        if (bo) await bundleEmails(bo);
      }
      break;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      await query(`UPDATE orders SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'`, [obj.id]);
      await query(`UPDATE bundle_orders SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'`, [obj.id]);
      break;
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      await invoicePaid(obj);
      break;
    case 'invoice.payment_failed':
      await invoiceFailed(obj);
      break;
    case 'customer.subscription.deleted':
      await subscriptionDeleted(obj);
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
