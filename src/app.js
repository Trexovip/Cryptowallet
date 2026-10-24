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
const userOut = (u) => ({ id: u.id, username: u.username, role: u.role, is_active: !!u.is_active, customer_type: u.customer_type || null });
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
const disbOut = (d) => ({ id: d.id, customer_id: d.customer_id, to_address: d.to_address, amount: d.amount, status: d.status, from_wallet_id: d.from_wallet_id, tx_hash: d.tx_hash, created_at: d.created_at });
const userName = (id) => { if (!id) return null; const u = getDb().prepare("SELECT username FROM users WHERE id=?").get(id); return u ? u.username : null; };
function txOut(m) {
  const o = moveOut(m);
  o.initiated_by_name = userName(m.initiated_by);
  const rate = m.usd_rate != null ? Number(m.usd_rate) : null;
  o.amount_usd = (m.token === "TRX" || rate == null) ? null : Number((Number(m.amount) * rate).toFixed(2));
  return o;
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
const staffOrAdmin = (req, res, next) =>
  (req.user.role === "admin" || req.user.role === "staff") ? next() : res.status(403).json({ detail: "staff or admin only" });
const customerOnly = (req, res, next) =>
  req.user.role === "customer" ? next() : res.status(403).json({ detail: "customers only" });
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
  const info = getDb().prepare(
    "INSERT INTO disbursement_requests(staff_user_id,customer_id,to_address,amount,status,reason,created_at) VALUES(?,?,?,?,'pending',?,?)"
  ).run(req.user.id, custId, dest, String(amount), String(reason || ""), new Date().toISOString());
  svc.audit(req.user.id, "disbursement_request", `req#${info.lastInsertRowid} ${amount} USDT -> ${dest}${custId ? ` (customer #${custId})` : ""}`, ip(req));

  // Auto-approve when at/below the admin-set per-transaction limit; otherwise leave for approval.
  const limit = Number(config.get().staff_auto_approve_limit || 0);
  const reqRow = getDb().prepare("SELECT * FROM disbursement_requests WHERE id=?").get(info.lastInsertRowid);
  if (limit > 0 && Number(amount) <= limit) {
    try {
      const updated = await svc.executeDisbursement(reqRow, req.user.id);
      svc.audit(req.user.id, "disbursement_auto_approved", `req#${updated.id} <= limit ${limit}`, ip(req));
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
  const { username, password, customer_type, label, whitelist_address } = req.body || {};
  if (String(username || "").length < 3) return res.status(400).json({ detail: "username too short" });
  if (String(password || "").length < 8) return res.status(400).json({ detail: "password must be at least 8 characters" });
  if (!["depositor", "remittance"].includes(customer_type)) return res.status(400).json({ detail: "customer_type must be depositor or remittance" });
  if (getDb().prepare("SELECT 1 FROM users WHERE username=?").get(username)) return res.status(400).json({ detail: "username exists" });

  const info = getDb().prepare("INSERT INTO users(username,password_hash,role,is_active,customer_type,created_at) VALUES(?,?,'customer',1,?,?)")
    .run(username, sec.hashPassword(password), customer_type, new Date().toISOString());
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
    return { id: u.id, username: u.username, customer_type: u.customer_type, is_active: !!u.is_active, whitelist_count: wl, deposit_address: dep ? dep.address : null };
  }));
});

app.get("/customers/:id", currentUser, staffOrAdmin, (req, res) => {
  const u = getDb().prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(req.params.id);
  if (!u) return res.status(404).json({ detail: "customer not found" });
  const whitelist = getDb().prepare("SELECT id,address,label,is_active FROM customer_whitelist WHERE customer_id=? AND is_active=1").all(u.id);
  const deposit_addresses = getDb().prepare("SELECT id,address,label FROM wallets WHERE owner_user_id=? AND wtype='deposit'").all(u.id);
  res.json({ id: u.id, username: u.username, customer_type: u.customer_type, is_active: !!u.is_active, whitelist, deposit_addresses });
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
  const tick = async () => {
    try { const r = await svc.scanAndSweep(); if (r && r.length) console.log("[worker]", JSON.stringify(r)); }
    catch (e) { console.log("[worker] error:", e.message); }
  };
  workerTimer = setInterval(tick, intervalMs);
  console.log(`[worker] started; every ${intervalMs / 1000}s on ${config.get().tron_network}`);
}

module.exports = { app, startWorker };
