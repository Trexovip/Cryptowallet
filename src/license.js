// Licensing + per-transaction metering for self-hosted (on-customer-server) deployments.
//
// A license is an Ed25519-SIGNED token:  v1.<payloadB64url>.<sigB64url>
// The app ships with the VENDOR's PUBLIC key and verifies the signature locally, so a
// customer cannot forge or alter a license without the vendor's private key.
//
// The token is read from the LICENSE_KEY env var or data/license.key. Billable events
// (payouts) are metered locally and reported to the vendor's license server for invoicing.
//
// NOTE: client-side licensing on hardware you don't control is inherently bypassable by a
// determined operator. The real protections are: the signature (no forged upgrades/renewals),
// usage reporting (accurate billing), and gating updates/support on a valid license.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

// Vendor public key — REPLACE with your own (keep the matching private key on your license server).
const DEFAULT_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEArtC+Rm6qtTguooardAk68QyyZkV7r2eJKiKPR9Jzbqs=
-----END PUBLIC KEY-----`;
const PUBKEY = (process.env.LICENSE_PUBLIC_KEY ? process.env.LICENSE_PUBLIC_KEY.replace(/\\n/g, "\n") : DEFAULT_PUBKEY);

let _lic = null, _loaded = false;
const licensePath = () => process.env.LICENSE_FILE || path.join(DATA_DIR, "license.key");

function load() {
  _loaded = true; _lic = null;
  let token = (process.env.LICENSE_KEY || "").trim();
  if (!token) { try { token = fs.readFileSync(licensePath(), "utf8").trim(); } catch { token = ""; } }
  if (!token) return;
  try {
    const [v, pB64, sB64] = token.split(".");
    if (v !== "v1" || !pB64 || !sB64) throw new Error("format");
    const payload = Buffer.from(pB64, "base64url");
    const sig = Buffer.from(sB64, "base64url");
    if (!crypto.verify(null, payload, PUBKEY, sig)) throw new Error("signature");
    _lic = { ...JSON.parse(payload.toString("utf8")), _valid_sig: true, _token: token };
  } catch { _lic = { _valid_sig: false }; }
}
function get() { if (!_loaded) load(); return _lic; }
function reload() { _loaded = false; return get(); }

function status() {
  const l = get();
  if (!l) return { licensed: false, reason: "no license installed" };
  if (!l._valid_sig) return { licensed: false, reason: "invalid license signature" };
  const now = Date.now();
  const exp = l.expires_at ? Date.parse(l.expires_at) : null;
  const graceMs = (Number(l.grace_days) || 0) * 86400000;
  const expired = exp != null && now > exp + graceMs;
  const in_grace = exp != null && now > exp && now <= exp + graceMs;
  return {
    licensed: !expired,
    in_grace, expired,
    licensee: l.licensee || null, plan: l.plan || null, license_id: l.license_id || null,
    expires_at: l.expires_at || null, billing: l.billing || "postpaid",
    included_transactions: l.included_transactions != null ? l.included_transactions : null,
    price_per_txn: l.price_per_txn != null ? l.price_per_txn : null,
    report_url: l.report_url || null, features: l.features || {},
  };
}

// ---- metering ----
const { getDb } = require("./db");
const period = () => new Date().toISOString().slice(0, 7); // YYYY-MM

async function usedThisPeriod() {
  try { return (await getDb().prepare("SELECT COUNT(*) c FROM billing_usage WHERE event='payout' AND period=?").get(period())).c; }
  catch { return 0; }
}
async function recordUsage(event, ref, amount) {
  try { await getDb().prepare("INSERT INTO billing_usage(event,ref,amount,period,reported,created_at) VALUES(?,?,?,?,0,?)").run(event, ref || null, String(amount || ""), period(), new Date().toISOString()); }
  catch (e) { /* metering is best-effort, never blocks a completed tx */ }
}
async function usageSummary() {
  const p = period();
  let month = 0, total = 0;
  try { month = (await getDb().prepare("SELECT COUNT(*) c FROM billing_usage WHERE event='payout' AND period=?").get(p)).c; } catch {}
  try { total = (await getDb().prepare("SELECT COUNT(*) c FROM billing_usage WHERE event='payout'").get()).c; } catch {}
  return { period: p, month, total };
}

// Throw before a billable action when the license won't allow it.
async function assertPayoutAllowed() {
  if (process.env.LICENSE_ENFORCE !== "1") return; // enforcement is opt-in (set LICENSE_ENFORCE=1 in production)
  const s = status();
  if (!s.licensed) throw new Error(s.reason || "license expired or invalid — contact your vendor");
  if (s.billing === "prepaid" && s.included_transactions != null) {
    const used = await usedThisPeriod();
    if (used >= s.included_transactions)
      throw new Error("transaction quota reached for this period — contact your vendor to top up");
  }
}

// Report unreported usage to the vendor's license server (best-effort; may return a renewed license).
async function reportUsage() {
  const s = status(); const l = get();
  if (!s.report_url || !s.license_id || !l || !l._token) return;
  const db = getDb();
  let rows = [];
  try { rows = await db.prepare("SELECT id,event,ref,amount,period,created_at FROM billing_usage WHERE reported=0 ORDER BY id LIMIT 1000").all(); } catch { return; }
  if (!rows.length) return;
  try {
    const res = await fetch(s.report_url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-License": l._token },
      body: JSON.stringify({ license_id: s.license_id, events: rows.map((r) => ({ event: r.event, ref: r.ref, amount: r.amount, period: r.period, at: r.created_at })) }),
    });
    if (!res.ok) return;
    const ids = rows.map((r) => r.id);
    await db.prepare(`UPDATE billing_usage SET reported=1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    try { const j = await res.json(); if (j && j.license) { fs.writeFileSync(licensePath(), String(j.license).trim()); reload(); } } catch {}
  } catch { /* offline — retry next cycle */ }
}

module.exports = { get, reload, status, usedThisPeriod, recordUsage, usageSummary, assertPayoutAllowed, reportUsage, licensePath };
