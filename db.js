/**
 * db.js — SQLite schema, connection, and seed for More5Stars (multi-tenant).
 *
 * Tables:
 *   businesses     — one row per tenant location (slug, name, google_review_url, settings)
 *   feedback       — private feedback captured from low-star raters (1..threshold-1)
 *   rating_events  — every star tap, for analytics + conversion tracking
 *   admins         — dashboard logins (bcrypt-hashed passwords)
 *
 * All queries elsewhere use prepared statements (parameterized) — no string concat.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'more5stars.db');
const db = new Database(DB_PATH);
// WAL gives better concurrency, but some network/mounted filesystems don't
// support it — fall back to the default journal mode if it errors.
try { db.pragma('journal_mode = WAL'); }
catch (e) { console.warn('WAL unavailable, using default journal mode:', e.message); }
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  logo_text         TEXT,                       -- short text/initial shown if no logo
  logo_url          TEXT,                       -- optional uploaded logo (data URL or http URL)
  brand_color       TEXT DEFAULT '#6C2BD9',
  google_review_url TEXT NOT NULL,              -- where 5-star raters are sent
  -- Routing config. star_threshold = minimum stars to send to Google.
  -- Default 5  => only 5 stars go to Google; 1-4 are captured privately.
  -- Set to 4 to run the "4-5 -> Google" variant; set very high to disable gating.
  star_threshold    INTEGER NOT NULL DEFAULT 5,
  notify_email      TEXT,                       -- where private feedback alerts go
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  stars         INTEGER NOT NULL,
  message       TEXT,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  resolved      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rating_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  stars        INTEGER NOT NULL,
  routed_to    TEXT NOT NULL,                   -- 'google' | 'private'
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_biz ON feedback(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_biz ON rating_events(business_id, created_at);
`);

// ---- Migrations (idempotent) — safely add new columns to existing databases ----
{
  const cols = db.prepare('PRAGMA table_info(businesses)').all().map((c) => c.name);
  if (!cols.includes('logo_url')) {
    db.exec('ALTER TABLE businesses ADD COLUMN logo_url TEXT');
    console.log('Migration: added businesses.logo_url');
  }
}

function seed() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@more5stars.net').toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD || 'changeme123';
  const existsAdmin = db.prepare('SELECT id FROM admins WHERE email = ?').get(adminEmail);
  if (!existsAdmin) {
    const hash = bcrypt.hashSync(adminPass, 12);
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(adminEmail, hash);
    console.log(`Seeded admin: ${adminEmail} (password from ADMIN_PASSWORD env, default "changeme123")`);
  }

  const demo = db.prepare('SELECT id FROM businesses WHERE slug = ?').get('demo');
  if (!demo) {
    db.prepare(`INSERT INTO businesses
      (slug, name, logo_text, brand_color, google_review_url, star_threshold, notify_email)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'demo',
      'Acme Plumbing',
      'A',
      '#6C2BD9',
      'https://search.google.com/local/writereview?placeid=DEMO_PLACE_ID',
      5,
      adminEmail
    );
    console.log('Seeded demo business: /r/demo');
  }
}

// Run seed when invoked directly: `node db.js --seed`
if (require.main === module || process.argv.includes('--seed')) {
  seed();
  console.log('Seed complete. DB at', DB_PATH);
}

module.exports = { db, seed, DB_PATH };
