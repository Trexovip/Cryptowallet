// Business logic: wallet provisioning, deposit sweeping, disbursement.
// Payouts leave from a RANDOM disbursement-pool wallet (never treasury directly),
// and every value movement is written to the append-only movements ledger.
const { getDb } = require("./db");
const chain = require("./chain");
const sec = require("./security");
const { get, save } = require("./config");
const { getUsdRate } = require("./price");
const license = require("./license");
const energy = require("./energy");

const now = () => new Date().toISOString();
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function audit(userId, action, detail = "", ip = "") {
  (await getDb().prepare("INSERT INTO audit_log(user_id,action,detail,ip,created_at) VALUES(?,?,?,?,?)")
    .run(userId, action, detail, ip, now()));
}
async function record(kind, from, to, amount, tx, { walletId = null, userId = null, status = "confirmed", note = "", token = "USDT", usdRate = null, energy = null } = {}) {
  return (await getDb().prepare(
    `INSERT INTO movements(kind,chain,token,from_address,to_address,amount,tx_hash,status,wallet_id,initiated_by,note,usd_rate,energy,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(kind, "tron", token, from, to, String(amount), tx, status, walletId, userId, note,
        usdRate == null ? null : String(usdRate), energy == null ? null : String(energy), now())).lastInsertRowid;
}

function fireWebhook(event, data) {
  const url = get().webhook_url;
  if (!url) return;
  try { fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, data, at: new Date().toISOString() }) }).catch(() => {}); }
  catch (e) { /* ignore */ }
}

async function importWallet(privHex, wtype, ownerUserId = null, label = "", preload = true) {
  const clean = String(privHex).replace(/^0x/, "").trim();
  const address = chain.addressFromPrivateKey(clean);
  if (!address) throw new Error("invalid private key");
  if ((await getDb().prepare("SELECT 1 FROM wallets WHERE address=?").get(address))) throw new Error("that wallet already exists");
  const info = (await getDb().prepare(
    `INSERT INTO wallets(chain,address,enc_privkey,wtype,label,owner_user_id,is_active,created_at) VALUES('tron',?,?,?,?,?,1,?)`
  ).run(address, sec.encryptSecret(clean), wtype, label, ownerUserId, now()));
  const wallet = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(info.lastInsertRowid));
  if (preload) await preloadGas(wallet);
  return wallet;
}

// Best-effort: send a starter amount of TRX from the gas wallet to a newly created wallet so it
// is activated and ready. Skips the gas wallet itself and does nothing if the gas wallet is
// missing/underfunded or the wallet already holds enough TRX.
async function preloadGas(wallet) {
  try {
    const amt = Number(get().wallet_preload_trx != null ? get().wallet_preload_trx : 20);
    if (!(amt > 0) || !wallet || wallet.wtype === "fee") return;
    const fee = await getFee();
    if (!fee) return;
    let have = 0; try { have = await chain.nativeBalance(wallet.address); } catch { have = 0; }
    if (have >= amt) return;
    let feeBal = 0; try { feeBal = await chain.nativeBalance(fee.address); } catch { feeBal = 0; }
    if (feeBal < amt) return;
    const feePk = sec.decryptSecret(fee.enc_privkey);
    const tx = await chain.sendNative(feePk, wallet.address, amt);
    await record("gas_fund", fee.address, wallet.address, amt, tx, { walletId: wallet.id, note: "pre-load on creation", token: "TRX" });
  } catch (e) { /* best-effort */ }
}

async function createWallet(wtype, ownerUserId = null, label = "") {
  const w = await chain.newWallet();
  const info = (await getDb().prepare(
    `INSERT INTO wallets(chain,address,enc_privkey,wtype,label,owner_user_id,is_active,created_at)
     VALUES('tron',?,?,?,?,?,1,?)`
  ).run(w.address, sec.encryptSecret(w.privateKey), wtype, label, ownerUserId, now()));
  const wallet = (await getDb().prepare("SELECT * FROM wallets WHERE id=?").get(info.lastInsertRowid));
  // Gas pre-load and the one-time on-chain name are done in the BACKGROUND so wallet
  // creation returns immediately and the UI refreshes without waiting on the network.
  provisionNewWallet(wallet);
  return wallet;
}

// Background side-effects for a freshly created wallet: fund gas, then set its one-time
// on-chain name (deposit wallets only). Best-effort — never blocks or fails creation.
async function provisionNewWallet(wallet) {
  try {
    await preloadGas(wallet);
    const tpl = get().customer_onchain_name != null ? get().customer_onchain_name : "KryvonWallet-{id}";
    if (tpl && wallet.wtype === "deposit") {
      const owner = wallet.owner_user_id ? (await getDb().prepare("SELECT username FROM users WHERE id=?").get(wallet.owner_user_id)) : null;
      const name = renderCustomerName(tpl, { id: wallet.owner_user_id || "", username: owner ? owner.username : "", app: get().app_name || "KryvonWallet" });
      if (name) await setOnchainName(wallet, name);
    }
  } catch (e) { /* non-fatal */ }
}
const getTreasury = async () => (await getDb().prepare("SELECT * FROM wallets WHERE wtype='treasury' AND is_active=1").get());
const getFee = async () => (await getDb().prepare("SELECT * FROM wallets WHERE wtype='fee' AND is_active=1").get());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ensure a wallet is activated and has TRX before it sends a TRC-20 transfer.
// Tops it up from the gas (fee) wallet when low, then waits for on-chain confirmation.
// Provision Energy for a wallet before a USDT transfer so it spends energy instead of burning TRX.
// Provision Energy before a USDT transfer so it spends energy instead of burning TRX.
// Returns true if an energy source was used (so the wallet needs only bandwidth TRX, not a burn top-up).
// Mode "auto" (default): rent via the provider API if configured, else delegate self-staked energy,
// else do nothing (caller falls back to burning TRX so the payout still succeeds).
// Rental credentials can come from env (ENERGY_RENTAL_URL / ENERGY_RENTAL_API_KEY / ENERGY_RENTAL_AMOUNT)
// so payouts can be made gas-free with zero in-app configuration.
async function ensureEnergy(wallet) {
  const mode = get().energy_mode || "auto";
  if (mode === "burn" || !wallet) return false;
  const rentalAmt = Number(process.env.ENERGY_RENTAL_AMOUNT || get().energy_rental_amount || 65000);
  const delegateTrx = Number(get().energy_delegate_trx || 0);
  // TronZap credentials (env takes precedence so it works with zero in-app config)
  const tzToken = process.env.TRONZAP_API_TOKEN || get().tronzap_api_token || "";
  const tzSecret = process.env.TRONZAP_API_SECRET || get().tronzap_api_secret || "";
  const provider = process.env.ENERGY_PROVIDER || get().energy_provider || (tzToken && tzSecret ? "tronzap" : "");
  const rentalUrl = process.env.ENERGY_RENTAL_URL || get().energy_rental_url || "";
  const rentalKey = process.env.ENERGY_RENTAL_API_KEY || get().energy_rental_api_key || "";
  try {
    if ((mode === "rental" || mode === "auto") && provider === "tronzap" && tzToken && tzSecret) {
      let bandwidth = Number(process.env.TRONZAP_BANDWIDTH != null ? process.env.TRONZAP_BANDWIDTH : (get().tronzap_bandwidth != null ? get().tronzap_bandwidth : 345));
      // Smart: only pay to rent bandwidth when the wallet's free/own bandwidth can't cover the transfer.
      if (bandwidth > 0 && get().tronzap_smart_bandwidth !== false) {
        let avail = 0; try { avail = await chain.availableBandwidth(wallet.address); } catch { avail = 0; }
        if (avail >= bandwidth) bandwidth = 0; // free bandwidth is enough — don't rent
      }
      const r = await energy.tronzapRent(wallet.address, rentalAmt, { token: tzToken, secret: tzSecret, baseUrl: process.env.TRONZAP_BASE_URL || get().tronzap_base_url, bandwidth, activate: !!get().tronzap_activate, externalId: "w" + (wallet.id || "") + "-" + Date.now() });
      if (!r.ok) console.log("[energy] TronZap rent failed:", r.error);
      return !!r.ok;
    }
    if ((mode === "rental" || mode === "auto") && rentalUrl) {
      const r = await energy.genericRent(wallet.address, rentalAmt, { url: rentalUrl, apiKey: rentalKey });
      return !!r.ok;
    }
    if ((mode === "stake" || mode === "auto") && delegateTrx > 0) {
      const fee = await getFee(); if (!fee) return false;
      const feePk = sec.decryptSecret(fee.enc_privkey);
      await chain.delegateEnergy(feePk, wallet.address, delegateTrx, false);
      return true;
    }
  } catch (e) { /* best-effort: fall back to burning TRX below */ }
  return false;
}

async function ensureGas(wallet) {
  const energyPerTx = Number(get().energy_rental_amount || 65000); // energy a USDT transfer consumes
  const fee = await getFee();
  if (!fee || !wallet) return energyPerTx;
  const energized = await ensureEnergy(wallet);
  let trx = 0;
  try { trx = await chain.nativeBalance(wallet.address); } catch { trx = 0; }
  // If energy was provisioned (TronZap/stake), send NO TRX for gas — the transfer uses the rented/
  // delegated energy and the account's free daily bandwidth. Only when energy provisioning FAILED do
  // we fall back to funding TRX so TRON can burn it and the payout still goes through. (bandwidth_trx
  // defaults to 0; raise it only if you hit bandwidth limits on high-volume wallets.)
  const need = energized ? Number(get().bandwidth_trx != null ? get().bandwidth_trx : 0) : Number(get().gas_fund_trx);
  if (need <= 0 || trx >= need) return energyPerTx;
  const feePk = sec.decryptSecret(fee.enc_privkey);
  const tx = await chain.sendNative(feePk, wallet.address, need);
  await record("gas_fund", fee.address, wallet.address, need, tx, { walletId: wallet.id, note: "gas for send", token: "TRX" });
  // wait until the account is funded/activated before broadcasting the token transfer
  for (let i = 0; i < 10; i++) {
    try { if ((await chain.nativeBalance(wallet.address)) > 0) break; } catch { /* retry */ }
    await sleep(1500);
  }
  return energyPerTx;
}

async function scanAndSweep() {
  const db = getDb();
  const treasury = await getTreasury();
  const fee = await getFee();
  const out = [];
  if (!treasury) return [{ error: "no treasury wallet configured" }];

  const rate = await getUsdRate();
  const deposits = (await db.prepare("SELECT * FROM wallets WHERE wtype='deposit' AND is_active=1").all());
  for (const w of deposits) {
    let bal;
    try { bal = await chain.usdtBalance(w.address); }
    catch (e) { out.push({ wallet: w.address, error: "balance: " + e.message }); continue; }
    if (bal < Number(get().sweep_min_usdt)) continue;

    // Record each incoming deposit with its real sender + tx hash, deduped by hash.
    // Falls back to a balance-only record if the transfer history can't be read.
    try {
      const incoming = await chain.listIncomingUsdt(w.address);
      const known = new Set((await db.prepare("SELECT tx_hash FROM movements WHERE kind='deposit_in' AND wallet_id=?").all(w.id)).map((r) => r.tx_hash));
      for (const t of incoming) {
        if (t.txid && known.has(t.txid)) continue;
        await record("deposit_in", t.from, w.address, t.amount, t.txid, { walletId: w.id, status: "confirmed", note: "deposit received", usdRate: rate });
        fireWebhook("deposit.received", { address: w.address, from: t.from, amount: t.amount, tx: t.txid });
      }
    } catch {
      await record("deposit_in", null, w.address, bal, null, { walletId: w.id, status: "confirmed", note: "detected on scan", usdRate: rate });
    }

    // Provision ENERGY first (staked delegation / rental), then only a minimal bandwidth TRX —
    // so deposit wallets sweep gas-free instead of each burning a full TRX top-up.
    try { await ensureGas(w); }
    catch (e) { out.push({ wallet: w.address, error: "gas: " + e.message }); continue; }
    try {
      const pk = sec.decryptSecret(w.enc_privkey);
      const tx = await chain.sendUsdt(pk, treasury.address, bal);
      await record("sweep", w.address, treasury.address, bal, tx, { walletId: w.id, note: "sweep to treasury", usdRate: rate });
      out.push({ wallet: w.address, swept: bal, tx });
    } catch (e) { out.push({ wallet: w.address, error: "sweep: " + e.message }); }
  }
  return out;
}

// Pick the next pool wallet in round-robin rotation (persisted), so each payout rotates
// to a different wallet instead of always using the same one.
function nextPoolWallet(pool) {
  const rotor = Number(get().pool_rotor || 0);
  const chosen = pool[rotor % pool.length];
  try { const c = { ...get() }; c.pool_rotor = (rotor + 1) % pool.length; save(c); } catch { /* best-effort */ }
  return chosen;
}

// Return a single pool wallet holding at least `need` USDT, ready to pay out.
// Wallets are used in ROUND-ROBIN order. If the rotated wallet is short, top it up by
// consolidating from the treasury (the reserve) first, then from other pool wallets.
async function ensurePoolFunded(need, usdRate = null) {
  const db = getDb();
  const pool = (await db.prepare("SELECT * FROM wallets WHERE wtype='disbursement' AND is_active=1 ORDER BY id").all());
  if (!pool.length) throw new Error("disbursement pool is empty — provision it first");

  // round-robin selection — advances every payout
  const target = nextPoolWallet(pool);
  let have = 0; try { have = await chain.usdtBalance(target.address); } catch { have = 0; }
  if (have + 1e-9 >= need) return target;

  // top up the rotated wallet: treasury first, then the other pool wallets (richest first)
  const others = pool.filter((w) => w.id !== target.id);
  const bals = [];
  for (const w of others) { let b = 0; try { b = await chain.usdtBalance(w.address); } catch { b = 0; } bals.push({ w, b }); }
  bals.sort((a, b) => b.b - a.b);

  const sources = [];
  const treasury = await getTreasury();
  if (treasury) { let tb = 0; try { tb = await chain.usdtBalance(treasury.address); } catch { tb = 0; } sources.push({ w: treasury, b: tb }); }
  for (const x of bals) sources.push(x);

  for (const s of sources) {
    if (have + 1e-9 >= need) break;
    if (s.b <= 0) continue;
    const move = Math.min(s.b, need - have);
    if (move <= 0) continue;
    await ensureGas(s.w);
    const spk = sec.decryptSecret(s.w.enc_privkey);
    const tx = await chain.sendUsdt(spk, target.address, move);
    await record("topup", s.w.address, target.address, move, tx, { walletId: target.id, note: "consolidate for payout", usdRate });
    have += move;
  }

  if (have + 1e-9 < need)
    throw new Error(`insufficient liquidity to cover ${need} USDT — fund the treasury or pool (available ${have.toFixed(2)})`);

  // wait for the consolidation transfers to reflect on-chain before the payout
  for (let i = 0; i < 12; i++) {
    let tb = 0; try { tb = await chain.usdtBalance(target.address); } catch { tb = 0; }
    if (tb + 1e-9 >= need) break;
    await sleep(2500);
  }
  return target;
}

// Check the on-chain receipt after broadcast and update the ledger + payout row to
// confirmed/failed (leaves it pending if it can't confirm within the window).
// Insert one on-chain transfer into the ledger if it isn't already recorded. Returns true if inserted.
async function _insertTransfer(db, tr, kind, walletId) {
  const exists = await db.prepare("SELECT 1 FROM movements WHERE tx_hash=? AND from_address IS ? AND to_address IS ?").get(tr.txid, tr.from, tr.to);
  if (exists) return false;
  await db.prepare("INSERT INTO movements(kind,chain,token,from_address,to_address,amount,tx_hash,status,wallet_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(kind, "tron", "USDT", tr.from, tr.to, String(tr.value), tr.txid, "confirmed", walletId, "reconciled from chain", tr.timestamp ? new Date(tr.timestamp).toISOString() : now());
  return true;
}

// MODE "payouts-to": given an EXTERNAL beneficiary address, find and save only the payouts WE sent to it
// from our pool/treasury wallets. Does NOT touch deposits or that address's unrelated history.
async function reconcilePayoutsTo(address) {
  const db = getDb();
  const ours = new Map((await db.prepare("SELECT id,address,wtype FROM wallets").all()).map((w) => [w.address, w]));
  const transfers = await chain.listTrc20Transfers(address, 5000);
  let scanned = transfers.length, inserted = 0;
  if (ours.has(address)) return { mode: "payouts-to", address, scanned: 0, inserted: 0, note: "that address is one of your own wallets — use 'reconcile a wallet' instead" };
  for (const tr of transfers) {
    if (tr.to !== address) continue;                 // only transfers that landed ON this (external) address
    const fromW = ours.get(tr.from);                 // ...and were sent FROM one of our pool/treasury wallets
    if (!fromW || (fromW.wtype !== "disbursement" && fromW.wtype !== "treasury")) continue;
    if (await _insertTransfer(db, tr, fromW.wtype === "treasury" ? "treasury_out" : "disburse_out", fromW.id)) inserted++;
  }
  return { mode: "payouts-to", address, scanned, inserted };
}

// MODE "wallet": reconcile ONE of OUR wallets in its natural direction.
//  - deposit wallet  -> save all INCOMING deposits to it
//  - pool/treasury   -> save all OUTGOING payouts from it
async function reconcileWallet(address) {
  const db = getDb();
  const w = await db.prepare("SELECT id,address,wtype FROM wallets WHERE address=?").get(address);
  if (!w) throw new Error("that address is not one of your wallets — use 'check payouts to address' for an external address");
  const ourAddrs = new Set((await db.prepare("SELECT address FROM wallets").all()).map((x) => x.address));
  const transfers = await chain.listTrc20Transfers(address, 5000);
  let scanned = transfers.length, inserted = 0;
  for (const tr of transfers) {
    if (w.wtype === "deposit") {
      if (tr.to !== address) continue;               // incoming only
      if (ourAddrs.has(tr.from)) continue;           // skip internal (funded by one of our wallets) — only real customer deposits
      if (await _insertTransfer(db, tr, "deposit_in", w.id)) inserted++;
    } else {
      if (tr.from !== address) continue;             // outgoing only
      if (ourAddrs.has(tr.to)) continue;             // skip internal (to one of our own wallets) — only real external payouts
      if (await _insertTransfer(db, tr, w.wtype === "treasury" ? "treasury_out" : "disburse_out", w.id)) inserted++;
    }
  }
  return { mode: "wallet", address, wtype: w.wtype, scanned, inserted };
}

// Reconcile every one of our active wallets in its natural direction.
async function reconcileAll() {
  const ws = await getDb().prepare("SELECT address FROM wallets WHERE is_active=1").all();
  let scanned = 0, inserted = 0;
  for (const w of ws) { const r = await reconcileWallet(w.address); scanned += r.scanned; inserted += r.inserted; }
  return { mode: "all", wallets: ws.length, scanned, inserted };
}

// Re-check any broadcast-but-still-pending payouts/movements and flip them to confirmed/failed.
// Runs every worker cycle so a transaction that confirms AFTER the initial window isn't stuck pending.
async function reconcilePending() {
  const db = getDb();
  const reqs = (await db.prepare("SELECT tx_hash FROM disbursement_requests WHERE status='pending' AND tx_hash IS NOT NULL").all());
  const moves = (await db.prepare("SELECT tx_hash FROM movements WHERE status='pending' AND tx_hash IS NOT NULL").all());
  const hashes = [...new Set([...reqs.map((r) => r.tx_hash), ...moves.map((m) => m.tx_hash)].filter(Boolean))];
  for (const h of hashes) {
    let st; try { st = await chain.confirmTx(h, { tries: 3, gapMs: 1500 }); } catch { st = "pending"; }
    if (st === "pending") continue;
    (await db.prepare("UPDATE disbursement_requests SET status=? WHERE tx_hash=? AND status='pending'").run(st, h));
    (await db.prepare("UPDATE movements SET status=? WHERE tx_hash=? AND status='pending'").run(st, h));
    if (st === "confirmed") {
      try { const e = await chain.txEnergyUsed(h); if (e != null) await db.prepare("UPDATE movements SET energy=? WHERE tx_hash=?").run(String(e), h); } catch { /* keep estimate */ }
      const r = (await db.prepare("SELECT * FROM disbursement_requests WHERE tx_hash=?").get(h)); if (r) fireWebhook("payout.sent", { to: r.to_address, amount: Number(r.amount), tx: h, request_id: r.id });
    }
  }
  return hashes.length;
}

function confirmInBackground(tx, { moveId = null, reqId = null } = {}) {
  Promise.resolve()
    .then(() => chain.confirmTx(tx))
    .then(async (status) => {
      if (status === "pending") return; // unknown yet — leave as pending
      const db = getDb();
      if (moveId) {
        (await db.prepare("UPDATE movements SET status=? WHERE id=?").run(status, moveId));
        if (status === "confirmed") { // replace the estimate with the real energy from the receipt
          try { const e = await chain.txEnergyUsed(tx); if (e != null) await db.prepare("UPDATE movements SET energy=? WHERE id=?").run(String(e), moveId); } catch { /* keep estimate */ }
        }
      }
      if (reqId) {
        (await db.prepare("UPDATE disbursement_requests SET status=? WHERE id=? AND tx_hash=?").run(status, reqId, tx));
        if (status === "confirmed") {
          const r = (await db.prepare("SELECT * FROM disbursement_requests WHERE id=?").get(reqId));
          if (r) fireWebhook("payout.sent", { to: r.to_address, amount: Number(r.amount), tx, request_id: r.id });
        }
      }
    })
    .catch(() => { /* best-effort */ });
}

// Can payouts currently be funded? Checks the energy provider (TronZap balance) and the gas wallet.
// Cached briefly so the dashboard can poll it without hammering the provider API.
let _readyCache = null, _readyAt = 0;
function _tzCreds() {
  const cfg = get();
  const token = process.env.TRONZAP_API_TOKEN || cfg.tronzap_api_token || "";
  const secret = process.env.TRONZAP_API_SECRET || cfg.tronzap_api_secret || "";
  const provider = process.env.ENERGY_PROVIDER || cfg.energy_provider || (token && secret ? "tronzap" : "");
  return { token, secret, provider };
}
async function payoutReadiness(force = false) {
  if (!force && _readyCache && Date.now() - _readyAt < 60000) return _readyCache;
  const cfg = get(); const mode = cfg.energy_mode || "auto";
  const fee = await getFee();
  let gasTrx = 0; try { if (fee) gasTrx = await chain.nativeBalance(fee.address); } catch { gasTrx = 0; }
  const gasFund = Number(cfg.gas_fund_trx || 20);
  const gasOk = gasTrx >= gasFund;
  const { token, secret, provider } = _tzCreds();
  const usesTz = (mode === "auto" || mode === "rental") && provider === "tronzap" && token && secret;
  let tzBalance = null, tzOk = false;
  if (usesTz) {
    const b = await energy.tronzapBalance({ token, secret, baseUrl: process.env.TRONZAP_BASE_URL || cfg.tronzap_base_url });
    if (b.ok) { tzBalance = b.balance; tzOk = (b.balance == null) || Number(b.balance) > 0; }
  }
  const genericRental = (mode === "auto" || mode === "rental") && !usesTz && !!(process.env.ENERGY_RENTAL_URL || cfg.energy_rental_url);
  const staked = (mode === "auto" || mode === "stake") && Number(cfg.energy_delegate_trx || 0) > 0;
  const ready = tzOk || gasOk || staked || genericRental;
  let reason = "";
  if (!ready) reason = usesTz
    ? "TronZap balance looks empty and the gas wallet has no TRX — fund your TronZap balance or send TRX to the gas wallet."
    : "No energy source: fund the gas wallet with TRX, or configure and fund an energy provider (TronZap).";
  const out = { ready, mode, provider: usesTz ? "tronzap" : (genericRental ? "generic" : (staked ? "stake" : "burn")), gas_trx: gasTrx, gas_fund_trx: gasFund, gas_ok: gasOk, tronzap_configured: !!usesTz, tronzap_balance: tzBalance, tronzap_ok: tzOk, staked, reason };
  _readyCache = out; _readyAt = Date.now();
  return out;
}
// Fast per-payout preflight: block early with a clear message only when there is NO way to pay resources.
async function assertResourceSource(wallet) {
  const cfg = get(); const mode = cfg.energy_mode || "auto";
  const { token, secret, provider } = _tzCreds();
  const tzConfigured = (mode === "auto" || mode === "rental") && provider === "tronzap" && token && secret;
  const genericRental = (mode === "auto" || mode === "rental") && !!(process.env.ENERGY_RENTAL_URL || cfg.energy_rental_url);
  const staked = (mode === "auto" || mode === "stake") && Number(cfg.energy_delegate_trx || 0) > 0;
  if (tzConfigured || genericRental || staked) return; // a provider exists; the send + fallback handle the rest
  const fee = await getFee();
  let gasTrx = 0; try { if (fee) gasTrx = await chain.nativeBalance(fee.address); } catch { gasTrx = 0; }
  if (gasTrx >= Number(cfg.gas_fund_trx || 20)) return; // gas wallet can fund the TRX burn
  throw new Error("Can't pay network resources for this payout: no energy provider is configured and the gas wallet is empty. Fund your TronZap balance, or send some TRX to the gas wallet, then retry.");
}

// Send USDT, but if it fails for lack of on-chain resources (energy/bandwidth), fund the wallet with
// TRX from the gas wallet and retry once so TRON can burn for the resources. Energy stays primary;
// TRX-burn is only the safety net — this prevents "account resource insufficient" failures.
async function sendUsdtResilient(pk, to, amount, wallet) {
  try { return await chain.sendUsdt(pk, to, amount); }
  catch (e) {
    const msg = String((e && e.message) || "");
    if (!/resource|energy|bandwidth|insufficient|not\s*enough|balance is not sufficient/i.test(msg)) throw e;
    const fee = await getFee();
    if (fee && wallet) {
      try {
        const feePk = sec.decryptSecret(fee.enc_privkey);
        const need = Number(get().gas_fund_trx) || 20;
        const gtx = await chain.sendNative(feePk, wallet.address, need);
        await record("gas_fund", fee.address, wallet.address, need, gtx, { walletId: wallet.id, note: "gas for send (resource fallback)", token: "TRX" });
        for (let i = 0; i < 10; i++) { try { if ((await chain.nativeBalance(wallet.address)) > 0) break; } catch { /* retry */ } await sleep(1500); }
      } catch (fundErr) { throw new Error("payout failed for lack of energy/bandwidth and the gas wallet could not be funded — top up the gas wallet with TRX or fund your energy provider"); }
    }
    return await chain.sendUsdt(pk, to, amount); // retry; the account can now burn TRX for resources
  }
}

async function executeDisbursement(req, approverId, cap = null) {
  const db = getDb();
  const amount = Number(req.amount);
  if (cap != null && amount > Number(cap))
    throw new Error(`amount exceeds the limit of ${cap}`);

  const rate = await getUsdRate();
  const wallet = await ensurePoolFunded(amount, rate);
  await ensureGas(wallet);
  const pk = sec.decryptSecret(wallet.enc_privkey);
  await assertResourceSource(wallet);
  await license.assertPayoutAllowed();
  const tx = await sendUsdtResilient(pk, req.to_address, amount, wallet);
  await license.recordUsage("payout", tx, amount);
  // Return immediately after broadcast (status "pending") so the UI is fast; the on-chain
  // receipt is checked in the background and the row flips to confirmed/failed when known.
  const moveId = await record("disburse_out", wallet.address, req.to_address, amount, tx,
    { walletId: wallet.id, userId: req.staff_user_id, status: "pending", note: `payout req#${req.id}`, usdRate: rate, energy: Number(get().energy_rental_amount || 65000) });
  (await db.prepare("UPDATE disbursement_requests SET status='pending', approved_by=?, from_wallet_id=?, tx_hash=?, resolved_at=? WHERE id=?")
    .run(approverId, wallet.id, tx, now(), req.id));
  confirmInBackground(tx, { moveId, reqId: req.id });
  return (await db.prepare("SELECT * FROM disbursement_requests WHERE id=?").get(req.id));
}

// Distribute treasury USDT across the disbursement pool, holding back holdPct%.
async function distributeTreasury(holdPct) {
  const db = getDb();
  const treasury = await getTreasury();
  if (!treasury) throw new Error("no treasury wallet");
  const pool = (await db.prepare("SELECT * FROM wallets WHERE wtype='disbursement' AND is_active=1").all());
  if (!pool.length) throw new Error("no disbursement pool wallets to distribute to");

  const bal = await chain.usdtBalance(treasury.address);
  const hold = bal * (Number(holdPct) / 100);
  const distributable = bal - hold;
  let per = Math.floor((distributable / pool.length) * 1e6) / 1e6; // round down to 6dp
  if (!(per > 0)) return { balance: bal, held: bal, distributed: 0, per_wallet: 0, count: pool.length };

  const rate = await getUsdRate();
  const tpk = sec.decryptSecret(treasury.enc_privkey);
  let distributed = 0;
  for (const w of pool) {
    await ensureGas(treasury);
    const tx = await chain.sendUsdt(tpk, w.address, per);
    await record("topup", treasury.address, w.address, per, tx, { walletId: w.id, note: `treasury split (hold ${holdPct}%)`, usdRate: rate });
    distributed += per;
  }
  return { balance: bal, held: bal - distributed, distributed, per_wallet: per, count: pool.length };
}

// Admin-only: send USDT from treasury to any address.
async function treasurySend(toAddress, amount) {
  const treasury = await getTreasury();
  if (!treasury) throw new Error("no treasury wallet");
  return adminSendFrom(treasury, toAddress, amount);
}

// Admin-only: send USDT from a chosen source wallet (treasury or a pool wallet).
async function adminSendFrom(sourceWallet, toAddress, amount) {
  const bal = await chain.usdtBalance(sourceWallet.address);
  if (Number(amount) > bal + 1e-9) throw new Error("amount exceeds source wallet balance");
  const rate = await getUsdRate();
  await ensureGas(sourceWallet);
  const pk = sec.decryptSecret(sourceWallet.enc_privkey);
  await assertResourceSource(sourceWallet);
  await license.assertPayoutAllowed();
  const tx = await sendUsdtResilient(pk, toAddress, Number(amount), sourceWallet);
  await license.recordUsage("payout", tx, Number(amount));
  const kind = sourceWallet.wtype === "treasury" ? "treasury_out" : "disburse_out";
  const moveId = await record(kind, sourceWallet.address, toAddress, Number(amount), tx,
    { walletId: sourceWallet.id, status: "pending", note: `admin send from ${sourceWallet.wtype}`, usdRate: rate, energy: Number(get().energy_rental_amount || 65000) });
  confirmInBackground(tx, { moveId });
  return { tx, kind, status: "pending" };
}

async function setOnchainName(wallet, name) {
  await ensureGas(wallet);
  const pk = sec.decryptSecret(wallet.enc_privkey);
  const tx = await chain.setAccountName(pk, name);
  return { tx };
}

// Render an on-chain name template for a customer wallet. Placeholders: {id} {username} {customer} {app}.
function renderCustomerName(tpl, ctx) {
  return String(tpl || "")
    .replace(/\{id\}/g, ctx.id != null ? ctx.id : "")
    .replace(/\{username\}/g, ctx.username || "")
    .replace(/\{customer\}/g, ctx.username || "")
    .replace(/\{app\}/g, ctx.app || "")
    .trim().slice(0, 32);
}

async function energyStatus() {
  const fee = await getFee();
  if (!fee) return { configured: false };
  let resources = {}; try { resources = await chain.accountResources(fee.address); } catch { resources = {}; }
  let trx = 0; try { trx = await chain.nativeBalance(fee.address); } catch { trx = 0; }
  return { configured: true, mode: get().energy_mode || "burn", address: fee.address, trx, ...resources };
}
async function stakeEnergy(trx) {
  const fee = await getFee(); if (!fee) throw new Error("no gas/energy wallet");
  const pk = sec.decryptSecret(fee.enc_privkey);
  return { tx: await chain.freezeEnergy(pk, trx) };
}
async function unstakeEnergy(trx) {
  const fee = await getFee(); if (!fee) throw new Error("no gas/energy wallet");
  const pk = sec.decryptSecret(fee.enc_privkey);
  return { tx: await chain.unfreezeEnergy(pk, trx) };
}

// Swap USDT (from treasury) to TRX and deliver it to the gas wallet.
async function swapToGas(usdtAmount) {
  const fee = await getFee(); if (!fee) throw new Error("no gas wallet");
  const src = await getTreasury(); if (!src) throw new Error("no treasury wallet");
  usdtAmount = Number(usdtAmount);
  if (!(usdtAmount > 0)) throw new Error("amount must be greater than 0");
  let bal = 0; try { bal = await chain.usdtBalance(src.address); } catch { bal = 0; }
  if (bal < usdtAmount) throw new Error("treasury USDT balance is too low for this swap");
  await ensureGas(src); // treasury needs a little TRX / energy to pay for the swap tx
  const srcPk = sec.decryptSecret(src.enc_privkey);
  const r = await chain.swapUsdtToTrx(srcPk, usdtAmount, fee.address, Number(get().swap_slippage_percent || 5));
  await record("gas_swap", src.address, fee.address, r.trxOut || 0, r.tx, { note: `swapped ${usdtAmount} USDT to TRX`, token: "TRX" });
  return { ...r, usdt_in: usdtAmount };
}
let _lastGasSwap = 0;
async function maybeAutoRefillGas() {
  if (!get().auto_swap_enabled) return;
  const fee = await getFee(); if (!fee) return;
  const amt = Number(get().auto_swap_usdt || 0); if (!(amt > 0)) return;
  let trx = 0; try { trx = await chain.nativeBalance(fee.address); } catch { return; }
  if (trx >= Number(get().gas_min_trx || 100)) return;
  if (Date.now() - _lastGasSwap < 5 * 60 * 1000) return; // cooldown, avoid repeated swaps
  _lastGasSwap = Date.now();
  try { const r = await swapToGas(amt); console.log("[worker] gas auto-refill:", r.trxOut, "TRX from", amt, "USDT"); }
  catch (e) { console.log("[worker] gas auto-refill skipped:", e.message); }
}

async function ownershipProof(wallet, project) {
  const message = `I confirm this address belongs to ${project}.`;
  const pk = sec.decryptSecret(wallet.enc_privkey);
  const signature = await chain.signMessage(pk, message);
  return { address: wallet.address, message, signature };
}

module.exports = {
  audit, record, createWallet, getTreasury, getFee, scanAndSweep, ensurePoolFunded, executeDisbursement,
  distributeTreasury, treasurySend, adminSendFrom, importWallet, fireWebhook, setOnchainName, ownershipProof, renderCustomerName,
  ensureEnergy, energyStatus, stakeEnergy, unstakeEnergy, swapToGas, maybeAutoRefillGas, reconcilePending, reconcilePayoutsTo, reconcileWallet, reconcileAll, payoutReadiness, assertResourceSource,
};
