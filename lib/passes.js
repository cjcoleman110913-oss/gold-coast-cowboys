import { query } from './db.js';

export const ROLES = ['lead', 'follow'];

export function currentPriceCents(pt, now = new Date()) {
  if (pt.early_price_cents != null && pt.early_until && new Date(pt.early_until) > now) return pt.early_price_cents;
  return pt.price_cents;
}

const SOLD_SQL = `(SELECT count(*)::int FROM orders o WHERE o.pass_type_id = pt.id
  AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > now())))`;

// An event stays on sale through its last day (yesterday still counts, to cover time zones).
export const NOT_PAST_SQL = `(COALESCE(c.end_date, c.event_date) IS NULL OR COALESCE(c.end_date, c.event_date) >= CURRENT_DATE - 1)`;


const dateStr = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Events (with their passes). Public callers only see active, not-yet-past events.
export async function listCompetitions({ eventSlug = null, includeInactive = false } = {}) {
  const params = [];
  let where = includeInactive ? 'TRUE' : `c.active AND ${NOT_PAST_SQL}`;
  if (eventSlug === 'none') where += ' AND c.event_slug IS NULL';
  else if (eventSlug) { params.push(eventSlug); where += ` AND c.event_slug = $${params.length}`; }
  const { rows } = await query(
    `SELECT c.id AS cid, c.event_slug, c.title, c.style, c.level, c.description, c.active,
            c.event_date, c.end_date, c.location, c.prize,
            (COALESCE(c.end_date, c.event_date) < CURRENT_DATE - 1) AS past,
            pt.id AS pid, pt.name AS pname, pt.role, pt.cap, pt.price_cents, pt.early_price_cents, pt.early_until,
            ${SOLD_SQL} AS sold,
            (SELECT count(*)::int FROM orders o WHERE o.pass_type_id = pt.id AND o.status = 'paid') AS paid
       FROM competitions c LEFT JOIN pass_types pt ON pt.competition_id = c.id
      WHERE ${where}
      ORDER BY c.event_date NULLS LAST, c.title, c.id, pt.id`, params);
  const byId = new Map();
  const now = new Date();
  for (const r of rows) {
    if (!byId.has(r.cid)) {
      byId.set(r.cid, { id: r.cid, eventSlug: r.event_slug, title: r.title, style: r.style, level: r.level,
        description: r.description, active: r.active, date: dateStr(r.event_date), endDate: dateStr(r.end_date),
        location: r.location, prize: r.prize, past: !!r.past, passes: [] });
    }
    if (r.pid) {
      const remaining = r.cap == null ? null : Math.max(0, r.cap - r.sold);
      byId.get(r.cid).passes.push({
        id: r.pid, name: r.pname, role: r.role, cap: r.cap, sold: r.sold, paid: r.paid, remaining,
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
