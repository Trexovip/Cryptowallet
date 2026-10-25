// Business logic: wallet provisioning, deposit sweeping, disbursement.
// Payouts leave from a RANDOM disbursement-pool wallet (never treasury directly),
// and every value movement is written to the append-only movements ledger.
const { getDb } = require("./db");
const chain = require("./chain");
const sec = require("./security");
const { get } = require("./config");
const { getUsdRate } = require("./price");

const now = () => new Date().toISOString();
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function audit(userId, action, detail = "", ip = "") {
  getDb().prepare("INSERT INTO audit_log(user_id,action,detail,ip,created_at) VALUES(?,?,?,?,?)")
    .run(userId, action, detail, ip, now());
}
function record(kind, from, to, amount, tx, { walletId = null, userId = null, status = "pending", note = "", token = "USDT", usdRate = null } = {}) {
  return getDb().prepare(
    `INSERT INTO movements(kind,chain,token,from_address,to_address,amount,tx_hash,status,wallet_id,initiated_by,note,usd_rate,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(kind, "tron", token, from, to, String(amount), tx, status, walletId, userId, note,
        usdRate == null ? null : String(usdRate), now()).lastInsertRowid;
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
  if (getDb().prepare("SELECT 1 FROM wallets WHERE address=?").get(address)) throw new Error("that wallet already exists");
  const info = getDb().prepare(
    `INSERT INTO wallets(chain,address,enc_privkey,wtype,label,owner_user_id,is_active,created_at) VALUES('tron',?,?,?,?,?,1,?)`
  ).run(address, sec.encryptSecret(clean), wtype, label, ownerUserId, now());
  const wallet = getDb().prepare("SELECT * FROM wallets WHERE id=?").get(info.lastInsertRowid);
  if (preload) await preloadGas(wallet);
  return wallet;
}

// Best-effort: send a starter amount of TRX from the gas wallet to a newly created wallet so it
// is activated and ready. Skips the gas wallet itself and does nothing if the gas wallet is
// missing/underfunded or the wallet already holds enough TRX.
async function preloadGas(wallet) {
  try {
    const amt = Number(get().wallet_preload_trx != null ? get().wallet_preload_trx : 30);
    if (!(amt > 0) || !wallet || wallet.wtype === "fee") return;
    const fee = getFee();
    if (!fee) return;
    let have = 0; try { have = await chain.nativeBalance(wallet.address); } catch { have = 0; }
    if (have >= amt) return;
    let feeBal = 0; try { feeBal = await chain.nativeBalance(fee.address); } catch { feeBal = 0; }
    if (feeBal < amt) return;
    const feePk = sec.decryptSecret(fee.enc_privkey);
    const tx = await chain.sendNative(feePk, wallet.address, amt);
    record("gas_fund", fee.address, wallet.address, amt, tx, { walletId: wallet.id, note: "pre-load on creation", token: "TRX" });
  } catch (e) { /* best-effort */ }
}

async function createWallet(wtype, ownerUserId = null, label = "") {
  const w = await chain.newWallet();
  const info = getDb().prepare(
    `INSERT INTO wallets(chain,address,enc_privkey,wtype,label,owner_user_id,is_active,created_at)
     VALUES('tron',?,?,?,?,?,1,?)`
  ).run(w.address, sec.encryptSecret(w.privateKey), wtype, label, ownerUserId, now());
  const wallet = getDb().prepare("SELECT * FROM wallets WHERE id=?").get(info.lastInsertRowid);
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
      const owner = wallet.owner_user_id ? getDb().prepare("SELECT username FROM users WHERE id=?").get(wallet.owner_user_id) : null;
      const name = renderCustomerName(tpl, { id: wallet.owner_user_id || "", username: owner ? owner.username : "", app: get().app_name || "KryvonWallet" });
      if (name) await setOnchainName(wallet, name);
    }
  } catch (e) { /* non-fatal */ }
}
const getTreasury = () => getDb().prepare("SELECT * FROM wallets WHERE wtype='treasury' AND is_active=1").get();
const getFee = () => getDb().prepare("SELECT * FROM wallets WHERE wtype='fee' AND is_active=1").get();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ensure a wallet is activated and has TRX before it sends a TRC-20 transfer.
// Tops it up from the gas (fee) wallet when low, then waits for on-chain confirmation.
// Provision Energy for a wallet before a USDT transfer so it spends energy instead of burning TRX.
async function ensureEnergy(wallet) {
  const mode = get().energy_mode || "burn";
  if (mode === "burn" || !wallet) return;
  try {
    if (mode === "stake") {
      const fee = getFee(); if (!fee) return;
      const trx = Number(get().energy_delegate_trx || 0);
      if (trx > 0) { const feePk = sec.decryptSecret(fee.enc_privkey); await chain.delegateEnergy(feePk, wallet.address, trx, false); }
    } else if (mode === "rental") {
      const url = get().energy_rental_url; if (!url) return;
      const headers = { "Content-Type": "application/json" };
      if (get().energy_rental_api_key) headers.Authorization = "Bearer " + get().energy_rental_api_key;
      await fetch(url, { method: "POST", headers, body: JSON.stringify({ address: wallet.address, energy: Number(get().energy_rental_amount || 65000) }) });
    }
  } catch (e) { /* best-effort: if energy provisioning fails the transfer still goes through by burning TRX */ }
}

async function ensureGas(wallet) {
  const fee = getFee();
  if (!fee || !wallet) return;
  await ensureEnergy(wallet);
  let trx = 0;
  try { trx = await chain.nativeBalance(wallet.address); } catch { trx = 0; }
  if (trx >= Number(get().gas_fund_trx)) return;
  const feePk = sec.decryptSecret(fee.enc_privkey);
  const tx = await chain.sendNative(feePk, wallet.address, Number(get().gas_fund_trx));
  record("gas_fund", fee.address, wallet.address, get().gas_fund_trx, tx, { walletId: wallet.id, note: "gas for send", token: "TRX" });
  // wait until the account is funded/activated before broadcasting the token transfer
  for (let i = 0; i < 10; i++) {
    try { if ((await chain.nativeBalance(wallet.address)) > 0) break; } catch { /* retry */ }
    await sleep(1500);
  }
}

async function scanAndSweep() {
  const db = getDb();
  const treasury = getTreasury();
  const fee = getFee();
  const out = [];
  if (!treasury) return [{ error: "no treasury wallet configured" }];

  const rate = await getUsdRate();
  const deposits = db.prepare("SELECT * FROM wallets WHERE wtype='deposit' AND is_active=1").all();
  for (const w of deposits) {
    let bal;
    try { bal = await chain.usdtBalance(w.address); }
    catch (e) { out.push({ wallet: w.address, error: "balance: " + e.message }); continue; }
    if (bal < Number(get().sweep_min_usdt)) continue;

    // Record each incoming deposit with its real sender + tx hash, deduped by hash.
    // Falls back to a balance-only record if the transfer history can't be read.
    try {
      const incoming = await chain.listIncomingUsdt(w.address);
      const known = new Set(db.prepare("SELECT tx_hash FROM movements WHERE kind='deposit_in' AND wallet_id=?").all(w.id).map((r) => r.tx_hash));
      for (const t of incoming) {
        if (t.txid && known.has(t.txid)) continue;
        record("deposit_in", t.from, w.address, t.amount, t.txid, { walletId: w.id, status: "confirmed", note: "deposit received", usdRate: rate });
        fireWebhook("deposit.received", { address: w.address, from: t.from, amount: t.amount, tx: t.txid });
      }
    } catch {
      record("deposit_in", null, w.address, bal, null, { walletId: w.id, status: "confirmed", note: "detected on scan", usdRate: rate });
    }

    let trx = 0;
    try { trx = await chain.nativeBalance(w.address); } catch { /* unactivated */ }
    if (trx < 1 && fee) {
      try {
        const feePk = sec.decryptSecret(fee.enc_privkey);
        const tx = await chain.sendNative(feePk, w.address, Number(get().gas_fund_trx));
        record("gas_fund", fee.address, w.address, get().gas_fund_trx, tx, { walletId: w.id, note: "gas for sweep", token: "TRX" });
      } catch (e) { out.push({ wallet: w.address, error: "gas: " + e.message }); continue; }
    }
    try {
      const pk = sec.decryptSecret(w.enc_privkey);
      const tx = await chain.sendUsdt(pk, treasury.address, bal);
      record("sweep", w.address, treasury.address, bal, tx, { walletId: w.id, status: "pending", note: "sweep to treasury", usdRate: rate });
      out.push({ wallet: w.address, swept: bal, tx });
    } catch (e) { out.push({ wallet: w.address, error: "sweep: " + e.message }); }
  }
  return out;
}

// Return a single pool wallet holding at least `need` USDT, ready to pay out.
// 1) If a pool wallet already covers it, use it (random among those).
// 2) Otherwise consolidate into one wallet: pull from the treasury first (the reserve),
//    then from other pool wallets, until it covers the amount. Throws clearly if the total
//    liquidity across treasury + pool can't cover it.
async function ensurePoolFunded(need, usdRate = null) {
  const db = getDb();
  const pool = db.prepare("SELECT * FROM wallets WHERE wtype='disbursement' AND is_active=1").all();
  if (!pool.length) throw new Error("disbursement pool is empty — provision it first");

  const bals = [];
  for (const w of pool) { let b = 0; try { b = await chain.usdtBalance(w.address); } catch { b = 0; } bals.push({ w, b }); }

  // 1) a single wallet already has enough → random among those
  const covering = bals.filter((x) => x.b + 1e-9 >= need);
  if (covering.length) return covering[Math.floor(Math.random() * covering.length)].w;

  // 2) consolidate into the wallet with the most USDT (fewest transfers)
  bals.sort((a, b) => b.b - a.b);
  const target = bals[0].w;
  let have = bals[0].b;

  const sources = [];
  const treasury = getTreasury();
  if (treasury) { let tb = 0; try { tb = await chain.usdtBalance(treasury.address); } catch { tb = 0; } sources.push({ w: treasury, b: tb }); }
  for (let i = 1; i < bals.length; i++) sources.push(bals[i]);

  for (const s of sources) {
    if (have + 1e-9 >= need) break;
    if (s.b <= 0) continue;
    const move = Math.min(s.b, need - have);
    if (move <= 0) continue;
    await ensureGas(s.w);
    const spk = sec.decryptSecret(s.w.enc_privkey);
    const tx = await chain.sendUsdt(spk, target.address, move);
    record("topup", s.w.address, target.address, move, tx, { walletId: target.id, note: "consolidate for payout", usdRate });
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

async function executeDisbursement(req, approverId, cap = null) {
  const db = getDb();
  const amount = Number(req.amount);
  if (cap != null && amount > Number(cap))
    throw new Error(`amount exceeds the limit of ${cap}`);

  const rate = await getUsdRate();
  const wallet = await ensurePoolFunded(amount, rate);
  await ensureGas(wallet);
  const pk = sec.decryptSecret(wallet.enc_privkey);
  const tx = await chain.sendUsdt(pk, req.to_address, amount);
  record("disburse_out", wallet.address, req.to_address, amount, tx,
    { walletId: wallet.id, userId: req.staff_user_id, note: `payout req#${req.id}`, usdRate: rate });
  fireWebhook("payout.sent", { to: req.to_address, amount, tx, request_id: req.id });

  db.prepare("UPDATE disbursement_requests SET status='pending', approved_by=?, from_wallet_id=?, tx_hash=?, resolved_at=? WHERE id=?")
    .run(approverId, wallet.id, tx, now(), req.id);
  return db.prepare("SELECT * FROM disbursement_requests WHERE id=?").get(req.id);
}

// Distribute treasury USDT across the disbursement pool, holding back holdPct%.
async function distributeTreasury(holdPct) {
  const db = getDb();
  const treasury = getTreasury();
  if (!treasury) throw new Error("no treasury wallet");
  const pool = db.prepare("SELECT * FROM wallets WHERE wtype='disbursement' AND is_active=1").all();
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
    record("topup", treasury.address, w.address, per, tx, { walletId: w.id, note: `treasury split (hold ${holdPct}%)`, usdRate: rate });
    distributed += per;
  }
  return { balance: bal, held: bal - distributed, distributed, per_wallet: per, count: pool.length };
}

// Admin-only: send USDT from treasury to any address.
async function treasurySend(toAddress, amount) {
  const treasury = getTreasury();
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
  const tx = await chain.sendUsdt(pk, toAddress, Number(amount));
  const kind = sourceWallet.wtype === "treasury" ? "treasury_out" : "disburse_out";
  record(kind, sourceWallet.address, toAddress, Number(amount), tx,
    { walletId: sourceWallet.id, note: `admin send from ${sourceWallet.wtype}`, usdRate: rate });
  return { tx, kind };
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
  const fee = getFee();
  if (!fee) return { configured: false };
  let resources = {}; try { resources = await chain.accountResources(fee.address); } catch { resources = {}; }
  let trx = 0; try { trx = await chain.nativeBalance(fee.address); } catch { trx = 0; }
  return { configured: true, mode: get().energy_mode || "burn", address: fee.address, trx, ...resources };
}
async function stakeEnergy(trx) {
  const fee = getFee(); if (!fee) throw new Error("no gas/energy wallet");
  const pk = sec.decryptSecret(fee.enc_privkey);
  return { tx: await chain.freezeEnergy(pk, trx) };
}
async function unstakeEnergy(trx) {
  const fee = getFee(); if (!fee) throw new Error("no gas/energy wallet");
  const pk = sec.decryptSecret(fee.enc_privkey);
  return { tx: await chain.unfreezeEnergy(pk, trx) };
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
  ensureEnergy, energyStatus, stakeEnergy, unstakeEnergy,
};
