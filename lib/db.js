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
  style TEXT,
  level TEXT,
  description TEXT,
  event_date DATE,
  end_date DATE,
  location TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pass_types (
  id SERIAL PRIMARY KEY,
  competition_id INT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name TEXT,
  role TEXT,
  cap INT CHECK (cap IS NULL OR cap >= 0),
  price_cents INT NOT NULL CHECK (price_cents >= 50),
  early_price_cents INT CHECK (early_price_cents IS NULL OR early_price_cents >= 50),
  early_until TIMESTAMPTZ
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
CREATE TABLE IF NOT EXISTS redemptions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  won_at TEXT NOT NULL,
  event_slug TEXT NOT NULL,
  ticket_type TEXT NOT NULL CHECK (ticket_type IN ('full_weekend','day_pass','competition_pass')),
  competition TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS redemptions_created ON redemptions (created_at DESC);
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('roommate','partner')),
  event_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  nights TEXT,
  gender_pref TEXT,
  competition TEXT,
  level TEXT,
  role_needed TEXT,
  notes TEXT,
  instagram TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '60 days'),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS listings_open ON listings (status, expires_at);
CREATE TABLE IF NOT EXISTS listing_requests (
  id SERIAL PRIMARY KEY,
  listing_id INT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, email)
);
-- Upgrades for databases created by earlier versions (all safe to re-run)
ALTER TABLE competitions ALTER COLUMN event_slug DROP NOT NULL;
ALTER TABLE competitions ALTER COLUMN style DROP NOT NULL;
ALTER TABLE competitions ALTER COLUMN level DROP NOT NULL;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS event_date DATE;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS prize TEXT;
ALTER TABLE pass_types ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE pass_types DROP CONSTRAINT IF EXISTS pass_types_role_check;
ALTER TABLE pass_types DROP CONSTRAINT IF EXISTS pass_types_competition_id_role_key;
ALTER TABLE pass_types ALTER COLUMN role DROP NOT NULL;
UPDATE pass_types SET role = NULL WHERE role = 'any';
UPDATE pass_types SET name = CASE role WHEN 'lead' THEN 'Lead' WHEN 'follow' THEN 'Follow' ELSE 'Pass' END WHERE name IS NULL;
ALTER TABLE pass_types ADD CONSTRAINT pass_types_role_check CHECK (role IS NULL OR role IN ('lead','follow'));
`;

export async function migrate() {
  // pg Pool can run multi-statement strings via simple query; PGlite needs exec.
  if (override && override.exec) return override.exec(SCHEMA);
  return getPool().query(SCHEMA);
}
