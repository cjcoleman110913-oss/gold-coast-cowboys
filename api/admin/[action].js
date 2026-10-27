import { wrap, send, readJson, HttpError, EMAIL_RE, EVENT_SLUGS, TICKET_TYPES, origin } from '../../lib/http.js';
import { query, tx } from '../../lib/db.js';
import {
  hashPassword, verifyPassword, checkPasswordStrength, sha256, newToken,
  startSession, endSession, requireAdmin, assertNotLocked, recordFailure, clearFailures
} from '../../lib/auth.js';
import { listCompetitions, ROLES } from '../../lib/passes.js';
import { listBundles } from '../../lib/bundles.js';
import crypto from 'node:crypto';

const need = (req, method) => { if (req.method !== method) throw new HttpError(405, 'Method not allowed'); };
const url = (req) => new URL(req.url, 'http://x');
const dollarsToCents = (v) => Math.round(Number(v) * 100);

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const actions = {
  // ---------- auth ----------
  async status(req, res) {
    need(req, 'GET');
    const { rows: [{ n }] } = await query('SELECT count(*)::int AS n FROM admins');
    send(res, 200, { needsSetup: n === 0 });
  },

  // The very first admin. Only works while there are no admins, and needs ADMIN_SETUP_KEY.
  async setup(req, res) {
    need(req, 'POST');
    const b = await readJson(req);
    if (!process.env.ADMIN_SETUP_KEY) throw new HttpError(503, 'ADMIN_SETUP_KEY is not configured on the server.');
    if (!safeEqual(b.setupKey || '', process.env.ADMIN_SETUP_KEY)) throw new HttpError(403, 'Wrong setup key.');
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').trim().slice(0, 100);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email.');
    if (!name) throw new HttpError(400, 'Enter your name.');
    checkPasswordStrength(b.password);
    const id = await tx(async (db) => {
      await db.query('LOCK TABLE admins IN EXCLUSIVE MODE');
      const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM admins');
      if (n > 0) throw new HttpError(409, 'Setup is already done. Ask an existing admin for an invite.');
      const { rows } = await db.query('INSERT INTO admins (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [email, name, hashPassword(b.password)]);
      return rows[0].id;
    });
    const csrf = startSession(res, id);
    send(res, 200, { ok: true, csrf });
  },

  async login(req, res) {
    need(req, 'POST');
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    await assertNotLocked(email);
    const { rows } = await query('SELECT id, password_hash FROM admins WHERE email = $1', [email]);
    // Always run a hash comparison so timing doesn't reveal whether the email exists.
    const ok = rows[0]
      ? verifyPassword(password, rows[0].password_hash)
      : (verifyPassword(password, 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64)), false);
    if (!ok) {
      await recordFailure(email);
      throw new HttpError(401, 'Wrong email or password.');
    }
    await clearFailures(email);
    const csrf = startSession(res, rows[0].id);
    send(res, 200, { ok: true, csrf });
  },

  async logout(req, res) {
    need(req, 'POST');
    endSession(res);
    send(res, 200, { ok: true });
  },

  async me(req, res) {
    need(req, 'GET');
    const { admin, csrf } = await requireAdmin(req);
    send(res, 200, { admin, csrf, events: EVENT_SLUGS });
  },

  // ---------- invites / admins ----------
  async 'invite-create'(req, res) {
    need(req, 'POST');
    const { admin } = await requireAdmin(req);
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase() || null;
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email or leave it blank.');
    const token = newToken();
    await query(`INSERT INTO invites (token_hash, email, created_by, expires_at) VALUES ($1,$2,$3, now() + interval '7 days')`,
      [sha256(token), email, admin.id]);
    send(res, 200, { link: `${origin(req)}/admin/accept.html?token=${token}`, expiresInDays: 7 });
  },

  async invites(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    const { rows } = await query(
      `SELECT i.id, i.email, i.expires_at, a.name AS invited_by FROM invites i LEFT JOIN admins a ON a.id = i.created_by
        WHERE i.used_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`);
    send(res, 200, { invites: rows });
  },

  async 'invite-revoke'(req, res) {
    need(req, 'POST');
    await requireAdmin(req);
    const b = await readJson(req);
    await query('DELETE FROM invites WHERE id = $1 AND used_at IS NULL', [Number(b.id)]);
    send(res, 200, { ok: true });
  },

  async 'invite-info'(req, res) {
    need(req, 'GET');
    const token = url(req).searchParams.get('token') || '';
    const { rows } = await query(
      'SELECT email FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()', [sha256(token)]);
    if (!rows[0]) throw new HttpError(404, 'This invite link is invalid or has expired.');
    send(res, 200, { email: rows[0].email });
  },

  async accept(req, res) {
    need(req, 'POST');
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').trim().slice(0, 100);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email.');
    if (!name) throw new HttpError(400, 'Enter your name.');
    checkPasswordStrength(b.password);
    const id = await tx(async (db) => {
      // Single-use: claim the invite atomically.
      const { rows } = await db.query(
        `UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email`,
        [sha256(String(b.token || ''))]);
      if (!rows[0]) throw new HttpError(404, 'This invite link is invalid or has expired.');
      if (rows[0].email && rows[0].email !== email) throw new HttpError(400, `This invite is for ${rows[0].email}.`);
      const { rows: dupe } = await db.query('SELECT 1 FROM admins WHERE email = $1', [email]);
      if (dupe[0]) throw new HttpError(409, 'An admin with that email already exists.');
      const r = await db.query('INSERT INTO admins (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [email, name, hashPassword(b.password)]);
      return r.rows[0].id;
    });
    const csrf = startSession(res, id);
    send(res, 200, { ok: true, csrf });
  },

  async admins(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    const { rows } = await query('SELECT id, name, email, created_at FROM admins ORDER BY id');
    send(res, 200, { admins: rows });
  },

  async 'admin-remove'(req, res) {
    need(req, 'POST');
    const { admin } = await requireAdmin(req);
    const b = await readJson(req);
    const id = Number(b.id);
    if (id === admin.id) throw new HttpError(400, "You can't remove yourself.");
    await query('DELETE FROM admins WHERE id = $1', [id]);
    send(res, 200, { ok: true });
  },

  // ---------- competitions ----------
  async competitions(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    send(res, 200, { competitions: await listCompetitions({ includeInactive: true }) });
  },

  async 'competition-save'(req, res) {
    need(req, 'POST');
    const { admin } = await requireAdmin(req);
    const b = await readJson(req);
    const id = b.id ? Number(b.id) : null;
    const eventSlug = String(b.eventSlug || '') || null; // optional: show on one of the three GCC event pages
    if (eventSlug && !EVENT_SLUGS[eventSlug]) throw new HttpError(400, 'Unknown event page.');
    const title = String(b.title || '').trim().slice(0, 120);
    const style = String(b.style || '').trim().slice(0, 60) || null;
    const level = String(b.level || '').trim().slice(0, 60) || null;
    const location = String(b.location || '').trim().slice(0, 200) || null;
    const description = String(b.description || '').trim().slice(0, 2000) || null;
    const prize = String(b.prize || '').trim().slice(0, 300) || null;
    if (!title) throw new HttpError(400, 'Add a title.');
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v + 'T00:00:00Z').getTime());
    const eventDate = String(b.date || '');
    if (!isDate(eventDate)) throw new HttpError(400, 'Choose the competition date.');
    const endDate = String(b.endDate || '') || null;
    if (endDate && (!isDate(endDate) || endDate < eventDate)) throw new HttpError(400, 'The end date must be on or after the start date.');
    if (!Array.isArray(b.passes) || !b.passes.length) throw new HttpError(400, 'Add at least one entry option.');
    if (b.passes.length > 30) throw new HttpError(400, 'That is too many entry options.');

    const passes = [];
    const names = new Set();
    for (const p of b.passes) {
      const role = p.role ? String(p.role) : null;
      if (role && !ROLES.includes(role)) throw new HttpError(400, 'Bad role.');
      const name = String(p.name || '').trim().slice(0, 80) || (role === 'lead' ? 'Lead' : role === 'follow' ? 'Follow' : '');
      if (!name) throw new HttpError(400, 'Give every entry option a name.');
      if (names.has(name.toLowerCase())) throw new HttpError(400, `Two entry options are named “${name}”. Names must be different.`);
      names.add(name.toLowerCase());
      const price = dollarsToCents(p.price);
      if (!Number.isFinite(price) || price < 50) throw new HttpError(400, `${name}: price must be at least $0.50.`);
      let cap = null;
      if (p.cap !== '' && p.cap != null) {
        cap = Number.parseInt(p.cap, 10);
        if (!Number.isInteger(cap) || cap < 0) throw new HttpError(400, `${name}: the limit must be a whole number (or blank for no limit).`);
      }
      let early = null, until = null;
      if (p.earlyPrice !== '' && p.earlyPrice != null) {
        early = dollarsToCents(p.earlyPrice);
        if (!Number.isFinite(early) || early < 50) throw new HttpError(400, `${name}: early-bird price must be at least $0.50.`);
        if (early >= price) throw new HttpError(400, `${name}: the early-bird price must be lower than the regular price.`);
        until = p.earlyUntil ? new Date(p.earlyUntil) : null;
        if (!until || Number.isNaN(until.getTime())) throw new HttpError(400, `${name}: set the early-bird deadline.`);
      }
      passes.push({ id: p.id ? Number(p.id) : null, name, role, price, cap, early, until: until ? until.toISOString() : null });
    }

    const outId = await tx(async (db) => {
      let cid = id;
      if (cid) {
        const r = await db.query(
          `UPDATE competitions SET event_slug=$2, title=$3, style=$4, level=$5, description=$6, active=$7,
                  event_date=$8, end_date=$9, location=$10, prize=$11 WHERE id=$1 RETURNING id`,
          [cid, eventSlug, title, style, level, description, b.active !== false, eventDate, endDate, location, prize]);
        if (!r.rows[0]) throw new HttpError(404, 'Competition not found.');
      } else {
        const r = await db.query(
          `INSERT INTO competitions (event_slug,title,style,level,description,active,event_date,end_date,location,created_by,prize)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [eventSlug, title, style, level, description, b.active !== false, eventDate, endDate, location, admin.id, prize]);
        cid = r.rows[0].id;
      }
      const { rows: existing } = await db.query(
        `SELECT pt.id, pt.name, (SELECT count(*)::int FROM orders o WHERE o.pass_type_id = pt.id AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > now()))) AS used
           FROM pass_types pt WHERE competition_id = $1 FOR UPDATE`, [cid]);
      for (const p of passes) {
        if (p.id && !existing.find((e) => e.id === p.id)) throw new HttpError(400, 'An entry option on this form no longer exists. Reload and try again.');
      }
      for (const old of existing) {
        if (!passes.find((p) => p.id === old.id)) {
          const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM orders WHERE pass_type_id = $1', [old.id]);
          if (n > 0) throw new HttpError(409, `“${old.name}” already has orders and can't be removed. Set its limit instead.`);
          await db.query('DELETE FROM pass_types WHERE id = $1', [old.id]);
        }
      }
      for (const p of passes) {
        const old = p.id ? existing.find((e) => e.id === p.id) : null;
        if (old) {
          if (p.cap != null && p.cap < old.used) throw new HttpError(409, `“${p.name}” limit can't be lower than the ${old.used} already sold or held.`);
          await db.query(`UPDATE pass_types SET name=$2, role=$3, cap=$4, price_cents=$5, early_price_cents=$6, early_until=$7 WHERE id=$1`,
            [old.id, p.name, p.role, p.cap, p.price, p.early, p.until]);
        } else {
          await db.query(`INSERT INTO pass_types (competition_id, name, role, cap, price_cents, early_price_cents, early_until) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [cid, p.name, p.role, p.cap, p.price, p.early, p.until]);
        }
      }
      return cid;
    });
    send(res, 200, { ok: true, id: outId });
  },

  async 'competition-delete'(req, res) {
    need(req, 'POST');
    await requireAdmin(req);
    const b = await readJson(req);
    const id = Number(b.id);
    const { rows: [{ n }] } = await query(
      `SELECT count(*)::int AS n FROM orders o JOIN pass_types pt ON pt.id = o.pass_type_id WHERE pt.competition_id = $1`, [id]);
    if (n > 0) throw new HttpError(409, 'This competition has entries, so it can’t be deleted. Hide it instead.');
    await query('DELETE FROM competitions WHERE id = $1', [id]);
    send(res, 200, { ok: true });
  },

  // ---------- buyers ----------
  async orders(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    send(res, 200, { orders: await fetchOrders(url(req).searchParams) });
  },

  // ---------- season-pass bundles ----------
  async bundles(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    send(res, 200, { bundles: await listBundles(), orders: await fetchBundleOrders(url(req).searchParams) });
  },

  async 'bundles-csv'(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    const rows = await fetchBundleOrders(url(req).searchParams);
    const esc = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [['Order', 'Status', 'Name', 'Email', 'Bundle', 'Amount (USD)', 'Paid at'].join(',')].concat(rows.map((o) => [
      o.id, o.status, o.buyer_name, o.email, o.bundle_name, (o.amount_cents / 100).toFixed(2), o.paid_at ? new Date(o.paid_at).toISOString() : ''
    ].map(esc).join(',')));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gcc-bundles.csv"');
    res.end(lines.join('\n'));
  },

  // ---------- pass / voucher redemptions ----------
  async redemptions(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    send(res, 200, { redemptions: await fetchRedemptions(url(req).searchParams) });
  },

  async 'redemption-update'(req, res) {
    need(req, 'POST');
    await requireAdmin(req);
    const b = await readJson(req);
    const id = Number(b.id);
    if (!Number.isInteger(id) || !['new', 'done'].includes(b.status)) throw new HttpError(400, 'Invalid request.');
    const { rows } = await query('UPDATE redemptions SET status = $1 WHERE id = $2 RETURNING id', [b.status, id]);
    if (!rows.length) throw new HttpError(404, 'Not found');
    send(res, 200, { ok: true });
  },

  async 'redemptions-csv'(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    const rows = await fetchRedemptions(url(req).searchParams);
    const esc = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['ID', 'Submitted', 'Status', 'Name', 'Email', 'Event', 'Ticket', 'Competition', 'Won at'];
    const lines = [head.join(',')].concat(rows.map((r) => [
      r.id, new Date(r.created_at).toISOString(), r.status, r.name, r.email, EVENT_SLUGS[r.event_slug] || r.event_slug,
      TICKET_TYPES[r.ticket_type] || r.ticket_type, r.competition || '', r.won_at
    ].map(esc).join(',')));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gcc-redemptions.csv"');
    res.end(lines.join('\n'));
  },

  // ---------- roommate / partner listings ----------
  async listings(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    const all = url(req).searchParams.get('status') === 'all';
    const { rows } = await query(
      `SELECT l.*, (SELECT count(*)::int FROM listing_requests r WHERE r.listing_id = l.id) AS requests
         FROM listings l ${all ? '' : `WHERE l.status = 'open' AND l.expires_at > now()`} ORDER BY l.created_at DESC LIMIT 1000`);
    send(res, 200, { listings: rows });
  },

  async 'listing-remove'(req, res) {
    need(req, 'POST');
    await requireAdmin(req);
    const id = Number((await readJson(req)).id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid request.');
    const { rows } = await query(`UPDATE listings SET status = 'removed', closed_at = now() WHERE id = $1 RETURNING id`, [id]);
    if (!rows.length) throw new HttpError(404, 'Not found');
    send(res, 200, { ok: true });
  },

  async 'orders-csv'(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    const rows = await fetchOrders(url(req).searchParams);
    const esc = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralize spreadsheet formula injection
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['Order', 'Status', 'Name', 'Email', 'Event', 'Event date', 'Location', 'Entry', 'Amount (USD)', 'Paid at'];
    const lines = [head.join(',')].concat(rows.map((o) => [
      o.id, o.status, o.buyer_name, o.email, o.title, o.event_date ? new Date(o.event_date).toISOString().slice(0, 10) : '', o.location || '',
      o.pass_name || '', (o.amount_cents / 100).toFixed(2), o.paid_at ? new Date(o.paid_at).toISOString() : ''
    ].map(esc).join(',')));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gcc-buyers.csv"');
    res.end(lines.join('\n'));
  }
};

async function fetchBundleOrders(sp) {
  const params = [];
  const where = [];
  const status = sp.get('status');
  if (status && status !== 'all') { params.push(status); where.push(`o.status = $${params.length}`); }
  else if (!status) where.push(`o.status IN ('paid','refunded')`);
  const slug = sp.get('bundle');
  if (slug) { params.push(slug); where.push(`o.bundle_slug = $${params.length}`); }
  const { rows } = await query(
    `SELECT o.id, o.status, o.buyer_name, o.email, o.amount_cents, o.paid_at, o.created_at, o.bundle_slug, b.name AS bundle_name
       FROM bundle_orders o JOIN bundles b ON b.slug = o.bundle_slug
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(o.paid_at, o.created_at) DESC LIMIT 5000`, params);
  return rows;
}

async function fetchRedemptions(sp) {
  const status = sp.get('status');
  const where = status === 'all' ? '' : `WHERE status = '${status === 'done' ? 'done' : 'new'}'`;
  const { rows } = await query(`SELECT * FROM redemptions ${where} ORDER BY created_at DESC LIMIT 5000`);
  return rows;
}

async function fetchOrders(sp) {
  const params = [];
  const where = [];
  const status = sp.get('status');
  if (status && status !== 'all') { params.push(status); where.push(`o.status = $${params.length}`); }
  else if (!status) where.push(`o.status IN ('paid','refunded')`);
  const comp = Number.parseInt(sp.get('competition'), 10);
  if (Number.isInteger(comp)) { params.push(comp); where.push(`c.id = $${params.length}`); }
  const ev = sp.get('event');
  if (ev === 'none') where.push('c.event_slug IS NULL');
  else if (ev) { params.push(ev); where.push(`c.event_slug = $${params.length}`); }
  const { rows } = await query(
    `SELECT o.id, o.status, o.buyer_name, o.email, o.amount_cents, o.paid_at, o.created_at,
            pt.name AS pass_name, pt.role, c.id AS competition_id, c.title, c.style, c.level, c.event_slug, c.event_date, c.location
       FROM orders o JOIN pass_types pt ON pt.id = o.pass_type_id JOIN competitions c ON c.id = pt.competition_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(o.paid_at, o.created_at) DESC LIMIT 5000`, params);
  return rows;
}

export default wrap(async (req, res) => {
  const action = req.query?.action || url(req).pathname.split('/').pop();
  const fn = Object.hasOwn(actions, action) ? actions[action] : null;
  if (!fn) throw new HttpError(404, 'Not found');
  await fn(req, res);
});
