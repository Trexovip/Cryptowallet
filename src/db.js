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
      role TEXT NOT NULL DEFAULT 'staff',
      is_active INTEGER NOT NULL DEFAULT 1,
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
    CREATE TABLE IF NOT EXISTS disbursement_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_user_id INTEGER NOT NULL,
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
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  // lightweight migration: add columns that older databases may lack
  const cols = db.prepare("PRAGMA table_info(movements)").all().map((c) => c.name);
  if (!cols.includes("usd_rate")) db.exec("ALTER TABLE movements ADD COLUMN usd_rate TEXT");

  return db;
}

module.exports = { getDb };
