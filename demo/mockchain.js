// DEMO ONLY — a simulated TRON chain. No network, no real funds.
// Implements the same functions as src/chain.js (now including listIncomingUsdt),
// backed by in-memory balances, so the real services.js logic runs unchanged.
const crypto = require("crypto");
let TronWeb;
{ const p = require("tronweb"); TronWeb = p.TronWeb || p; }
const tw = new TronWeb({ fullHost: "https://nile.trongrid.io" });

const usdt = {};       // address -> USDT balance
const _transfers = [];  // on-chain TRC-20 transfer log (for reconciliation tests)
const _delegations = []; // energy delegations (for gas-free tests)
const _bandwidth = {};   // address -> available bandwidth (default ample)
const trx = {};        // address -> TRX balance
const incoming = {};   // address -> [{ from, to, txid, amount, ts }]
const names = {};      // address -> on-chain account name
const _staked = {};    // address -> TRX frozen for energy (mock)
const _failTx = {};    // txid -> true when a simulated tx should confirm as failed
let _failNext = false; // when true, the next sendUsdt simulates an on-chain failure
let _pendNext = 0;    // number of confirmTx calls that should report "pending" before confirming
const txid = () => crypto.randomBytes(32).toString("hex");
const addrFromPk = (pk) => tw.address.fromPrivateKey(pk);
const randAddr = () => { const b = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; return "T" + Array.from({length:33},()=>b[Math.floor(Math.random()*b.length)]).join(""); };

module.exports = {
  async newWallet() { const a = await tw.createAccount(); return { address: a.address.base58, privateKey: a.privateKey }; },
  async usdtBalance(addr) { return usdt[addr] || 0; },
  async nativeBalance(addr) { return trx[addr] || 0; },
  async listIncomingUsdt(addr) { return incoming[addr] || []; },
  async listTrc20Transfers(addr) { return _transfers.filter((x) => x.from === addr || x.to === addr); },
  async txEnergyUsed() { return 64285; },
  async availableBandwidth(addr) { return _bandwidth[addr] != null ? _bandwidth[addr] : 5000; },
  __setBandwidth(addr, n) { _bandwidth[addr] = n; },
  addressFromPrivateKey(pk) { try { return addrFromPk(String(pk).replace(/^0x/, "")); } catch { return null; } },
  async setAccountName(pk, name) { try { names[addrFromPk(String(pk).replace(/^0x/, ""))] = name; } catch {} return txid(); },
  async signMessage(pk, message) { return "0x" + crypto.createHash("sha256").update(String(pk) + "|" + message).digest("hex"); },
  async confirmTx(txid) { if (_failTx[txid]) return "failed"; if (_pendNext > 0) { _pendNext--; return "pending"; } return "confirmed"; },
  async swapUsdtToTrx(pk, usdtAmount, toAddress) {
    const owner = addrFromPk(String(pk).replace(/^0x/, "")); usdtAmount = Number(usdtAmount);
    if ((usdt[owner] || 0) < usdtAmount) throw new Error("insufficient USDT for swap");
    usdt[owner] -= usdtAmount; const trxOut = usdtAmount * 8; // mock rate: 1 USDT = 8 TRX
    trx[toAddress] = (trx[toAddress] || 0) + trxOut;
    return { tx: txid(), trxOut };
  },
  async accountResources(address) { const staked = _staked[address] || 0; const energy = Math.round(staked * 100); return { energyLimit: energy, energyUsed: 0, energyAvailable: energy, netLimit: 600, netUsed: 0, tronPowerLimit: staked }; },
  async freezeEnergy(pk, trx) { const a = addrFromPk(String(pk).replace(/^0x/, "")); _staked[a] = (_staked[a] || 0) + Number(trx); return txid(); },
  async unfreezeEnergy(pk, trx) { const a = addrFromPk(String(pk).replace(/^0x/, "")); _staked[a] = Math.max(0, (_staked[a] || 0) - Number(trx)); return txid(); },
  async delegateEnergy(pk, to, trx) { _delegations.push({ to, trx }); return txid(); },
  __delegations() { return _delegations; },
  async undelegateEnergy() { return txid(); },
  __name(addr) { return names[addr]; },
  async sendUsdt(pk, to, amount) {
    const from = addrFromPk(pk); amount = Number(amount);
    if (_failNext) { _failNext = false; const id = txid(); _failTx[id] = true; return id; } // simulate on-chain revert (no funds move)
    if ((usdt[from] || 0) + 1e-9 < amount) throw new Error("insufficient USDT (demo)");
    usdt[from] = (usdt[from] || 0) - amount; usdt[to] = (usdt[to] || 0) + amount;
    const id = txid(); _transfers.push({ from, to, txid: id, value: amount, timestamp: Date.now() }); return id;
  },
  async sendNative(pk, to, amount) {
    const from = addrFromPk(pk); amount = Number(amount);
    trx[from] = (trx[from] || 0) - amount; trx[to] = (trx[to] || 0) + amount; return txid();
  },
  // demo helpers (not part of the real adapter)
  __seedUsdt(addr, amt, from) {
    usdt[addr] = (usdt[addr] || 0) + amt;
    const _id = txid(); const _from = from || randAddr();
    (incoming[addr] = incoming[addr] || []).push({ from: _from, to: addr, txid: _id, amount: amt, ts: new Date().toISOString() });
    _transfers.push({ from: _from, to: addr, txid: _id, value: amt, timestamp: Date.now() });
  },
  __seedTrx(addr, amt) { trx[addr] = (trx[addr] || 0) + amt; },
  __failNextSend(v = true) { _failNext = v; },
  __pendingNextConfirm(n = 1) { _pendNext = n; },
  __usdt(addr) { return usdt[addr] || 0; },
};
