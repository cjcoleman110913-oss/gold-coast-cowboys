import { query } from './db.js';

const USED_SQL = `(SELECT count(*)::int FROM bundle_orders o WHERE o.bundle_slug = b.slug
  AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > now())))`;

export async function listBundles() {
  const { rows } = await query(`SELECT b.slug, b.name, b.price_cents, b.cap, ${USED_SQL} AS used FROM bundles b ORDER BY b.sort`);
  return rows.map((b) => {
    const remaining = b.cap == null ? null : Math.max(0, b.cap - b.used);
    return { slug: b.slug, name: b.name, priceCents: b.price_cents, cap: b.cap, remaining, soldOut: remaining === 0 };
  });
}
