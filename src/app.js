const express = require("express");
const crypto = require("crypto");
const path = require("path");
const config = require("./config");
const { getDb } = require("./db");
const sec = require("./security");
const svc = require("./services");

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PUBLIC = path.join(__dirname, "..", "public");
app.use("/static", express.static(PUBLIC));

const ip = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";
const userOut = (u) => ({ id: u.id, username: u.username, role: u.role, is_active: !!u.is_active });
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
  return {
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
}
const disbOut = (d) => ({ id: d.id, to_address: d.to_address, amount: d.amount, status: d.status, from_wallet_id: d.from_wallet_id, tx_hash: d.tx_hash });

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
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) =>
  res.status(400).json({ detail: e.message || "request failed" }));

// ---------------- auth ----------------
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = getDb().prepare("SELECT * FROM users WHERE username=?").get(String(username || ""));
  if (!u || !u.is_active || !sec.verifyPassword(String(password || ""), u.password_hash))
    return res.status(401).json({ detail: "bad username or password" });
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

app.post("/wallets/deposit", currentUser, adminRequired, wrap(async (req, res) => {
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

// ---------------- disbursements ----------------
app.post("/disbursements", currentUser, (req, res) => {
  const { to_address, amount, reason } = req.body || {};
  if (!to_address) return res.status(400).json({ detail: "recipient address required" });
  if (!(Number(amount) > 0)) return res.status(400).json({ detail: "amount must be positive" });
  const info = getDb().prepare(
    "INSERT INTO disbursement_requests(staff_user_id,to_address,amount,status,reason,created_at) VALUES(?,?,?,'pending',?,?)"
  ).run(req.user.id, to_address, String(amount), String(reason || ""), new Date().toISOString());
  svc.audit(req.user.id, "disbursement_request", `req#${info.lastInsertRowid} ${amount} USDT -> ${to_address}`, ip(req));
  res.json(disbOut(getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(info.lastInsertRowid)));
});

app.post("/disbursements/:id/approve", currentUser, adminRequired, wrap(async (req, res) => {
  const reqRow = getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(req.params.id);
  if (!reqRow) return res.status(404).json({ detail: "request not found" });
  if (reqRow.status !== "pending" || reqRow.tx_hash) return res.status(400).json({ detail: "request already processed" });
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

// ---------------- ledger / audit ----------------
app.get("/movements", currentUser, (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200);
  res.json(getDb().prepare("SELECT * FROM movements ORDER BY id DESC LIMIT ?").all(limit).map(moveOut));
});

app.get("/receipts/:id", currentUser, (req, res) => {
  const key = req.params.id;
  const m = /^\d+$/.test(key)
    ? getDb().prepare("SELECT * FROM movements WHERE id=?").get(key)
    : getDb().prepare("SELECT * FROM movements WHERE tx_hash=? ORDER BY id DESC").get(key);
  if (!m) return res.status(404).json({ detail: "receipt not found" });
  if (req.user.role !== "admin") {
    let ownsWallet = false;
    if (m.wallet_id) {
      const w = getDb().prepare("SELECT owner_user_id FROM wallets WHERE id=?").get(m.wallet_id);
      ownsWallet = w && w.owner_user_id === req.user.id;
    }
    if (m.initiated_by !== req.user.id && !ownsWallet)
      return res.status(403).json({ detail: "not permitted" });
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
  const tick = async () => {
    try { const r = await svc.scanAndSweep(); if (r && r.length) console.log("[worker]", JSON.stringify(r)); }
    catch (e) { console.log("[worker] error:", e.message); }
  };
  workerTimer = setInterval(tick, intervalMs);
  console.log(`[worker] started; every ${intervalMs / 1000}s on ${config.get().tron_network}`);
}

module.exports = { app, startWorker };
