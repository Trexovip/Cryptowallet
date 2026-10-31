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
  const payload = { service: "energy", params: { address, energy_amount: Number(energy), duration: Number(opts.duration || 1), activate_address: !!opts.activate } };
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

module.exports = { tronzapRent, genericRent };
