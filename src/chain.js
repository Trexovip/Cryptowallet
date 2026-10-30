// TRON / TRC-20 adapter (TronWeb). TronWeb is required lazily so the rest of the
// app loads even before dependencies for the chain are needed.
const { get } = require("./config");
const USDT_DECIMALS = 6;

// --- Global request throttle for TronGrid (avoids 429 on the free tier) ---
// Spaces request starts by a minimum gap and caps concurrency. Every network call below
// is routed through this queue, so bursts (e.g. a dashboard reading many wallets) are smoothed.
function makeLimiter(rps, concurrency) {
  const minGap = 1000 / Math.max(1, rps);
  let active = 0, lastStart = 0;
  const queue = [];
  function pump() {
    if (active >= concurrency || queue.length === 0) return;
    const wait = Math.max(0, lastStart + minGap - Date.now());
    if (wait > 0) { setTimeout(pump, wait + 1); return; }
    const job = queue.shift();
    active++; lastStart = Date.now();
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    pump();
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
let _limit = null;
function limit(fn) {
  if (!_limit) {
    const c = get();
    _limit = makeLimiter(Number(c.trongrid_rps || 8), Number(c.trongrid_concurrency || 3));
  }
  return _limit(fn);
}

let _TronWeb = null;
function TW() {
  if (!_TronWeb) {
    const pkg = require("tronweb");
    _TronWeb = pkg.TronWeb || pkg;      // v6 exports { TronWeb }; older exports default
  }
  return _TronWeb;
}
function hostFor(net) {
  if (net === "mainnet") return "https://api.trongrid.io";
  if (net === "shasta") return "https://api.shasta.trongrid.io";
  return "https://nile.trongrid.io"; // nile testnet
}
function base(extra = {}) {
  const c = get();
  const opts = { fullHost: hostFor(c.tron_network), ...extra };
  if (c.trongrid_api_key) opts.headers = { "TRON-PRO-API-KEY": c.trongrid_api_key };
  return new (TW())(opts);
}
function signer(privateKey) {
  return base({ privateKey });
}

async function newWallet() {
  const acct = await base().createAccount(); // generated offline
  return { address: acct.address.base58, privateKey: acct.privateKey };
}
const TRC20_MIN_ABI = [
  { constant: true, inputs: [{ name: "who", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { constant: false, inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
];
async function usdtBalance(address) {
  const tw = base();
  tw.setAddress(address);
  // Pass a built-in ABI so TronWeb does NOT fetch the contract ABI from TronGrid on every call
  // (that extra request is a common cause of 429 rate-limit errors).
  const contract = tw.contract(TRC20_MIN_ABI, get().usdt_contract);
  const raw = await contract.balanceOf(address).call();
  return Number(raw.toString()) / 10 ** USDT_DECIMALS;
}
async function nativeBalance(address) {
  const sun = await base().trx.getBalance(address);
  return Number(sun) / 1e6;
}
async function sendUsdt(fromPrivKey, to, amount) {
  const tw = signer(fromPrivKey);
  const contract = await tw.contract().at(get().usdt_contract);
  const units = Math.round(Number(amount) * 10 ** USDT_DECIMALS);
  const txid = await contract.transfer(to, units).send({ feeLimit: 100_000_000 });
  return txid;
}
async function sendNative(fromPrivKey, to, amountTrx) {
  const tw = signer(fromPrivKey);
  const sun = Math.round(Number(amountTrx) * 1e6);
  const res = await tw.trx.sendTransaction(to, sun);
  return res.txid || (res.transaction && res.transaction.txID) || "";
}

// Incoming USDT transfers to an address (for deposit detection with real sender
// + tx hash + timestamp). Uses TronGrid's TRC-20 transactions REST endpoint.
async function listIncomingUsdt(address, limit = 50) {
  const c = get();
  const url = `${hostFor(c.tron_network)}/v1/accounts/${address}/transactions/trc20`
    + `?only_to=true&limit=${limit}&contract_address=${c.usdt_contract}`;
  const headers = c.trongrid_api_key ? { "TRON-PRO-API-KEY": c.trongrid_api_key } : {};
  const res = await fetch(url, { headers });
  const j = await res.json();
  const rows = (j && j.data) || [];
  return rows.map((t) => ({
    from: t.from,
    to: t.to,
    txid: t.transaction_id,
    amount: Number(t.value) / 10 ** USDT_DECIMALS,
    ts: t.block_timestamp ? new Date(t.block_timestamp).toISOString() : null,
  }));
}

function addressFromPrivateKey(privHex) {
  try { return base().address.fromPrivateKey(String(privHex).replace(/^0x/, "")); }
  catch { return null; }
}

// Set the on-chain account name (UpdateAccountContract). Can only be set once per account.
async function setAccountName(privHex, name) {
  const tw = signer(String(privHex).replace(/^0x/, ""));
  const owner = tw.defaultAddress && tw.defaultAddress.base58;
  const unsigned = await tw.transactionBuilder.updateAccount(name, owner);
  const signed = await tw.trx.sign(unsigned);
  const res = await tw.trx.sendRawTransaction(signed);
  return (res && (res.txid || (res.transaction && res.transaction.txID))) || "";
}

// Swap USDT -> TRX via SunSwap V2 (Uniswap-V2 fork on TRON) and send the TRX to `toAddress`.
// NOTE: on-chain DEX swap — test on mainnet with a small amount first; router/WTRX are configurable.
async function swapUsdtToTrx(fromPrivKey, usdtAmount, toAddress, slippagePct = 5) {
  const tw = signer(String(fromPrivKey).replace(/^0x/, ""));
  const c = get();
  const router = c.swap_router, wtrx = c.wtrx_contract, usdtAddr = c.usdt_contract;
  const amountIn = Math.round(Number(usdtAmount) * 10 ** USDT_DECIMALS);
  const token = await tw.contract().at(usdtAddr);
  await token.approve(router, amountIn).send({ feeLimit: 100_000_000 });
  const r = await tw.contract().at(router);
  const amounts = await r.getAmountsOut(amountIn, [usdtAddr, wtrx]).call();
  const out = Number(amounts[amounts.length - 1].toString());
  const minOut = Math.floor(out * (1 - Number(slippagePct) / 100));
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const txid = await r.swapExactTokensForETH(amountIn, minOut, [usdtAddr, wtrx], toAddress, deadline).send({ feeLimit: 200_000_000 });
  return { tx: txid, trxOut: out / 1e6 };
}

// Full TRC-20 (USDT) transfer history for an address — both incoming and outgoing — from TronGrid.
async function listTrc20Transfers(address, max = 2000) {
  const c = get();
  const headers = c.trongrid_api_key ? { "TRON-PRO-API-KEY": c.trongrid_api_key } : {};
  let url = `${hostFor(c.tron_network)}/v1/accounts/${address}/transactions/trc20?limit=200&contract_address=${c.usdt_contract}`;
  const out = [];
  for (let page = 0; page < 100 && out.length < max; page++) {
    let j; try { j = await (await fetch(url, { headers })).json(); } catch { break; }
    const rows = (j && j.data) || [];
    for (const t of rows) out.push({ from: t.from, to: t.to, txid: t.transaction_id, value: Number(t.value) / 10 ** USDT_DECIMALS, timestamp: t.block_timestamp || null });
    const next = j && j.meta && j.meta.links && j.meta.links.next;
    if (!next || !rows.length) break;
    url = next;
  }
  return out.slice(0, max);
}

// ---- Energy (Stake 2.0) ----
async function accountResources(address) {
  const r = await base().trx.getAccountResources(address);
  const energyLimit = Number(r.EnergyLimit || 0), energyUsed = Number(r.EnergyUsed || 0);
  return {
    energyLimit, energyUsed, energyAvailable: Math.max(0, energyLimit - energyUsed),
    netLimit: Number(r.NetLimit || 0) + Number(r.freeNetLimit || 0),
    netUsed: Number(r.NetUsed || 0) + Number(r.freeNetUsed || 0),
    tronPowerLimit: Number(r.TronPowerLimit || 0),
  };
}
async function _send(tw, unsigned) {
  const signed = await tw.trx.sign(unsigned);
  const res = await tw.trx.sendRawTransaction(signed);
  return (res && (res.txid || (res.transaction && res.transaction.txID))) || "";
}
async function freezeEnergy(privHex, amountTrx) {
  const tw = signer(String(privHex).replace(/^0x/, "")); const owner = tw.defaultAddress.base58;
  return _send(tw, await tw.transactionBuilder.freezeBalanceV2(Math.round(Number(amountTrx) * 1e6), "ENERGY", owner));
}
async function unfreezeEnergy(privHex, amountTrx) {
  const tw = signer(String(privHex).replace(/^0x/, "")); const owner = tw.defaultAddress.base58;
  return _send(tw, await tw.transactionBuilder.unfreezeBalanceV2(Math.round(Number(amountTrx) * 1e6), "ENERGY", owner));
}
async function delegateEnergy(privHex, toAddress, amountTrx, lock = false, lockPeriod) {
  const tw = signer(String(privHex).replace(/^0x/, "")); const owner = tw.defaultAddress.base58;
  return _send(tw, await tw.transactionBuilder.delegateResource(Math.round(Number(amountTrx) * 1e6), toAddress, "ENERGY", owner, lock, lockPeriod));
}
async function undelegateEnergy(privHex, toAddress, amountTrx) {
  const tw = signer(String(privHex).replace(/^0x/, "")); const owner = tw.defaultAddress.base58;
  return _send(tw, await tw.transactionBuilder.undelegateResource(Math.round(Number(amountTrx) * 1e6), toAddress, "ENERGY", owner));
}

// Confirm a broadcast tx actually succeeded on-chain. Returns "confirmed" | "failed" | "pending".
// Not routed through the throttle itself (it would hog a slot while polling); each poll IS throttled.
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function _getTxInfo(txid) { try { return await base().trx.getTransactionInfo(txid); } catch { return null; } }
async function confirmTx(txid, { tries = 10, gapMs = 2000 } = {}) {
  if (!txid) return "failed";
  for (let i = 0; i < tries; i++) {
    const info = await limit(() => _getTxInfo(txid));
    if (info && info.id) {
      if (info.result === "FAILED") return "failed";
      const r = info.receipt && info.receipt.result;
      if (r && r !== "SUCCESS" && r !== "DEFAULT") return "failed"; // REVERT / OUT_OF_ENERGY / OUT_OF_TIME ...
      return "confirmed";
    }
    await _sleep(gapMs);
  }
  return "pending"; // broadcast but not yet confirmed within the window
}

// Sign an arbitrary message with the wallet's key (for Tronscan ownership proof).
async function signMessage(privHex, message) {
  const tw = signer(String(privHex).replace(/^0x/, ""));
  if (tw.trx && tw.trx.signMessageV2) return await tw.trx.signMessageV2(message);
  return await tw.trx.sign(message);
}

// Route every network-touching function through the global throttle/queue.
const _networkFns = { usdtBalance, nativeBalance, sendUsdt, sendNative, listIncomingUsdt, listTrc20Transfers, setAccountName, swapUsdtToTrx, accountResources, freezeEnergy, unfreezeEnergy, delegateEnergy, undelegateEnergy };
const _throttled = {};
for (const [k, f] of Object.entries(_networkFns)) _throttled[k] = (...args) => limit(() => f(...args));
// newWallet / addressFromPrivateKey / signMessage are local (no network) — left unthrottled.
module.exports = { newWallet, addressFromPrivateKey, signMessage, confirmTx, ..._throttled };
