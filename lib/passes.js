import { query } from './db.js';

export const ROLES = ['lead', 'follow', 'any'];

export function currentPriceCents(pt, now = new Date()) {
  if (pt.early_price_cents != null && pt.early_until && new Date(pt.early_until) > now) return pt.early_price_cents;
  return pt.price_cents;
}

const SOLD_SQL = `(SELECT count(*)::int FROM orders o WHERE o.pass_type_id = pt.id
  AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > now())))`;

// Public view of competitions + passes (optionally for one event).
export async function listCompetitions({ eventSlug = null, includeInactive = false } = {}) {
  const params = [];
  let where = includeInactive ? 'TRUE' : 'c.active';
  if (eventSlug === 'none') where += ' AND c.event_slug IS NULL';
  else if (eventSlug) { params.push(eventSlug); where += ` AND c.event_slug = $${params.length}`; }
  const { rows } = await query(
    `SELECT c.id AS cid, c.event_slug, c.title, c.style, c.level, c.description, c.active,
            pt.id AS pid, pt.role, pt.cap, pt.price_cents, pt.early_price_cents, pt.early_until,
            ${SOLD_SQL} AS sold,
            (SELECT count(*)::int FROM orders o WHERE o.pass_type_id = pt.id AND o.status = 'paid') AS paid
       FROM competitions c LEFT JOIN pass_types pt ON pt.competition_id = c.id
      WHERE ${where}
      ORDER BY (c.event_slug IS NULL), c.event_slug, c.style, c.level, c.id, CASE pt.role WHEN 'lead' THEN 0 WHEN 'follow' THEN 1 ELSE 2 END`, params);
  const byId = new Map();
  const now = new Date();
  for (const r of rows) {
    if (!byId.has(r.cid)) {
      byId.set(r.cid, { id: r.cid, eventSlug: r.event_slug, title: r.title, style: r.style, level: r.level,
        description: r.description, active: r.active, passes: [] });
    }
    if (r.pid) {
      const remaining = r.cap == null ? null : Math.max(0, r.cap - r.sold);
      byId.get(r.cid).passes.push({
        id: r.pid, role: r.role, cap: r.cap, sold: r.sold, paid: r.paid, remaining,
        soldOut: remaining === 0,
        priceCents: r.price_cents, earlyPriceCents: r.early_price_cents,
        earlyUntil: r.early_until ? new Date(r.early_until).toISOString() : null,
        currentPriceCents: currentPriceCents(r, now),
        earlyActive: r.early_price_cents != null && r.early_until && new Date(r.early_until) > now
      });
    }
  }
  return [...byId.values()];
}
