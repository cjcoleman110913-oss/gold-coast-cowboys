import { wrap, send, readJson, HttpError, EMAIL_RE, EVENT_SLUGS, origin } from '../../lib/http.js';
import { query, tx } from '../../lib/db.js';
import {
  hashPassword, verifyPassword, checkPasswordStrength, sha256, newToken,
  startSession, endSession, requireAdmin, assertNotLocked, recordFailure, clearFailures
} from '../../lib/auth.js';
import { listCompetitions, ROLES } from '../../lib/passes.js';
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
    const eventSlug = String(b.eventSlug || '') || null; // optional: null = not tied to an event
    if (eventSlug && !EVENT_SLUGS[eventSlug]) throw new HttpError(400, 'Unknown event.');
    const title = String(b.title || '').trim().slice(0, 120);
    const style = String(b.style || '').trim().slice(0, 60);
    const level = String(b.level || '').trim().slice(0, 60);
    const description = String(b.description || '').trim().slice(0, 1000) || null;
    if (!title || !style || !level) throw new HttpError(400, 'Title, style and level/division are required.');
    if (!Array.isArray(b.passes) || !b.passes.length) throw new HttpError(400, 'Add at least one pass (lead, follow or open).');

    const passes = [];
    const seen = new Set();
    for (const p of b.passes) {
      if (!ROLES.includes(p.role)) throw new HttpError(400, 'Bad role.');
      if (seen.has(p.role)) throw new HttpError(400, `Duplicate ${p.role} pass.`);
      seen.add(p.role);
      if (seen.has('any') && seen.size > 1) throw new HttpError(400, 'Use either an Open pass or Lead/Follow passes, not both.');
      const price = dollarsToCents(p.price);
      if (!Number.isFinite(price) || price < 50) throw new HttpError(400, 'Price must be at least $0.50.');
      let cap = null;
      if (p.cap !== '' && p.cap != null) {
        cap = Number.parseInt(p.cap, 10);
        if (!Number.isInteger(cap) || cap < 0) throw new HttpError(400, 'Pass limit must be a whole number (or blank for no limit).');
      }
      let early = null, until = null;
      if (p.earlyPrice !== '' && p.earlyPrice != null) {
        early = dollarsToCents(p.earlyPrice);
        if (!Number.isFinite(early) || early < 50) throw new HttpError(400, 'Early-bird price must be at least $0.50.');
        if (early >= price) throw new HttpError(400, 'Early-bird price must be lower than the regular price.');
        until = p.earlyUntil ? new Date(p.earlyUntil) : null;
        if (!until || Number.isNaN(until.getTime())) throw new HttpError(400, 'Set the early-bird deadline.');
      }
      passes.push({ role: p.role, price, cap, early, until: until ? until.toISOString() : null });
    }
    if (passes.some((p) => p.role === 'any') && passes.length > 1) throw new HttpError(400, 'Use either an Open pass or Lead/Follow passes, not both.');

    const outId = await tx(async (db) => {
      let cid = id;
      if (cid) {
        const r = await db.query(
          `UPDATE competitions SET event_slug=$2, title=$3, style=$4, level=$5, description=$6, active=$7 WHERE id=$1 RETURNING id`,
          [cid, eventSlug, title, style, level, description, b.active !== false]);
        if (!r.rows[0]) throw new HttpError(404, 'Competition not found.');
      } else {
        const r = await db.query(
          `INSERT INTO competitions (event_slug,title,style,level,description,active,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [eventSlug, title, style, level, description, b.active !== false, admin.id]);
        cid = r.rows[0].id;
      }
      const { rows: existing } = await db.query(
        `SELECT pt.id, pt.role, (SELECT count(*)::int FROM orders o WHERE o.pass_type_id = pt.id AND (o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > now()))) AS used
           FROM pass_types pt WHERE competition_id = $1 FOR UPDATE`, [cid]);
      for (const old of existing) {
        if (!passes.find((p) => p.role === old.role)) {
          const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM orders WHERE pass_type_id = $1', [old.id]);
          if (n > 0) throw new HttpError(409, `The ${old.role} pass already has orders and can't be removed. Set its limit instead.`);
          await db.query('DELETE FROM pass_types WHERE id = $1', [old.id]);
        }
      }
      for (const p of passes) {
        const old = existing.find((e) => e.role === p.role);
        if (old) {
          if (p.cap != null && p.cap < old.used) throw new HttpError(409, `The ${p.role} limit can't be lower than the ${old.used} already sold or held.`);
          await db.query(`UPDATE pass_types SET cap=$2, price_cents=$3, early_price_cents=$4, early_until=$5 WHERE id=$1`,
            [old.id, p.cap, p.price, p.early, p.until]);
        } else {
          await db.query(`INSERT INTO pass_types (competition_id, role, cap, price_cents, early_price_cents, early_until) VALUES ($1,$2,$3,$4,$5,$6)`,
            [cid, p.role, p.cap, p.price, p.early, p.until]);
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
    if (n > 0) throw new HttpError(409, 'This competition has orders, so it can’t be deleted. Hide it instead.');
    await query('DELETE FROM competitions WHERE id = $1', [id]);
    send(res, 200, { ok: true });
  },

  // ---------- buyers ----------
  async orders(req, res) {
    need(req, 'GET');
    await requireAdmin(req);
    send(res, 200, { orders: await fetchOrders(url(req).searchParams) });
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
    const head = ['Order', 'Status', 'Name', 'Email', 'Event', 'Competition', 'Style', 'Level', 'Role', 'Amount (USD)', 'Paid at'];
    const lines = [head.join(',')].concat(rows.map((o) => [
      o.id, o.status, o.buyer_name, o.email, o.event_slug ? (EVENT_SLUGS[o.event_slug] || o.event_slug) : 'No specific event', o.title, o.style, o.level, o.role,
      (o.amount_cents / 100).toFixed(2), o.paid_at ? new Date(o.paid_at).toISOString() : ''
    ].map(esc).join(',')));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gcc-buyers.csv"');
    res.end(lines.join('\n'));
  }
};

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
            pt.role, c.id AS competition_id, c.title, c.style, c.level, c.event_slug
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
