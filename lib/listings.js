import crypto from 'node:crypto';

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 24) throw new Error('SESSION_SECRET must be set (24+ chars)');
  return s;
}

// The private "manage" link for a listing is an HMAC of its id, so nothing secret is stored
// and the link can be re-sent in any later email.
export const manageToken = (id) =>
  crypto.createHmac('sha256', secret()).update(`listing-manage:${id}`).digest('base64url');

export function tokenOk(id, token) {
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(manageToken(id));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const manageLink = (base, id) => `${base}/listing-manage.html?id=${id}&token=${manageToken(id)}`;

export const KINDS = ['roommate', 'partner'];
export const ROLES_NEEDED = ['Lead', 'Follow', 'Either'];
export const OPEN_SQL = `status = 'open' AND expires_at > now()`;

export const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
