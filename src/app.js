const express = require("express");
const crypto = require("crypto");
const path = require("path");
const config = require("./config");
const { getDb } = require("./db");
const sec = require("./security");
const svc = require("./services");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

const PUBLIC = path.join(__dirname, "..", "public");
app.use("/static", express.static(PUBLIC));

const ip = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";
const userOut = (u) => ({ id: u.id, username: u.username, role: u.role, is_active: !!u.is_active, customer_type: u.customer_type || null, auto_approve_limit: u.auto_approve_limit != null ? Number(u.auto_approve_limit) : null, phone: u.phone || null });
const assignedStaffIds = (customerId) => getDb().prepare("SELECT staff_id FROM customer_staff WHERE customer_id=?").all(customerId).map((r) => r.staff_id);
function canAccessCustomer(user, customerId) {
  if (user.role === "admin") return true;
  if (user.role === "customer") return Number(user.id) === Number(customerId);
  if (user.role === "staff") return assignedStaffIds(customerId).includes(user.id);
  return false;
}
const walletOut = (w) => ({ id: w.id, chain: w.chain, address: w.address, wtype: w.wtype, label: w.label, owner_user_id: w.owner_user_id, is_active: !!w.is_active });
const moveOut = (m) => ({ id: m.id, kind: m.kind, token: m.token, from_address: m.from_address, to_address: m.to_address, amount: m.amount, tx_hash: m.tx_hash, status: m.status, usd_rate: m.usd_rate, created_at: m.created_at });

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
const userName = (id) => { if (!id) return null; const u = getDb().prepare("SELECT username FROM users WHERE id=?").get(id); return u ? u.username : null; };
function txOut(m) {
  const o = moveOut(m);
  o.initiated_by_name = userName(m.initiated_by);
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
function addressAllowed(addr) {
  if (getDb().prepare("SELECT 1 FROM address_book WHERE address=? AND is_active=1").get(addr)) return true;
  if (getDb().prepare("SELECT 1 FROM customer_whitelist WHERE address=? AND is_active=1").get(addr)) return true;
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
    req.path === "/api/setup/status" ||
    (req.path === "/api/setup" && req.method === "POST");
  if (allowed) return next();
  if (req.method === "GET" && req.accepts("html")) return res.redirect("/setup");
  return res.status(409).json({ detail: "Setup not complete" });
});

// ---------------- pages ----------------
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC, "index.html")));
app.get("/setup", (_req, res) => res.sendFile(path.join(PUBLIC, "setup.html")));
app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// Public branding (logo, favicon, name) so the login/setup pages can theme before auth.
app.get("/branding", (_req, res) => {
  let c = {}; try { c = config.get(); } catch { c = {}; }
  res.json({ app_name: c.app_name || "KryvonWallet", brand_logo: c.brand_logo || "", favicon: c.favicon || "", qr_logo: c.qr_logo || "" });
});

// ---------------- setup wizard API ----------------
app.get("/api/setup/status", (_req, res) => res.json({ needs_setup: !config.isSetupComplete() }));

app.post("/api/setup", (req, res) => {
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
  db.prepare("INSERT INTO users(username,password_hash,role,is_active,created_at) VALUES(?,?,'admin',1,?)")
    .run(username, sec.hashPassword(password), new Date().toISOString());
  svc.audit(1, "setup_complete", `admin ${username}, network ${net}`, ip(req));

  startWorker();
  // Return the generated encryption key once so the operator can back it up.
  res.json({ ok: true, wallet_enc_key: cfg.wallet_enc_key, network: net });
});

// ---------------- auth middleware ----------------
function currentUser(req, res, next) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ detail: "invalid credentials" });
  try {
    const p = sec.verifyToken(tok);
    const u = getDb().prepare("SELECT * FROM users WHERE username=?").get(p.sub);
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
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || "");
  const key = uname + "|" + ip(req);
  const now = Date.now();
  const rec = loginFails.get(key);
  if (rec && rec.lockUntil && now < rec.lockUntil)
    return res.status(429).json({ detail: "too many failed attempts — try again later" });
  const u = getDb().prepare("SELECT * FROM users WHERE username=?").get(uname);
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

app.get("/users/me", currentUser, (req, res) => res.json(userOut(req.user)));

app.get("/users", currentUser, adminRequired, (_req, res) =>
  res.json(getDb().prepare("SELECT * FROM users ORDER BY id").all().map(userOut)));

app.post("/users", currentUser, adminRequired, (req, res) => {
  const { username, password, role } = req.body || {};
  if (String(username || "").length < 3) return res.status(400).json({ detail: "username too short" });
  if (String(password || "").length < 8) return res.status(400).json({ detail: "password must be at least 8 characters" });
  if (getDb().prepare("SELECT 1 FROM users WHERE username=?").get(username))
    return res.status(400).json({ detail: "username exists" });
  const r = role === "admin" ? "admin" : "staff";
  const info = getDb().prepare("INSERT INTO users(username,password_hash,role,is_active,created_at) VALUES(?,?,?,1,?)")
    .run(username, sec.hashPassword(password), r, new Date().toISOString());
  svc.audit(req.user.id, "create_user", `created ${username} (${r})`, ip(req));
  res.json(userOut(getDb().prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid)));
});

app.post("/users/:id/limit", currentUser, adminRequired, (req, res) => {
  const u = getDb().prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ detail: "user not found" });
  if (u.role !== "staff") return res.status(400).json({ detail: "limits apply to staff only" });
  const { limit } = req.body || {};
  let val = null; // null = fall back to global default
  if (limit !== null && limit !== "" && limit !== undefined) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ detail: "invalid limit" });
    val = n;
  }
  getDb().prepare("UPDATE users SET auto_approve_limit=? WHERE id=?").run(val, u.id);
  svc.audit(req.user.id, "set_staff_limit", `staff #${u.id} -> ${val === null ? "default" : val}`, ip(req));
  res.json(userOut(getDb().prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

app.post("/users/:id/active", currentUser, adminRequired, (req, res) => {
  const u = getDb().prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ detail: "user not found" });
  if (u.id === req.user.id) return res.status(400).json({ detail: "you cannot change your own status" });
  const active = req.body && req.body.active ? 1 : 0;
  if (!active && u.role === "admin") {
    const admins = getDb().prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND is_active=1").get().c;
    if (admins <= 1) return res.status(400).json({ detail: "cannot disable the last active admin" });
  }
  getDb().prepare("UPDATE users SET is_active=? WHERE id=?").run(active, u.id);
  svc.audit(req.user.id, active ? "enable_user" : "disable_user", u.username, ip(req));
  res.json(userOut(getDb().prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

app.post("/users/:id/password", currentUser, adminRequired, (req, res) => {
  const u = getDb().prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ detail: "user not found" });
  const pw = String((req.body || {}).password || "");
  if (pw.length < 8) return res.status(400).json({ detail: "password must be at least 8 characters" });
  getDb().prepare("UPDATE users SET password_hash=? WHERE id=?").run(sec.hashPassword(pw), u.id);
  svc.audit(req.user.id, "reset_password", u.username, ip(req));
  res.json({ ok: true });
});

// ---------------- wallets ----------------
app.post("/wallets/treasury", currentUser, adminRequired, wrap(async (req, res) => {
  if (svc.getTreasury()) return res.status(400).json({ detail: "treasury already exists" });
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
  const staff = getDb().prepare("SELECT * FROM users WHERE id=?").get(staff_user_id);
  if (!staff) return res.status(404).json({ detail: "staff user not found" });
  const w = await svc.createWallet("deposit", staff.id, String(label || ""));
  svc.audit(req.user.id, "create_deposit_wallet", `${w.address} for ${staff.username}`, ip(req));
  res.json(walletOut(w));
}));

app.get("/wallets", currentUser, (req, res) => {
  const rows = req.user.role === "admin"
    ? getDb().prepare("SELECT * FROM wallets").all()
    : getDb().prepare("SELECT * FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(req.user.id);
  res.json(rows.map(walletOut));
});

app.get("/wallets/:id/balance", currentUser, wrap(async (req, res) => {
  const chain = require("./chain");
  const w = getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id);
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  if (req.user.role !== "admin" && w.owner_user_id !== req.user.id)
    return res.status(403).json({ detail: "not your wallet" });
  res.json({
    address: w.address, type: w.wtype,
    usdt: String(await chain.usdtBalance(w.address)),
    native: String(await chain.nativeBalance(w.address)),
  });
}));

// Export ALL wallets with private keys (admin only, audited) — full backup.
app.get("/wallets/export", currentUser, adminRequired, (req, res) => {
  const rows = getDb().prepare("SELECT * FROM wallets ORDER BY id").all();
  const wallets = rows.map((w) => {
    let pk = null; try { pk = sec.decryptSecret(w.enc_privkey); } catch { pk = null; }
    const owner = w.owner_user_id ? ((getDb().prepare("SELECT username FROM users WHERE id=?").get(w.owner_user_id) || {}).username || null) : null;
    return { type: friendlyType(w.wtype), label: w.label || "", address: w.address, owner, private_key: pk };
  });
  svc.audit(req.user.id, "export_all_wallets", `${wallets.length} wallets`, ip(req));
  res.set("Content-Type", "application/json")
     .set("Content-Disposition", "attachment; filename=kryvonwallet-wallets-backup.json")
     .send(JSON.stringify({ exported_at: new Date().toISOString(), network: config.get().tron_network, wallets }, null, 2));
});

// Bulk import wallets from a backup (admin only, audited). No gas pre-load on restore.
app.post("/wallets/import-bulk", currentUser, adminRequired, wrap(async (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : (Array.isArray(body.wallets) ? body.wallets : null);
  if (!list) return res.status(400).json({ detail: "expected a wallets array or { wallets: [...] }" });
  let imported = 0, skipped = 0; const errors = [];
  for (const it of list) {
    try {
      const pk = String(it.private_key || it.privateKey || "").trim();
      if (!pk) { skipped++; continue; }
      const wtype = wtypeFromFriendly(it.type || it.wtype);
      if (!wtype) { errors.push(`unknown type: ${it.type || it.wtype}`); continue; }
      if (wtype === "treasury" && svc.getTreasury()) { skipped++; continue; }
      let ownerId = null;
      const ownerName = it.owner || it.owner_username;
      if (ownerName) { const u = getDb().prepare("SELECT id FROM users WHERE username=?").get(String(ownerName)); if (u) ownerId = u.id; }
      await svc.importWallet(pk, wtype, ownerId, String(it.label || ""), false);
      imported++;
    } catch (e) {
      if (String(e.message).includes("already exists")) skipped++;
      else errors.push(e.message);
    }
  }
  svc.audit(req.user.id, "import_all_wallets", `imported ${imported}, skipped ${skipped}`, ip(req));
  res.json({ imported, skipped, errors });
}));

// Reveal a wallet's private key (admin only, audited). For backup / import / migration.
app.get("/wallets/:id/secret", currentUser, adminRequired, (req, res) => {
  const w = getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id);
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  let pk;
  try { pk = sec.decryptSecret(w.enc_privkey); } catch { return res.status(500).json({ detail: "could not decrypt key" }); }
  svc.audit(req.user.id, "reveal_private_key", `${w.wtype} ${w.address}`, ip(req));
  res.json({ address: w.address, wtype: w.wtype, private_key: pk });
});

// Rename a wallet's in-app display name (admin only).
app.post("/wallets/:id/name", currentUser, adminRequired, (req, res) => {
  const w = getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id);
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  const name = String((req.body || {}).name || "").trim();
  getDb().prepare("UPDATE wallets SET label=? WHERE id=?").run(name, w.id);
  svc.audit(req.user.id, "rename_wallet", `${w.address} -> ${name}`, ip(req));
  res.json(walletOut(getDb().prepare("SELECT * FROM wallets WHERE id=?").get(w.id)));
});

// Set the wallet's on-chain account name (admin only; one-time, permanent on TRON).
app.post("/wallets/:id/onchain-name", currentUser, adminRequired, wrap(async (req, res) => {
  const w = getDb().prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id);
  if (!w) return res.status(404).json({ detail: "wallet not found" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ detail: "name required" });
  const r = await svc.setOnchainName(w, name);
  getDb().prepare("UPDATE wallets SET label=? WHERE id=?").run(name, w.id);
  svc.audit(req.user.id, "set_onchain_name", `${w.address} -> ${name} tx=${r.tx}`, ip(req));
  res.json({ ok: true, tx: r.tx });
}));

// Import an existing private key as a wallet (admin only).
app.post("/wallets/import", currentUser, adminRequired, wrap(async (req, res) => {
  const { private_key, wtype, label, owner_user_id } = req.body || {};
  if (!private_key) return res.status(400).json({ detail: "private_key required" });
  if (!["treasury", "fee", "disbursement", "deposit"].includes(wtype)) return res.status(400).json({ detail: "invalid wallet type" });
  if (wtype === "treasury" && svc.getTreasury()) return res.status(400).json({ detail: "treasury already exists" });
  const w = await svc.importWallet(String(private_key), wtype, owner_user_id || null, String(label || "imported"));
  svc.audit(req.user.id, "import_wallet", `${wtype} ${w.address}`, ip(req));
  res.json(walletOut(w));
}));

// Total liquidity available for payouts (treasury + pool), admin/staff.
app.get("/liquidity", currentUser, staffOrAdmin, wrap(async (req, res) => {
  const chain = require("./chain");
  const db = getDb();
  const safe = async (a) => { try { return Number(await chain.usdtBalance(a)); } catch { return 0; } };
  const treasury = svc.getTreasury();
  const pool = db.prepare("SELECT address FROM wallets WHERE wtype='disbursement' AND is_active=1").all();
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
    const cust = getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(customer_id);
    if (!cust) return res.status(404).json({ detail: "customer not found" });
    if (cust.customer_type !== "remittance") return res.status(400).json({ detail: "payouts are only for remittance customers" });
    const wl = getDb().prepare("SELECT * FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(customer_id);
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
  if (config.get().payout_allowlist_only && !addressAllowed(dest))
    return res.status(400).json({ detail: "allow-list mode is on — destination must be in the address book or a customer whitelist" });
  const info = getDb().prepare(
    "INSERT INTO disbursement_requests(staff_user_id,customer_id,to_address,amount,status,reason,created_at) VALUES(?,?,?,?,'pending',?,?)"
  ).run(req.user.id, custId, dest, String(amount), String(reason || ""), new Date().toISOString());
  svc.audit(req.user.id, "disbursement_request", `req#${info.lastInsertRowid} ${amount} USDT -> ${dest}${custId ? ` (customer #${custId})` : ""}`, ip(req));

  // Admin payouts execute immediately. Staff payouts auto-execute at/below their
  // own limit (or the global default if they have none); otherwise await approval.
  const reqRow = getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(info.lastInsertRowid);
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
      return res.json(disbOut(getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(info.lastInsertRowid)));
    }
  }
  res.json(disbOut(reqRow));
}));

app.post("/disbursements/:id/approve", currentUser, adminRequired, wrap(async (req, res) => {
  const reqRow = getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(req.params.id);
  if (!reqRow) return res.status(404).json({ detail: "request not found" });
  if (reqRow.status !== "pending" || reqRow.tx_hash) return res.status(400).json({ detail: "request already processed" });
  const threshold = Number(config.get().dual_control_threshold || 0);
  if (threshold > 0 && Number(reqRow.amount) >= threshold) {
    if (!reqRow.first_approver) {
      getDb().prepare("UPDATE disbursement_requests SET first_approver=? WHERE id=?").run(req.user.id, reqRow.id);
      svc.audit(req.user.id, "disbursement_first_approval", `req#${reqRow.id} (awaiting 2nd approval)`, ip(req));
      return res.json(disbOut(getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(reqRow.id)));
    }
    if (reqRow.first_approver === req.user.id) return res.status(400).json({ detail: "a different admin must give the second approval" });
  }
  const updated = await svc.executeDisbursement(reqRow, req.user.id);
  svc.audit(req.user.id, "disbursement_approve", `req#${updated.id} tx=${updated.tx_hash} from_wallet=${updated.from_wallet_id}`, ip(req));
  res.json(disbOut(updated));
}));

app.get("/disbursements", currentUser, (req, res) => {
  const rows = req.user.role === "admin"
    ? getDb().prepare("SELECT * FROM disbursement_requests ORDER BY id DESC").all()
    : getDb().prepare("SELECT * FROM disbursement_requests WHERE staff_user_id=? ORDER BY id DESC").all(req.user.id);
  res.json(rows.map(disbOut));
});

// ---------------- customers (managed by staff/admin) ----------------
app.post("/customers", currentUser, staffOrAdmin, wrap(async (req, res) => {
  const { username, password, customer_type, label, whitelist_address, phone } = req.body || {};
  if (String(username || "").length < 3) return res.status(400).json({ detail: "username too short" });
  if (String(password || "").length < 8) return res.status(400).json({ detail: "password must be at least 8 characters" });
  if (!["depositor", "remittance"].includes(customer_type)) return res.status(400).json({ detail: "customer_type must be depositor or remittance" });
  if (getDb().prepare("SELECT 1 FROM users WHERE username=?").get(username)) return res.status(400).json({ detail: "username exists" });

  const info = getDb().prepare("INSERT INTO users(username,password_hash,role,is_active,customer_type,phone,created_at) VALUES(?,?,'customer',1,?,?,?)")
    .run(username, sec.hashPassword(password), customer_type, String(phone || "").trim() || null, new Date().toISOString());
  const custId = info.lastInsertRowid;
  const out = { id: custId, username, role: "customer", customer_type };

  if (customer_type === "depositor") {
    const w = await svc.createWallet("deposit", custId, String(label || `${username} deposit`));
    out.deposit_address = w.address;
  } else if (whitelist_address) {
    getDb().prepare("INSERT INTO customer_whitelist(customer_id,address,label,is_active,created_by,created_at) VALUES(?,?,?,1,?,?)")
      .run(custId, String(whitelist_address), String(label || ""), req.user.id, new Date().toISOString());
    out.whitelist = [{ address: String(whitelist_address), label: String(label || "") }];
  }
  svc.audit(req.user.id, "create_customer", `${username} (${customer_type})`, ip(req));
  res.json(out);
}));

app.get("/customers", currentUser, staffOrAdmin, (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM users WHERE role='customer' ORDER BY id").all();
  res.json(rows.map((u) => {
    const wl = getDb().prepare("SELECT COUNT(*) c FROM customer_whitelist WHERE customer_id=? AND is_active=1").get(u.id).c;
    const dep = getDb().prepare("SELECT address FROM wallets WHERE owner_user_id=? AND wtype='deposit' LIMIT 1").get(u.id);
    const staffCount = getDb().prepare("SELECT COUNT(*) c FROM customer_staff WHERE customer_id=?").get(u.id).c;
    return { id: u.id, username: u.username, customer_type: u.customer_type, is_active: !!u.is_active, whitelist_count: wl, deposit_address: dep ? dep.address : null, phone: u.phone || null, staff_count: staffCount };
  }));
});

app.get("/customers/:id", currentUser, staffOrAdmin, (req, res) => {
  const u = getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(req.params.id);
  if (!u) return res.status(404).json({ detail: "customer not found" });
  const whitelist = getDb().prepare("SELECT id,address,label,is_active FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(u.id);
  const deposit_addresses = getDb().prepare("SELECT id,address,label FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(u.id);
  const assigned_staff = getDb().prepare("SELECT u.id,u.username FROM customer_staff cs JOIN users u ON u.id=cs.staff_id WHERE cs.customer_id=?").all(u.id);
  res.json({ id: u.id, username: u.username, customer_type: u.customer_type, is_active: !!u.is_active, phone: u.phone || null, whitelist, deposit_addresses, assigned_staff });
});

// assign / unassign staff to a customer (admin)
app.post("/customers/:id/staff", currentUser, adminRequired, (req, res) => {
  const u = getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(req.params.id);
  if (!u) return res.status(404).json({ detail: "customer not found" });
  const staff = getDb().prepare("SELECT * FROM users WHERE id=?").get((req.body || {}).staff_id);
  if (!staff || !["staff", "admin"].includes(staff.role)) return res.status(400).json({ detail: "pick a staff member" });
  if (!getDb().prepare("SELECT 1 FROM customer_staff WHERE customer_id=? AND staff_id=?").get(u.id, staff.id))
    getDb().prepare("INSERT INTO customer_staff(customer_id,staff_id,created_at) VALUES(?,?,?)").run(u.id, staff.id, new Date().toISOString());
  svc.audit(req.user.id, "assign_staff", `${staff.username} -> customer #${u.id}`, ip(req));
  res.json({ ok: true });
});
app.delete("/customers/:id/staff/:sid", currentUser, adminRequired, (req, res) => {
  getDb().prepare("DELETE FROM customer_staff WHERE customer_id=? AND staff_id=?").run(req.params.id, req.params.sid);
  svc.audit(req.user.id, "unassign_staff", `staff #${req.params.sid} x customer #${req.params.id}`, ip(req));
  res.json({ ok: true });
});

// a staff member's assigned customers (admin sees all), with received totals + recent activity
app.get("/my/customers", currentUser, staffOrAdmin, (req, res) => {
  const db = getDb();
  let custs;
  if (req.user.role === "admin") custs = db.prepare("SELECT * FROM users WHERE role='customer' ORDER BY id").all();
  else {
    const ids = db.prepare("SELECT customer_id FROM customer_staff WHERE staff_id=?").all(req.user.id).map((r) => r.customer_id);
    custs = ids.length ? db.prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
  }
  res.json(custs.map((u) => {
    let total = 0, recent = [];
    if (u.customer_type === "remittance") {
      total = db.prepare("SELECT COALESCE(SUM(CAST(amount AS REAL)),0) s FROM disbursement_requests WHERE customer_id=? AND tx_hash IS NOT NULL").get(u.id).s;
      recent = db.prepare("SELECT * FROM disbursement_requests WHERE customer_id=? ORDER BY id DESC LIMIT 5").all(u.id).map(disbOut);
    } else {
      const wids = db.prepare("SELECT id FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(u.id).map((w) => w.id);
      if (wids.length) {
        const inq = wids.map(() => "?").join(",");
        total = db.prepare(`SELECT COALESCE(SUM(CAST(amount AS REAL)),0) s FROM movements WHERE kind='deposit_in' AND wallet_id IN (${inq})`).get(...wids).s;
        recent = db.prepare(`SELECT * FROM movements WHERE kind='deposit_in' AND wallet_id IN (${inq}) ORDER BY id DESC LIMIT 5`).all(...wids).map(moveOut);
      }
    }
    return { id: u.id, username: u.username, customer_type: u.customer_type, phone: u.phone || null, total_received: total, recent };
  }));
});

// ---------------- messaging (customer thread) ----------------
app.get("/customers/:id/messages", currentUser, (req, res) => {
  if (!canAccessCustomer(req.user, req.params.id)) return res.status(403).json({ detail: "not permitted" });
  const rows = getDb().prepare("SELECT * FROM messages WHERE customer_id=? ORDER BY id ASC LIMIT 500").all(req.params.id);
  res.json(rows.map((m) => ({ id: m.id, sender_user_id: m.sender_user_id, sender_role: m.sender_role, sender_name: m.sender_name, body: m.body, kind: m.kind, ref_tx: m.ref_tx, created_at: m.created_at })));
});
app.post("/customers/:id/messages", currentUser, (req, res) => {
  if (!canAccessCustomer(req.user, req.params.id)) return res.status(403).json({ detail: "not permitted" });
  const cust = getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(req.params.id);
  if (!cust) return res.status(404).json({ detail: "customer not found" });
  const { body, kind, ref_tx } = req.body || {};
  const k = ["text", "receipt", "ack"].includes(kind) ? kind : "text";
  if (!String(body || "").trim()) return res.status(400).json({ detail: "empty message" });
  const info = getDb().prepare("INSERT INTO messages(customer_id,sender_user_id,sender_role,sender_name,body,kind,ref_tx,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(cust.id, req.user.id, req.user.role, req.user.username, String(body || ""), k, ref_tx ? String(ref_tx) : null, new Date().toISOString());
  svc.audit(req.user.id, "message", `customer #${cust.id} (${k})`, ip(req));
  res.json({ id: info.lastInsertRowid, kind: k });
});

app.post("/customers/:id/whitelist", currentUser, staffOrAdmin, (req, res) => {
  const u = getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(req.params.id);
  if (!u) return res.status(404).json({ detail: "customer not found" });
  if (u.customer_type !== "remittance") return res.status(400).json({ detail: "only remittance customers have a whitelist" });
  const { address, label } = req.body || {};
  if (!address) return res.status(400).json({ detail: "address required" });
  const info = getDb().prepare("INSERT INTO customer_whitelist(customer_id,address,label,is_active,created_by,created_at) VALUES(?,?,?,1,?,?)")
    .run(u.id, String(address), String(label || ""), req.user.id, new Date().toISOString());
  svc.audit(req.user.id, "whitelist_add", `customer #${u.id} ${address}`, ip(req));
  res.json({ id: info.lastInsertRowid, address: String(address), label: String(label || ""), is_active: true });
});

app.delete("/customers/:id/whitelist/:wid", currentUser, staffOrAdmin, (req, res) => {
  const row = getDb().prepare("SELECT * FROM customer_whitelist WHERE id=? AND customer_id=?").get(req.params.wid, req.params.id);
  if (!row) return res.status(404).json({ detail: "whitelist entry not found" });
  getDb().prepare("UPDATE customer_whitelist SET is_active=0 WHERE id=?").run(row.id);
  svc.audit(req.user.id, "whitelist_remove", `customer #${req.params.id} ${row.address}`, ip(req));
  res.json({ ok: true });
});

// ---------------- customer portal (customer role only; read-only, no payouts) ----------------
app.get("/customer/me", currentUser, customerOnly, (req, res) => {
  const u = req.user;
  const whitelist = getDb().prepare("SELECT id,address,label FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(u.id);
  const deposit_addresses = getDb().prepare("SELECT id,address,label FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(u.id);
  res.json({ id: u.id, username: u.username, customer_type: u.customer_type, whitelist, deposit_addresses });
});

app.get("/customer/deposits", currentUser, customerOnly, (req, res) => {
  const ids = getDb().prepare("SELECT id FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(req.user.id).map((w) => w.id);
  if (!ids.length) return res.json([]);
  const q = `SELECT * FROM movements WHERE kind='deposit_in' AND wallet_id IN (${ids.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 500`;
  res.json(getDb().prepare(q).all(...ids).map(moveOut));
});

app.get("/customer/transfers", currentUser, customerOnly, (req, res) => {
  res.json(getDb().prepare("SELECT * FROM disbursement_requests WHERE customer_id=? ORDER BY id DESC").all(req.user.id).map(disbOut));
});

app.get("/customer/dashboard", currentUser, customerOnly, (req, res) => {
  const db = getDb();
  const u = req.user;
  if (u.customer_type === "depositor") {
    const wallets = db.prepare("SELECT id,address,label FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(u.id);
    const ids = wallets.map((w) => w.id);
    let recent = [], total = 0;
    if (ids.length) {
      const inq = ids.map(() => "?").join(",");
      recent = db.prepare(`SELECT * FROM movements WHERE kind='deposit_in' AND wallet_id IN (${inq}) ORDER BY id DESC LIMIT 10`).all(...ids).map(moveOut);
      total = db.prepare(`SELECT COALESCE(SUM(CAST(amount AS REAL)),0) s FROM movements WHERE kind='deposit_in' AND wallet_id IN (${inq})`).get(...ids).s;
    }
    return res.json({ customer_type: "depositor", network: config.get().tron_network, deposit_addresses: wallets, total_received: total, recent });
  }
  const whitelist = db.prepare("SELECT id,address,label FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(u.id);
  const recent = db.prepare("SELECT * FROM disbursement_requests WHERE customer_id=? ORDER BY id DESC LIMIT 10").all(u.id).map(disbOut);
  const total = db.prepare("SELECT COALESCE(SUM(CAST(amount AS REAL)),0) s FROM disbursement_requests WHERE customer_id=? AND tx_hash IS NOT NULL").get(u.id).s;
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
app.get("/settings", currentUser, staffOrAdmin, (_req, res) => res.json(settingsOut()));
app.post("/settings", currentUser, adminRequired, (req, res) => {
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
app.get("/admin/config", currentUser, adminRequired, (_req, res) => {
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
    wallet_preload_trx: Number(c.wallet_preload_trx != null ? c.wallet_preload_trx : 30),
    app_name: c.app_name || "KryvonWallet",
    brand_logo: c.brand_logo || "",
    favicon: c.favicon || "",
    qr_logo: c.qr_logo || "",
    setup_at: c.setup_at || null,
  });
});
app.post("/admin/config", currentUser, adminRequired, (req, res) => {
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
app.get("/admin/config/apikey", currentUser, adminRequired, (req, res) => {
  svc.audit(req.user.id, "reveal_api_key", "trongrid", ip(req));
  res.json({ trongrid_api_key: config.get().trongrid_api_key || "" });
});

// ---------------- API keys (admin manages; external systems use them) ----------------
const API_SCOPES = ["read", "deposits", "payouts"];
app.post("/apikeys", currentUser, adminRequired, (req, res) => {
  const { name, scopes } = req.body || {};
  const scopeList = Array.isArray(scopes) ? scopes.filter((s) => API_SCOPES.includes(s)) : [];
  if (!scopeList.length) return res.status(400).json({ detail: "select at least one scope" });
  const key = sec.generateApiKey();
  getDb().prepare("INSERT INTO api_keys(name,key_hash,prefix,scopes,created_by,is_active,created_at) VALUES(?,?,?,?,?,1,?)")
    .run(String(name || ""), sec.hashApiKey(key), key.slice(0, 11), scopeList.join(","), req.user.id, new Date().toISOString());
  svc.audit(req.user.id, "apikey_create", `${name || ""} [${scopeList.join(",")}]`, ip(req));
  res.json({ key, prefix: key.slice(0, 11), scopes: scopeList, note: "Save this key now — it will not be shown again." });
});
app.get("/apikeys", currentUser, adminRequired, (_req, res) => {
  res.json(getDb().prepare("SELECT id,name,prefix,scopes,is_active,last_used,created_at FROM api_keys ORDER BY id DESC").all()
    .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: (k.scopes || "").split(",").filter(Boolean), is_active: !!k.is_active, last_used: k.last_used, created_at: k.created_at })));
});
app.post("/apikeys/:id/revoke", currentUser, adminRequired, (req, res) => {
  const k = getDb().prepare("SELECT * FROM api_keys WHERE id=?").get(req.params.id);
  if (!k) return res.status(404).json({ detail: "not found" });
  getDb().prepare("UPDATE api_keys SET is_active=0 WHERE id=?").run(k.id);
  svc.audit(req.user.id, "apikey_revoke", k.prefix, ip(req));
  res.json({ ok: true });
});

// ---------------- programmatic API (X-API-Key) ----------------
function apiAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key) return res.status(401).json({ detail: "missing X-API-Key" });
  const row = getDb().prepare("SELECT * FROM api_keys WHERE key_hash=? AND is_active=1").get(sec.hashApiKey(String(key)));
  if (!row) return res.status(401).json({ detail: "invalid API key" });
  getDb().prepare("UPDATE api_keys SET last_used=? WHERE id=?").run(new Date().toISOString(), row.id);
  req.apiKey = { id: row.id, name: row.name, scopes: (row.scopes || "").split(",").filter(Boolean), created_by: row.created_by };
  next();
}
const requireScope = (s) => (req, res, next) =>
  req.apiKey && req.apiKey.scopes.includes(s) ? next() : res.status(403).json({ detail: `API key lacks '${s}' scope` });

app.get("/api/v1/ping", apiAuth, (req, res) => res.json({ ok: true, name: req.apiKey.name, scopes: req.apiKey.scopes }));

app.get("/api/v1/wallets/:address/balance", apiAuth, requireScope("read"), wrap(async (req, res) => {
  const chain = require("./chain");
  res.json({ address: req.params.address, usdt: String(await chain.usdtBalance(req.params.address)), native: String(await chain.nativeBalance(req.params.address)) });
}));

app.post("/api/v1/deposit-wallets", apiAuth, requireScope("deposits"), wrap(async (req, res) => {
  const { customer_id, label } = req.body || {};
  let owner = null;
  if (customer_id) {
    const c = getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(customer_id);
    if (!c) return res.status(404).json({ detail: "customer not found" });
    owner = c.id;
  }
  const w = await svc.createWallet("deposit", owner, String(label || "api"));
  svc.audit(req.apiKey.created_by, "create_deposit_wallet", `${w.address} (via API ${req.apiKey.name})`, ip(req));
  res.json({ address: w.address, chain: w.chain, owner_user_id: w.owner_user_id, label: w.label });
}));

app.get("/api/v1/transactions", apiAuth, requireScope("read"), (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 100);
  res.json(getDb().prepare("SELECT * FROM movements ORDER BY id DESC LIMIT ?").all(limit).map(txOut));
});

app.post("/api/v1/payouts", apiAuth, requireScope("payouts"), wrap(async (req, res) => {
  const { to_address, amount, reason, idempotency_key } = req.body || {};
  if (!to_address) return res.status(400).json({ detail: "to_address required" });
  if (!(Number(amount) > 0)) return res.status(400).json({ detail: "amount must be positive" });
  if (config.get().payout_allowlist_only && !addressAllowed(String(to_address)))
    return res.status(400).json({ detail: "allow-list mode is on — destination not allowed" });
  const creator = req.apiKey.created_by;
  if (idempotency_key) {
    const existing = getDb().prepare("SELECT * FROM disbursement_requests WHERE idempotency_key=?").get(String(idempotency_key));
    if (existing) return res.json(disbOut(existing));
  }
  const info = getDb().prepare("INSERT INTO disbursement_requests(staff_user_id,to_address,amount,status,reason,idempotency_key,created_at) VALUES(?,?,?,'pending',?,?,?)")
    .run(creator, String(to_address), String(amount), String(reason || `api ${req.apiKey.name}`), idempotency_key ? String(idempotency_key) : null, new Date().toISOString());
  const reqRow = getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(info.lastInsertRowid);
  svc.audit(creator, "disbursement_request", `req#${reqRow.id} ${amount} USDT -> ${to_address} (via API ${req.apiKey.name})`, ip(req));
  const limit = Number(config.get().staff_auto_approve_limit || 0);
  if (limit > 0 && Number(amount) <= limit) {
    try {
      const updated = await svc.executeDisbursement(reqRow, creator, limit);
      svc.audit(creator, "disbursement_auto_approved", `req#${updated.id} (API)`, ip(req));
      return res.json(disbOut(updated));
    } catch (e) {
      return res.json(disbOut(getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(reqRow.id)));
    }
  }
  res.json(disbOut(reqRow));
}));

// ---------------- CSV export (admin) ----------------
function csvEscape(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
app.get("/transactions.csv", currentUser, adminRequired, (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM movements ORDER BY id DESC LIMIT 10000").all();
  const head = ["id", "created_at", "kind", "token", "from_address", "to_address", "amount", "usd_rate", "status", "tx_hash", "initiated_by"];
  const lines = [head.join(",")].concat(rows.map((m) => [m.id, m.created_at, m.kind, m.token, m.from_address, m.to_address, m.amount, m.usd_rate, m.status, m.tx_hash, userName(m.initiated_by)].map(csvEscape).join(",")));
  res.set("Content-Type", "text/csv").set("Content-Disposition", "attachment; filename=transactions.csv").send(lines.join("\n"));
});
app.get("/audit.csv", currentUser, adminRequired, (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 10000").all();
  const head = ["id", "created_at", "user_id", "action", "detail", "ip"];
  const lines = [head.join(",")].concat(rows.map((r) => [r.id, r.created_at, r.user_id, r.action, r.detail, r.ip].map(csvEscape).join(",")));
  res.set("Content-Type", "text/csv").set("Content-Disposition", "attachment; filename=audit.csv").send(lines.join("\n"));
});

// ---------------- address book (staff/admin) ----------------
app.get("/address-book", currentUser, staffOrAdmin, (_req, res) =>
  res.json(getDb().prepare("SELECT id,label,address FROM address_book WHERE is_active=1 ORDER BY id DESC").all()));
app.post("/address-book", currentUser, staffOrAdmin, (req, res) => {
  const { address, label } = req.body || {};
  if (!address) return res.status(400).json({ detail: "address required" });
  const info = getDb().prepare("INSERT INTO address_book(label,address,is_active,created_by,created_at) VALUES(?,?,1,?,?)")
    .run(String(label || ""), String(address), req.user.id, new Date().toISOString());
  svc.audit(req.user.id, "address_book_add", `${address} (${label || ""})`, ip(req));
  res.json({ id: info.lastInsertRowid, label: String(label || ""), address: String(address) });
});
app.delete("/address-book/:id", currentUser, staffOrAdmin, (req, res) => {
  const row = getDb().prepare("SELECT * FROM address_book WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ detail: "not found" });
  getDb().prepare("UPDATE address_book SET is_active=0 WHERE id=?").run(row.id);
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
    wallet = svc.getTreasury();
    if (!wallet) return res.status(400).json({ detail: "no treasury wallet" });
  } else {
    wallet = getDb().prepare("SELECT * FROM wallets WHERE id=? AND is_active=1").get(from);
    if (!wallet) return res.status(404).json({ detail: "source wallet not found" });
    if (!["treasury", "disbursement"].includes(wallet.wtype))
      return res.status(400).json({ detail: "can only send from treasury or a pool wallet" });
  }
  const r = await svc.adminSendFrom(wallet, String(to_address), Number(amount));
  svc.audit(req.user.id, "admin_send", `${amount} USDT from ${wallet.wtype} #${wallet.id} -> ${to_address} tx=${r.tx}`, ip(req));
  res.json(r);
}));

// ---------------- ledger / audit ----------------
app.get("/movements", currentUser, (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200);
  res.json(getDb().prepare("SELECT * FROM movements ORDER BY id DESC LIMIT ?").all(limit).map(moveOut));
});

// Transaction history. Admin: all, or ?user_id= to scope to one user. Staff: own only.
app.get("/transactions", currentUser, staffOrAdmin, (req, res) => {
  const db = getDb();
  const limit = Math.min(2000, parseInt(req.query.limit, 10) || 500);
  let uid = req.query.user_id ? Number(req.query.user_id) : null;
  if (req.user.role !== "admin") uid = req.user.id; // staff see only their own
  if (!uid) {
    return res.json(db.prepare("SELECT * FROM movements ORDER BY id DESC LIMIT ?").all(limit).map(txOut));
  }
  // movements relevant to this user: initiated by them, on their wallets, or paid to them (remittance)
  const walletIds = db.prepare("SELECT id FROM wallets WHERE owner_user_id=?").all(uid).map((w) => w.id);
  const txs = db.prepare("SELECT tx_hash FROM disbursement_requests WHERE customer_id=? AND tx_hash IS NOT NULL").all(uid).map((r) => r.tx_hash);
  const clauses = ["initiated_by=?"]; const params = [uid];
  if (walletIds.length) { clauses.push(`(kind='deposit_in' AND wallet_id IN (${walletIds.map(() => "?").join(",")}))`); params.push(...walletIds); }
  if (txs.length) { clauses.push(`tx_hash IN (${txs.map(() => "?").join(",")})`); params.push(...txs); }
  const rows = db.prepare(`SELECT * FROM movements WHERE ${clauses.join(" OR ")} ORDER BY id DESC LIMIT ?`).all(...params, limit);
  res.json(rows.map(txOut));
});

// Analytics / reports summary (admin)
app.get("/reports/summary", currentUser, adminRequired, (req, res) => {
  const db = getDb();
  const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 14));
  const tot = (kind) => db.prepare("SELECT COUNT(*) c, COALESCE(SUM(CAST(amount AS REAL)),0) v FROM movements WHERE kind=? AND token='USDT'").get(kind);
  const deposits = tot("deposit_in"), payouts = tot("disburse_out");

  const map = {};
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); map[d] = { date: d, deposits: 0, payouts: 0 }; }
  const since = Object.keys(map)[0];
  db.prepare(`SELECT substr(created_at,1,10) d, kind, COALESCE(SUM(CAST(amount AS REAL)),0) v
              FROM movements WHERE token='USDT' AND kind IN ('deposit_in','disburse_out') AND substr(created_at,1,10) >= ?
              GROUP BY d, kind`).all(since).forEach((r) => {
    if (map[r.d]) { if (r.kind === "deposit_in") map[r.d].deposits = r.v; else map[r.d].payouts = r.v; }
  });

  const topCustomers = db.prepare(`SELECT u.username, COUNT(*) c, COALESCE(SUM(CAST(dr.amount AS REAL)),0) v
    FROM disbursement_requests dr JOIN users u ON u.id=dr.customer_id
    WHERE dr.customer_id IS NOT NULL AND dr.tx_hash IS NOT NULL
    GROUP BY dr.customer_id ORDER BY v DESC LIMIT 10`).all();
  const byStaff = db.prepare(`SELECT u.username, COUNT(*) c, COALESCE(SUM(CAST(m.amount AS REAL)),0) v
    FROM movements m JOIN users u ON u.id=m.initiated_by
    WHERE m.kind='disburse_out' GROUP BY m.initiated_by ORDER BY v DESC LIMIT 10`).all();

  res.json({
    days,
    deposits: { count: deposits.c, volume: deposits.v },
    payouts: { count: payouts.c, volume: payouts.v },
    counts: {
      customers: db.prepare("SELECT COUNT(*) c FROM users WHERE role='customer'").get().c,
      staff: db.prepare("SELECT COUNT(*) c FROM users WHERE role='staff'").get().c,
      pending_approvals: db.prepare("SELECT COUNT(*) c FROM disbursement_requests WHERE status='pending' AND tx_hash IS NULL").get().c,
    },
    series: Object.values(map),
    top_customers: topCustomers,
    by_staff: byStaff,
  });
});

app.get("/receipts/:id", currentUser, (req, res) => {
  const key = req.params.id;
  const m = /^\d+$/.test(key)
    ? getDb().prepare("SELECT * FROM movements WHERE id=?").get(key)
    : getDb().prepare("SELECT * FROM movements WHERE tx_hash=? ORDER BY id DESC").get(key);
  if (!m) return res.status(404).json({ detail: "receipt not found" });
  if (req.user.role !== "admin") {
    let ok = false;
    if (m.wallet_id) {
      const w = getDb().prepare("SELECT owner_user_id FROM wallets WHERE id=?").get(m.wallet_id);
      if (w && w.owner_user_id === req.user.id) ok = true;   // own deposit wallet
    }
    if (!ok && m.initiated_by === req.user.id) ok = true;     // staff who initiated
    if (!ok && req.user.role === "customer" && m.tx_hash) {   // remittance received by this customer
      const dr = getDb().prepare("SELECT 1 FROM disbursement_requests WHERE customer_id=? AND tx_hash=?").get(req.user.id, m.tx_hash);
      if (dr) ok = true;
    }
    if (!ok) return res.status(403).json({ detail: "not permitted" });
  }
  res.json(buildReceipt(m, config.get().tron_network));
});

app.get("/audit", currentUser, adminRequired, (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200);
  res.json(getDb().prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit)
    .map((r) => ({ id: r.id, user_id: r.user_id, action: r.action, detail: r.detail, ip: r.ip, at: r.created_at })));
});

// ---------------- dashboard ----------------
app.get("/dashboard", currentUser, wrap(async (req, res) => {
  const chain = require("./chain");
  const db = getDb();
  const net = config.get().tron_network;
  const safeUsdt = async (a) => { try { return String(await chain.usdtBalance(a)); } catch { return null; } };
  const safeNative = async (a) => { try { return String(await chain.nativeBalance(a)); } catch { return null; } };
  const recent = db.prepare("SELECT * FROM movements ORDER BY id DESC LIMIT 15").all().map(moveOut);

  if (req.user.role === "admin") {
    const treasury = svc.getTreasury();
    const fee = svc.getFee();
    const pool = db.prepare("SELECT * FROM wallets WHERE wtype='disbursement' AND is_active=1").all();
    const poolOut = [];
    for (const w of pool) poolOut.push({ id: w.id, address: w.address, usdt: await safeUsdt(w.address) });
    return res.json({
      role: "admin", network: net,
      treasury: treasury ? { address: treasury.address, usdt: await safeUsdt(treasury.address) } : null,
      fee: fee ? { address: fee.address, usdt: await safeUsdt(fee.address), native: await safeNative(fee.address) } : null,
      pool: poolOut,
      staff_count: db.prepare("SELECT COUNT(*) c FROM users WHERE role='staff'").get().c,
      deposit_wallet_count: db.prepare("SELECT COUNT(*) c FROM wallets WHERE wtype='deposit'").get().c,
      pending_approvals: db.prepare("SELECT COUNT(*) c FROM disbursement_requests WHERE status='pending' AND tx_hash IS NULL").get().c,
      recent_movements: recent,
    });
  }
  const myWallets = db.prepare("SELECT * FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(req.user.id);
  const myReqs = db.prepare("SELECT * FROM disbursement_requests WHERE staff_user_id=? ORDER BY id DESC LIMIT 10").all(req.user.id);
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
