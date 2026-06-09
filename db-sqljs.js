/**
 * db.js — SQLite using sql.js (pure JavaScript, no native build needed)
 */
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'more5stars.db');

let SQL;
let db;

async function initDB() {
  SQL = await initSqlJs();
  
  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS businesses (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      slug              TEXT UNIQUE NOT NULL,
      name              TEXT NOT NULL,
      logo_text         TEXT,
      brand_color       TEXT DEFAULT '#6C2BD9',
      google_review_url TEXT NOT NULL,
      star_threshold    INTEGER NOT NULL DEFAULT 5,
      notify_email      TEXT,
      active            INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS feedback (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      stars         INTEGER NOT NULL,
      message       TEXT,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      resolved      INTEGER DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS rating_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      stars         INTEGER NOT NULL,
      routed_to     TEXT NOT NULL CHECK(routed_to IN ('google', 'private')),
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS admins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  save();
  console.log('✅ Database initialized:', DB_PATH);
}

function save() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {}
  stmt.free();
  save();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function seed() {
  // Check if admin exists
  const adminExists = get('SELECT * FROM admins WHERE email = ?', ['admin@more5stars.net']);
  
  if (!adminExists) {
    const hash = bcrypt.hashSync('changeme123', 12);
    run('INSERT INTO admins (email, password_hash) VALUES (?, ?)', ['admin@more5stars.net', hash]);
    console.log('📝 Seeded admin user: admin@more5stars.net / changeme123');
  }
  
  // Check if demo business exists
  const demoExists = get('SELECT * FROM businesses WHERE slug = ?', ['demo']);
  
  if (!demoExists) {
    run(
      `INSERT INTO businesses (slug, name, google_review_url, star_threshold, notify_email) 
       VALUES (?, ?, ?, ?, ?)`,
      ['demo', 'Demo Business', 'https://google.com/search?q=demo', 5, 'demo@more5stars.net']
    );
    console.log('🏢 Seeded demo business location');
  }
}

module.exports = {
  initDB,
  run,
  get,
  all,
  save,
  seed,
  db: () => db
};
