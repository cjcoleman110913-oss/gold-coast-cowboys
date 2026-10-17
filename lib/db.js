// Database layer. Production: Postgres via DATABASE_URL (Neon on Vercel). Tests inject PGlite.
import pg from 'pg';

let override = null;
let pool = null;

export function setDb(db) { override = db; }

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  }
  return pool;
}

// Tables are created automatically the first time the server talks to a fresh database.
let ready = null;
function ensureSchema() {
  if (!ready) ready = getPool().query(SCHEMA).catch((e) => { ready = null; throw e; });
  return ready;
}

export async function query(text, params = []) {
  if (override) return override.query(text, params);
  await ensureSchema();
  return getPool().query(text, params);
}

// Run fn(client) inside a transaction. client.query(text, params) -> { rows }
export async function tx(fn) {
  if (override) {
    return override.transaction(async (t) => fn({ query: (q, p = []) => t.query(q, p) }));
  }
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally { client.release(); }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invites (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  created_by INT REFERENCES admins(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT PRIMARY KEY,
  fails INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS competitions (
  id SERIAL PRIMARY KEY,
  event_slug TEXT,
  title TEXT NOT NULL,
  style TEXT NOT NULL,
  level TEXT NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pass_types (
  id SERIAL PRIMARY KEY,
  competition_id INT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('lead','follow','any')),
  cap INT CHECK (cap IS NULL OR cap >= 0),
  price_cents INT NOT NULL CHECK (price_cents >= 50),
  early_price_cents INT CHECK (early_price_cents IS NULL OR early_price_cents >= 50),
  early_until TIMESTAMPTZ,
  UNIQUE (competition_id, role)
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  pass_type_id INT NOT NULL REFERENCES pass_types(id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  amount_cents INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','expired','refunded')),
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_pass_status ON orders (pass_type_id, status);
-- Competitions no longer need an event (for databases created before this change)
ALTER TABLE competitions ALTER COLUMN event_slug DROP NOT NULL;
`;

export async function migrate() {
  // pg Pool can run multi-statement strings via simple query; PGlite needs exec.
  if (override && override.exec) return override.exec(SCHEMA);
  return getPool().query(SCHEMA);
}
