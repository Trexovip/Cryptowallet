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

async function createWallet(wtype, ownerUserId = null, label = "") {
  const w = await chain.newWallet();
  const info = getDb().prepare(
    `INSERT INTO wallets(chain,address,enc_privkey,wtype,label,owner_user_id,is_active,created_at)
     VALUES('tron',?,?,?,?,?,1,?)`
  ).run(w.address, sec.encryptSecret(w.privateKey), wtype, label, ownerUserId, now());
  return getDb().prepare("SELECT * FROM wallets WHERE id=?").get(info.lastInsertRowid);
}
const getTreasury = () => getDb().prepare("SELECT * FROM wallets WHERE wtype='treasury' AND is_active=1").get();
const getFee = () => getDb().prepare("SELECT * FROM wallets WHERE wtype='fee' AND is_active=1").get();

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

async function ensurePoolFunded(need, usdRate = null) {
  const db = getDb();
  const pool = db.prepare("SELECT * FROM wallets WHERE wtype='disbursement' AND is_active=1").all();
  if (!pool.length) throw new Error("disbursement pool is empty — provision it first");

  shuffle(pool);
  for (const w of pool) {
    try { if ((await chain.usdtBalance(w.address)) >= need) return w; } catch { /* try next */ }
  }
  const treasury = getTreasury();
  if (!treasury) throw new Error("no treasury wallet to fund disbursement pool");
  const target = pool[Math.floor(Math.random() * pool.length)];
  const topup = Math.max(need, Number(get().disbursement_float_usdt));
  const tpk = sec.decryptSecret(treasury.enc_privkey);
  const tx = await chain.sendUsdt(tpk, target.address, topup);
  record("topup", treasury.address, target.address, topup, tx, { walletId: target.id, note: "treasury -> disbursement float", usdRate });
  return target;
}

async function executeDisbursement(req, approverId, cap = null) {
  const db = getDb();
  const amount = Number(req.amount);
  if (cap != null && amount > Number(cap))
    throw new Error(`amount exceeds the limit of ${cap}`);

  const rate = await getUsdRate();
  const wallet = await ensurePoolFunded(amount, rate);
  const pk = sec.decryptSecret(wallet.enc_privkey);
  const tx = await chain.sendUsdt(pk, req.to_address, amount);
  record("disburse_out", wallet.address, req.to_address, amount, tx,
    { walletId: wallet.id, userId: req.staff_user_id, note: `payout req#${req.id}`, usdRate: rate });

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
  const pk = sec.decryptSecret(sourceWallet.enc_privkey);
  const tx = await chain.sendUsdt(pk, toAddress, Number(amount));
  const kind = sourceWallet.wtype === "treasury" ? "treasury_out" : "disburse_out";
  record(kind, sourceWallet.address, toAddress, Number(amount), tx,
    { walletId: sourceWallet.id, note: `admin send from ${sourceWallet.wtype}`, usdRate: rate });
  return { tx, kind };
}

module.exports = {
  audit, record, createWallet, getTreasury, getFee, scanAndSweep, ensurePoolFunded, executeDisbursement,
  distributeTreasury, treasurySend, adminSendFrom,
};
