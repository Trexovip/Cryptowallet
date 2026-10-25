// Runtime configuration. Written once by the browser setup wizard to data/config.json.
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.CUSTODY_DATA_DIR
  ? path.resolve(process.env.CUSTODY_DATA_DIR)
  : path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const DEFAULTS = {
  tron_network: "mainnet",                 // mainnet | nile | shasta
  trongrid_api_key: "",
  usdt_contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", // TRC-20 USDT (mainnet)
  sweep_min_usdt: 1.0,
  gas_fund_trx: 20.0,
  disbursement_float_usdt: 500.0,
  max_disburse_usdt: 2000.0,
  poll_interval_seconds: 30,
  access_token_minutes: 60,
  staff_auto_approve_limit: 0,   // staff payouts <= this (USDT) skip approval; 0 = always require approval
  treasury_hold_percent: 10,     // % of treasury kept back when distributing to the pool
  deposit_fee_percent: 0,        // operator fee % shown on deposit receipts (net credited = amount - fee)
  dual_control_threshold: 0,     // payouts >= this (USDT) need a 2nd admin approval; 0 = off
  webhook_url: "",               // POST deposit/payout events here; "" = disabled
  payout_allowlist_only: false,  // if true, pool payouts only to address-book / whitelisted addresses
  auto_distribute_enabled: false, // worker periodically distributes treasury surplus to the pool
  wallet_preload_trx: 30,         // TRX sent from the gas wallet to each newly created wallet
  app_name: "KryvonWallet",       // brand name shown in the UI
  brand_logo: "",                 // data URL / URL of the header logo
  favicon: "",                    // data URL / URL of the browser favicon
  qr_logo: "",                    // data URL / URL placed in the centre of QR codes
  customer_onchain_name: "KryvonWallet-{id}", // on-chain TRON name template per customer deposit wallet; {id} {username} {app} ("" = off)
};

let cfg = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function isSetupComplete() {
  return fs.existsSync(CONFIG_PATH);
}
function load() {
  if (cfg) return cfg;
  if (!isSetupComplete()) return null;
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return cfg;
}
function save(obj) {
  ensureDataDir();
  // 0600 so the file (which holds the key-encryption key) isn't world-readable
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
  cfg = obj;
  return cfg;
}
function get() {
  const c = cfg || load();
  if (!c) throw new Error("Configuration not initialised — run setup first");
  return c;
}

module.exports = { DATA_DIR, CONFIG_PATH, DEFAULTS, ensureDataDir, isSetupComplete, load, save, get };
