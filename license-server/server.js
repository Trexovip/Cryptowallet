// Vendor-side license + billing server. Run this on YOUR infrastructure (never ship to customers).
// - POST /usage    : customer deployments report metered transactions here (set as report_url in the license)
// - POST /issue    : mint a signed license (admin-only)
// - GET  /usage/:id : per-customer transaction totals for invoicing (admin-only)
// Keys: keys/private.pem (secret, signs licenses) + keys/public.pem (embed in the app).
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 9000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me";
const pub = fs.readFileSync(path.join(__dirname, "keys", "public.pem"), "utf8");
const privPath = process.env.LICENSE_PRIVATE_KEY || path.join(__dirname, "keys", "private.pem");

const db = new Database(path.join(__dirname, "license.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, license_id TEXT, event TEXT, ref TEXT,
    amount TEXT, period TEXT, at TEXT, received_at TEXT);
  CREATE TABLE IF NOT EXISTS licenses (license_id TEXT PRIMARY KEY, licensee TEXT, plan TEXT, token TEXT, issued_at TEXT);
`);

const app = express();
app.use(express.json({ limit: "4mb" }));

const verifyToken = (tok) => {
  try { const [v, p, s] = String(tok || "").split("."); if (v !== "v1") return null;
    const payload = Buffer.from(p, "base64url");
    if (!crypto.verify(null, payload, pub, Buffer.from(s, "base64url"))) return null;
    return JSON.parse(payload.toString()); } catch { return null; }
};
const admin = (req, res, next) => ((req.headers.authorization || "") === "Bearer " + ADMIN_TOKEN ? next() : res.status(403).json({ detail: "forbidden" }));

app.get("/health", (_q, r) => r.json({ ok: true }));

// usage ingestion (authenticated by the signed license token)
app.post("/usage", (req, res) => {
  const lic = verifyToken(req.headers["x-license"]);
  const { license_id, events } = req.body || {};
  if (!lic || lic.license_id !== license_id) return res.status(401).json({ detail: "invalid license" });
  const ins = db.prepare("INSERT INTO usage(license_id,event,ref,amount,period,at,received_at) VALUES(?,?,?,?,?,?,?)");
  const now = new Date().toISOString(); let n = 0;
  for (const e of (events || [])) { ins.run(license_id, e.event, e.ref || null, e.amount || null, e.period || null, e.at || null, now); n++; }
  res.json({ ok: true, accepted: n });
});

// mint a signed license
app.post("/issue", admin, (req, res) => {
  const b = req.body || {};
  const payload = {
    license_id: b.license_id || "lic_" + crypto.randomBytes(5).toString("hex"),
    licensee: b.licensee || "Customer", plan: b.plan || "standard", issued_at: new Date().toISOString(),
    expires_at: b.days ? new Date(Date.now() + b.days * 86400000).toISOString() : null,
    billing: b.billing || "postpaid", included_transactions: b.included_transactions != null ? b.included_transactions : null,
    price_per_txn: b.price_per_txn != null ? b.price_per_txn : null, grace_days: b.grace_days != null ? b.grace_days : 7,
    report_url: b.report_url || null, features: b.features || {},
  };
  const buf = Buffer.from(JSON.stringify(payload));
  const token = `v1.${buf.toString("base64url")}.${Buffer.from(crypto.sign(null, buf, fs.readFileSync(privPath, "utf8"))).toString("base64url")}`;
  db.prepare("INSERT OR REPLACE INTO licenses(license_id,licensee,plan,token,issued_at) VALUES(?,?,?,?,?)")
    .run(payload.license_id, payload.licensee, payload.plan, token, payload.issued_at);
  res.json({ token, license: payload });
});

// billing view
app.get("/usage/:id", admin, (req, res) => {
  const by_period = db.prepare("SELECT period, COUNT(*) c FROM usage WHERE license_id=? AND event='payout' GROUP BY period ORDER BY period").all(req.params.id);
  const total = db.prepare("SELECT COUNT(*) c FROM usage WHERE license_id=? AND event='payout'").get(req.params.id).c;
  res.json({ license_id: req.params.id, total_transactions: total, by_period });
});

app.listen(PORT, () => console.log("License server on :" + PORT));
