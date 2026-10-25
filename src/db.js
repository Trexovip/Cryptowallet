// SQLite (better-sqlite3) — synchronous, embedded, zero external DB to configure.
const Database = require("better-sqlite3");
const path = require("path");
const { DATA_DIR, ensureDataDir } = require("./config");

let db = null;

function getDb() {
  if (db) return db;
  ensureDataDir();
  db = new Database(path.join(DATA_DIR, "custody.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',   -- admin | staff | customer
      is_active INTEGER NOT NULL DEFAULT 1,
      customer_type TEXT,                   -- depositor | remittance (customers only)
      auto_approve_limit REAL,              -- per-staff payout auto-approve limit (null = use global default)
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain TEXT NOT NULL DEFAULT 'tron',
      address TEXT UNIQUE NOT NULL,
      enc_privkey TEXT NOT NULL,
      wtype TEXT NOT NULL,            -- deposit | treasury | disbursement | fee
      label TEXT DEFAULT '',
      owner_user_id INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,             -- deposit_in | gas_fund | sweep | topup | disburse_out
      chain TEXT DEFAULT 'tron',
      token TEXT DEFAULT 'USDT',
      from_address TEXT,
      to_address TEXT,
      amount TEXT NOT NULL,
      tx_hash TEXT,
      status TEXT DEFAULT 'pending',  -- pending | confirmed | failed
      wallet_id INTEGER,
      initiated_by INTEGER,
      note TEXT DEFAULT '',
      usd_rate TEXT,
      created_at TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS customer_whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      label TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS disbursement_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_user_id INTEGER NOT NULL,
      customer_id INTEGER,
      to_address TEXT NOT NULL,
      amount TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      approved_by INTEGER,
      from_wallet_id INTEGER,
      tx_hash TEXT,
      reason TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS address_book (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT DEFAULT '',
      address TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      sender_user_id INTEGER,
      sender_role TEXT,
      sender_name TEXT,
      body TEXT DEFAULT '',
      kind TEXT DEFAULT 'text',   -- text | receipt | ack
      ref_tx TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      key_hash TEXT NOT NULL,
      prefix TEXT NOT NULL,
      scopes TEXT DEFAULT '',
      created_by INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_used TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  // lightweight migrations: add columns that older databases may lack
  const mcols = db.prepare("PRAGMA table_info(movements)").all().map((c) => c.name);
  if (!mcols.includes("usd_rate")) db.exec("ALTER TABLE movements ADD COLUMN usd_rate TEXT");
  const ucols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!ucols.includes("customer_type")) db.exec("ALTER TABLE users ADD COLUMN customer_type TEXT");
  if (!ucols.includes("auto_approve_limit")) db.exec("ALTER TABLE users ADD COLUMN auto_approve_limit REAL");
  if (!ucols.includes("phone")) db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  if (!ucols.includes("pay_token")) db.exec("ALTER TABLE users ADD COLUMN pay_token TEXT");
  const dcols = db.prepare("PRAGMA table_info(disbursement_requests)").all().map((c) => c.name);
  if (!dcols.includes("customer_id")) db.exec("ALTER TABLE disbursement_requests ADD COLUMN customer_id INTEGER");
  if (!dcols.includes("idempotency_key")) db.exec("ALTER TABLE disbursement_requests ADD COLUMN idempotency_key TEXT");
  if (!dcols.includes("first_approver")) db.exec("ALTER TABLE disbursement_requests ADD COLUMN first_approver INTEGER");

  return db;
}

module.exports = { getDb };
