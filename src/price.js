// USDT -> USD rate. USDT tracks the dollar but isn't exactly 1.0000, so the rate
// is captured at settlement time and stored on each movement/receipt. If the price
// source is unavailable, we fall back to 1.00 so settlement is never blocked.
let cache = { rate: 1, at: 0 };
const TTL_MS = 60_000;

async function getUsdRate() {
  const now = Date.now();
  if (now - cache.at < TTL_MS) return cache.rate;
  try {
    const opts = AbortSignal.timeout ? { signal: AbortSignal.timeout(4000) } : {};
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd",
      opts
    );
    const j = await res.json();
    const r = Number(j && j.tether && j.tether.usd);
    if (Number.isFinite(r) && r > 0) { cache = { rate: r, at: now }; return r; }
  } catch {
    /* fall through to fallback */
  }
  cache = { rate: 1, at: now }; // fallback: treat USDT as $1.00
  return 1;
}

module.exports = { getUsdRate };
