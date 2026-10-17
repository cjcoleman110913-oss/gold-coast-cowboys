import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.js';

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
  const base = { eventSlug: 'boots-on-the-coast', title: 'Novice Jack & Jill', style: 'Jack & Jill', level: 'Novice',
    passes: [{ role: 'lead', price: 60, cap: 2, earlyPrice: 45, earlyUntil: future(10) }, { role: 'follow', price: 60, cap: 3 }] };
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, eventSlug: 'nope' })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, title: '' })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [] })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ role: 'lead', price: 0.1 }] })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ role: 'lead', price: 50, earlyPrice: 60, earlyUntil: future(1) }] })).status, 400);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ role: 'lead', price: 50, earlyPrice: 40 }] })).status, 400, 'deadline required');
  assert.equal((await owner.req('POST', '/api/admin/competition-save', { ...base, passes: [{ role: 'any', price: 50 }, { role: 'lead', price: 50 }] })).status, 400);
  const r = await owner.req('POST', '/api/admin/competition-save', base);
  assert.equal(r.status, 200);
  compId = r.json.id;
  const pub = await new Client().req('GET', '/api/passes?event=boots-on-the-coast');
  assert.equal(pub.json.competitions.length, 1);
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
  const r = await owner.req('POST', '/api/admin/competition-save', { eventSlug: 'st-louis-stomp', title: 'Race', style: 'Two Step', level: 'Open',
    passes: [{ role: 'any', price: 30, cap: 3 }] });
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

test('edit competition: cap cannot drop below sold; passes with orders cannot be removed; delete guarded', async () => {
  const cur = (await owner.req('GET', '/api/admin/competitions')).json.competitions.find((c) => c.id === compId);
  const lead = cur.passes.find((p) => p.role === 'lead');
  await S.db.query(`UPDATE orders SET status='paid', paid_at=now() WHERE id=(SELECT id FROM orders WHERE pass_type_id=$1 ORDER BY id LIMIT 1)`, [lead.id]);
  const payload = (over) => ({ id: compId, eventSlug: cur.eventSlug, title: cur.title, style: cur.style, level: cur.level, active: true, ...over });
  assert.equal((await owner.req('POST', '/api/admin/competition-save', payload({ passes: [{ role: 'lead', price: 60, cap: 0 }, { role: 'follow', price: 60, cap: 5 }] }))).status, 409);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', payload({ passes: [{ role: 'follow', price: 60, cap: 5 }] }))).status, 409);
  assert.equal((await owner.req('POST', '/api/admin/competition-save', payload({ title: 'Renamed', passes: [{ role: 'lead', price: 70, cap: 10 }, { role: 'follow', price: 60, cap: 5 }] }))).status, 200);
  assert.equal((await owner.req('POST', '/api/admin/competition-delete', { id: compId })).status, 409);
  // hide
  await owner.req('POST', '/api/admin/competition-save', payload({ active: false, passes: [{ role: 'lead', price: 70, cap: 10 }, { role: 'follow', price: 60, cap: 5 }] }));
  assert.equal((await new Client().req('GET', '/api/passes?event=boots-on-the-coast')).json.competitions.length, 0);
  assert.equal((await buy(lead.id)).status, 404, 'hidden competition cannot be bought');
  // empty competition can be deleted
  const e = await owner.req('POST', '/api/admin/competition-save', { eventSlug: 'tails-california', title: 'Tmp', style: 'S', level: 'L', passes: [{ role: 'any', price: 20 }] });
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
  assert.ok(csv.text.split('\n')[0].startsWith('Order,Status,Name,Email'));
  assert.ok(!/(^|,)=HYPERLINK/.test(csv.text) && csv.text.includes("'=HYPERLINK"));
  assert.equal((await new Client().req('GET', '/api/admin/orders-csv')).status, 401);
});

test('order-status endpoint', async () => {
  const { rows: [o] } = await S.db.query(`SELECT stripe_session_id sid FROM orders WHERE status='paid' AND stripe_session_id IS NOT NULL LIMIT 1`);
  const r = await new Client().req('GET', `/api/order-status?session_id=${o.sid}`);
  assert.equal(r.json.status, 'paid'); assert.equal(r.json.event, 'Boots on the Coast');
  assert.equal((await new Client().req('GET', '/api/order-status?session_id=x')).status, 400);
});

test('logout clears session', async () => {
  const c = new Client();
  await c.req('POST', '/api/admin/login', { email: 'cj@x.com', password: PW });
  assert.equal((await c.req('POST', '/api/admin/logout', {})).status, 200);
});

test('competitions without an event: create, list, buy, export', async () => {
  const r = await owner.req('POST', '/api/admin/competition-save', { eventSlug: '', title: 'Standalone Strictly', style: 'Strictly', level: 'Open',
    passes: [{ role: 'any', price: 25, cap: 5 }] });
  assert.equal(r.status, 200);
  const all = (await new Client().req('GET', '/api/passes')).json.competitions;
  const mine = all.find((c) => c.title === 'Standalone Strictly');
  assert.ok(mine && mine.eventSlug === null, 'shows on the all-competitions list');
  assert.ok(all.some((c) => c.eventSlug), 'event competitions are listed there too');
  assert.equal(all.at(-1).title, 'Standalone Strictly', 'standalone ones are listed last');
  const none = (await new Client().req('GET', '/api/passes?event=none')).json.competitions;
  assert.deepEqual(none.map((c) => c.title), ['Standalone Strictly']);
  for (const slug of ['boots-on-the-coast', 'st-louis-stomp', 'tails-california']) {
    const l = (await new Client().req('GET', `/api/passes?event=${slug}`)).json.competitions;
    assert.ok(!l.some((c) => c.title === 'Standalone Strictly'));
  }
  const b = await buy(mine.passes[0].id, 's@x.com', 'Solo');
  assert.equal(b.status, 200);
  const sess = [...S.stripe.sessions.values()].at(-1);
  assert.equal(sess.line_items[0].price_data.product_data.name, 'Standalone Strictly (Open)');
  assert.ok(sess.cancel_url.endsWith('/passes.html'));
  const sid = [...S.stripe.sessions.keys()].at(-1);
  assert.equal(await pay(sid), 200);
  const st = await new Client().req('GET', `/api/order-status?session_id=${sid}`);
  assert.equal(st.json.status, 'paid'); assert.equal(st.json.event, null);
  const filtered = (await owner.req('GET', '/api/admin/orders?event=none')).json.orders;
  assert.equal(filtered.length, 1);
  assert.match((await owner.req('GET', '/api/admin/orders-csv?event=none')).text, /No specific event/);
  // can switch an existing competition to/from an event
  const up = await owner.req('POST', '/api/admin/competition-save', { id: mine.id, eventSlug: 'tails-california', title: mine.title, style: 'Strictly', level: 'Open', active: true,
    passes: [{ role: 'any', price: 25, cap: 5 }] });
  assert.equal(up.status, 200);
  assert.equal((await new Client().req('GET', '/api/passes?event=tails-california')).json.competitions.length, 1);
});

test('migration: existing database with NOT NULL event_slug is upgraded', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { SCHEMA } = await import('../lib/db.js');
  const old = new PGlite();
  await old.exec(`CREATE TABLE admins (id SERIAL PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE competitions (id SERIAL PRIMARY KEY, event_slug TEXT NOT NULL, title TEXT NOT NULL, style TEXT NOT NULL, level TEXT NOT NULL, description TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, created_by INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  await old.exec(SCHEMA);
  await old.exec(`INSERT INTO competitions (event_slug,title,style,level) VALUES (NULL,'x','y','z')`);
  await old.exec(SCHEMA); // idempotent second run
  assert.equal((await old.query('SELECT count(*)::int n FROM competitions')).rows[0].n, 1);
});
