import { wrap, send, readJson, HttpError, EMAIL_RE, origin } from '../lib/http.js';
import { tx, query } from '../lib/db.js';
import { getStripe } from '../lib/stripe.js';
import { currentPriceCents } from '../lib/passes.js';
import { listBundles, planOf, addMonths, saleOpen } from '../lib/bundles.js';
import { TERMS_VERSION } from '../lib/terms.js';

const HOLD_MINUTES = 32; // Stripe sessions must live >= 30 min; hold the spot a bit longer

// Season-pass bundles (Bronze / Silver / Gold): same flow, separate tables.
async function bundleCheckout(req, res, body) {
  const slug = String(body.bundle || '').toLowerCase();
  const monthly = body.plan === 'monthly';
  if (!saleOpen()) throw new HttpError(410, 'Season pass sales ended on May 26, 2027.');
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email.');
  if (monthly && body.acceptTerms !== true) throw new HttpError(400, 'Please agree to the Terms & Conditions to pay monthly.');

  const order = await tx(async (db) => {
    const { rows } = await db.query(`SELECT * FROM bundles WHERE slug = $1 FOR UPDATE`, [slug]);
    const b = rows[0];
    if (!b) throw new HttpError(404, 'That pass is not available.');
    if (b.cap != null) {
      const { rows: [{ n }] } = await db.query(
        `SELECT count(*)::int AS n FROM bundle_orders WHERE bundle_slug = $1
          AND (status = 'paid' OR (status = 'pending' AND expires_at > now()))`, [slug]);
      if (n >= b.cap) throw new HttpError(409, 'Sorry, this pass is sold out.');
    }
    const plan = monthly ? planOf(b) : null;
    if (monthly && !plan) throw new HttpError(400, 'Monthly payments are not available for this pass.');
    const { rows: [o] } = await db.query(
      `INSERT INTO bundle_orders (bundle_slug, email, buyer_name, amount_cents, status, expires_at,
                                  plan, plan_months, plan_monthly_cents, plan_total_cents, plan_status, terms_version, terms_accepted_at)
       VALUES ($1,$2,$3,$4,'pending', now() + ($5 || ' minutes')::interval, $6,$7,$8,$9,$10,$11, CASE WHEN $11::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [slug, email, name, plan ? plan.downCents : b.price_cents, String(HOLD_MINUTES),
       plan ? 'monthly' : 'full', plan?.months ?? null, plan?.monthlyCents ?? null, plan?.totalCents ?? null, plan ? 'active' : null,
       plan ? TERMS_VERSION : null]);
    return { id: o.id, amount: plan ? plan.downCents : b.price_cents, b, plan };
  });

  const base = origin(req);
  try {
    const product = (suffix) => ({ name: `Gold Coast Cowboys 2027 Season Pass: ${order.b.name}${suffix}`.slice(0, 250),
      description: 'Boots on the Coast, St. Louis Stomp and Tails California' });
    const common = {
      customer_email: email,
      client_reference_id: `bundle-${order.id}`,
      metadata: { bundle_order_id: String(order.id) },
    };
    // Monthly plan: down payment now (one-time item), then a monthly subscription whose first charge is one month out.
    // billing_cycle_anchor (not a free trial) so Stripe's page never says "free trial"; proration none = no charge for the gap.
    // The webhook cancels the subscription after the last payment.
    const mode = order.plan
      ? { mode: 'subscription',
          line_items: [
            { quantity: 1, price_data: { currency: 'usd', unit_amount: order.plan.monthlyCents, recurring: { interval: 'month' }, product_data: product(` (monthly payment, ${order.plan.months} total)`) } },
            { quantity: 1, price_data: { currency: 'usd', unit_amount: order.plan.downCents, product_data: product(' (down payment)') } }],
          subscription_data: { billing_cycle_anchor: Math.floor(addMonths(new Date(), 1).getTime() / 1000), proration_behavior: 'none', metadata: { bundle_order_id: String(order.id) } } }
      : { mode: 'payment',
          line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: order.amount, product_data: product('') } }],
          payment_intent_data: { metadata: { bundle_order_id: String(order.id) } } };
    const session = await getStripe().checkout.sessions.create({
      ...common, ...mode,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: `${base}/pass-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/index.html#season-passes`
    });
    await query('UPDATE bundle_orders SET stripe_session_id = $1 WHERE id = $2', [session.id, order.id]);
    send(res, 200, { url: session.url });
  } catch (e) {
    await query(`UPDATE bundle_orders SET status = 'expired' WHERE id = $1`, [order.id]);
    console.error('Stripe bundle checkout failed', e);
    // TEMPORARY: show Stripe's reason while the monthly plan is being tested.
    throw new HttpError(502, 'Could not start checkout. Please try again.' + (e?.raw?.message ? ` [${e.raw.message}]` : ''));
  }
}

export default wrap(async (req, res) => {
  if (req.method === 'GET') return send(res, 200, { bundles: await listBundles() }); // availability for the home page
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const body = await readJson(req);
  if (body.bundle) return bundleCheckout(req, res, body);
  const passTypeId = Number.parseInt(body.passTypeId, 10);
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  if (!Number.isInteger(passTypeId)) throw new HttpError(400, 'Choose a pass.');
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email.');

  // Atomically reserve a spot: lock the pass row so concurrent buyers can't oversell the cap.
  const order = await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT pt.*, c.title, c.style, c.level, c.event_slug, c.active, c.location, c.event_date,
              (COALESCE(c.end_date, c.event_date) < CURRENT_DATE - 1) AS past
         FROM pass_types pt JOIN competitions c ON c.id = pt.competition_id
        WHERE pt.id = $1 FOR UPDATE OF pt`, [passTypeId]);
    const pt = rows[0];
    if (!pt || !pt.active) throw new HttpError(404, 'That pass is not available.');
    if (pt.past) throw new HttpError(410, 'This event has already happened.');
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
          product_data: { name: `${pt.title}: ${pt.name || 'Pass'}`.slice(0, 250),
            ...(([pt.style, pt.level, pt.location].filter(Boolean).join(' · ')) ? { description: [pt.style, pt.level, pt.location].filter(Boolean).join(' · ').slice(0, 500) } : {}) }
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
