import { query } from './db.js';

const USED_SQL = `(SELECT count(*)::int FROM bundle_orders o WHERE o.bundle_slug = b.slug
  AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > now())))`;

export const planOf = (b) => (b.plan_months && b.plan_monthly_cents != null && b.plan_down_cents != null)
  ? { months: b.plan_months, downCents: b.plan_down_cents, monthlyCents: b.plan_monthly_cents,
      totalCents: b.plan_down_cents + b.plan_months * b.plan_monthly_cents } : null;

export async function listBundles() {
  const { rows } = await query(`SELECT b.*, ${USED_SQL} AS used FROM bundles b ORDER BY b.sort`);
  return rows.map((b) => {
    const remaining = b.cap == null ? null : Math.max(0, b.cap - b.used);
    return { slug: b.slug, name: b.name, priceCents: b.price_cents, cap: b.cap, remaining, soldOut: remaining === 0, plan: planOf(b) };
  });
}

export const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 });
