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
