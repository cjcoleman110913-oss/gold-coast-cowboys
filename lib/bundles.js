import { query } from './db.js';

const USED_SQL = `(SELECT count(*)::int FROM bundle_orders o WHERE o.bundle_slug = b.slug
  AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > now())))`;

export const planOf = (b) => (b.plan_months && b.plan_monthly_cents != null && b.plan_down_cents != null)
  ? { months: b.plan_months, downCents: b.plan_down_cents, monthlyCents: b.plan_monthly_cents,
      totalCents: b.plan_down_cents + b.plan_months * b.plan_monthly_cents,
      schedule: paymentDates(b.plan_months) } : null;

export async function listBundles() {
  const { rows } = await query(`SELECT b.*, ${USED_SQL} AS used FROM bundles b ORDER BY b.sort`);
  return rows.map((b) => {
    const remaining = b.cap == null ? null : Math.max(0, b.cap - b.used);
    return { slug: b.slug, name: b.name, priceCents: b.price_cents, cap: b.cap, remaining, soldOut: remaining === 0, saleEnded: !saleOpen(), plan: planOf(b) };
  });
}

// Same day each month (or the last day of a shorter month), matching how Stripe bills a monthly subscription.
export function addMonths(from, n) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + n, 1, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(from.getUTCDate(), last));
  return d;
}
export const paymentDates = (months, from = new Date()) => Array.from({ length: months }, (_, i) => addMonths(from, i + 1).toISOString().slice(0, 10));

// Bundles can be bought through May 26, 2027 (end of day, Central time; CDT = UTC-5).
export const SALE_ENDS_AT = new Date('2027-05-27T05:00:00Z');
export const saleOpen = (now = new Date()) => now < SALE_ENDS_AT;

export const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 });
