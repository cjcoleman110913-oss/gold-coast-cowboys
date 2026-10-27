import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.js';
import { setMailer } from '../lib/notify.js';

let S;
test.before(async () => { S = await startServer(); });
test.after(async () => { await S.close(); });

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    const r = await fetch(S.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch {}
    if (json?.csrf) this.csrf = json.csrf;
    return { status: r.status, json, text, headers: r.headers };
  }
}
const owner = new Client();
const PW = 'correct-horse-battery';

test('setup: needs setup key, works once', async () => {
  const anon = new Client();
  assert.equal((await anon.req('GET', '/api/admin/status')).json.needsSetup, true);
  let r = await anon.req('POST', '/api/admin/setup', { setupKey: 'nope', email: 'o@x.com', name: 'Owner', password: PW });
  assert.equal(r.status, 403);
  r = await anon.req('POST', '/api/admin/setup', { setupKey: 'setup-key-123', email: 'o@x.com', name: 'Owner', password: 'short' });
  assert.equal(r.status, 400);
  r = await owner.req('POST', '/api/admin/setup', { setupKey: 'setup-key-123', email: 'Owner@X.com', name: 'Owner', password: PW });
  assert.equal(r.status, 200);
  assert.match(owner.cookie, /^gcc_admin=/);
  r = await anon.req('POST', '/api/admin/setup', { setupKey: 'setup-key-123', email: 'b@x.com', name: 'B', password: PW });
  assert.equal(r.status, 409);
  assert.equal((await anon.req('GET', '/api/admin/status')).json.needsSetup, false);
});

test('admin endpoints require login and CSRF', async () => {
  const anon = new Client();
  assert.equal((await anon.req('GET', '/api/admin/competitions')).status, 401);
  assert.equal((await anon.req('GET', '/api/admin/orders')).status, 401);
  const noCsrf = new Client(); noCsrf.cookie = owner.cookie; // cookie but no csrf header
  assert.equal((await noCsrf.req('POST', '/api/admin/invite-create', {})).status, 403);
  const forged = new Client(); forged.cookie = owner.cookie.slice(0, -3) + 'xyz'; forged.csrf = owner.csrf;
  assert.equal((await forged.req('GET', '/api/admin/me')).status, 401);
  const me = await owner.req('GET', '/api/admin/me');
  assert.equal(me.json.admin.email, 'owner@x.com');
});

test('login: wrong password, lockout after 5, correct login', async () => {
  const c = new Client();
  for (let i = 0; i < 5; i++) assert.equal((await c.req('POST', '/api/admin/login', { email: 'owner@x.com', password: 'bad-password-1' })).status, i < 5 ? 401 : 429);
  const locked = await c.req('POST', '/api/admin/login', { email: 'owner@x.com', password: PW });
  assert.equal(locked.status, 429);
  await S.db.query(`UPDATE login_attempts SET locked_until = now() - interval '1 minute'`);
  const ok = await c.req('POST', '/api/admin/login', { email: 'owner@x.com', password: PW });
  assert.equal(ok.status, 200);
  // unknown email behaves like wrong password
  assert.equal((await new Client().req('POST', '/api/admin/login', { email: 'ghost@x.com', password: PW })).status, 401);
});

test('invites: create, accept once, expire, email-locked', async () => {
  const inv = await owner.req('POST', '/api/admin/invite-create', {});
  assert.equal(inv.status, 200);
  const token = new URL(inv.json.link).searchParams.get('token');
  assert.equal((await new Client().req('GET', `/api/admin/invite-info?token=${token}`)).status, 200);
  const guest = new Client();
  assert.equal((await guest.req('POST', '/api/admin/accept', { token: 'bogus', email: 'cj@x.com', name: 'CJ', password: PW })).status, 404);
  const ok = await guest.req('POST', '/api/admin/accept', { token, email: 'cj@x.com', name: 'CJ', password: PW });
  assert.equal(ok.status, 200);
  assert.equal((await guest.req('GET', '/api/admin/me')).json.admin.name, 'CJ');
  assert.equal((await new Client().req('POST', '/api/admin/accept', { token, email: 'z@x.com', name: 'Z', password: PW })).status, 404, 'single use');
  // email-restricted + expired
  const inv2 = await owner.req('POST', '/api/admin/invite-create', { email: 'only@x.com' });
  const t2 = new URL(inv2.json.link).searchParams.get('token');
  assert.equal((await new Client().req('POST', '/api/admin/accept', { token: t2, email: 'other@x.com', name: 'O', password: PW })).status, 400);
  const inv3 = await owner.req('POST', '/api/admin/invite-create', {});
  await S.db.query(`UPDATE invites SET expires_at = now() - interval '1 day' WHERE used_at IS NULL AND email IS NULL`);
  assert.equal((await new Client().req('POST', '/api/admin/accept', { token: new URL(inv3.json.link).searchParams.get('token'), email: 'late@x.com', name: 'L', password: PW })).status, 404);
  const admins = await owner.req('GET', '/api/admin/admins');
  assert.equal(admins.json.admins.length, 2);
  assert.equal((await owner.req('POST', '/api/admin/admin-remove', { id: admins.json.admins[0].id })).status, 400, 'cannot remove self');
});

let compId, leadId, followId;
const future = (d) => new Date(Date.now() + d * 864e5).toISOString();

test('competitions: validation and create', async () => {
  const base = { eventSlug: 'boots-on-the-coast', title: 'Novice Jack & Jill', date: '2099-05-27', endDate: '2099-05-30', location: 'Irvine, CA', style: 'Jack & Jill', level: 'Novice', prize: 'Full weekend pass to Boots on the Coast',
    passes: [{ role: 'lead', price: 60, cap: 2, earlyPrice: 45, earlyUntil: future(10) }, { role: 'follow', price: 60, cap: 3 }] };
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, eventSlug: 'nope' })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, title: '' })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [] })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ role: 'lead', price: 0.1 }] })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ role: 'lead', price: 50, earlyPrice: 60, earlyUntil: future(1) }] })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ role: 'lead', price: 50, earlyPrice: 40 }] })).status, 400, 'deadline required');
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ name: 'Same', price: 50 }, { name: 'same', price: 50 }] })).status, 400, 'duplicate names');
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ price: 50 }] })).status, 400, 'pass needs a name');
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, date: '' })).status, 400, 'date required');
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, endDate: '2099-05-01' })).status, 400, 'end before start');
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ role: 'dj', name: 'x', price: 50 }] })).status, 400, 'bad role');
  const r = await owner.req('POST', '/api/admin/competition-save', base);
  assert.equal(r.status, 200);
  compId = r.json.id;
  const pub = await new Client().req('GET', '/api/passes?event=boots-on-the-coast');
  assert.equal(pub.json.competitions.length, 1);
  assert.equal(pub.json.competitions[0].prize, 'Full weekend pass to Boots on the Coast');
  const lead = pub.json.competitions[0].passes.find((p) => p.role === 'lead');
  leadId = lead.id; followId = pub.json.competitions[0].passes.find((p) => p.role === 'follow').id;
  assert.equal(lead.currentPriceCents, 4500); assert.equal(lead.earlyActive, true);
  assert.equal((await new Client().req('GET', '/api/passes?event=nope')).status, 404);
  // other event page doesn't show it
  assert.equal((await new Client().req('GET', '/api/passes?event=st-louis-stomp')).json.competitions.length, 0);
});

async function buy(passTypeId, email = 'dancer@x.com', name = 'Dancer') {
  return new Client().req('POST', '/api/checkout', { passTypeId, email, name });
}
async function pay(sid, type) {
  const r = await fetch(`${S.base}/__dev/pay?session_id=${sid}&type=${type || 'checkout.session.completed'}`, { method: 'POST' });
  return r.status;
}

test('checkout: validation, early-bird price sent to Stripe, cap enforced', async () => {
  assert.equal((await buy(leadId, 'not-an-email')).status, 400);
  assert.equal((await buy(leadId, 'a@x.com', '')).status, 400);
  assert.equal((await buy(99999)).status, 404);
  const a = await buy(leadId, 'a@x.com', 'A');
  assert.equal(a.status, 200); assert.match(a.json.url, /fake-checkout/);
  const sess = [...S.stripe.sessions.values()].at(-1);
  assert.equal(sess.line_items[0].price_data.unit_amount, 4500);
  assert.equal(sess.mode, 'payment');
  assert.equal(sess.customer_email, 'a@x.com');
  const b = await buy(leadId, 'b@x.com', 'B');
  assert.equal(b.status, 200);
  const c = await buy(leadId, 'c@x.com', 'C');
  assert.equal(c.status, 409, 'cap of 2 holds spots for pending checkouts');
  // follow cap is independent
  assert.equal((await buy(followId, 'f@x.com', 'F')).status, 200);
});

test('webhook: signature required; paid / expired / refunded transitions', async () => {
  const bad = await fetch(`${S.base}/api/webhook`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${S.base}/api/webhook`)).status, 405);
  const { rows } = await S.db.query(`SELECT o.id, o.stripe_session_id sid, o.email FROM orders o ORDER BY id`);
  const [a, b] = rows;
  assert.equal(await pay(a.sid), 200);
  assert.equal(await pay(a.sid), 200, 'idempotent');
  assert.equal((await S.db.query('SELECT status FROM orders WHERE id=$1', [a.id])).rows[0].status, 'paid');
  // expire b -> spot frees up
  assert.equal(await pay(b.sid, 'checkout.session.expired'), 200);
  assert.equal((await S.db.query('SELECT status FROM orders WHERE id=$1', [b.id])).rows[0].status, 'expired');
  const c = await buy(leadId, 'c@x.com', 'C');
  assert.equal(c.status, 200, 'spot released after expiry');
  // lead now full (a paid + c pending)
  assert.equal((await buy(leadId, 'd@x.com', 'D')).status, 409);
  // refund frees the spot
  assert.equal(await pay(a.sid, 'charge.refunded'), 200);
  assert.equal((await S.db.query('SELECT status FROM orders WHERE id=$1', [a.id])).rows[0].status, 'refunded');
  assert.equal((await buy(leadId, 'd@x.com', 'D')).status, 200);
});

test('stale hold expires by time even without a webhook', async () => {
  await S.db.query(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE status = 'pending'`);
  const pub = await new Client().req('GET', '/api/passes?event=boots-on-the-coast');
  const lead = pub.json.competitions[0].passes.find((p) => p.role === 'lead');
  assert.equal(lead.sold, 0); // only refunded/expired remain
});

test('concurrent buyers cannot oversell', async () => {
  const r = await owner.req('POST', '/api/admin/competition-save', { eventSlug: 'st-louis-stomp', title: 'Race', date: '2099-01-01', style: 'Two Step', level: 'Open',
    passes: [{ name: 'Open', price: 30, cap: 3 }] });
  const pt = (await new Client().req('GET', '/api/passes?event=st-louis-stomp')).json.competitions[0].passes[0].id;
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => buy(pt, `p${i}@x.com`, `P${i}`)));
  assert.equal(results.filter((x) => x.status === 200).length, 3);
  assert.equal(results.filter((x) => x.status === 409).length, 7);
});

test('stripe failure releases the reservation', async () => {
  S.stripe.failNext = true;
  const before = (await S.db.query(`SELECT count(*)::int n FROM orders WHERE status='pending'`)).rows[0].n;
  const r = await buy(followId, 'z@x.com', 'Z');
  S.stripe.failNext = false;
  assert.equal(r.status, 502);
  const after = (await S.db.query(`SELECT count(*)::int n FROM orders WHERE status='pending'`)).rows[0].n;
  assert.equal(after, before);
});

test('early bird ends at deadline', async () => {
  await S.db.query(`UPDATE pass_types SET early_until = now() - interval '1 hour' WHERE id = $1`, [followId]);
  await S.db.query(`UPDATE pass_types SET early_price_cents = 4000, early_until = now() - interval '1 hour' WHERE id = $1`, [followId]);
  await buy(followId, 'late@x.com', 'Late');
  const sess = [...S.stripe.sessions.values()].at(-1);
  assert.equal(sess.line_items[0].price_data.unit_amount, 6000);
});

test('edit event: cap cannot drop below sold; passes with orders cannot be removed; delete guarded', async () => {
  const cur = (await owner.req('GET', '/api/admin/competitions')).json.competitions.find((c) => c.id === compId);
  const lead = cur.passes.find((p) => p.role === 'lead');
  const follow = cur.passes.find((p) => p.role === 'follow');
  await S.db.query(`UPDATE orders SET status='paid', paid_at=now() WHERE id=(SELECT id FROM orders WHERE pass_type_id=$1 ORDER BY id LIMIT 1)`, [lead.id]);
  const payload = (over) => ({ id: compId, eventSlug: cur.eventSlug, title: cur.title, date: cur.date, location: cur.location, style: cur.style, level: cur.level, active: true, ...over });
  const L = (o = {}) => ({ id: lead.id, name: 'Lead', role: 'lead', price: 60, cap: 10, ...o });
  const F = (o = {}) => ({ id: follow.id, name: 'Follow', role: 'follow', price: 60, cap: 5, ...o });
  assert.equal((await owner.req('POST', '/api/admin/competition-save', payload({ passes: [L({ cap: 0 }), F()] }))).status, 409);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', payload({ passes: [F()] }))).status, 409, 'lead has orders');
  assert.equal((await owner.req('POST', '/api/admin/competition-save', payload({ title: 'Renamed', passes: [L({ price: 70 }), F({ name: 'Follow (new name)' }), { name: 'Spectator', price: 15 }] }))).status, 200);
  const after = (await owner.req('GET', '/api/admin/competitions')).json.competitions.find((c) => c.id === compId);
  assert.equal(after.passes.length, 3); assert.ok(after.passes.some((p) => p.name === 'Follow (new name)' && p.id === follow.id));
  assert.equal((await owner.req('POST', '/api/admin/competition-delete', { id: compId })).status, 409);
  // pass from another event cannot be hijacked
  const other = (await owner.req('POST', '/api/admin/competition-save', { eventSlug: '', title: 'Other', date: '2099-03-03', passes: [{ name: 'X', price: 10 }] })).json.id;
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { id: other, title: 'Other', date: '2099-03-03', passes: [{ id: lead.id, name: 'X', price: 10 }] })).status, 400);
  await owner.req('POST', '/api/admin/competition-delete', { id: other });
  // hide
  await owner.req('POST', '/api/admin/competition-save', payload({ active: false, passes: [L(), F(), { id: after.passes.find((p) => p.name === 'Spectator').id, name: 'Spectator', price: 15 }] }));
  assert.equal((await new Client().req('GET', '/api/passes?event=boots-on-the-coast')).json.competitions.length, 0);
  assert.equal((await buy(lead.id)).status, 404, 'hidden event cannot be bought');
  const e = await owner.req('POST', '/api/admin/competition-save', { eventSlug: 'tails-california', title: 'Tmp', date: '2099-02-02', passes: [{ name: 'Pass', price: 20 }] });
  assert.equal((await owner.req('POST', '/api/admin/competition-delete', { id: e.json.id })).status, 200);
});

test('buyers list, filter and CSV (formula-injection safe)', async () => {
  await S.db.query(`UPDATE orders SET buyer_name = '=HYPERLINK("x")' WHERE id = (SELECT min(id) FROM orders)`);
  const all = await owner.req('GET', '/api/admin/orders?status=all');
  assert.ok(all.json.orders.length >= 5);
  const paid = await owner.req('GET', '/api/admin/orders');
  assert.ok(paid.json.orders.every((o) => ['paid', 'refunded'].includes(o.status)));
  const csv = await owner.req('GET', '/api/admin/orders-csv?status=all');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.split('\n')[0].startsWith('Order,Status,Name,Email,Event,Event date,Location,Entry'));
  assert.ok(!/(^|,)=HYPERLINK/.test(csv.text) && csv.text.includes("'=HYPERLINK"));
  assert.equal((await new Client().req('GET', '/api/admin/orders-csv')).status, 401);
});

test('order-status endpoint', async () => {
  const { rows: [o] } = await S.db.query(`SELECT stripe_session_id sid FROM orders WHERE status='paid' AND stripe_session_id IS NOT NULL LIMIT 1`);
  const r = await new Client().req('GET', `/api/order-status?session_id=${o.sid}`);
  assert.equal(r.json.status, 'paid'); assert.equal(r.json.event, 'Boots on the Coast');
  assert.equal((await new Client().req('GET', '/api/order-status?session_id=x')).status, 400);
});

test('events: no GCC page needed; date/location; past events leave the site', async () => {
  const r = await owner.req('POST', '/api/admin/competition-save', { title: 'Standalone Social', date: '2099-07-04', endDate: '2099-07-06', location: 'Dallas, TX',
    passes: [{ name: 'General Admission', price: 25, cap: 5 }, { name: 'VIP', price: 60 }] });
  assert.equal(r.status, 200);
  const all = (await new Client().req('GET', '/api/passes')).json.competitions;
  const mine = all.find((c) => c.title === 'Standalone Social');
  assert.equal(mine.eventSlug, null); assert.equal(mine.date, '2099-07-04'); assert.equal(mine.endDate, '2099-07-06'); assert.equal(mine.location, 'Dallas, TX');
  assert.deepEqual(mine.passes.map((p) => p.name), ['General Admission', 'VIP']);
  assert.deepEqual(all.map((c) => c.date), [...all.map((c) => c.date)].sort(), 'sorted by date');
  assert.deepEqual((await new Client().req('GET', '/api/passes?event=none')).json.competitions.map((c) => c.title), ['Standalone Social']);
  for (const slug of ['boots-on-the-coast', 'st-louis-stomp']) {
    assert.ok(!(await new Client().req('GET', `/api/passes?event=${slug}`)).json.competitions.some((c) => c.title === 'Standalone Social'));
  }
  const b = await buy(mine.passes[0].id, 's@x.com', 'Solo');
  assert.equal(b.status, 200);
  const sess = [...S.stripe.sessions.values()].at(-1);
  assert.equal(sess.line_items[0].price_data.product_data.name, 'Standalone Social: General Admission');
  assert.match(sess.line_items[0].price_data.product_data.description, /Dallas, TX/);
  assert.ok(sess.cancel_url.endsWith('/passes.html'));
  const sid = [...S.stripe.sessions.keys()].at(-1);
  assert.equal(await pay(sid), 200);
  const st = (await new Client().req('GET', `/api/order-status?session_id=${sid}`)).json;
  assert.equal(st.status, 'paid'); assert.equal(st.passName, 'General Admission'); assert.equal(st.location, 'Dallas, TX'); assert.equal(st.event, null);
  const filtered = (await owner.req('GET', `/api/admin/orders?competition=${mine.id}`)).json.orders;
  assert.equal(filtered.length, 1); assert.equal(filtered[0].pass_name, 'General Admission');
  const csv = (await owner.req('GET', `/api/admin/orders-csv?competition=${mine.id}`)).text;
  assert.match(csv, /Standalone Social,2099-07-04,Dallas, TX|Standalone Social,2099-07-04,"Dallas, TX"/);
  // past events: hidden from the public site and cannot be bought
  const ptId = mine.passes[1].id;
  await S.db.query(`UPDATE competitions SET event_date = CURRENT_DATE - 5, end_date = CURRENT_DATE - 3 WHERE id = $1`, [mine.id]);
  assert.ok(!(await new Client().req('GET', '/api/passes')).json.competitions.some((c) => c.id === mine.id));
  assert.equal((await buy(ptId)).status, 410);
  const adminView = (await owner.req('GET', '/api/admin/competitions')).json.competitions.find((c) => c.id === mine.id);
  assert.equal(adminView.past, true);
});

test('migration: databases from earlier versions are upgraded', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { SCHEMA } = await import('../lib/db.js');
  const old = new PGlite();
  await old.exec(`CREATE TABLE admins (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE competitions (id SERIAL PRIMARY KEY, event_slug TEXT NOT NULL, title TEXT NOT NULL, style TEXT NOT NULL, level TEXT NOT NULL, description TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE pass_types (id SERIAL PRIMARY KEY, competition_id INT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('lead','follow','any')), cap INT, price_cents INT NOT NULL, early_price_cents INT, early_until TIMESTAMPTZ, UNIQUE (competition_id, role));
    INSERT INTO competitions (event_slug,title,style,level) VALUES ('st-louis-stomp','Old comp','J&J','Novice');
    INSERT INTO pass_types (competition_id, role, price_cents) VALUES (1,'lead',5000),(1,'follow',5000);`);
  await old.exec(SCHEMA);
  await old.exec(SCHEMA); // idempotent second run
  const pts = (await old.query('SELECT name, role FROM pass_types ORDER BY id')).rows;
  assert.deepEqual(pts, [{ name: 'Lead', role: 'lead' }, { name: 'Follow', role: 'follow' }]);
  await old.exec(`INSERT INTO competitions (event_slug,title,style,level,event_date) VALUES (NULL,'New',NULL,NULL,'2099-01-01'); INSERT INTO pass_types (competition_id,name,role,price_cents) VALUES (2,'GA',NULL,2500),(2,'GA2',NULL,2500);`);
  assert.equal((await old.query('SELECT count(*)::int n FROM pass_types')).rows[0].n, 4);
});

test('redemption form: validates, stores, admin lists and marks handled, CSV safe', async () => {
  const anon = new Client();
  const ok = { name: 'Dana Dancer', email: 'Dana@Example.com', wonAt: 'Instagram giveaway', event: 'boots-on-the-coast', ticketType: 'full_weekend' };
  assert.equal((await anon.req('POST', '/api/redeem', { ...ok, name: '' })).status, 400);
  assert.equal((await anon.req('POST', '/api/redeem', { ...ok, email: 'nope' })).status, 400);
  assert.equal((await anon.req('POST', '/api/redeem', { ...ok, wonAt: '' })).status, 400);
  assert.equal((await anon.req('POST', '/api/redeem', { ...ok, event: 'other' })).status, 400);
  assert.equal((await anon.req('POST', '/api/redeem', { ...ok, ticketType: 'vip' })).status, 400);
    assert.equal((await anon.req('POST', '/api/redeem', { ...ok, website: 'http://spam' })).status, 200); // honeypot: pretend success, store nothing
  assert.equal((await anon.req('GET', '/api/redeem')).status, 405);
  assert.equal((await anon.req('GET', '/api/admin/redemptions')).status, 401);
  assert.equal((await anon.req('POST', '/api/redeem', ok)).status, 200);
  assert.equal((await anon.req('POST', '/api/redeem', { ...ok, email: 'nocomp@example.com', ticketType: 'competition_pass' })).status, 200); // competition is optional
  assert.equal((await anon.req('POST', '/api/redeem', { ...ok, email: 'cj@example.com', name: '=HYPERLINK("x")', event: 'tails-california', ticketType: 'competition_pass', competition: 'Novice J&J' })).status, 200);
  let r = await owner.req('GET', '/api/admin/redemptions?status=new');
  assert.equal(r.json.redemptions.length, 3);
  const first = r.json.redemptions.find((x) => x.email === 'dana@example.com');
  assert.equal(first.competition, null);
  assert.equal(r.json.redemptions.find((x) => x.email === 'cj@example.com').competition, 'Novice J&J');
  assert.equal((await owner.req('POST', '/api/admin/redemption-update', { id: first.id, status: 'done' })).status, 200);
  assert.equal((await owner.req('GET', '/api/admin/redemptions?status=new')).json.redemptions.length, 2);
  assert.equal((await owner.req('GET', '/api/admin/redemptions?status=done')).json.redemptions.length, 1);
  const csv = await owner.req('GET', '/api/admin/redemptions-csv?status=all');
  assert.ok(csv.text.startsWith('ID,Submitted,Status,Name,Email,Event,Ticket,Competition,Won at'));
  assert.ok(csv.text.includes("'=HYPERLINK"));
});

test('listings: post, apply, accept/decline, close, expiry, admin remove, privacy', async () => {
  const mail = [];
  setMailer(async (m) => { mail.push(m); });
  const anon = new Client();
  const post = (o) => anon.req('POST', '/api/listings', { action: 'create', ...o });
  const room = { kind: 'roommate', event: 'boots-on-the-coast', name: 'Riley', email: 'Riley@Example.com', nights: 'Thu-Sun', genderPref: 'Women', notes: 'Early riser' };
  assert.equal((await post({ ...room, kind: 'x' })).status, 400);
  assert.equal((await post({ ...room, event: 'nope' })).status, 400);
  assert.equal((await post({ ...room, email: 'bad' })).status, 400);
  assert.equal((await post({ ...room, instagram: 'https://evil.example/x' })).status, 400);
  assert.equal((await post({ ...room, website: 'spam' })).json.honeypot, true);
  let r = await post(room);
  assert.equal(r.status, 200);
  const id = r.json.id; const manage = new URL(r.json.manageUrl);
  const token = manage.searchParams.get('token');
  assert.ok(mail.find((m) => m.to === 'riley@example.com' && m.text.includes('listing-manage.html')), 'poster gets private link');

  // public list never leaks email or token
  const pub = await anon.req('GET', '/api/listings');
  assert.equal(pub.json.listings.length, 1);
  assert.ok(!/riley@example|token/i.test(pub.text));
  assert.equal(pub.json.listings[0].event, 'Boots on the Coast');

  // applying
  const apply = (o) => anon.req('POST', '/api/listings', { action: 'apply', listingId: id, ...o });
  assert.equal((await apply({ name: 'Me', email: 'riley@example.com' })).status, 400, 'cannot apply to own listing');
  assert.equal((await apply({ name: 'A', email: 'a@example.com' })).status, 400);
  assert.equal((await apply({ name: 'Alex', email: 'alex@example.com', message: 'Hi!' })).status, 200);
  assert.equal((await apply({ name: 'Alex', email: 'alex@example.com' })).status, 409, 'duplicate request');
  assert.equal((await apply({ name: 'Sam', email: 'sam@example.com' })).status, 200);
  assert.equal((await apply({ name: 'Jo', email: 'jo@example.com' })).status, 200);
  assert.ok(mail.find((m) => m.to === 'riley@example.com' && /Alex wants to connect/.test(m.subject)), 'poster notified of request');
  assert.equal((await anon.req('POST', '/api/listings', { action: 'apply', listingId: 9999, name: 'Zed', email: 'z@example.com' })).status, 404);

  // manage: token required, applicant emails hidden until accepted
  const mg = (t) => anon.req('GET', `/api/listing-manage?id=${id}&token=${t}`);
  assert.equal((await mg('wrong')).status, 403);
  let m = await mg(token);
  assert.equal(m.status, 200);
  assert.equal(m.json.requests.length, 3);
  assert.ok(m.json.requests.every((q) => q.email === undefined));
  const alex = m.json.requests.find((q) => q.name === 'Alex'), sam = m.json.requests.find((q) => q.name === 'Sam'), jo = m.json.requests.find((q) => q.name === 'Jo');
  const act = (body) => anon.req('POST', '/api/listing-manage', { id, token, ...body });
  assert.equal((await anon.req('POST', '/api/listing-manage', { id, token: 'bad', action: 'close' })).status, 403);

  // decline emails the applicant, no contact info leaked
  assert.equal((await act({ action: 'decline', requestId: sam.id })).status, 200);
  const decl = mail.find((x) => x.to === 'sam@example.com');
  assert.ok(decl && !decl.text.includes('riley@example.com'));
  assert.equal((await act({ action: 'decline', requestId: sam.id })).status, 409);

  // accept: exchanges contact, closes listing, tells the other pending applicant
  r = await act({ action: 'accept', requestId: alex.id });
  assert.equal(r.status, 200); assert.equal(r.json.email, 'alex@example.com');
  assert.ok(mail.find((x) => x.to === 'alex@example.com' && x.text.includes('riley@example.com')));
  assert.ok(mail.find((x) => x.to === 'riley@example.com' && x.text.includes('alex@example.com')));
  assert.ok(mail.find((x) => x.to === 'jo@example.com' && /filled/.test(x.text)), 'other pending applicants told it was filled');
  assert.equal((await anon.req('GET', '/api/listings')).json.listings.length, 0, 'accepted listing leaves the site');
  assert.equal((await act({ action: 'accept', requestId: jo.id })).status, 409, 'jo was auto-declined');
  m = await mg(token);
  assert.equal(m.json.listing.status, 'filled');
  assert.equal(m.json.requests.find((q) => q.name === 'Alex').email, 'alex@example.com');
  assert.equal((await apply({ name: 'Late', email: 'late@example.com' })).status, 404, 'closed listings take no requests');

  // keepOpen, close, expiry, admin remove
  const mk = async (name) => (await post({ ...room, name, email: `${name.toLowerCase()}@example.com` })).json;
  const k = await mk('Keep');
  await anon.req('POST', '/api/listings', { action: 'apply', listingId: k.id, name: 'Pat', email: 'pat@example.com' });
  const kt = new URL(k.manageUrl).searchParams.get('token');
  const kreq = (await anon.req('GET', `/api/listing-manage?id=${k.id}&token=${kt}`)).json.requests[0];
  await anon.req('POST', '/api/listing-manage', { id: k.id, token: kt, action: 'accept', requestId: kreq.id, keepOpen: true });
  assert.ok((await anon.req('GET', '/api/listings')).json.listings.some((x) => x.id === k.id), 'keepOpen leaves it up');
  assert.equal((await anon.req('POST', '/api/listing-manage', { id: k.id, token: kt, action: 'close' })).status, 200);
  assert.ok(!(await anon.req('GET', '/api/listings')).json.listings.some((x) => x.id === k.id), 'close removes it');

  const e = await mk('Old');
  const { query } = await import('../lib/db.js');
  await query(`UPDATE listings SET expires_at = now() - interval '1 day' WHERE id = $1`, [e.id]);
  assert.ok(!(await anon.req('GET', '/api/listings')).json.listings.some((x) => x.id === e.id), 'expired listings disappear');

  const a = await mk('Admin');
  assert.equal((await anon.req('GET', '/api/admin/listings')).status, 401);
  assert.equal((await owner.req('GET', '/api/admin/listings')).json.listings.some((x) => x.id === a.id), true);
  assert.equal((await owner.req('POST', '/api/admin/listing-remove', { id: a.id })).status, 200);
  assert.ok(!(await anon.req('GET', '/api/listings')).json.listings.some((x) => x.id === a.id));
  setMailer(null);
});

test('emails: branded HTML escapes user input and keeps a plain-text copy', async () => {
  const { renderEmail } = await import('../lib/email.js');
  const e = renderEmail({ heading: 'Hi <script>', intro: ['x'], quote: '<img src=x onerror=alert(1)>', details: [['Name', '"><b>Z</b>']], button: { label: 'Go', url: 'https://example.com/?a=1&b=2' } });
  assert.ok(!e.html.includes('<script>') && !e.html.includes('<img src=x') && !e.html.includes('<b>Z</b>'));
  assert.ok(e.html.includes('&lt;script&gt;') && e.html.includes('a=1&amp;b=2'));
  assert.ok(e.text.includes('Go: https://example.com/?a=1&b=2'));
});

test('logout clears session', async () => {
  const c = new Client();
  await c.req('POST', '/api/admin/login', { email: 'cj@x.com', password: PW });
  assert.equal((await c.req('POST', '/api/admin/logout', {})).status, 200);
});

test('bundles: availability, checkout, caps, webhook, admin tab', async () => {
  const anon = new Client();
  const list = await anon.req('GET', '/api/checkout');
  assert.deepEqual(list.json.bundles.map((b) => [b.slug, b.priceCents, b.cap]), [['bronze', 59900, 20], ['silver', 69900, 15], ['gold', 84900, 10]]);
  assert.equal((await anon.req('POST', '/api/checkout', { bundle: 'platinum', name: 'A', email: 'a@x.com' })).status, 404);
  assert.equal((await anon.req('POST', '/api/checkout', { bundle: 'gold', name: '', email: 'a@x.com' })).status, 400);
  assert.equal((await anon.req('POST', '/api/checkout', { bundle: 'gold', name: 'A', email: 'nope' })).status, 400);
  const sent = []; setMailer(async (m) => { sent.push(m); });
  // price is server-side: client-sent amount is ignored
  const r = await anon.req('POST', '/api/checkout', { bundle: 'gold', name: 'Gina Gold', email: 'gina@x.com', amount: 1 });
  assert.equal(r.status, 200);
  const sess = [...S.stripe.sessions.values()].at(-1);
  assert.equal(sess.line_items[0].price_data.unit_amount, 84900);
  const { rows: [o] } = await S.db.query(`SELECT id, stripe_session_id sid FROM bundle_orders ORDER BY id DESC LIMIT 1`);
  assert.equal((await anon.req('GET', '/api/order-status?session_id=' + o.sid)).json.status, 'pending');
  assert.equal(await pay(o.sid), 200);
  const st = await anon.req('GET', '/api/order-status?session_id=' + o.sid);
  assert.equal(st.json.status, 'paid'); assert.match(st.json.bundle, /Gold/);
  assert.ok(sent.some((m) => m.to === 'gina@x.com'), 'buyer confirmation email');
  assert.ok(sent.some((m) => m.to === 'dance@goldcoastcowboys.com'), 'team email');
  // cap of 10 for gold: 1 paid, fill the rest with pending holds
  for (let i = 0; i < 9; i++) assert.equal((await anon.req('POST', '/api/checkout', { bundle: 'gold', name: 'G' + i, email: `g${i}@x.com` })).status, 200);
  assert.equal((await anon.req('POST', '/api/checkout', { bundle: 'gold', name: 'Late', email: 'late@x.com' })).status, 409);
  assert.equal((await anon.req('GET', '/api/checkout')).json.bundles.find((b) => b.slug === 'gold').soldOut, true);
  // admin tab
  assert.equal((await new Client().req('GET', '/api/admin/bundles')).status, 401);
  const a = await owner.req('GET', '/api/admin/bundles');
  assert.equal(a.status, 200);
  assert.equal(a.json.orders.length, 1); assert.equal(a.json.orders[0].email, 'gina@x.com');
  assert.equal(a.json.bundles.find((b) => b.slug === 'gold').remaining, 0);
  assert.match((await owner.req('GET', '/api/admin/bundles-csv')).text, /gina@x.com/);
  // refund frees the spot
  assert.equal(await pay(o.sid, 'charge.refunded'), 200);
  assert.equal((await S.db.query('SELECT status FROM bundle_orders WHERE id=$1', [o.id])).rows[0].status, 'refunded');
  assert.equal((await anon.req('POST', '/api/checkout', { bundle: 'gold', name: 'Late', email: 'late@x.com' })).status, 200);
  setMailer(null);
});

test('bundles: monthly payment plan (down payment, 7 payments, auto-stop, failures, release)', async () => {
  const { default: Stripe } = await import('stripe');
  const hook = async (type, object) => {
    const payload = JSON.stringify({ id: 'evt_' + Math.random(), type, data: { object } });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    return (await fetch(`${S.base}/api/webhook`, { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload })).status;
  };
  const anon = new Client();
  const sent = []; setMailer(async (m) => { sent.push(m); });
  const pub = (await anon.req('GET', '/api/checkout')).json.bundles;
  assert.deepEqual(pub.map((b) => [b.slug, b.plan.downCents, b.plan.monthlyCents, b.plan.months, b.plan.totalCents]),
    [['bronze', 4900, 8200, 7, 62300], ['silver', 10400, 8900, 7, 72700], ['gold', 14800, 10500, 7, 88300]]);
  // plan totals are the full price + 4%
  for (const b of pub) assert.ok(Math.abs(b.plan.totalCents - b.priceCents * 1.04) < 100, b.slug);

  const r = await anon.req('POST', '/api/checkout', { bundle: 'bronze', plan: 'monthly', name: 'Molly Monthly', email: 'molly@x.com' });
  assert.equal(r.status, 200);
  const sess = [...S.stripe.sessions.entries()].at(-1);
  const p = sess[1];
  assert.equal(p.mode, 'subscription'); assert.equal(p.subscription_data.trial_period_days, 30);
  assert.deepEqual(p.line_items.map((l) => [l.price_data.unit_amount, !!l.price_data.recurring]), [[8200, true], [4900, false]]);
  const { rows: [o] } = await S.db.query(`SELECT * FROM bundle_orders WHERE stripe_session_id = $1`, [sess[0]]);
  assert.equal(o.plan, 'monthly'); assert.equal(o.amount_cents, 4900); assert.equal(o.plan_total_cents, 62300);

  // down payment succeeds
  assert.equal(await hook('checkout.session.completed', { id: sess[0], payment_status: 'paid', subscription: 'sub_m1', payment_intent: null }), 200);
  assert.equal((await S.db.query('SELECT status, plan_status, stripe_subscription_id FROM bundle_orders WHERE id=$1', [o.id])).rows[0].plan_status, 'active');
  assert.ok(sent.some((m) => m.to === 'molly@x.com' && /7 monthly payments of \$82/.test(m.text)), 'buyer gets the schedule');
  const down = { id: 'in_0', billing_reason: 'subscription_create', amount_paid: 4900, parent: { subscription_details: { subscription: 'sub_m1' } } };
  assert.equal(await hook('invoice.paid', down), 200);
  assert.equal((await S.db.query(`SELECT count(*)::int n FROM bundle_payments WHERE kind='monthly'`)).rows[0].n, 0, 'down payment is not a monthly payment');
  // 7 monthly payments (one redelivered): stops only after the 7th
  for (let i = 1; i <= 7; i++) {
    const inv = { id: 'in_' + i, billing_reason: 'subscription_cycle', amount_paid: 8200, parent: { subscription_details: { subscription: 'sub_m1' } } };
    assert.equal(await hook('invoice.paid', inv), 200);
    if (i === 3) assert.equal(await hook('invoice.paid', inv), 200);
    const st = (await S.db.query('SELECT plan_status FROM bundle_orders WHERE id=$1', [o.id])).rows[0].plan_status;
    assert.equal(st, i < 7 ? 'active' : 'completed', 'after payment ' + i);
    assert.equal(S.stripe.canceled.length, i < 7 ? 0 : 1);
  }
  assert.deepEqual(S.stripe.canceled, ['sub_m1']);
  assert.ok(sent.some((m) => m.to === 'molly@x.com' && /paid off/.test(m.subject)));
  assert.equal(await hook('customer.subscription.deleted', { id: 'sub_m1' }), 200);
  assert.equal((await S.db.query('SELECT plan_status FROM bundle_orders WHERE id=$1', [o.id])).rows[0].plan_status, 'completed', 'our own cancel does not raise an alert');

  // failure path
  sent.length = 0;
  await anon.req('POST', '/api/checkout', { bundle: 'silver', plan: 'monthly', name: 'Fay Failed', email: 'fay@x.com' });
  const s2 = [...S.stripe.sessions.keys()].at(-1);
  await hook('checkout.session.completed', { id: s2, payment_status: 'paid', subscription: 'sub_f1' });
  const failInv = { id: 'in_f1', billing_reason: 'subscription_cycle', attempt_count: 2, amount_due: 8900, hosted_invoice_url: 'https://invoice.stripe.com/i/x', subscription: 'sub_f1' };
  assert.equal(await hook('invoice.payment_failed', failInv), 200);
  const fo = (await S.db.query(`SELECT id, plan_status FROM bundle_orders WHERE stripe_subscription_id='sub_f1'`)).rows[0];
  assert.equal(fo.plan_status, 'past_due');
  assert.ok(sent.some((m) => m.to === 'dance@goldcoastcowboys.com' && /PAYMENT FAILED/.test(m.subject)), 'Brian is alerted');
  assert.ok(sent.some((m) => m.to === 'fay@x.com' && /invoice\.stripe\.com/.test(m.html)), 'buyer gets a pay-now link');
  // a later successful retry clears past_due
  await hook('invoice.paid', { ...failInv, id: 'in_f2', amount_paid: 8900 });
  assert.equal((await S.db.query('SELECT plan_status FROM bundle_orders WHERE id=$1', [fo.id])).rows[0].plan_status, 'active');
  // retries exhausted: subscription canceled by Stripe -> alert + releasable
  sent.length = 0;
  await hook('invoice.payment_failed', { ...failInv, id: 'in_f3' });
  assert.equal(await hook('customer.subscription.deleted', { id: 'sub_f1' }), 200);
  assert.ok(sent.some((m) => /PLAN CANCELED/.test(m.subject)));
  const spots = async () => (await anon.req('GET', '/api/checkout')).json.bundles.find((b) => b.slug === 'silver').remaining;
  const before = await spots();
  assert.equal((await new Client().req('POST', '/api/admin/bundle-release', { id: fo.id })).status, 401);
  assert.equal((await owner.req('POST', '/api/admin/bundle-release', { id: fo.id })).status, 200);
  assert.equal(await spots(), before + 1, 'spot freed');
  assert.equal((await owner.req('POST', '/api/admin/bundle-release', { id: fo.id })).status, 409);
  // admin tab + csv show plan progress
  const a = await owner.req('GET', '/api/admin/bundles?status=all');
  const molly = a.json.orders.find((x) => x.email === 'molly@x.com');
  assert.equal(molly.monthly_paid, 7); assert.equal(molly.plan_paid_cents, 4900 + 7 * 8200);
  assert.match((await owner.req('GET', '/api/admin/bundles-csv?status=all')).text, /7 of 7/);
  // order-status shows the plan
  const st = await anon.req('GET', '/api/order-status?session_id=' + sess[0]);
  assert.equal(st.json.plan.months, 7);
  // monthly not offered for an unknown bundle; client can't pick amounts
  assert.equal((await anon.req('POST', '/api/checkout', { bundle: 'nope', plan: 'monthly', name: 'A', email: 'a@x.com' })).status, 404);
  setMailer(null);
});
