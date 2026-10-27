// Test/dev harness: in-memory Postgres (PGlite), fake Stripe, and a tiny Vercel-like HTTP server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import Stripe from 'stripe';
import { setDb, migrate } from '../lib/db.js';
import { setStripe } from '../lib/stripe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function fakeStripe() {
  const sessions = new Map();
  let n = 0;
  return {
    sessions,
    canceled: [],
    subscriptions: { cancel: async (id) => { /* set below */ } },
    failNext: false,
    checkout: { sessions: { async create(params) {
      if (this.failNext) throw new Error('stripe down');
      const id = `cs_test_${++n}`;
      sessions.set(id, params);
      return { id, url: `${params.success_url.split('/pass-success')[0]}/fake-checkout.html?session_id=${id}` };
    } } }
  };
}

export async function startServer({ port = 0 } = {}) {
  process.env.SESSION_SECRET ||= 'test-secret-test-secret-test-secret';
  process.env.ADMIN_SETUP_KEY ||= 'setup-key-123';
  process.env.STRIPE_SECRET_KEY ||= 'sk_test_123';
  process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_test_secret';
  process.env.INSECURE_COOKIES = '1';
  const db = new PGlite();
  setDb(db);
  await migrate();
  const stripe = fakeStripe();
  // `failNext` lives on the object; bind create so `this` works.
  stripe.checkout.sessions.create = stripe.checkout.sessions.create.bind(stripe);
  stripe.subscriptions.cancel = async (id) => { stripe.canceled.push(id); return { id }; };
  stripe.created = [];
  stripe.paymentIntents = { retrieve: async (id) => ({ id, payment_method: 'pm_test_1' }) };
  stripe.products = { create: async () => ({ id: 'prod_test_1' }) };
  stripe.subscriptions.create = async (params) => { const id = stripe.nextSub || `sub_auto_${stripe.created.length + 1}`; stripe.nextSub = null; stripe.created.push(params); return { id }; };
  setStripe(stripe);

  const routes = {
    '/api/passes': (await import('../api/passes.js')).default,
    '/api/checkout': (await import('../api/checkout.js')).default,
    '/api/webhook': (await import('../api/webhook.js')).default,
    '/api/order-status': (await import('../api/order-status.js')).default,
    '/api/redeem': (await import('../api/redeem.js')).default,
    '/api/listings': (await import('../api/listings.js')).default,
    '/api/listing-manage': (await import('../api/listing-manage.js')).default
  };
  const adminHandler = (await import('../api/admin/[action].js')).default;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      if (u.pathname.startsWith('/api/admin/')) {
        req.query = { action: u.pathname.split('/').pop() };
        if (req.method === 'POST' && (req.headers['content-type'] || '').includes('json')) {
          const chunks = []; for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks).toString();
          req.body = raw ? JSON.parse(raw) : {};
        }
        return await adminHandler(req, res);
      }
      if (routes[u.pathname]) {
        if (u.pathname === '/api/checkout' && req.method === 'POST') {
          const chunks = []; for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks).toString();
          try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
        }
        return await routes[u.pathname](req, res);
      }
      if (u.pathname === '/__dev/pay' && req.method === 'POST') {
        // Simulate Stripe calling our webhook for a session (signed with the real library).
        const sid = u.searchParams.get('session_id');
        const type = u.searchParams.get('type') || 'checkout.session.completed';
        const payload = JSON.stringify(webhookEvent(type, sid));
        const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
        const r = await fetch(`http://localhost:${server.address().port}/api/webhook`, { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload });
        res.statusCode = r.status; return res.end(await r.text());
      }
      if (u.pathname === '/fake-checkout.html') {
        res.setHeader('Content-Type', 'text/html');
        return res.end(`<title>Fake Stripe</title><h1>Fake Stripe Checkout</h1><button id="pay">Pay</button><button id="abandon">Abandon</button>
<script>const sid=new URLSearchParams(location.search).get('session_id');
pay.onclick=async()=>{await fetch('/__dev/pay?session_id='+sid,{method:'POST'});location.href='/pass-success.html?session_id='+sid};
abandon.onclick=()=>{history.back()}</script>`);
      }
      // static
      let p = decodeURIComponent(u.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch (e) { console.error(e); res.statusCode = 500; res.end('err'); }
  });
  await new Promise((r) => server.listen(port, r));
  return { server, db, stripe, base: `http://localhost:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export function webhookEvent(type, sid, extra = {}) {
  if (type === 'charge.refunded') return { id: 'evt_1', type, data: { object: { id: 'ch_1', refunded: true, payment_intent: extra.pi || `pi_${sid}` } } };
  return { id: 'evt_1', type, data: { object: { id: sid, payment_status: 'paid', payment_intent: `pi_${sid}` } } };
}

if (process.argv[1] && process.argv[1].endsWith('harness.js')) {
  const s = await startServer({ port: 3000 });
  console.log('Dev server on', s.base);
}
