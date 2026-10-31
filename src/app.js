const express = require("express");
const crypto = require("crypto");
const path = require("path");
const config = require("./config");
const { getDb, dialect } = require("./db");
const sec = require("./security");
const svc = require("./services");
const license = require("./license");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "16mb" }));
app.use(express.urlencoded({ extended: false }));

const PUBLIC = path.join(__dirname, "..", "public");
app.use("/static", express.static(PUBLIC));

const ip = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";
const userOut = (u) => ({ id: u.id, username: u.username, role: u.role, is_active: !!u.is_active, customer_type: u.customer_type || null, auto_approve_limit: u.auto_approve_limit != null ? Number(u.auto_approve_limit) : null, phone: u.phone || null });
const assignedStaffIds = async (customerId) => (await getDb().prepare("SELECT staff_id FROM customer_staff WHERE customer_id=?").all(customerId)).map((r) => r.staff_id);
const assignedCustomerIds = async (staffId) => (await getDb().prepare("SELECT customer_id FROM customer_staff WHERE staff_id=?").all(staffId)).map((r) => r.customer_id);
async function ensurePayToken(u) {
  if (u.pay_token) return u.pay_token;
  const tok = crypto.randomBytes(12).toString("base64url");
  (await getDb().prepare("UPDATE users SET pay_token=? WHERE id=?").run(tok, u.id));
  return tok;
}
async function canAccessCustomer(user, customerId) {
  if (user.role === "admin") return true;
  if (user.role === "customer") return Number(user.id) === Number(customerId);
  if (user.role === "staff") return (await assignedStaffIds(customerId)).includes(user.id);
  return false;
}
const walletOut = (w) => ({ id: w.id, chain: w.chain, address: w.address, wtype: w.wtype, label: w.label, owner_user_id: w.owner_user_id, is_active: !!w.is_active });
const moveOut = (m) => ({ id: m.id, kind: m.kind, token: m.token, from_address: m.from_address, to_address: m.to_address, amount: m.amount, tx_hash: m.tx_hash, status: m.status, usd_rate: m.usd_rate, energy: m.energy, created_at: m.created_at });

function explorerTx(network, hash) {
  if (!hash) return null;
  const sub = network === "mainnet" ? "" : network + ".";
  return `https://${sub}tronscan.org/#/transaction/${hash}`;
}
function buildReceipt(m, network) {
  const isTrx = m.token === "TRX";
  const rate = m.usd_rate != null ? Number(m.usd_rate) : 1;
  const amt = Number(m.amount);
  const out = {
    receipt_id: "RCPT-" + String(m.id).padStart(6, "0"),
    kind: m.kind,
    status: m.status,
    datetime: m.created_at,
    network,
    token: m.token,
    sender_address: m.from_address,
    receiver_address: m.to_address,
    amount: String(amt),
    usd_rate: isTrx ? null : rate,
    amount_usd: isTrx ? null : Number((amt * rate).toFixed(2)),
    tx_hash: m.tx_hash,
    explorer_url: explorerTx(network, m.tx_hash),
  };
  if (m.kind === "deposit_in" && !isTrx) {
    const feePct = Number(config.get().deposit_fee_percent || 0);
    if (feePct > 0) {
      out.deposit_fee_percent = feePct;
      out.fee_amount = Number((amt * feePct / 100).toFixed(6));
      out.net_amount = Number((amt - out.fee_amount).toFixed(6));
    }
  }
  return out;
}
const disbOut = (d) => ({ id: d.id, customer_id: d.customer_id, to_address: d.to_address, amount: d.amount, status: d.status, from_wallet_id: d.from_wallet_id, tx_hash: d.tx_hash, created_at: d.created_at, first_approver: d.first_approver || null, awaiting_second_approval: !!(d.first_approver && !d.tx_hash && d.status === "pending") });
const userName = async (id) => { if (!id) return null; const u = (await getDb().prepare("SELECT username FROM users WHERE id=?").get(id)); return u ? u.username : null; };
async function txOut(m) {
  const o = moveOut(m);
  o.initiated_by_name = await userName(m.initiated_by);
  const rate = m.usd_rate != null ? Number(m.usd_rate) : null;
  o.amount_usd = (m.token === "TRX" || rate == null) ? null : Number((Number(m.amount) * rate).toFixed(2));
  return o;
}
const FRIENDLY = { treasury: "treasury", fee: "gas", disbursement: "pool", deposit: "customer" };
const friendlyType = (w) => FRIENDLY[w] || w;
function wtypeFromFriendly(f) {
  const map = { treasury: "treasury", gas: "fee", fee: "fee", pool: "disbursement", disbursement: "disbursement", customer: "deposit", deposit: "deposit" };
  return map[String(f || "").toLowerCase()] || null;
}
async function addressAllowed(addr) {
  if ((await getDb().prepare("SELECT 1 FROM address_book WHERE address=? AND is_active=1").get(addr))) return true;
  if ((await getDb().prepare("SELECT 1 FROM customer_whitelist WHERE address=? AND is_active=1").get(addr))) return true;
  return false;
}

// ---------------- setup gating ----------------
app.use((req, res, next) => {
  const done = config.isSetupComplete();
  if (done) {
    if (req.path === "/setup") return res.redirect("/");
    return next();
  }
  const allowed =
    req.path === "/setup" ||
    req.path.startsWith("/static/") ||
    req.path === "/health" ||
    req.path === "/branding" ||
    req.path === "/manifest.webmanifest" ||
    req.path === "/sw.js" ||
    req.path.startsWith("/pay/") ||
    req.path.startsWith("/paylink/") ||
    req.path === "/api/setup/status" ||
    (req.path === "/api/setup" && req.method === "POST");
  if (allowed) return next();
  if (req.method === "GET" && req.accepts("html")) return res.redirect("/setup");
  return res.status(409).json({ detail: "Setup not complete" });
});

// ---------------- pages ----------------
app.get("/", async (_req, res) => res.sendFile(path.join(PUBLIC, "index.html")));
app.get("/setup", async (_req, res) => res.sendFile(path.join(PUBLIC, "setup.html")));
app.get("/health", async (_req, res) => res.json({ status: "ok", db: dialect(), time: new Date().toISOString() }));

// Public branding (logo, favicon, name) so the login/setup pages can theme before auth.
app.get("/branding", async (_req, res) => {
  let c = {}; try { c = config.get(); } catch { c = {}; }
  res.json({ app_name: c.app_name || "KryvonWallet", brand_logo: c.brand_logo || "", favicon: c.favicon || "", qr_logo: c.qr_logo || "" });
});

// PWA: service worker (served at root so its scope is the whole app) + dynamic manifest.
app.get("/sw.js", (_req, res) => res.set("Content-Type", "application/javascript").sendFile(path.join(PUBLIC, "sw.js")));
app.get("/manifest.webmanifest", (_req, res) => {
  let c = {}; try { c = config.get(); } catch { c = {}; }
  const name = c.app_name || "KryvonWallet";
  const icon = c.brand_logo || "/static/icon.svg";
  const type = icon.startsWith("data:image/png") ? "image/png" : icon.startsWith("data:image/jpeg") ? "image/jpeg" : "image/svg+xml";
  res.set("Content-Type", "application/manifest+json").send(JSON.stringify({
    name, short_name: name.slice(0, 12), start_url: "/", scope: "/",
    display: "standalone", orientation: "portrait-primary",
    background_color: "#0B0F17", theme_color: "#4F46E5",
    icons: [{ src: icon, sizes: "512x512", type, purpose: "any" }, { src: icon, sizes: "192x192", type, purpose: "maskable" }],
  }));
});

// Public payment link: page + data (no auth). Token is unguessable.
app.get("/pay/:token", async (_req, res) => res.sendFile(path.join(PUBLIC, "pay.html")));
app.get("/paylink/:token", async (req, res) => {
  let c = {}; try { c = config.get(); } catch { c = {}; }
  const u = (await getDb().prepare("SELECT * FROM users WHERE pay_token=? AND role='customer' AND is_active=1").get(req.params.token));
  if (!u) return res.status(404).json({ detail: "invalid or expired link" });
  const addresses = (await getDb().prepare("SELECT address,label FROM wallets WHERE owner_user_id=? AND wtype='deposit' AND is_active=1").all(u.id));
  res.json({ app_name: c.app_name || "KryvonWallet", brand_logo: c.brand_logo || "", qr_logo: c.qr_logo || "", customer_name: u.username, addresses });
});

// ---------------- setup wizard API ----------------
app.get("/api/setup/status", async (_req, res) => res.json({ needs_setup: !config.isSetupComplete() }));

app.post("/api/setup", async (req, res) => {
  if (config.isSetupComplete()) return res.status(409).json({ detail: "Already set up" });
  const b = req.body || {};
  const username = String(b.username || "").trim();
  const password = String(b.password || "");
  const net = String(b.tron_network || "mainnet");
  const apiKey = String(b.trongrid_api_key || "").trim();

  if (username.length < 3) return res.status(400).json({ detail: "Username must be at least 3 characters" });
  if (password.length < 8) return res.status(400).json({ detail: "Password must be at least 8 characters" });
  if (!["mainnet", "nile", "shasta"].includes(net)) return res.status(400).json({ detail: "Pick a valid network" });
  if (net === "mainnet" && !apiKey) return res.status(400).json({ detail: "A TronGrid API key is required for mainnet" });

  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  const D = config.DEFAULTS;
  const cfg = {
    ...D, // persist every default (incl. gas-free energy_mode "auto") so no post-setup configuration is needed
    app_secret: crypto.randomBytes(48).toString("hex"),
    wallet_enc_key: crypto.randomBytes(32).toString("hex"),
    tron_network: net,
    trongrid_api_key: apiKey,
    usdt_contract: String(b.usdt_contract || D.usdt_contract).trim(),
    sweep_min_usdt: num(b.sweep_min_usdt, D.sweep_min_usdt),
    gas_fund_trx: num(b.gas_fund_trx, D.gas_fund_trx),
    disbursement_float_usdt: num(b.disbursement_float_usdt, D.disbursement_float_usdt),
    max_disburse_usdt: num(b.max_disburse_usdt, D.max_disburse_usdt),
    poll_interval_seconds: num(b.poll_interval_seconds, D.poll_interval_seconds),
    access_token_minutes: D.access_token_minutes,
    setup_at: new Date().toISOString(),
  };
  config.save(cfg);

  const db = getDb();
  (await db.prepare("INSERT INTO users(username,password_hash,role,is_active,created_at) VALUES(?,?,'admin',1,?)")
    .run(username, sec.hashPassword(password), new Date().toISOString()));
  svc.audit(1, "setup_complete", `admin ${username}, network ${net}`, ip(req));

  startWorker();
  // Return the generated encryption key once so the operator can back it up.
  res.json({ ok: true, wallet_enc_key: cfg.wallet_enc_key, network: net });
});

// ---------------- auth middleware ----------------
async function currentUser(req, res, next) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ detail: "invalid credentials" });
  try {
    const p = sec.verifyToken(tok);
    const u = (await getDb().prepare("SELECT * FROM users WHERE username=?").get(p.sub));
    if (!u || !u.is_active) return res.status(401).json({ detail: "invalid credentials" });
    req.user = u;
    next();
  } catch {
    return res.status(401).json({ detail: "session expired" });
  }
}
const adminRequired = (req, res, next) =>
  req.user.role === "admin" ? next() : res.status(403).json({ detail: "admin only" });
const staffOrAdmin = (req, res, next) =>
  (req.user.role === "admin" || req.user.role === "staff") ? next() : res.status(403).json({ detail: "staff or admin only" });
const customerOnly = (req, res, next) =>
  req.user.role === "customer" ? next() : res.status(403).json({ detail: "customers only" });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) =>
  res.status(400).json({ detail: e.message || "request failed" }));

// ---------------- auth ----------------
const LOGIN_MAX = 5, LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map();
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || "");
  const key = uname + "|" + ip(req);
  const now = Date.now();
  const rec = loginFails.get(key);
  if (rec && rec.lockUntil && now < rec.lockUntil)
    return res.status(429).json({ detail: "too many failed attempts — try again later" });
  const u = (await getDb().prepare("SELECT * FROM users WHERE username=?").get(uname));
  if (!u || !u.is_active || !sec.verifyPassword(String(password || ""), u.password_hash)) {
    const r = (rec && now - rec.firstAt < LOGIN_WINDOW_MS) ? rec : { count: 0, firstAt: now };
    r.count++;
    if (r.count >= LOGIN_MAX) r.lockUntil = now + LOGIN_LOCK_MS;
    loginFails.set(key, r);
    return res.status(401).json({ detail: "bad username or password" });
  }
  loginFails.delete(key);
  svc.audit(u.id, "login", "", ip(req));
  res.json({ access_token: sec.signToken(u), token_type: "bearer" });
});

app.get("/users/me", currentUser, async (req, res) => res.json(userOut(req.user)));

app.get("/users", currentUser, adminRequired, async (_req, res) =>
  res.json((await getDb().prepare("SELECT * FROM users ORDER BY id").all()).map(userOut)));

app.post("/users", currentUser, adminRequired, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (String(username || "").length < 3) return res.status(400).json({ detail: "username too short" });
  if (String(password || "").length < 8) return res.status(400).json({ detail: "password must be at least 8 characters" });
  if ((await getDb().prepare("SELECT 1 FROM users WHERE username=?").get(username)))
    return res.status(400).json({ detail: "username exists" });
  const r = role === "admin" ? "admin" : "staff";
  const info = (await getDb().prepare("INSERT INTO users(username,password_hash,role,is_active,created_at) VALUES(?,?,?,1,?)")
    .run(username, sec.hashPassword(password), r, new Date().toISOString()));
  svc.audit(req.user.id, "create_user", `created ${username} (${r})`, ip(req));
  res.json(userOut((await getDb().prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid))));
});

app.post("/users/:id/limit", currentUser, adminRequired, async (req, res) => {
  const u = (await getDb().prepare("SELECT * FROM users WHERE id=?").get(req.params.id));
  if (!u) return res.status(404).json({ detail: "user not found" });
  if (u.role !== "staff") return res.status(400).json({ detail: "limits apply to staff only" });
  const { limit } = req.body || {};
  let val = null; // null = fall back to global default
  if (limit !== null && limit !== "" && limit !== undefined) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ detail: "invalid limit" });
    val = n;
  }
  (await getDb().prepare("UPDATE users SET auto_approve_limit=? WHERE id=?").run(val, u.id));
  svc.audit(req.user.id, "set_staff_limit", `staff #${u.id} -> ${val === null ? "default" : val}`, ip(req));
  res.json(userOut((await getDb().prepare("SELECT * FROM users WHERE id=?").get(u.id))));
});

app.post("/users/:id/active", currentUser, adminRequired, async (req, res) => {
  const u = (await getDb().prepare("SELECT * FROM users WHERE id=?").get(req.params.id));
  if (!u) return res.status(404).json({ detail: "user not found" });
  if (u.id === req.user.id) return res.status(400).json({ detail: "you cannot change your own status" });
  const active = req.body && req.body.active ? 1 : 0;
  if (!active && u.role === "admin") {
    const admins = (await getDb().prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND is_active=1").get()).c;
    if (admins <= 1) return res.status(400).json({ detail: "cannot disable the last active admin" });
  }
  (await getDb().prepare("UPDATE users SET is_active=? WHERE id=?").run(active, u.id));
  svc.audit(req.user.id, active ? "enable_user" : "disable_user", u.username, ip(req));
  res.json(userOut((await getDb().prepare("SELECT * FROM users WHERE id=?").get(u.id))));
});

app.post("/users/:id/password", currentUser, adminRequired, async (req, res) => {
  const u = (await getDb().prepare("SELECT * FROM users WHERE id=?").get(req.params.id));
  if (!u) return res.status(404).json({ detail: "user not found" });
  const pw = String((req.body || {}).password || "");
  if (pw.length < 8) return res.status(400).json({ detail: "password must be at least 8 characters" });
  (await getDb().prepare("UPDATE users SET password_hash=? WHERE id=?").run(sec.hashPassword(pw), u.id));
  svc.audit(req.user.id, "reset_password", u.username, ip(req));
  res.json({ ok: true });
});

// ---------------- wallets ----------------
app.post("/wallets/treasury", currentUser, adminRequired, wrap(async (req, res) => {
  if (await svc.getTreasury()) return res.status(400).json({ detail: "treasury already exists" });
  const w = await svc.createWallet("treasury", null, "master treasury");
  svc.audit(req.user.id, "create_treasury", w.address, ip(req));
  res.json(walletOut(w));
}));

app.post("/wallets/fee", currentUser, adminRequired, wrap(async (req, res) => {
  const w = await svc.createWallet("fee", null, "gas fee wallet");
  svc.audit(req.user.id, "create_fee_wallet", w.address, ip(req));
  res.json(walletOut(w));
}));

app.post("/wallets/disbursement-pool", currentUser, adminRequired, wrap(async (req, res) => {
  const count = Math.max(1, Math.min(50, parseInt(req.query.count, 10) || 5));
  const made = [];
  for (let i = 0; i < count; i++) made.push(walletOut(await svc.createWallet("disbursement", null, `pool-${i + 1}`)));
  svc.audit(req.user.id, "create_pool", `${count} wallets`, ip(req));
  res.json(made);
}));

app.post("/wallets/deposit", currentUser, staffOrAdmin, wrap(async (req, res) => {
  const { staff_user_id, label } = req.body || {};
  const staff = (await getDb().prepare("SELECT * FROM users WHERE id=?").get(staff_user_id));
  if (!staff) return res.status(404).json({ detail: "staff user not found" });
  const w = await svc.createWallet("deposit", staff.id, String(label || ""));
  svc.audit(req.user.id, "create_deposit_wallet", `${w.address} for ${staff.username}`, ip(req));
  res.json(walletOut(w));
}));

app.get("/wallets", currentUser, async (req, res) => {
  const rows = req.user.role === "admin"
    ? (await getDb().prepare("SELECT * FROM wallets").all())
    : (await getDb().prepare("SELECT * FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(req.user.id));
  res.json(rows.map(walletOut));
});

const _balCache = new Map();
const BAL_TTL_MS = 15000;
const isRateLimit = async (e) => /429|too many requests|rate.?limit/i.test(String((e && e.message) || e));
// Cached {usdt, native} read for an address. Shared by the dashboard and the balance endpoint
// so repeated/parallel checks don't hammer TronGrid. On a rate-limit, retries once and then
// falls back to the last known value (so balances show stale, not zero) rather than failing.
async function balanceOf(address, fresh = false) {
  const chain = require("./chain");
  const now = Date.now(), ce = _balCache.get(address);
  if (!fresh && ce && now - ce.t < BAL_TTL_MS) return ce.v;
  const read = async () => ({ usdt: String(await chain.usdtBalance(address)), native: String(await chain.nativeBalance(address)) });
  try { const v = await read(); _balCache.set(address, { v, t: now }); return v; }
  catch (e) {
    if (isRateLimit(e)) {
      try { await new Promise((r) => setTimeout(r, 1200)); const v = await read(); _balCache.set(address, { v, t: now }); return v; }
      catch (e2) { if (ce) return ce.v; throw e2; }
    }
    if (ce) return ce.v; throw e;
  }
}
app.get("/wallets/:id/balance", currentUser, wrap(async (req, res) => {
  const w = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id));
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  if (req.user.role !== "admin" && w.owner_user_id !== req.user.id) {
    const staffMayView = req.user.role === "staff" && w.wtype === "deposit" && w.owner_user_id && await canAccessCustomer(req.user, w.owner_user_id);
    if (!staffMayView) return res.status(403).json({ detail: "not your wallet" });
  }
  try { const b = await balanceOf(w.address); res.json({ address: w.address, type: w.wtype, ...b }); }
  catch (e) {
    if (isRateLimit(e)) return res.status(429).json({ detail: "TronGrid rate limit reached — add a TronGrid API key in Settings → Network & keys, or wait a moment and retry." });
    throw e;
  }
}));

// Export ALL wallets with private keys (admin only, audited) — full backup.
app.get("/wallets/export", currentUser, adminRequired, async (req, res) => {
  const rows = (await getDb().prepare("SELECT * FROM wallets ORDER BY id").all());
  const wallets = await Promise.all(rows.map(async (w) => {
    let pk = null; try { pk = sec.decryptSecret(w.enc_privkey); } catch { pk = null; }
    const owner = w.owner_user_id ? (((await getDb().prepare("SELECT username FROM users WHERE id=?").get(w.owner_user_id)) || {}).username || null) : null;
    return { type: friendlyType(w.wtype), label: w.label || "", address: w.address, owner, private_key: pk };
  }));
  svc.audit(req.user.id, "export_all_wallets", `${wallets.length} wallets`, ip(req));
  res.set("Content-Type", "application/json")
     .set("Content-Disposition", "attachment; filename=kryvonwallet-wallets-backup.json")
     .send(JSON.stringify({ exported_at: new Date().toISOString(), network: config.get().tron_network, wallets }, null, 2));
});

// Export ALL wallets as CSV (admin only, audited).
app.get("/wallets/export.csv", currentUser, adminRequired, async (req, res) => {
  const rows = (await getDb().prepare("SELECT * FROM wallets ORDER BY id").all());
  const head = ["type", "label", "address", "owner", "private_key"];
  const lines = [head.join(",")];
  for (const w of rows) {
    let pk = ""; try { pk = sec.decryptSecret(w.enc_privkey); } catch { pk = ""; }
    const owner = w.owner_user_id ? (((await getDb().prepare("SELECT username FROM users WHERE id=?").get(w.owner_user_id)) || {}).username || "") : "";
    lines.push([friendlyType(w.wtype), w.label || "", w.address, owner, pk].map(csvEscape).join(","));
  }
  svc.audit(req.user.id, "export_all_wallets_csv", `${rows.length} wallets`, ip(req));
  res.set("Content-Type", "text/csv").set("Content-Disposition", "attachment; filename=kryvonwallet-wallets-backup.csv").send(lines.join("\n"));
});

// Bulk import wallets from a backup (admin only, audited). No gas pre-load on restore.
app.post("/wallets/import-bulk", currentUser, adminRequired, wrap(async (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : (Array.isArray(body.wallets) ? body.wallets : null);
  if (!list) return res.status(400).json({ detail: "expected a wallets array or { wallets: [...] }" });
  let imported = 0, skipped = 0; const errors = []; const importedAddrs = [];
  for (const it of list) {
    try {
      const pk = String(it.private_key || it.privateKey || "").trim();
      if (!pk) { skipped++; continue; }
      const wtype = wtypeFromFriendly(it.type || it.wtype);
      if (!wtype) { errors.push(`unknown type: ${it.type || it.wtype}`); continue; }
      if (wtype === "treasury" && await svc.getTreasury()) { skipped++; continue; }
      let ownerId = null;
      const ownerName = it.owner || it.owner_username;
      if (ownerName) { const u = (await getDb().prepare("SELECT id FROM users WHERE username=?").get(String(ownerName))); if (u) ownerId = u.id; }
      const iw = await svc.importWallet(pk, wtype, ownerId, String(it.label || ""), false);
      imported++; importedAddrs.push(iw.address);
    } catch (e) {
      if (String(e.message).includes("already exists")) skipped++;
      else errors.push(e.message);
    }
  }
  svc.audit(req.user.id, "import_all_wallets", `imported ${imported}, skipped ${skipped}`, ip(req));
  res.json({ imported, skipped, errors, history: "fetching on-chain history in background" });
  // backfill each imported wallet's history from the chain, without blocking the response
  for (const a of importedAddrs) svc.reconcileWallet(a).catch(() => {});
}));

// Top up the gas wallet by swapping USDT (from treasury) to TRX (admin).
app.post("/gas/refill", currentUser, adminRequired, wrap(async (req, res) => {
  const usdt = Number((req.body || {}).usdt || config.get().auto_swap_usdt || 0);
  if (!(usdt > 0)) return res.status(400).json({ detail: "usdt amount must be greater than 0" });
  const r = await svc.swapToGas(usdt);
  svc.audit(req.user.id, "gas_swap", `${usdt} USDT -> ${r.trxOut || "?"} TRX to gas`, ip(req));
  res.json(r);
}));

// Reconcile against the chain (Tronscan/TronGrid): fetch an address's full USDT history and
// insert any transfers missing from our ledger. With no address, scans all our wallets (admin).
app.post("/reconcile", currentUser, adminRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const address = (b.address || "").trim();
  const mode = b.mode || (address ? "wallet" : "all");
  let r;
  if (!address || mode === "all") r = await svc.reconcileAll();
  else if (mode === "payouts-to") r = await svc.reconcilePayoutsTo(address);
  else r = await svc.reconcileWallet(address); // our deposit wallet or pool/treasury wallet
  svc.audit(req.user.id, "reconcile", `${mode} ${address || "all wallets"} — scanned ${r.scanned}, inserted ${r.inserted}`, ip(req));
  res.json(r);
}));

// Energy management: view resources, stake (freeze) or unstake (unfreeze) TRX for energy (admin).
app.get("/energy/status", currentUser, adminRequired, wrap(async (_req, res) => res.json(await svc.energyStatus())));
app.post("/energy/stake", currentUser, adminRequired, wrap(async (req, res) => {
  const trx = Number((req.body || {}).trx || 0);
  if (!(trx > 0)) return res.status(400).json({ detail: "trx must be greater than 0" });
  const r = await svc.stakeEnergy(trx); svc.audit(req.user.id, "energy_stake", `${trx} TRX`, ip(req)); res.json(r);
}));
app.post("/energy/unstake", currentUser, adminRequired, wrap(async (req, res) => {
  const trx = Number((req.body || {}).trx || 0);
  if (!(trx > 0)) return res.status(400).json({ detail: "trx must be greater than 0" });
  const r = await svc.unstakeEnergy(trx); svc.audit(req.user.id, "energy_unstake", `${trx} TRX`, ip(req)); res.json(r);
}));

// Apply the configured on-chain name to every existing customer deposit wallet (admin).
app.post("/wallets/name-customers", currentUser, adminRequired, wrap(async (req, res) => {
  const tpl = config.get().customer_onchain_name != null ? config.get().customer_onchain_name : "KryvonWallet-{id}";
  const t = String(tpl).trim() || String((req.body || {}).name || "").trim();
  if (!t) return res.status(400).json({ detail: "no on-chain name configured" });
  const appName = config.get().app_name || "KryvonWallet";
  const rows = (await getDb().prepare("SELECT * FROM wallets WHERE wtype='deposit' AND is_active=1").all());
  let named = 0, failed = 0;
  for (const w of rows) {
    const owner = w.owner_user_id ? (await getDb().prepare("SELECT username FROM users WHERE id=?").get(w.owner_user_id)) : null;
    const name = svc.renderCustomerName(t, { id: w.owner_user_id || "", username: owner ? owner.username : "", app: appName });
    if (!name) { failed++; continue; }
    try { await svc.setOnchainName(w, name); named++; } catch (e) { failed++; }
  }
  svc.audit(req.user.id, "name_customer_wallets", `named ${named}, failed ${failed}`, ip(req));
  res.json({ named, failed, total: rows.length });
}));

// Reveal a wallet's private key (admin only, audited). For backup / import / migration.
app.get("/wallets/:id/secret", currentUser, adminRequired, async (req, res) => {
  const w = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id));
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  let pk;
  try { pk = sec.decryptSecret(w.enc_privkey); } catch { return res.status(500).json({ detail: "could not decrypt key" }); }
  svc.audit(req.user.id, "reveal_private_key", `${w.wtype} ${w.address}`, ip(req));
  res.json({ address: w.address, wtype: w.wtype, private_key: pk });
});

// Rename a wallet's in-app display name (admin only).
app.post("/wallets/:id/name", currentUser, adminRequired, async (req, res) => {
  const w = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id));
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  const name = String((req.body || {}).name || "").trim();
  (await getDb().prepare("UPDATE wallets SET label=? WHERE id=?").run(name, w.id));
  svc.audit(req.user.id, "rename_wallet", `${w.address} -> ${name}`, ip(req));
  res.json(walletOut((await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(w.id))));
});

// Set the wallet's on-chain account name (admin only; one-time, permanent on TRON).
app.post("/wallets/:id/onchain-name", currentUser, adminRequired, wrap(async (req, res) => {
  const w = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id));
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ detail: "name required" });
  const r = await svc.setOnchainName(w, name);
  (await getDb().prepare("UPDATE wallets SET label=? WHERE id=?").run(name, w.id));
  svc.audit(req.user.id, "set_onchain_name", `${w.address} -> ${name} tx=${r.tx}`, ip(req));
  res.json({ ok: true, tx: r.tx });
}));

// Generate a Tronscan public-tag ownership proof (signed message) for a wallet (admin).
app.post("/wallets/:id/ownership-proof", currentUser, adminRequired, wrap(async (req, res) => {
  const w = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id));
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  const project = String((req.body || {}).project || config.get().app_name || "KryvonWallet").trim();
  const r = await svc.ownershipProof(w, project);
  svc.audit(req.user.id, "tronscan_proof", `${w.address} (${project})`, ip(req));
  res.json(r);
}));

// Map an existing deposit wallet to a customer (re-assign owner; no private key needed) — admin.
app.post("/wallets/:id/assign", currentUser, adminRequired, wrap(async (req, res) => {
  const w = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id));
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  if (w.wtype !== "deposit") return res.status(400).json({ detail: "only deposit wallets can be mapped to a customer" });
  const ownerId = (req.body || {}).owner_user_id;
  let u = null;
  if (ownerId) {
    u = (await getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(ownerId));
    if (!u) return res.status(404).json({ detail: "customer not found" });
  }
  (await getDb().prepare("UPDATE wallets SET owner_user_id=? WHERE id=?").run(u ? u.id : null, w.id));
  svc.audit(req.user.id, "assign_wallet", `${w.address} -> ${u ? u.username : "unassigned"}`, ip(req));
  let history = null;
  try { history = await svc.reconcileWallet(w.address); } catch (e) { /* best-effort */ }
  res.json({ ok: true, address: w.address, owner: u ? u.username : null, history });
}));

// Import an existing private key as a wallet (admin only).
// Remove (deactivate) a wallet — soft delete, keeps history; excluded from sweeps/payouts.
app.post("/wallets/:id/deactivate", currentUser, adminRequired, wrap(async (req, res) => {
  const w = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id));
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  (await getDb().prepare("UPDATE wallets SET is_active=0 WHERE id=?").run(w.id));
  svc.audit(req.user.id, "deactivate_wallet", `${w.wtype} ${w.address}`, ip(req));
  res.json({ ok: true });
}));

// Re-add (reactivate) a previously removed wallet.
app.post("/wallets/:id/activate", currentUser, adminRequired, wrap(async (req, res) => {
  const w = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id));
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  if (w.wtype === "treasury" || w.wtype === "fee") {
    const other = (await getDb().prepare("SELECT 1 FROM wallets WHERE wtype=? AND is_active=1 AND id<>?").get(w.wtype, w.id));
    if (other) return res.status(400).json({ detail: `an active ${w.wtype === "fee" ? "gas" : w.wtype} wallet already exists — remove it first` });
  }
  (await getDb().prepare("UPDATE wallets SET is_active=1 WHERE id=?").run(w.id));
  svc.audit(req.user.id, "activate_wallet", `${w.wtype} ${w.address}`, ip(req));
  res.json({ ok: true });
}));

app.post("/wallets/import", currentUser, adminRequired, wrap(async (req, res) => {
  const { private_key, wtype, label, owner_user_id } = req.body || {};
  if (!private_key) return res.status(400).json({ detail: "private_key required" });
  if (!["treasury", "fee", "disbursement", "deposit"].includes(wtype)) return res.status(400).json({ detail: "invalid wallet type" });
  if (wtype === "treasury" && await svc.getTreasury()) return res.status(400).json({ detail: "treasury already exists" });
  let owner = null;
  if (owner_user_id) {
    const u = (await getDb().prepare("SELECT id FROM users WHERE id=?").get(owner_user_id));
    if (!u) return res.status(404).json({ detail: "owner user not found" });
    owner = u.id;
  }
  const w = await svc.importWallet(String(private_key), wtype, owner, String(label || "imported"));
  svc.audit(req.user.id, "import_wallet", `${wtype} ${w.address}`, ip(req));
  let history = null; // fetch this wallet's on-chain history from Tronscan/TronGrid and backfill
  try { history = await svc.reconcileWallet(w.address); } catch (e) { /* best-effort */ }
  res.json({ ...walletOut(w), history });
}));

// Total liquidity available for payouts (treasury + pool), admin/staff.
app.get("/liquidity", currentUser, staffOrAdmin, wrap(async (req, res) => {
  const chain = require("./chain");
  const db = getDb();
  const safe = async (a) => { try { return Number(await chain.usdtBalance(a)); } catch { return 0; } };
  const treasury = await svc.getTreasury();
  const pool = (await db.prepare("SELECT address FROM wallets WHERE wtype='disbursement' AND is_active=1").all());
  let poolTotal = 0;
  for (const w of pool) poolTotal += await safe(w.address);
  const tre = treasury ? await safe(treasury.address) : 0;
  res.json({ treasury: tre, pool_total: poolTotal, total: tre + poolTotal, pool_count: pool.length });
}));

// ---------------- disbursements ----------------
app.post("/disbursements", currentUser, staffOrAdmin, wrap(async (req, res) => {
  const { to_address, amount, reason, customer_id } = req.body || {};
  if (!(Number(amount) > 0)) return res.status(400).json({ detail: "amount must be positive" });
  let dest = to_address ? String(to_address) : null;
  let custId = null;
  if (customer_id) {
    const cust = (await getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(customer_id));
    if (!cust) return res.status(404).json({ detail: "customer not found" });
    if (cust.customer_type !== "remittance") return res.status(400).json({ detail: "payouts are only for remittance customers" });
    const wl = (await getDb().prepare("SELECT * FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(customer_id));
    if (!wl.length) return res.status(400).json({ detail: "customer has no whitelisted address" });
    if (dest) {
      if (!wl.some((w) => w.address === dest)) return res.status(400).json({ detail: "destination is not in the customer's whitelist" });
    } else if (wl.length === 1) {
      dest = wl[0].address;
    } else {
      return res.status(400).json({ detail: "specify which whitelisted address to use" });
    }
    custId = Number(customer_id);
  }
  if (!dest) return res.status(400).json({ detail: "recipient address required" });
  if (config.get().payout_allowlist_only && !(await addressAllowed(dest)))
    return res.status(400).json({ detail: "allow-list mode is on — destination must be in the address book or a customer whitelist" });
  const info = (await getDb().prepare(
    "INSERT INTO disbursement_requests(staff_user_id,customer_id,to_address,amount,status,reason,created_at) VALUES(?,?,?,?,'pending',?,?)"
  ).run(req.user.id, custId, dest, String(amount), String(reason || ""), new Date().toISOString()));
  svc.audit(req.user.id, "disbursement_request", `req#${info.lastInsertRowid} ${amount} USDT -> ${dest}${custId ? ` (customer #${custId})` : ""}`, ip(req));

  // Admin payouts execute immediately. Staff payouts auto-execute at/below their
  // own limit (or the global default if they have none); otherwise await approval.
  const reqRow = (await getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(info.lastInsertRowid));
  const isAdmin = req.user.role === "admin";
  const staffLimit = req.user.auto_approve_limit != null
    ? Number(req.user.auto_approve_limit)
    : Number(config.get().staff_auto_approve_limit || 0);
  const auto = isAdmin || (staffLimit > 0 && Number(amount) <= staffLimit);
  if (auto) {
    try {
      const updated = await svc.executeDisbursement(reqRow, req.user.id, isAdmin ? null : staffLimit);
      svc.audit(req.user.id, isAdmin ? "disbursement_executed" : "disbursement_auto_approved",
        `req#${updated.id}${isAdmin ? " (admin)" : " <= limit " + staffLimit}`, ip(req));
      return res.json(disbOut(updated));
    } catch (e) {
      // Surface the real reason (e.g. "treasury has no TRX for fees", "insufficient liquidity")
      // instead of silently showing the request as pending. It stays pending so it can be retried.
      return res.status(400).json({ detail: `payout could not be sent — ${e.message}. It's saved as pending; fix the issue and approve to retry.`, request_id: info.lastInsertRowid });
    }
  }
  res.json(disbOut(reqRow));
}));

app.post("/disbursements/:id/approve", currentUser, adminRequired, wrap(async (req, res) => {
  const reqRow = (await getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(req.params.id));
  if (!reqRow) return res.status(404).json({ detail: "request not found" });
  if (reqRow.status !== "pending" || reqRow.tx_hash) return res.status(400).json({ detail: "request already processed" });
  const threshold = Number(config.get().dual_control_threshold || 0);
  if (threshold > 0 && Number(reqRow.amount) >= threshold) {
    if (!reqRow.first_approver) {
      (await getDb().prepare("UPDATE disbursement_requests SET first_approver=? WHERE id=?").run(req.user.id, reqRow.id));
      svc.audit(req.user.id, "disbursement_first_approval", `req#${reqRow.id} (awaiting 2nd approval)`, ip(req));
      return res.json(disbOut((await getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(reqRow.id))));
    }
    if (reqRow.first_approver === req.user.id) return res.status(400).json({ detail: "a different admin must give the second approval" });
  }
  const updated = await svc.executeDisbursement(reqRow, req.user.id);
  svc.audit(req.user.id, "disbursement_approve", `req#${updated.id} tx=${updated.tx_hash} from_wallet=${updated.from_wallet_id}`, ip(req));
  res.json(disbOut(updated));
}));

app.get("/disbursements", currentUser, async (req, res) => {
  const rows = req.user.role === "admin"
    ? (await getDb().prepare("SELECT * FROM disbursement_requests ORDER BY id DESC").all())
    : (await getDb().prepare("SELECT * FROM disbursement_requests WHERE staff_user_id=? ORDER BY id DESC").all(req.user.id));
  res.json(rows.map(disbOut));
});

// ---------------- customers (managed by staff/admin) ----------------
app.post("/customers", currentUser, staffOrAdmin, wrap(async (req, res) => {
  const { username, password, customer_type, label, whitelist_address, phone } = req.body || {};
  if (String(username || "").length < 3) return res.status(400).json({ detail: "username too short" });
  if (String(password || "").length < 8) return res.status(400).json({ detail: "password must be at least 8 characters" });
  if (!["depositor", "remittance"].includes(customer_type)) return res.status(400).json({ detail: "customer_type must be depositor or remittance" });
  if ((await getDb().prepare("SELECT 1 FROM users WHERE username=?").get(username))) return res.status(400).json({ detail: "username exists" });

  const payTok = crypto.randomBytes(12).toString("base64url");
  const info = (await getDb().prepare("INSERT INTO users(username,password_hash,role,is_active,customer_type,phone,pay_token,created_at) VALUES(?,?,'customer',1,?,?,?,?)")
    .run(username, sec.hashPassword(password), customer_type, String(phone || "").trim() || null, payTok, new Date().toISOString()));
  const custId = info.lastInsertRowid;
  const out = { id: custId, username, role: "customer", customer_type };

  if (customer_type === "depositor") {
    const pk = String((req.body || {}).private_key || "").trim();
    const w = pk
      ? await svc.importWallet(pk, "deposit", custId, String(label || `${username} deposit`), false)
      : await svc.createWallet("deposit", custId, String(label || `${username} deposit`));
    out.deposit_address = w.address;
  } else if (whitelist_address) {
    (await getDb().prepare("INSERT INTO customer_whitelist(customer_id,address,label,is_active,created_by,created_at) VALUES(?,?,?,1,?,?)")
      .run(custId, String(whitelist_address), String(label || ""), req.user.id, new Date().toISOString()));
    out.whitelist = [{ address: String(whitelist_address), label: String(label || "") }];
  }
  svc.audit(req.user.id, "create_customer", `${username} (${customer_type})`, ip(req));
  res.json(out);
}));

app.get("/customers", currentUser, staffOrAdmin, async (req, res) => {
  let rows = (await getDb().prepare("SELECT * FROM users WHERE role='customer' ORDER BY id").all());
  if (req.user.role === "staff") { const ids = new Set(await assignedCustomerIds(req.user.id)); rows = rows.filter((u) => ids.has(u.id)); }
  res.json(await Promise.all(rows.map(async (u) => {
    const wl = (await getDb().prepare("SELECT COUNT(*) c FROM customer_whitelist WHERE customer_id=? AND is_active=1").get(u.id)).c;
    const dep = (await getDb().prepare("SELECT address FROM wallets WHERE owner_user_id=? AND wtype='deposit' LIMIT 1").get(u.id));
    const staffCount = (await getDb().prepare("SELECT COUNT(*) c FROM customer_staff WHERE customer_id=?").get(u.id)).c;
    return { id: u.id, username: u.username, customer_type: u.customer_type, is_active: !!u.is_active, whitelist_count: wl, deposit_address: dep ? dep.address : null, phone: u.phone || null, staff_count: staffCount };
  })));
});

app.get("/customers/:id", currentUser, staffOrAdmin, async (req, res) => {
  const u = (await getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(req.params.id));
  if (!u) return res.status(404).json({ detail: "customer not found" });
  if (req.user.role === "staff" && !(await canAccessCustomer(req.user, u.id))) return res.status(403).json({ detail: "not your customer" });
  const whitelist = (await getDb().prepare("SELECT id,address,label,is_active FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(u.id));
  const deposit_addresses = (await getDb().prepare("SELECT id,address,label FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(u.id));
  const assigned_staff = (await getDb().prepare("SELECT u.id,u.username FROM customer_staff cs JOIN users u ON u.id=cs.staff_id WHERE cs.customer_id=?").all(u.id));
  res.json({ id: u.id, username: u.username, customer_type: u.customer_type, is_active: !!u.is_active, phone: u.phone || null, pay_token: await ensurePayToken(u), whitelist, deposit_addresses, assigned_staff });
});

// assign / unassign staff to a customer (admin)
app.post("/customers/:id/staff", currentUser, adminRequired, async (req, res) => {
  const u = (await getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(req.params.id));
  if (!u) return res.status(404).json({ detail: "customer not found" });
  const staff = (await getDb().prepare("SELECT * FROM users WHERE id=?").get((req.body || {}).staff_id));
  if (!staff || !["staff", "admin"].includes(staff.role)) return res.status(400).json({ detail: "pick a staff member" });
  if (!(await getDb().prepare("SELECT 1 FROM customer_staff WHERE customer_id=? AND staff_id=?").get(u.id, staff.id)))
    (await getDb().prepare("INSERT INTO customer_staff(customer_id,staff_id,created_at) VALUES(?,?,?)").run(u.id, staff.id, new Date().toISOString()));
  svc.audit(req.user.id, "assign_staff", `${staff.username} -> customer #${u.id}`, ip(req));
  res.json({ ok: true });
});
app.delete("/customers/:id/staff/:sid", currentUser, adminRequired, async (req, res) => {
  (await getDb().prepare("DELETE FROM customer_staff WHERE customer_id=? AND staff_id=?").run(req.params.id, req.params.sid));
  svc.audit(req.user.id, "unassign_staff", `staff #${req.params.sid} x customer #${req.params.id}`, ip(req));
  res.json({ ok: true });
});

// a staff member's assigned customers (admin sees all), with received totals + recent activity
app.get("/my/customers", currentUser, staffOrAdmin, async (req, res) => {
  const db = getDb();
  let custs;
  if (req.user.role === "admin") custs = (await db.prepare("SELECT * FROM users WHERE role='customer' ORDER BY id").all());
  else {
    const ids = (await db.prepare("SELECT customer_id FROM customer_staff WHERE staff_id=?").all(req.user.id)).map((r) => r.customer_id);
    custs = ids.length ? (await db.prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids)) : [];
  }
  res.json(await Promise.all(custs.map(async (u) => {
    let total = 0, recent = [];
    if (u.customer_type === "remittance") {
      total = (await db.prepare("SELECT COALESCE(SUM(CAST(amount AS REAL)),0) s FROM disbursement_requests WHERE customer_id=? AND tx_hash IS NOT NULL").get(u.id)).s;
      recent = (await db.prepare("SELECT * FROM disbursement_requests WHERE customer_id=? ORDER BY id DESC LIMIT 5").all(u.id)).map(disbOut);
    } else {
      const wids = (await db.prepare("SELECT id FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(u.id)).map((w) => w.id);
      if (wids.length) {
        const inq = wids.map(() => "?").join(",");
        total = (await db.prepare(`SELECT COALESCE(SUM(CAST(amount AS REAL)),0) s FROM movements WHERE kind='deposit_in' AND wallet_id IN (${inq})`).get(...wids)).s;
        recent = (await db.prepare(`SELECT * FROM movements WHERE kind='deposit_in' AND wallet_id IN (${inq}) ORDER BY id DESC LIMIT 5`).all(...wids)).map(moveOut);
      }
    }
    return { id: u.id, username: u.username, customer_type: u.customer_type, phone: u.phone || null, pay_token: await ensurePayToken(u), total_received: total, recent };
  })));
});

// ---------------- messaging (customer thread) ----------------
app.get("/customers/:id/messages", currentUser, async (req, res) => {
  if (!(await canAccessCustomer(req.user, req.params.id))) return res.status(403).json({ detail: "not permitted" });
  const rows = (await getDb().prepare("SELECT * FROM messages WHERE customer_id=? ORDER BY id ASC LIMIT 500").all(req.params.id));
  res.json(rows.map((m) => ({ id: m.id, sender_user_id: m.sender_user_id, sender_role: m.sender_role, sender_name: m.sender_name, body: m.body, kind: m.kind, ref_tx: m.ref_tx, created_at: m.created_at })));
});
app.post("/customers/:id/messages", currentUser, async (req, res) => {
  if (!(await canAccessCustomer(req.user, req.params.id))) return res.status(403).json({ detail: "not permitted" });
  const cust = (await getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(req.params.id));
  if (!cust) return res.status(404).json({ detail: "customer not found" });
  const { body, kind, ref_tx } = req.body || {};
  const k = ["text", "receipt", "ack"].includes(kind) ? kind : "text";
  if (!String(body || "").trim()) return res.status(400).json({ detail: "empty message" });
  const info = (await getDb().prepare("INSERT INTO messages(customer_id,sender_user_id,sender_role,sender_name,body,kind,ref_tx,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(cust.id, req.user.id, req.user.role, req.user.username, String(body || ""), k, ref_tx ? String(ref_tx) : null, new Date().toISOString()));
  svc.audit(req.user.id, "message", `customer #${cust.id} (${k})`, ip(req));
  res.json({ id: info.lastInsertRowid, kind: k });
});

app.post("/customers/:id/whitelist", currentUser, staffOrAdmin, async (req, res) => {
  const u = (await getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(req.params.id));
  if (!u) return res.status(404).json({ detail: "customer not found" });
  if (u.customer_type !== "remittance") return res.status(400).json({ detail: "only remittance customers have a whitelist" });
  const { address, label } = req.body || {};
  if (!address) return res.status(400).json({ detail: "address required" });
  const info = (await getDb().prepare("INSERT INTO customer_whitelist(customer_id,address,label,is_active,created_by,created_at) VALUES(?,?,?,1,?,?)")
    .run(u.id, String(address), String(label || ""), req.user.id, new Date().toISOString()));
  svc.audit(req.user.id, "whitelist_add", `customer #${u.id} ${address}`, ip(req));
  res.json({ id: info.lastInsertRowid, address: String(address), label: String(label || ""), is_active: true });
});

app.delete("/customers/:id/whitelist/:wid", currentUser, staffOrAdmin, async (req, res) => {
  const row = (await getDb().prepare("SELECT * FROM customer_whitelist WHERE id=? AND customer_id=?").get(req.params.wid, req.params.id));
  if (!row) return res.status(404).json({ detail: "whitelist entry not found" });
  (await getDb().prepare("UPDATE customer_whitelist SET is_active=0 WHERE id=?").run(row.id));
  svc.audit(req.user.id, "whitelist_remove", `customer #${req.params.id} ${row.address}`, ip(req));
  res.json({ ok: true });
});

// ---------------- customer portal (customer role only; read-only, no payouts) ----------------
app.get("/customer/me", currentUser, customerOnly, async (req, res) => {
  const u = req.user;
  const whitelist = (await getDb().prepare("SELECT id,address,label FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(u.id));
  const deposit_addresses = (await getDb().prepare("SELECT id,address,label FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(u.id));
  res.json({ id: u.id, username: u.username, customer_type: u.customer_type, whitelist, deposit_addresses });
});

app.get("/customer/deposits", currentUser, customerOnly, async (req, res) => {
  const ids = (await getDb().prepare("SELECT id FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(req.user.id)).map((w) => w.id);
  if (!ids.length) return res.json([]);
  const q = `SELECT * FROM movements WHERE kind='deposit_in' AND wallet_id IN (${ids.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 500`;
  res.json((await getDb().prepare(q).all(...ids)).map(moveOut));
});

app.get("/customer/transfers", currentUser, customerOnly, async (req, res) => {
  res.json((await getDb().prepare("SELECT * FROM disbursement_requests WHERE customer_id=? ORDER BY id DESC").all(req.user.id)).map(disbOut));
});

app.get("/customer/dashboard", currentUser, customerOnly, async (req, res) => {
  const db = getDb();
  const u = req.user;
  if (u.customer_type === "depositor") {
    const wallets = (await db.prepare("SELECT id,address,label FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(u.id));
    const ids = wallets.map((w) => w.id);
    let recent = [], total = 0;
    if (ids.length) {
      const inq = ids.map(() => "?").join(",");
      recent = (await db.prepare(`SELECT * FROM movements WHERE kind='deposit_in' AND wallet_id IN (${inq}) ORDER BY id DESC LIMIT 10`).all(...ids)).map(moveOut);
      total = (await db.prepare(`SELECT COALESCE(SUM(CAST(amount AS REAL)),0) s FROM movements WHERE kind='deposit_in' AND wallet_id IN (${inq})`).get(...ids)).s;
    }
    return res.json({ customer_type: "depositor", network: config.get().tron_network, deposit_addresses: wallets, total_received: total, recent });
  }
  const whitelist = (await db.prepare("SELECT id,address,label FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(u.id));
  const recent = (await db.prepare("SELECT * FROM disbursement_requests WHERE customer_id=? ORDER BY id DESC LIMIT 10").all(u.id)).map(disbOut);
  const total = (await db.prepare("SELECT COALESCE(SUM(CAST(amount AS REAL)),0) s FROM disbursement_requests WHERE customer_id=? AND tx_hash IS NOT NULL").get(u.id)).s;
  res.json({ customer_type: "remittance", network: config.get().tron_network, whitelist, total_received: total, recent });
});

// ---------------- settings (admin sets; staff can read) ----------------
function settingsOut() {
  const c = config.get();
  return {
    staff_auto_approve_limit: Number(c.staff_auto_approve_limit || 0),
    treasury_hold_percent: Number(c.treasury_hold_percent != null ? c.treasury_hold_percent : 10),
    max_disburse_usdt: Number(c.max_disburse_usdt != null ? c.max_disburse_usdt : 2000),
  };
}
app.get("/settings", currentUser, staffOrAdmin, async (_req, res) => res.json(settingsOut()));
app.post("/settings", currentUser, adminRequired, async (req, res) => {
  const c = { ...config.get() };
  const b = req.body || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  if (b.staff_auto_approve_limit !== undefined) { const n = num(b.staff_auto_approve_limit); if (n === null) return res.status(400).json({ detail: "invalid limit" }); c.staff_auto_approve_limit = n; }
  if (b.treasury_hold_percent !== undefined) { const n = num(b.treasury_hold_percent); if (n === null || n > 100) return res.status(400).json({ detail: "invalid hold percent" }); c.treasury_hold_percent = n; }
  if (b.max_disburse_usdt !== undefined) { const n = num(b.max_disburse_usdt); if (n === null) return res.status(400).json({ detail: "invalid max" }); c.max_disburse_usdt = n; }
  config.save(c);
  svc.audit(req.user.id, "update_settings", JSON.stringify(settingsOut()), ip(req));
  res.json(settingsOut());
});

// Full operational config — admin only. The API key is returned masked; the
// wallet encryption key and app secret are never exposed or editable here.
function maskKey(k) { if (!k) return ""; return k.length <= 8 ? "••••" : k.slice(0, 4) + "…" + k.slice(-4); }
app.get("/admin/config", currentUser, adminRequired, async (_req, res) => {
  const c = config.get();
  res.json({
    tron_network: c.tron_network,
    usdt_contract: c.usdt_contract,
    trongrid_api_key_masked: maskKey(c.trongrid_api_key || ""),
    has_trongrid_key: !!c.trongrid_api_key,
    sweep_min_usdt: Number(c.sweep_min_usdt || 0),
    gas_fund_trx: Number(c.gas_fund_trx || 0),
    disbursement_float_usdt: Number(c.disbursement_float_usdt || 0),
    poll_interval_seconds: Number(c.poll_interval_seconds || 30),
    treasury_hold_percent: Number(c.treasury_hold_percent != null ? c.treasury_hold_percent : 10),
    staff_auto_approve_limit: Number(c.staff_auto_approve_limit || 0),
    deposit_fee_percent: Number(c.deposit_fee_percent || 0),
    dual_control_threshold: Number(c.dual_control_threshold || 0),
    webhook_url: c.webhook_url || "",
    payout_allowlist_only: !!c.payout_allowlist_only,
    auto_distribute_enabled: !!c.auto_distribute_enabled,
    wallet_preload_trx: Number(c.wallet_preload_trx != null ? c.wallet_preload_trx : 20),
    app_name: c.app_name || "KryvonWallet",
    brand_logo: c.brand_logo || "",
    favicon: c.favicon || "",
    qr_logo: c.qr_logo || "",
    customer_onchain_name: c.customer_onchain_name != null ? c.customer_onchain_name : "KryvonWallet-{id}",
    energy_mode: c.energy_mode || "auto",
    energy_provider: c.energy_provider || "",
    tronzap_api_token: c.tronzap_api_token || "",
    tronzap_api_secret_masked: maskKey(c.tronzap_api_secret || ""),
    has_tronzap_secret: !!c.tronzap_api_secret,
    tronzap_base_url: c.tronzap_base_url || "",
    tronzap_bandwidth: Number(c.tronzap_bandwidth != null ? c.tronzap_bandwidth : 345),
    tronzap_activate: !!c.tronzap_activate,
    energy_delegate_trx: Number(c.energy_delegate_trx || 0),
    energy_rental_url: c.energy_rental_url || "",
    energy_rental_api_key: c.energy_rental_api_key || "",
    energy_rental_amount: Number(c.energy_rental_amount != null ? c.energy_rental_amount : 65000),
    auto_swap_enabled: !!c.auto_swap_enabled,
    gas_min_trx: Number(c.gas_min_trx != null ? c.gas_min_trx : 100),
    auto_swap_usdt: Number(c.auto_swap_usdt != null ? c.auto_swap_usdt : 50),
    swap_slippage_percent: Number(c.swap_slippage_percent != null ? c.swap_slippage_percent : 5),
    db_engine: dialect(),
    setup_at: c.setup_at || null,
  });
});
app.post("/admin/config", currentUser, adminRequired, async (req, res) => {
  const c = { ...config.get() };
  const b = req.body || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  if (b.tron_network !== undefined) {
    if (!["mainnet", "nile", "shasta"].includes(b.tron_network)) return res.status(400).json({ detail: "invalid network" });
    c.tron_network = b.tron_network;
  }
  if (b.usdt_contract !== undefined) { const v = String(b.usdt_contract || "").trim(); if (!v) return res.status(400).json({ detail: "contract required" }); c.usdt_contract = v; }
  if (b.trongrid_api_key !== undefined) { const v = String(b.trongrid_api_key || "").trim(); if (v) c.trongrid_api_key = v; } // blank = keep existing
  for (const k of ["sweep_min_usdt", "gas_fund_trx", "disbursement_float_usdt", "poll_interval_seconds", "treasury_hold_percent", "staff_auto_approve_limit", "deposit_fee_percent", "dual_control_threshold", "wallet_preload_trx"]) {
    if (b[k] !== undefined) {
      const n = num(b[k]); if (n === null) return res.status(400).json({ detail: "invalid " + k });
      if ((k === "treasury_hold_percent" || k === "deposit_fee_percent") && n > 100) return res.status(400).json({ detail: k + " must be 0–100" });
      c[k] = n;
    }
  }
  if (b.webhook_url !== undefined) c.webhook_url = String(b.webhook_url || "").trim();
  if (b.payout_allowlist_only !== undefined) c.payout_allowlist_only = !!b.payout_allowlist_only;
  if (b.auto_distribute_enabled !== undefined) c.auto_distribute_enabled = !!b.auto_distribute_enabled;
  if (b.app_name !== undefined) c.app_name = String(b.app_name || "").trim().slice(0, 60) || "KryvonWallet";
  if (b.customer_onchain_name !== undefined) c.customer_onchain_name = String(b.customer_onchain_name || "").trim().slice(0, 64);
  if (b.energy_mode !== undefined) c.energy_mode = ["auto", "burn", "stake", "rental"].includes(String(b.energy_mode)) ? String(b.energy_mode) : "auto";
  if (b.energy_provider !== undefined) c.energy_provider = ["", "tronzap", "generic"].includes(String(b.energy_provider)) ? String(b.energy_provider) : "";
  if (b.tronzap_api_token !== undefined) c.tronzap_api_token = String(b.tronzap_api_token || "").trim();
  if (b.tronzap_api_secret !== undefined && String(b.tronzap_api_secret||"").trim() && !/[\u2022\u2026*]/.test(String(b.tronzap_api_secret))) c.tronzap_api_secret = String(b.tronzap_api_secret).trim();
  if (b.tronzap_base_url !== undefined) c.tronzap_base_url = String(b.tronzap_base_url || "").trim();
  if (b.tronzap_bandwidth !== undefined) c.tronzap_bandwidth = Math.max(0, Number(b.tronzap_bandwidth) || 0);
  if (b.tronzap_activate !== undefined) c.tronzap_activate = !!b.tronzap_activate;
  if (b.energy_delegate_trx !== undefined) c.energy_delegate_trx = Math.max(0, Number(b.energy_delegate_trx) || 0);
  if (b.energy_rental_url !== undefined) c.energy_rental_url = String(b.energy_rental_url || "").trim();
  if (b.energy_rental_api_key !== undefined) c.energy_rental_api_key = String(b.energy_rental_api_key || "").trim();
  if (b.energy_rental_amount !== undefined) c.energy_rental_amount = Math.max(0, Number(b.energy_rental_amount) || 0);
  if (b.auto_swap_enabled !== undefined) c.auto_swap_enabled = !!b.auto_swap_enabled;
  if (b.gas_min_trx !== undefined) c.gas_min_trx = Math.max(0, Number(b.gas_min_trx) || 0);
  if (b.auto_swap_usdt !== undefined) c.auto_swap_usdt = Math.max(0, Number(b.auto_swap_usdt) || 0);
  if (b.swap_slippage_percent !== undefined) c.swap_slippage_percent = Math.min(50, Math.max(0, Number(b.swap_slippage_percent) || 0));
  for (const k of ["brand_logo", "favicon", "qr_logo"]) {
    if (b[k] !== undefined) {
      const v = String(b[k] || "");
      if (v.length > 700000) return res.status(400).json({ detail: `${k} image is too large (keep under ~500 KB)` });
      c[k] = v;
    }
  }
  if (c.tron_network === "mainnet" && !c.trongrid_api_key) return res.status(400).json({ detail: "mainnet requires a TronGrid API key" });
  config.save(c);
  svc.audit(req.user.id, "update_config", `network=${c.tron_network} contract=${c.usdt_contract}`, ip(req));
  res.json({ ok: true });
});

// Reveal the full TronGrid API key (admin only, audited).
app.get("/admin/config/apikey", currentUser, adminRequired, async (req, res) => {
  svc.audit(req.user.id, "reveal_api_key", "trongrid", ip(req));
  res.json({ trongrid_api_key: config.get().trongrid_api_key || "" });
});

// ---------------- API keys (admin manages; external systems use them) ----------------
const API_SCOPES = ["read", "deposits", "payouts"];
app.post("/apikeys", currentUser, adminRequired, async (req, res) => {
  const { name, scopes } = req.body || {};
  const scopeList = Array.isArray(scopes) ? scopes.filter((s) => API_SCOPES.includes(s)) : [];
  if (!scopeList.length) return res.status(400).json({ detail: "select at least one scope" });
  const key = sec.generateApiKey();
  (await getDb().prepare("INSERT INTO api_keys(name,key_hash,prefix,scopes,created_by,is_active,created_at) VALUES(?,?,?,?,?,1,?)")
    .run(String(name || ""), sec.hashApiKey(key), key.slice(0, 11), scopeList.join(","), req.user.id, new Date().toISOString()));
  svc.audit(req.user.id, "apikey_create", `${name || ""} [${scopeList.join(",")}]`, ip(req));
  res.json({ key, prefix: key.slice(0, 11), scopes: scopeList, note: "Save this key now — it will not be shown again." });
});
app.get("/apikeys", currentUser, adminRequired, async (_req, res) => {
  res.json((await getDb().prepare("SELECT id,name,prefix,scopes,is_active,last_used,created_at FROM api_keys ORDER BY id DESC").all())
    .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: (k.scopes || "").split(",").filter(Boolean), is_active: !!k.is_active, last_used: k.last_used, created_at: k.created_at })));
});
app.post("/apikeys/:id/revoke", currentUser, adminRequired, async (req, res) => {
  const k = (await getDb().prepare("SELECT * FROM api_keys WHERE id=?").get(req.params.id));
  if (!k) return res.status(404).json({ detail: "not found" });
  (await getDb().prepare("UPDATE api_keys SET is_active=0 WHERE id=?").run(k.id));
  svc.audit(req.user.id, "apikey_revoke", k.prefix, ip(req));
  res.json({ ok: true });
});

// ---------------- programmatic API (X-API-Key) ----------------
async function apiAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key) return res.status(401).json({ detail: "missing X-API-Key" });
  const row = (await getDb().prepare("SELECT * FROM api_keys WHERE key_hash=? AND is_active=1").get(sec.hashApiKey(String(key))));
  if (!row) return res.status(401).json({ detail: "invalid API key" });
  (await getDb().prepare("UPDATE api_keys SET last_used=? WHERE id=?").run(new Date().toISOString(), row.id));
  req.apiKey = { id: row.id, name: row.name, scopes: (row.scopes || "").split(",").filter(Boolean), created_by: row.created_by };
  next();
}
const requireScope = (s) => (req, res, next) =>
  req.apiKey && req.apiKey.scopes.includes(s) ? next() : res.status(403).json({ detail: `API key lacks '${s}' scope` });

app.get("/api/v1/ping", apiAuth, async (req, res) => res.json({ ok: true, name: req.apiKey.name, scopes: req.apiKey.scopes }));

app.get("/api/v1/wallets/:address/balance", apiAuth, requireScope("read"), wrap(async (req, res) => {
  const chain = require("./chain");
  res.json({ address: req.params.address, usdt: String(await chain.usdtBalance(req.params.address)), native: String(await chain.nativeBalance(req.params.address)) });
}));

app.post("/api/v1/deposit-wallets", apiAuth, requireScope("deposits"), wrap(async (req, res) => {
  const { customer_id, label } = req.body || {};
  let owner = null;
  if (customer_id) {
    const c = (await getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(customer_id));
    if (!c) return res.status(404).json({ detail: "customer not found" });
    owner = c.id;
  }
  const w = await svc.createWallet("deposit", owner, String(label || "api"));
  svc.audit(req.apiKey.created_by, "create_deposit_wallet", `${w.address} (via API ${req.apiKey.name})`, ip(req));
  res.json({ address: w.address, chain: w.chain, owner_user_id: w.owner_user_id, label: w.label });
}));

app.get("/api/v1/transactions", apiAuth, requireScope("read"), async (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 100);
  res.json(await Promise.all((await getDb().prepare("SELECT * FROM movements ORDER BY id DESC LIMIT ?").all(limit)).map(txOut)));
});

app.post("/api/v1/payouts", apiAuth, requireScope("payouts"), wrap(async (req, res) => {
  const { to_address, amount, reason, idempotency_key } = req.body || {};
  if (!to_address) return res.status(400).json({ detail: "to_address required" });
  if (!(Number(amount) > 0)) return res.status(400).json({ detail: "amount must be positive" });
  if (config.get().payout_allowlist_only && !(await addressAllowed(String(to_address))))
    return res.status(400).json({ detail: "allow-list mode is on — destination not allowed" });
  const creator = req.apiKey.created_by;
  if (idempotency_key) {
    const existing = (await getDb().prepare("SELECT * FROM disbursement_requests WHERE idempotency_key=?").get(String(idempotency_key)));
    if (existing) return res.json(disbOut(existing));
  }
  const info = (await getDb().prepare("INSERT INTO disbursement_requests(staff_user_id,to_address,amount,status,reason,idempotency_key,created_at) VALUES(?,?,?,'pending',?,?,?)")
    .run(creator, String(to_address), String(amount), String(reason || `api ${req.apiKey.name}`), idempotency_key ? String(idempotency_key) : null, new Date().toISOString()));
  const reqRow = (await getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(info.lastInsertRowid));
  svc.audit(creator, "disbursement_request", `req#${reqRow.id} ${amount} USDT -> ${to_address} (via API ${req.apiKey.name})`, ip(req));
  const limit = Number(config.get().staff_auto_approve_limit || 0);
  if (limit > 0 && Number(amount) <= limit) {
    try {
      const updated = await svc.executeDisbursement(reqRow, creator, limit);
      svc.audit(creator, "disbursement_auto_approved", `req#${updated.id} (API)`, ip(req));
      return res.json(disbOut(updated));
    } catch (e) {
      return res.status(400).json({ detail: `payout could not be sent — ${e.message}`, request_id: reqRow.id });
    }
  }
  res.json(disbOut(reqRow));
}));

// ---------------- CSV export (admin) ----------------
function csvEscape(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
// Build a movements query from export/search filters (address, from, to).
function txExportQuery(q, cap) {
  const w = [], p = [];
  const addr = (q.address || "").trim();
  if (addr) { w.push("(from_address=? OR to_address=?)"); p.push(addr, addr); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || "")) { w.push("substr(created_at,1,10) >= ?"); p.push(q.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || "")) { w.push("substr(created_at,1,10) <= ?"); p.push(q.to); }
  const where = w.length ? "WHERE " + w.join(" AND ") : "";
  return { sql: `SELECT * FROM movements ${where} ORDER BY id DESC LIMIT ${cap}`, params: p };
}

app.get("/transactions.csv", currentUser, adminRequired, async (req, res) => {
  const { sql, params } = txExportQuery(req.query, 1000000);
  const rows = (await getDb().prepare(sql).all(...params));
  const who = await custLookup(getDb(), rows);
  const head = ["id", "created_at", "kind", "token", "from_address", "to_address", "amount", "usd_rate", "energy", "status", "tx_hash", "initiated_by", "customer"];
  const lines = [head.join(",")].concat(await Promise.all(rows.map(async (m) => [m.id, m.created_at, m.kind, m.token, m.from_address, m.to_address, m.amount, m.usd_rate, m.energy || "", m.status, m.tx_hash, await userName(m.initiated_by), who(m) || ""].map(csvEscape).join(","))));
  res.set("Content-Type", "text/csv").set("Content-Disposition", "attachment; filename=transactions.csv").send(lines.join("\n"));
});

// Export the ledger as JSON (admin).
app.get("/transactions.json", currentUser, adminRequired, async (req, res) => {
  const { sql, params } = txExportQuery(req.query, 1000000);
  const raw = (await getDb().prepare(sql).all(...params));
  const who = await custLookup(getDb(), raw);
  const rows = await Promise.all(raw.map(async (m) => ({ kind: m.kind, token: m.token, from_address: m.from_address, to_address: m.to_address, amount: m.amount, usd_rate: m.usd_rate, energy: m.energy, status: m.status, tx_hash: m.tx_hash, note: m.note, created_at: m.created_at, initiated_by: await userName(m.initiated_by), customer: who(m) || "" })));
  svc.audit(req.user.id, "export_transactions", `${rows.length} rows`, ip(req));
  res.set("Content-Type", "application/json").set("Content-Disposition", "attachment; filename=transactions.json")
     .send(JSON.stringify({ exported_at: new Date().toISOString(), network: config.get().tron_network, transactions: rows }, null, 2));
});

// Import ledger rows from a JSON/CSV export (admin, audited). Deduplicates; does NOT move funds.
app.post("/transactions/import", currentUser, adminRequired, wrap(async (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body) ? body : (body.transactions || []);
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ detail: "no transactions to import" });
  const db = getDb();
  const userIdByName = async (name) => { if (!name) return null; const u = (await db.prepare("SELECT id FROM users WHERE username=?").get(String(name))); return u ? u.id : null; };
  const existsTx = db.prepare("SELECT 1 FROM movements WHERE tx_hash=? AND kind=? AND amount=?");
  const existsNoTx = db.prepare("SELECT 1 FROM movements WHERE kind=? AND from_address IS ? AND to_address IS ? AND amount=? AND created_at=?");
  const ins = db.prepare("INSERT INTO movements(kind,chain,token,from_address,to_address,amount,tx_hash,status,wallet_id,initiated_by,note,usd_rate,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  let imported = 0, skipped = 0; const errors = []; const importedAddrs = [];
  for (const r of rows) {
    try {
      const kind = String(r.kind || "").trim();
      const amount = (r.amount != null ? String(r.amount) : "").trim();
      if (!kind || !amount) { skipped++; continue; }
      const tx = r.tx_hash ? String(r.tx_hash) : null;
      const from = (r.from_address != null && r.from_address !== "") ? String(r.from_address) : null;
      const to = (r.to_address != null && r.to_address !== "") ? String(r.to_address) : null;
      const created = r.created_at ? String(r.created_at) : new Date().toISOString();
      const dup = tx ? (await existsTx.get(tx, kind, amount)) : (await existsNoTx.get(kind, from, to, amount, created));
      if (dup) { skipped++; continue; }
      (await ins.run(kind, "tron", String(r.token || "USDT"), from, to, amount, tx, String(r.status || "confirmed"), null,
        await userIdByName(r.initiated_by), String(r.note || "imported"), (r.usd_rate != null && r.usd_rate !== "") ? String(r.usd_rate) : null, created));
      imported++;
    } catch (e) { if (errors.length < 5) errors.push(String(e.message || e)); }
  }
  svc.audit(req.user.id, "import_transactions", `imported ${imported}, skipped ${skipped}`, ip(req));
  res.json({ imported, skipped, errors });
}));
app.get("/audit.csv", currentUser, adminRequired, async (_req, res) => {
  const rows = (await getDb().prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 10000").all());
  const head = ["id", "created_at", "user_id", "action", "detail", "ip"];
  const lines = [head.join(",")].concat(rows.map((r) => [r.id, r.created_at, r.user_id, r.action, r.detail, r.ip].map(csvEscape).join(",")));
  res.set("Content-Type", "text/csv").set("Content-Disposition", "attachment; filename=audit.csv").send(lines.join("\n"));
});

// ---------------- address book (staff/admin) ----------------
app.get("/address-book", currentUser, staffOrAdmin, async (_req, res) =>
  res.json((await getDb().prepare("SELECT id,label,address FROM address_book WHERE is_active=1 ORDER BY id DESC").all())));
app.post("/address-book", currentUser, staffOrAdmin, async (req, res) => {
  const { address, label } = req.body || {};
  if (!address) return res.status(400).json({ detail: "address required" });
  const info = (await getDb().prepare("INSERT INTO address_book(label,address,is_active,created_by,created_at) VALUES(?,?,1,?,?)")
    .run(String(label || ""), String(address), req.user.id, new Date().toISOString()));
  svc.audit(req.user.id, "address_book_add", `${address} (${label || ""})`, ip(req));
  res.json({ id: info.lastInsertRowid, label: String(label || ""), address: String(address) });
});
app.delete("/address-book/:id", currentUser, staffOrAdmin, async (req, res) => {
  const row = (await getDb().prepare("SELECT * FROM address_book WHERE id=?").get(req.params.id));
  if (!row) return res.status(404).json({ detail: "not found" });
  (await getDb().prepare("UPDATE address_book SET is_active=0 WHERE id=?").run(row.id));
  svc.audit(req.user.id, "address_book_remove", row.address, ip(req));
  res.json({ ok: true });
});

// ---------------- treasury (admin only) ----------------
app.post("/treasury/distribute", currentUser, adminRequired, wrap(async (req, res) => {
  const hold = Number(config.get().treasury_hold_percent != null ? config.get().treasury_hold_percent : 10);
  const r = await svc.distributeTreasury(hold);
  svc.audit(req.user.id, "treasury_distribute", `held ${r.held} distributed ${r.distributed} to ${r.count}`, ip(req));
  res.json(r);
}));
app.post("/treasury/send", currentUser, adminRequired, wrap(async (req, res) => {
  const { to_address, amount } = req.body || {};
  if (!to_address) return res.status(400).json({ detail: "recipient address required" });
  if (!(Number(amount) > 0)) return res.status(400).json({ detail: "amount must be positive" });
  const r = await svc.treasurySend(String(to_address), Number(amount));
  svc.audit(req.user.id, "treasury_send", `${amount} USDT -> ${to_address} tx=${r.tx}`, ip(req));
  res.json(r);
}));

// Admin sends to any address, choosing the source: "treasury" or a pool wallet id.
// Admin only — staff can never send from treasury or use this endpoint.
app.post("/admin/send", currentUser, adminRequired, wrap(async (req, res) => {
  const { from, to_address, amount } = req.body || {};
  if (!to_address) return res.status(400).json({ detail: "recipient address required" });
  if (!(Number(amount) > 0)) return res.status(400).json({ detail: "amount must be positive" });
  let wallet;
  if (from === undefined || from === "treasury") {
    wallet = await svc.getTreasury();
    if (!wallet) return res.status(400).json({ detail: "no treasury wallet" });
  } else {
    wallet = (await getDb().prepare("SELECT * FROM wallets WHERE id=? AND is_active=1").get(from));
    if (!wallet) return res.status(404).json({ detail: "source wallet not found" });
    if (!["treasury", "disbursement"].includes(wallet.wtype))
      return res.status(400).json({ detail: "can only send from treasury or a pool wallet" });
  }
  const r = await svc.adminSendFrom(wallet, String(to_address), Number(amount));
  svc.audit(req.user.id, "admin_send", `${amount} USDT from ${wallet.wtype} #${wallet.id} -> ${to_address} tx=${r.tx}`, ip(req));
  res.json(r);
}));

// ---------------- ledger / audit ----------------
app.get("/movements", currentUser, async (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200);
  res.json((await getDb().prepare("SELECT * FROM movements ORDER BY id DESC LIMIT ?").all(limit)).map(moveOut));
});

// Transaction history. Admin: all, or ?user_id= to scope to one user. Staff: own only.
// Movements relevant to one user id: initiated by them, deposits on their wallets, or payouts tied to them.
async function relevantMovements(db, ownerIds, extraInitiators, limit, opts = {}) {
  const walletIds = ownerIds.length ? (await db.prepare(`SELECT id FROM wallets WHERE owner_user_id IN (${ownerIds.map(() => "?").join(",")})`).all(...ownerIds)).map((w) => w.id) : [];
  const txs = ownerIds.length ? (await db.prepare(`SELECT tx_hash FROM disbursement_requests WHERE tx_hash IS NOT NULL AND customer_id IN (${ownerIds.map(() => "?").join(",")})`).all(...ownerIds)).map((r) => r.tx_hash) : [];
  // the customer's own addresses: their deposit wallet(s) + whitelisted payout address(es)
  const addrs = ownerIds.length ? [].concat(
    (await db.prepare(`SELECT address FROM wallets WHERE owner_user_id IN (${ownerIds.map(() => "?").join(",")})`).all(...ownerIds)).map((r) => r.address),
    (await db.prepare(`SELECT address FROM customer_whitelist WHERE is_active=1 AND customer_id IN (${ownerIds.map(() => "?").join(",")})`).all(...ownerIds)).map((r) => r.address)
  ) : [];
  const clauses = []; const params = [];
  const initiators = extraInitiators.filter((x) => x != null);
  if (initiators.length) { clauses.push(`initiated_by IN (${initiators.map(() => "?").join(",")})`); params.push(...initiators); }
  if (walletIds.length) { clauses.push(`(kind='deposit_in' AND wallet_id IN (${walletIds.map(() => "?").join(",")}))`); params.push(...walletIds); }
  if (txs.length) { clauses.push(`tx_hash IN (${txs.map(() => "?").join(",")})`); params.push(...txs); }
  if (addrs.length) { const ph = addrs.map(() => "?").join(","); clauses.push(`(to_address IN (${ph}) AND kind IN ('deposit_in','disburse_out','treasury_out'))`); params.push(...addrs); }
  if (!clauses.length) return [];
  let where = `(${clauses.join(" OR ")})`;
  if (opts.from) { where += " AND substr(created_at,1,10) >= ?"; params.push(opts.from); }
  if (opts.to) { where += " AND substr(created_at,1,10) <= ?"; params.push(opts.to); }
  if (opts.before) { where += " AND id < ?"; params.push(opts.before); }
  const lim = limit != null ? " LIMIT ?" : "";
  const args = limit != null ? [...params, limit] : params;
  return (await db.prepare(`SELECT * FROM movements WHERE ${where} ORDER BY id DESC${lim}`).all(...args));
}
// Full backup: customers (with whitelist + staff links + password hash), staff, wallets, transactions.
app.get("/backup/export", currentUser, adminRequired, async (req, res) => {
  const db = getDb();
  const staff = (await db.prepare("SELECT * FROM users WHERE role IN ('staff','admin')").all()).map((u) => ({
    username: u.username, role: u.role, password_hash: u.password_hash, auto_approve_limit: u.auto_approve_limit, is_active: u.is_active,
  }));
  const customers = await Promise.all((await db.prepare("SELECT * FROM users WHERE role='customer'").all()).map(async (u) => ({
    username: u.username, customer_type: u.customer_type, phone: u.phone, pay_token: u.pay_token, is_active: u.is_active, password_hash: u.password_hash,
    whitelist: (await db.prepare("SELECT address,label FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(u.id)),
    staff: (await db.prepare("SELECT us.username FROM customer_staff cs JOIN users us ON us.id=cs.staff_id WHERE cs.customer_id=?").all(u.id)).map((r) => r.username),
  })));
  const wallets = await Promise.all((await db.prepare("SELECT * FROM wallets ORDER BY id").all()).map(async (w) => {
    let pk = ""; try { pk = sec.decryptSecret(w.enc_privkey); } catch { pk = ""; }
    return { type: friendlyType(w.wtype), label: w.label, address: w.address, owner: w.owner_user_id ? await userName(w.owner_user_id) : "", private_key: pk };
  }));
  const transactions = await Promise.all((await db.prepare("SELECT * FROM movements ORDER BY id").all()).map(async (m) => ({
    kind: m.kind, token: m.token, from_address: m.from_address, to_address: m.to_address, amount: m.amount, usd_rate: m.usd_rate, status: m.status, tx_hash: m.tx_hash, note: m.note, created_at: m.created_at, initiated_by: await userName(m.initiated_by),
  })));
  svc.audit(req.user.id, "export_full_backup", `${customers.length} customers, ${wallets.length} wallets, ${transactions.length} tx`, ip(req));
  res.set("Content-Type", "application/json").set("Content-Disposition", "attachment; filename=kryvonwallet-full-backup.json")
     .send(JSON.stringify({ exported_at: new Date().toISOString(), network: config.get().tron_network, staff, customers, wallets, transactions }, null, 2));
});

app.post("/backup/import", currentUser, adminRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const db = getDb();
  const out = { staff: 0, customers: 0, whitelist: 0, assignments: 0, wallets: 0, transactions: 0, skipped: 0, errors: [] };
  const err = (m) => { if (out.errors.length < 10) out.errors.push(m); };
  const userByName = async (name) => (await db.prepare("SELECT * FROM users WHERE username=?").get(String(name)));
  const randPw = () => sec.hashPassword(crypto.randomBytes(9).toString("base64url"));

  for (const s of (b.staff || [])) {
    try {
      if (!s.username || await userByName(s.username)) continue;
      const role = s.role === "admin" ? "admin" : "staff";
      (await db.prepare("INSERT INTO users(username,password_hash,role,is_active,auto_approve_limit,created_at) VALUES(?,?,?,?,?,?)")
        .run(s.username, s.password_hash || randPw(), role, s.is_active != null ? (s.is_active ? 1 : 0) : 1, s.auto_approve_limit != null ? s.auto_approve_limit : null, new Date().toISOString()));
      out.staff++;
    } catch (e) { err("staff " + (s.username || "") + ": " + e.message); }
  }
  for (const c of (b.customers || [])) {
    try {
      if (!c.username) continue;
      let u = await userByName(c.username);
      if (!u) {
        (await db.prepare("INSERT INTO users(username,password_hash,role,is_active,customer_type,phone,pay_token,created_at) VALUES(?,?,'customer',?,?,?,?,?)")
          .run(c.username, c.password_hash || randPw(), c.is_active != null ? (c.is_active ? 1 : 0) : 1, c.customer_type || "depositor", c.phone || null, c.pay_token || crypto.randomBytes(12).toString("base64url"), new Date().toISOString()));
        u = await userByName(c.username); out.customers++;
      }
      for (const w of (c.whitelist || [])) {
        if (!w.address) continue;
        if (!(await db.prepare("SELECT 1 FROM customer_whitelist WHERE customer_id=? AND address=?").get(u.id, w.address))) {
          (await db.prepare("INSERT INTO customer_whitelist(customer_id,address,label,is_active,created_at) VALUES(?,?,?,1,?)").run(u.id, w.address, w.label || null, new Date().toISOString()));
          out.whitelist++;
        }
      }
      for (const sn of (c.staff || [])) {
        const st = await userByName(sn); if (!st) continue;
        if (!(await db.prepare("SELECT 1 FROM customer_staff WHERE customer_id=? AND staff_id=?").get(u.id, st.id))) {
          (await db.prepare("INSERT INTO customer_staff(customer_id,staff_id,created_at) VALUES(?,?,?)").run(u.id, st.id, new Date().toISOString()));
          out.assignments++;
        }
      }
    } catch (e) { err("customer " + (c.username || "") + ": " + e.message); }
  }
  for (const it of (b.wallets || [])) {
    try {
      const pk = String(it.private_key || it.privateKey || "").trim(); if (!pk) { out.skipped++; continue; }
      const wtype = wtypeFromFriendly(it.type || it.wtype); if (!wtype) { err("wallet type: " + (it.type || it.wtype)); continue; }
      if (wtype === "treasury" && await svc.getTreasury()) { out.skipped++; continue; }
      let ownerId = null; if (it.owner) { const u = await userByName(it.owner); if (u) ownerId = u.id; }
      await svc.importWallet(pk, wtype, ownerId, String(it.label || ""), false);
      out.wallets++;
    } catch (e) { if (String(e.message).includes("already exists")) out.skipped++; else err("wallet: " + e.message); }
  }
  {
    const existsTx = db.prepare("SELECT 1 FROM movements WHERE tx_hash=? AND kind=? AND amount=?");
    const existsNoTx = db.prepare("SELECT 1 FROM movements WHERE kind=? AND from_address IS ? AND to_address IS ? AND amount=? AND created_at=?");
    const ins = db.prepare("INSERT INTO movements(kind,chain,token,from_address,to_address,amount,tx_hash,status,wallet_id,initiated_by,note,usd_rate,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const r of (b.transactions || [])) {
      try {
        const kind = String(r.kind || "").trim(); const amount = (r.amount != null ? String(r.amount) : "").trim();
        if (!kind || !amount) { out.skipped++; continue; }
        const tx = r.tx_hash ? String(r.tx_hash) : null;
        const from = (r.from_address != null && r.from_address !== "") ? String(r.from_address) : null;
        const to = (r.to_address != null && r.to_address !== "") ? String(r.to_address) : null;
        const created = r.created_at ? String(r.created_at) : new Date().toISOString();
        const dup = tx ? (await existsTx.get(tx, kind, amount)) : (await existsNoTx.get(kind, from, to, amount, created));
        if (dup) { out.skipped++; continue; }
        let by = null; if (r.initiated_by) { const u = await userByName(r.initiated_by); by = u ? u.id : null; }
        (await ins.run(kind, "tron", String(r.token || "USDT"), from, to, amount, tx, String(r.status || "confirmed"), null, by, String(r.note || "imported"), (r.usd_rate != null && r.usd_rate !== "") ? String(r.usd_rate) : null, created));
        out.transactions++;
      } catch (e) { err("tx: " + e.message); }
    }
  }
  svc.audit(req.user.id, "import_full_backup", `customers ${out.customers}, wallets ${out.wallets}, tx ${out.transactions}`, ip(req));
  res.json(out);
}));

// Build a lookup that maps each movement to its related customer:
// deposits → the deposit wallet's customer owner; payouts → the disbursement request's customer.
async function custLookup(db, _rows) {
  // address -> customer username (deposit wallets + whitelisted payout addresses)
  const addrCust = {};
  for (const r of (await db.prepare("SELECT w.address a, u.username un FROM wallets w JOIN users u ON u.id=w.owner_user_id WHERE u.role='customer'").all())) addrCust[r.a] = r.un;
  for (const r of (await db.prepare("SELECT cw.address a, u.username un FROM customer_whitelist cw JOIN users u ON u.id=cw.customer_id WHERE cw.is_active=1").all())) if (!addrCust[r.a]) addrCust[r.a] = r.un;
  // tx_hash -> customer (payout requests) as a fallback
  const txCust = {};
  for (const r of (await db.prepare("SELECT dr.tx_hash th, u.username un FROM disbursement_requests dr JOIN users u ON u.id=dr.customer_id WHERE dr.tx_hash IS NOT NULL").all())) txCust[r.th] = r.un;
  return (m) => addrCust[m.to_address] || addrCust[m.from_address] || (m.tx_hash && txCust[m.tx_hash]) || null;
}
async function annotateCustomers(db, rows) {
  const who = await custLookup(db, rows);
  return await Promise.all(rows.map(async (m) => { const o = await txOut(m); o.customer = who(m); return o; }));
}
app.get("/transactions", currentUser, staffOrAdmin, async (req, res) => {
  const db = getDb();
  const noLimit = req.query.limit === "all" || parseInt(req.query.limit, 10) === 0;
  const limit = noLimit ? null : Math.min(100000, parseInt(req.query.limit, 10) || 500);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : null;
  const before = parseInt(req.query.before, 10) || null;
  const address = (req.query.address || "").trim() || null;
  const opts = { from, to, before };
  if (req.user.role === "admin") {
    // search by wallet address — across ALL wallets, in/out, no row cap
    if (address) {
      const w = ["(from_address=? OR to_address=?)"]; const p = [address, address];
      if (from) { w.push("substr(created_at,1,10) >= ?"); p.push(from); }
      if (to) { w.push("substr(created_at,1,10) <= ?"); p.push(to); }
      if (before) { w.push("id < ?"); p.push(before); }
      const sql = `SELECT * FROM movements WHERE ${w.join(" AND ")} ORDER BY id DESC${noLimit ? "" : " LIMIT ?"}`;
      return res.json(await annotateCustomers(db, (await db.prepare(sql).all(...(noLimit ? p : [...p, limit])))));
    }
    const uid = req.query.user_id ? Number(req.query.user_id) : null;
    if (!uid) {
      const w = []; const p = [];
      if (from) { w.push("substr(created_at,1,10) >= ?"); p.push(from); }
      if (to) { w.push("substr(created_at,1,10) <= ?"); p.push(to); }
      if (before) { w.push("id < ?"); p.push(before); }
      const where = w.length ? "WHERE " + w.join(" AND ") : "";
      const sql = `SELECT * FROM movements ${where} ORDER BY id DESC${noLimit ? "" : " LIMIT ?"}`;
      return res.json(await annotateCustomers(db, (await db.prepare(sql).all(...(noLimit ? p : [...p, limit])))));
    }
    return res.json(await annotateCustomers(db, await relevantMovements(db, [uid], [uid], limit, opts)));
  }
  // staff: only their own activity + their assigned customers' deposits & payouts
  const custIds = await assignedCustomerIds(req.user.id);
  res.json(await annotateCustomers(db, await relevantMovements(db, custIds, [req.user.id], limit, opts)));
});

// Analytics / reports summary (admin)
app.get("/reports/summary", currentUser, adminRequired, async (req, res) => {
  const db = getDb();
  const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 14));
  const tot = async (kind) => (await db.prepare("SELECT COUNT(*) c, COALESCE(SUM(CAST(amount AS REAL)),0) v FROM movements WHERE kind=? AND token='USDT'").get(kind));
  const deposits = await tot("deposit_in"), payouts = await tot("disburse_out");

  const map = {};
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); map[d] = { date: d, deposits: 0, payouts: 0 }; }
  const since = Object.keys(map)[0];
  (await db.prepare(`SELECT substr(created_at,1,10) d, kind, COALESCE(SUM(CAST(amount AS REAL)),0) v
              FROM movements WHERE token='USDT' AND kind IN ('deposit_in','disburse_out') AND substr(created_at,1,10) >= ?
              GROUP BY d, kind`).all(since)).forEach((r) => {
    if (map[r.d]) { if (r.kind === "deposit_in") map[r.d].deposits = r.v; else map[r.d].payouts = r.v; }
  });

  const topCustomers = (await db.prepare(`SELECT u.username, COUNT(*) c, COALESCE(SUM(CAST(dr.amount AS REAL)),0) v
    FROM disbursement_requests dr JOIN users u ON u.id=dr.customer_id
    WHERE dr.customer_id IS NOT NULL AND dr.tx_hash IS NOT NULL
    GROUP BY dr.customer_id ORDER BY v DESC LIMIT 10`).all());
  const byStaff = (await db.prepare(`SELECT u.username, COUNT(*) c, COALESCE(SUM(CAST(m.amount AS REAL)),0) v
    FROM movements m JOIN users u ON u.id=m.initiated_by
    WHERE m.kind='disburse_out' GROUP BY m.initiated_by ORDER BY v DESC LIMIT 10`).all());

  res.json({
    days,
    deposits: { count: deposits.c, volume: deposits.v },
    payouts: { count: payouts.c, volume: payouts.v },
    counts: {
      customers: (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='customer'").get()).c,
      staff: (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='staff'").get()).c,
      pending_approvals: (await db.prepare("SELECT COUNT(*) c FROM disbursement_requests WHERE status='pending' AND tx_hash IS NULL").get()).c,
    },
    series: Object.values(map),
    top_customers: topCustomers,
    by_staff: byStaff,
  });
});

app.get("/receipts/:id", currentUser, async (req, res) => {
  const key = req.params.id;
  const m = /^\d+$/.test(key)
    ? (await getDb().prepare("SELECT * FROM movements WHERE id=?").get(key))
    : (await getDb().prepare("SELECT * FROM movements WHERE tx_hash=? ORDER BY id DESC").get(key));
  if (!m) return res.status(404).json({ detail: "receipt not found" });
  if (req.user.role !== "admin") {
    let ok = false;
    if (m.wallet_id) {
      const w = (await getDb().prepare("SELECT owner_user_id FROM wallets WHERE id=?").get(m.wallet_id));
      if (w && w.owner_user_id === req.user.id) ok = true;   // own deposit wallet
    }
    if (!ok && m.initiated_by === req.user.id) ok = true;     // staff who initiated
    if (!ok && req.user.role === "customer" && m.tx_hash) {   // remittance received by this customer
      const dr = (await getDb().prepare("SELECT 1 FROM disbursement_requests WHERE customer_id=? AND tx_hash=?").get(req.user.id, m.tx_hash));
      if (dr) ok = true;
    }
    if (!ok) return res.status(403).json({ detail: "not permitted" });
  }
  res.json(buildReceipt(m, config.get().tron_network));
});

app.get("/audit", currentUser, adminRequired, async (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200);
  res.json((await getDb().prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit))
    .map((r) => ({ id: r.id, user_id: r.user_id, action: r.action, detail: r.detail, ip: r.ip, at: r.created_at })));
});

// ---------------- dashboard ----------------
app.get("/license", currentUser, adminRequired, wrap(async (_req, res) => { res.json({ ...license.status(), usage: await license.usageSummary() }); }));
app.get("/dashboard", currentUser, wrap(async (req, res) => {
  const chain = require("./chain");
  const db = getDb();
  const net = config.get().tron_network;
  const fresh = String(req.query.fresh || "") === "1";
  const safeUsdt = async (a) => { try { return (await balanceOf(a, fresh)).usdt; } catch { return null; } };
  const safeNative = async (a) => { try { return (await balanceOf(a, fresh)).native; } catch { return null; } };
  const recent = (await db.prepare("SELECT * FROM movements ORDER BY id DESC LIMIT 15").all()).map(moveOut);

  if (req.user.role === "admin") {
    const [treasury, fee, pool] = await Promise.all([
      svc.getTreasury(), svc.getFee(),
      db.prepare("SELECT * FROM wallets WHERE wtype='disbursement' AND is_active=1").all(),
    ]);
    const since24 = new Date(Date.now() - 86400000).toISOString();
    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM for "energy this month"
    // all balance reads + aggregates run in parallel (chain reads still rate-limited by the throttle)
    const [treUsdt, feeBal, poolUsdts, staffCount, depCount, pending, dep24, pay24, failed24, energyMonth] = await Promise.all([
      treasury ? safeUsdt(treasury.address) : null,
      fee ? Promise.all([safeUsdt(fee.address), safeNative(fee.address)]) : [null, null],
      Promise.all(pool.map((w) => safeUsdt(w.address))),
      db.prepare("SELECT COUNT(*) c FROM users WHERE role='staff'").get(),
      db.prepare("SELECT COUNT(*) c FROM wallets WHERE wtype='deposit'").get(),
      db.prepare("SELECT COUNT(*) c FROM disbursement_requests WHERE status='pending' AND tx_hash IS NULL").get(),
      db.prepare("SELECT COUNT(*) c, COALESCE(SUM(CAST(amount AS REAL)),0) v FROM movements WHERE kind='deposit_in' AND token='USDT' AND created_at>=?").get(since24),
      db.prepare("SELECT COUNT(*) c, COALESCE(SUM(CAST(amount AS REAL)),0) v FROM movements WHERE kind='disburse_out' AND token='USDT' AND created_at>=?").get(since24),
      db.prepare("SELECT COUNT(*) c FROM movements WHERE kind IN ('disburse_out','treasury_out') AND status='failed' AND created_at>=?").get(since24),
      db.prepare("SELECT COALESCE(SUM(CAST(energy AS REAL)),0) e FROM movements WHERE kind IN ('disburse_out','treasury_out') AND substr(created_at,1,7)=?").get(monthKey),
    ]);
    const poolOut = pool.map((w, i) => ({ id: w.id, address: w.address, usdt: poolUsdts[i] }));
    const gasMin = Number(config.get().gas_fund_trx || 20);
    const feeNative = fee ? feeBal[1] : null;
    return res.json({
      role: "admin", network: net,
      treasury: treasury ? { address: treasury.address, usdt: treUsdt } : null,
      fee: fee ? { address: fee.address, usdt: feeBal[0], native: feeNative } : null,
      pool: poolOut,
      staff_count: staffCount.c, deposit_wallet_count: depCount.c, pending_approvals: pending.c,
      today: { deposits: { count: dep24.c, volume: Number(dep24.v) }, payouts: { count: pay24.c, volume: Number(pay24.v) }, failed_payouts: failed24.c },
      energy_month: Number(energyMonth.e || 0),
      alerts: {
        low_gas: feeNative != null && Number(feeNative) < gasMin,
        gas_min: gasMin,
        pending_approvals: pending.c,
        failed_payouts_24h: failed24.c,
      },
      recent_movements: recent,
    });
  }
  const myWallets = (await db.prepare("SELECT * FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(req.user.id));
  const myReqs = (await db.prepare("SELECT * FROM disbursement_requests WHERE staff_user_id=? ORDER BY id DESC LIMIT 10").all(req.user.id));
  res.json({
    role: "staff", network: net,
    my_deposit_wallets: myWallets.map((w) => ({ id: w.id, address: w.address, label: w.label })),
    my_requests: myReqs.map(disbOut),
    recent_movements: recent,
  });
}));

// ---------------- background sweeper ----------------
let workerTimer = null;
function startWorker() {
  if (workerTimer || !config.isSetupComplete()) return;
  const intervalMs = (Number(config.get().poll_interval_seconds) || 30) * 1000;
  let lastDistribute = 0;
  const tick = async () => {
    try { const r = await svc.scanAndSweep(); if (r && r.length) console.log("[worker]", JSON.stringify(r)); }
    catch (e) { console.log("[worker] error:", e.message); }
    try { await svc.maybeAutoRefillGas(); } catch (e) { console.log("[worker] gas refill error:", e.message); }
    try { await svc.reconcilePending(); } catch (e) { console.log("[worker] reconcile error:", e.message); }
    try { await license.reportUsage(); } catch (e) { /* best-effort */ }
    try {
      if (config.get().auto_distribute_enabled && Date.now() - lastDistribute > 10 * 60 * 1000) {
        lastDistribute = Date.now();
        const d = await svc.distributeTreasury(Number(config.get().treasury_hold_percent != null ? config.get().treasury_hold_percent : 10));
        if (d && d.distributed) console.log("[worker] auto-distributed", d.distributed);
      }
    } catch (e) { console.log("[worker] auto-distribute error:", e.message); }
  };
  workerTimer = setInterval(tick, intervalMs);
  console.log(`[worker] started; every ${intervalMs / 1000}s on ${config.get().tron_network}`);
}

module.exports = { app, startWorker };
