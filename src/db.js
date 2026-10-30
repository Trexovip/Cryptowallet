// Dual database adapter: embedded SQLite (default) or MySQL/MariaDB.
// Exposes an ASYNC query API: getDb().prepare(sql).get/all/run(...args) each return a Promise.
// Choose the engine with env DB_CLIENT=sqlite|mysql (default sqlite).
//   MySQL: MYSQL_URL=mysql://user:pass@host:3306/db   (or MYSQL_HOST/PORT/USER/PASSWORD/DATABASE)
const path = require("path");
const { DATA_DIR, ensureDataDir } = require("./config");

const CLIENT = (process.env.DB_CLIENT || "sqlite").toLowerCase();
let adapter = null;

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff', is_active INTEGER NOT NULL DEFAULT 1, customer_type TEXT,
    auto_approve_limit REAL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL DEFAULT 'tron', address TEXT UNIQUE NOT NULL,
    enc_privkey TEXT NOT NULL, wtype TEXT NOT NULL, label TEXT DEFAULT '', owner_user_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, chain TEXT DEFAULT 'tron', token TEXT DEFAULT 'USDT',
    from_address TEXT, to_address TEXT, amount TEXT NOT NULL, tx_hash TEXT, status TEXT DEFAULT 'pending',
    wallet_id INTEGER, initiated_by INTEGER, note TEXT DEFAULT '', usd_rate TEXT, created_at TEXT NOT NULL, confirmed_at TEXT);
  CREATE TABLE IF NOT EXISTS customer_whitelist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, address TEXT NOT NULL, label TEXT DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1, created_by INTEGER, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS disbursement_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, staff_user_id INTEGER NOT NULL, customer_id INTEGER, to_address TEXT NOT NULL,
    amount TEXT NOT NULL, status TEXT DEFAULT 'pending', approved_by INTEGER, from_wallet_id INTEGER, tx_hash TEXT,
    reason TEXT DEFAULT '', created_at TEXT NOT NULL, resolved_at TEXT);
  CREATE TABLE IF NOT EXISTS address_book (
    id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT DEFAULT '', address TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS customer_staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, staff_id INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, sender_user_id INTEGER, sender_role TEXT,
    sender_name TEXT, body TEXT DEFAULT '', kind TEXT DEFAULT 'text', ref_tx TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT DEFAULT '', key_hash TEXT NOT NULL, prefix TEXT NOT NULL,
    scopes TEXT DEFAULT '', created_by INTEGER, is_active INTEGER NOT NULL DEFAULT 1, last_used TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL, detail TEXT DEFAULT '',
    ip TEXT DEFAULT '', created_at TEXT NOT NULL);
`;

function makeSqlite() {
  const Database = require("better-sqlite3");
  ensureDataDir();
  const db = new Database(path.join(DATA_DIR, "custody.db"));
  db.pragma("journal_mode = WAL");
  db.exec(SQLITE_SCHEMA);
  const col = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const add = (t, c, d) => { if (!col(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  add("movements", "usd_rate", "TEXT");
  add("users", "customer_type", "TEXT"); add("users", "auto_approve_limit", "REAL");
  add("users", "phone", "TEXT"); add("users", "pay_token", "TEXT");
  add("disbursement_requests", "customer_id", "INTEGER"); add("disbursement_requests", "idempotency_key", "TEXT");
  add("disbursement_requests", "first_approver", "INTEGER");
  return {
    _dialect: "sqlite",
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get: async (...p) => stmt.get(...p),
        all: async (...p) => stmt.all(...p),
        run: async (...p) => { const r = stmt.run(...p); return { lastInsertRowid: r.lastInsertRowid, changes: r.changes }; },
      };
    },
    exec: async (sql) => db.exec(sql),
  };
}

async function makeMysql() {
  const mysql = require("mysql2/promise");
  const pool = process.env.MYSQL_URL
    ? mysql.createPool({ uri: process.env.MYSQL_URL, decimalNumbers: true, charset: "utf8mb4" })
    : mysql.createPool({
        host: process.env.MYSQL_HOST || "127.0.0.1",
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || "root",
        password: process.env.MYSQL_PASSWORD || "",
        database: process.env.MYSQL_DATABASE || "kryvon",
        waitForConnections: true, connectionLimit: 10, charset: "utf8mb4",
        decimalNumbers: true, // SUM/aggregate DECIMALs come back as JS numbers (like SQLite)
      });
  const schema = require("fs").readFileSync(path.join(__dirname, "..", "db", "mysql-schema.sql"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  // wait for the DB to accept connections (it may still be starting, e.g. on Railway)
  let conn, lastErr;
  for (let i = 0; i < 20; i++) {
    try { conn = await pool.getConnection(); break; }
    catch (e) { lastErr = e; console.log(`[db] waiting for MySQL (${e.code || e.message})...`); await new Promise((r) => setTimeout(r, 3000)); }
  }
  if (!conn) throw lastErr;
  try { for (const stmt of schema.split(";").map((s) => s.trim()).filter(Boolean)) await conn.query(stmt); }
  finally { conn.release(); }
  // SQLite-isms -> MySQL: null-safe equality, and CAST(x AS REAL) (unsupported in MySQL).
  const fix = (sql) => sql.replace(/ IS \?/g, " <=> ?").replace(/ AS REAL\)/g, " AS DECIMAL(38,8))");
  return {
    _dialect: "mysql",
    prepare(sql) {
      const s = fix(sql);
      return {
        get: async (...p) => { const [rows] = await pool.query(s, p); return rows[0]; },
        all: async (...p) => { const [rows] = await pool.query(s, p); return rows; },
        run: async (...p) => { const [r] = await pool.query(s, p); return { lastInsertRowid: r.insertId, changes: r.affectedRows }; },
      };
    },
    exec: async (sql) => { const c = await pool.getConnection(); try { await c.query(sql); } finally { c.release(); } },
  };
}

async function init() {
  if (adapter) return adapter;
  adapter = CLIENT === "mysql" ? await makeMysql() : makeSqlite();
  console.log(`[db] using ${adapter._dialect}`);
  return adapter;
}
function getDb() {
  if (adapter) return adapter;
  if (CLIENT === "mysql") throw new Error("MySQL not initialized — await init() during startup");
  adapter = makeSqlite();
  return adapter;
}

function dialect() { return adapter ? adapter._dialect : CLIENT; }
module.exports = { getDb, init, dialect };
