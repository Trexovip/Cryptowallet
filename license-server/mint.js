#!/usr/bin/env node
/*
 * mint.js — VENDOR-ONLY. Mints a signed license token for a customer.
 * Keep keys/private.pem secret; never ship this folder to customers.
 *
 * Example:
 *   node license-server/mint.js --licensee "Acme Pay" --plan pro --days 365 \
 *     --billing prepaid --included 10000 --price 0.10 \
 *     --report-url https://license.yourco.com/usage --out acme.license.key
 *
 * Give the customer the printed token (or the .key file). They set it as the
 * LICENSE_KEY env var, or drop it in their data dir as license.key, and run with
 * LICENSE_ENFORCE=1.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : (i >= 0 ? true : d); };
const privPath = process.env.LICENSE_PRIVATE_KEY || path.join(__dirname, "keys", "private.pem");
if (!fs.existsSync(privPath)) { console.error("private key not found at " + privPath); process.exit(1); }
const privateKey = fs.readFileSync(privPath, "utf8");

const payload = {
  license_id: arg("id", "lic_" + crypto.randomBytes(5).toString("hex")),
  licensee: String(arg("licensee", "Customer")),
  plan: String(arg("plan", "standard")),
  issued_at: new Date().toISOString(),
  expires_at: arg("days") ? new Date(Date.now() + Number(arg("days")) * 86400000).toISOString() : null,
  billing: String(arg("billing", "postpaid")),               // prepaid | postpaid
  included_transactions: arg("included") ? Number(arg("included")) : null, // prepaid monthly quota
  price_per_txn: arg("price") ? Number(arg("price")) : null,
  grace_days: Number(arg("grace", "7")),
  report_url: arg("report-url") ? String(arg("report-url")) : null,
  features: {},
};
const buf = Buffer.from(JSON.stringify(payload));
const sig = crypto.sign(null, buf, privateKey);
const token = `v1.${buf.toString("base64url")}.${Buffer.from(sig).toString("base64url")}`;

if (arg("out")) { fs.writeFileSync(String(arg("out")), token); console.error("Wrote " + arg("out")); }
console.log(token);
console.error("\nLicense:", JSON.stringify(payload, null, 2));
