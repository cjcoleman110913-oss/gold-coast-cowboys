import crypto from 'node:crypto';
import { query } from './db.js';
import { HttpError } from './http.js';

const COOKIE = 'gcc_admin';
const SESSION_HOURS = 12;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 24) throw new Error('SESSION_SECRET must be set (24+ chars)');
  return s;
}

// ---- passwords (scrypt) ----
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Password must be at least 10 characters.');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long.');
}

// ---- tokens ----
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

// ---- signed session cookie ----
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function unsign(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function startSession(res, adminId) {
  const csrf = crypto.randomBytes(16).toString('hex');
  const token = sign({ id: adminId, csrf, exp: Date.now() + SESSION_HOURS * 3600e3 });
  const secure = process.env.INSECURE_COOKIES === '1' ? '' : '; Secure';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  return csrf;
}
export function endSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// Returns { admin, csrf } or throws 401. Mutating requests must carry the CSRF header.
export async function requireAdmin(req) {
  const p = unsign(parseCookies(req)[COOKIE]);
  if (!p) throw new HttpError(401, 'Please log in.');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const sent = req.headers['x-csrf-token'];
    if (!sent || sent !== p.csrf) throw new HttpError(403, 'Session check failed. Reload the page and try again.');
  }
  const { rows } = await query('SELECT id, email, name FROM admins WHERE id = $1', [p.id]);
  if (!rows[0]) throw new HttpError(401, 'Please log in.');
  return { admin: rows[0], csrf: p.csrf };
}

// ---- login lockout: 5 failures -> 15 minute lock ----
const MAX_FAILS = 5, LOCK_MIN = 15;
export async function assertNotLocked(email) {
  const { rows } = await query('SELECT fails, locked_until FROM login_attempts WHERE email = $1', [email]);
  if (rows[0]?.locked_until && new Date(rows[0].locked_until) > new Date()) {
    throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }
}
export async function recordFailure(email) {
  await query(
    `INSERT INTO login_attempts (email, fails) VALUES ($1, 1)
     ON CONFLICT (email) DO UPDATE SET
       fails = CASE WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now() THEN 1 ELSE login_attempts.fails + 1 END,
       locked_until = CASE
         WHEN (CASE WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now() THEN 1 ELSE login_attempts.fails + 1 END) >= ${MAX_FAILS}
         THEN now() + interval '${LOCK_MIN} minutes' ELSE NULL END`,
    [email]
  );
}
export async function clearFailures(email) {
  await query('DELETE FROM login_attempts WHERE email = $1', [email]);
}
