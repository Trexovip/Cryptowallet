// Energy-rental provider clients. Keeps payouts gas-free by renting TRON energy for the sending
// wallet before a USDT transfer. Currently supports TronZap (signed REST) and a generic POST webhook.
const crypto = require("crypto");

// TronZap (https://tronzap.com, API docs https://docs.tronzap.com).
// Auth: Authorization: Bearer <api_token>  +  X-Signature: sha256(rawBody + api_secret) [lowercase hex].
// Creates an energy order that is auto-paid from your prepaid TronZap balance, so fund the balance
// in your TronZap dashboard first. Energy (~65,000 for a standard USDT transfer) arrives in seconds.
async function tronzapRent(address, energy, opts = {}) {
  const token = opts.token, secret = opts.secret;
  if (!token || !secret) return { ok: false, error: "missing TronZap token/secret" };
  const baseUrl = (opts.baseUrl || "https://api.tronzap.com").replace(/\/+$/, "");
  const params = { address, energy_amount: Number(energy), duration: Number(opts.duration || 1), activate_address: !!opts.activate };
  // Rent bandwidth in the same order (resource bundle) so the transfer needs zero TRX even at volume.
  // TronZap reports a bundle under service "energy" with a bandwidth_amount param.
  if (opts.bandwidth && Number(opts.bandwidth) > 0) params.bandwidth_amount = Number(opts.bandwidth);
  const payload = { service: "energy", params };
  if (opts.externalId) payload.external_id = String(opts.externalId);
  const body = JSON.stringify(payload);                       // sign the EXACT bytes we send
  const signature = crypto.createHash("sha256").update(body + secret).digest("hex");
  let res, j;
  try {
    res = await fetch(baseUrl + "/v1/transaction/new", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "X-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    j = await res.json().catch(() => null);
  } catch (e) { return { ok: false, error: e.message }; }
  // TronZap signals success with HTTP 200 and body code 0; auth/other errors come as code != 0.
  const ok = !!(res && res.ok && j && j.code === 0);
  return { ok, code: j && j.code, result: j && j.result, error: ok ? null : (j && (j.message || j.key)) || ("http " + (res && res.status)) };
}

// TronZap prepaid balance (signed GET-style POST to /v1/balance). Returns { ok, balance }.
async function tronzapBalance(opts = {}) {
  const { token, secret } = opts;
  if (!token || !secret) return { ok: false, error: "missing TronZap token/secret" };
  const baseUrl = (opts.baseUrl || "https://api.tronzap.com").replace(/\/+$/, "");
  const body = "{}";
  const signature = crypto.createHash("sha256").update(body + secret).digest("hex");
  try {
    const res = await fetch(baseUrl + "/v1/balance", { method: "POST", headers: { Authorization: "Bearer " + token, "X-Signature": signature, "Content-Type": "application/json" }, body });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || j.code !== 0) return { ok: false, error: (j && (j.message || j.key)) || ("http " + (res && res.status)) };
    const r = j.result || {};
    const raw = r.balance != null ? r.balance : (r.trx != null ? r.trx : (r.amount != null ? r.amount : null));
    const bal = raw == null ? null : Number(raw);
    return { ok: true, balance: (bal == null || isNaN(bal)) ? null : bal };
  } catch (e) { return { ok: false, error: e.message }; }
}

// TronSave (https://tronsave.io) v2 API. Auth: `apikey` header. Buys ENERGY (resourceAmount must be
// > 64000). Balance comes from /v2/user-info in SUN. Prepaid, like TronZap.
async function tronsaveRent(address, energy, opts = {}) {
  const key = opts.apiKey;
  if (!key) return { ok: false, error: "missing TronSave api key" };
  const baseUrl = (opts.baseUrl || "https://api.tronsave.io").replace(/\/+$/, "");
  const amt = Math.max(65000, Number(energy) || 65000);
  const body = JSON.stringify({ receiver: address, resourceType: "ENERGY", resourceAmount: amt, durationSec: Number(opts.durationSec || 3600) });
  try {
    const res = await fetch(baseUrl + "/v2/buy-resource", { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body });
    const j = await res.json().catch(() => null);
    const d = j && (j.data || j);
    const ok = !!(res.ok && d && (d.orderId || d.order_id || d.id || j.success === true || j.code === 0));
    return { ok, result: j, error: ok ? null : ((j && (j.message || j.error)) || ("http " + (res && res.status))) };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function tronsaveBalance(opts = {}) {
  const key = opts.apiKey;
  if (!key) return { ok: false };
  const baseUrl = (opts.baseUrl || "https://api.tronsave.io").replace(/\/+$/, "");
  try {
    const res = await fetch(baseUrl + "/v2/user-info", { headers: { apikey: key } });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) return { ok: false };
    const d = j.data || j;
    const sun = d.balance != null ? Number(d.balance) : (d.balanceSun != null ? Number(d.balanceSun) : null);
    return { ok: true, balance: (sun == null || isNaN(sun)) ? null : sun / 1e6 }; // SUN -> TRX
  } catch (e) { return { ok: false, error: e.message }; }
}

// TEnergy (https://tenergy.me) — a TRON energy router. Signed REST: three headers, HMAC-SHA256 over
// `timestamp + METHOD + path + query + body`. POST /v1/orders buys energy; GET /v1/balance reads balance.
function tenergySign(secret, ts, method, path, query, body) {
  return crypto.createHmac("sha256", secret).update(ts + method + path + query + body).digest("base64");
}
async function tenergyRent(address, energy, opts = {}) {
  const key = opts.apiKey, secret = opts.apiSecret;
  if (!key || !secret) return { ok: false, error: "missing TEnergy key/secret" };
  const baseUrl = (opts.baseUrl || "https://api.tenergy.me").replace(/\/+$/, "");
  const path = "/v1/orders";
  const payload = { client_order_id: opts.clientOrderId || ("w" + Date.now()), resource: "energy", amount: Math.max(32000, Number(energy) || 65000), tier: opts.tier || "1h", receiver: address, activate: opts.activate !== false };
  const body = JSON.stringify(payload);
  const ts = new Date().toISOString();
  const sign = tenergySign(secret, ts, "POST", path, "", body);
  try {
    const res = await fetch(baseUrl + path, { method: "POST", headers: { "X-API-KEY": key, "X-API-TIMESTAMP": ts, "X-API-SIGN": sign, "Content-Type": "application/json" }, body });
    const j = await res.json().catch(() => null);
    const ok = !!((res.status === 200 || res.status === 201) && j && (j.id || j.status) && j.status !== "failed");
    return { ok, result: j, error: ok ? null : ((j && (j.error || j.message || j.slug)) || ("http " + (res && res.status))) };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function tenergyBalance(opts = {}) {
  const key = opts.apiKey, secret = opts.apiSecret;
  if (!key || !secret) return { ok: false };
  const baseUrl = (opts.baseUrl || "https://api.tenergy.me").replace(/\/+$/, "");
  const ts = new Date().toISOString();
  const sign = tenergySign(secret, ts, "GET", "/v1/balance", "", "");
  try {
    const res = await fetch(baseUrl + "/v1/balance", { headers: { "X-API-KEY": key, "X-API-TIMESTAMP": ts, "X-API-SIGN": sign } });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) return { ok: false };
    const d = j.data || j;
    const sun = d.balance_sun != null ? Number(d.balance_sun) : (d.available_sun != null ? Number(d.available_sun) : (d.balance != null ? Number(d.balance) : null));
    return { ok: true, balance: (sun == null || isNaN(sun)) ? null : sun / 1e6 };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Generic provider: POST { address, energy } with an optional bearer key; any 2xx = success.
async function genericRent(address, energy, opts = {}) {
  if (!opts.url) return { ok: false, error: "no rental url" };
  const headers = { "Content-Type": "application/json" };
  if (opts.apiKey) headers.Authorization = "Bearer " + opts.apiKey;
  try {
    const res = await fetch(opts.url, { method: "POST", headers, body: JSON.stringify({ address, energy: Number(energy) }) });
    return { ok: !!(res && res.ok) };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { tronzapRent, genericRent, tronzapBalance, tronsaveRent, tronsaveBalance, tenergyRent, tenergyBalance };
