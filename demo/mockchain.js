// DEMO ONLY — a simulated TRON chain. No network, no real funds.
// Implements the same functions as src/chain.js (now including listIncomingUsdt),
// backed by in-memory balances, so the real services.js logic runs unchanged.
const crypto = require("crypto");
let TronWeb;
{ const p = require("tronweb"); TronWeb = p.TronWeb || p; }
const tw = new TronWeb({ fullHost: "https://nile.trongrid.io" });

const usdt = {};       // address -> USDT balance
const trx = {};        // address -> TRX balance
const incoming = {};   // address -> [{ from, to, txid, amount, ts }]
const names = {};      // address -> on-chain account name
const _staked = {};    // address -> TRX frozen for energy (mock)
const txid = () => crypto.randomBytes(32).toString("hex");
const addrFromPk = (pk) => tw.address.fromPrivateKey(pk);
const randAddr = () => { const b = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; return "T" + Array.from({length:33},()=>b[Math.floor(Math.random()*b.length)]).join(""); };

module.exports = {
  async newWallet() { const a = await tw.createAccount(); return { address: a.address.base58, privateKey: a.privateKey }; },
  async usdtBalance(addr) { return usdt[addr] || 0; },
  async nativeBalance(addr) { return trx[addr] || 0; },
  async listIncomingUsdt(addr) { return incoming[addr] || []; },
  addressFromPrivateKey(pk) { try { return addrFromPk(String(pk).replace(/^0x/, "")); } catch { return null; } },
  async setAccountName(pk, name) { try { names[addrFromPk(String(pk).replace(/^0x/, ""))] = name; } catch {} return txid(); },
  async signMessage(pk, message) { return "0x" + crypto.createHash("sha256").update(String(pk) + "|" + message).digest("hex"); },
  async accountResources(address) { const staked = _staked[address] || 0; const energy = Math.round(staked * 100); return { energyLimit: energy, energyUsed: 0, energyAvailable: energy, netLimit: 600, netUsed: 0, tronPowerLimit: staked }; },
  async freezeEnergy(pk, trx) { const a = addrFromPk(String(pk).replace(/^0x/, "")); _staked[a] = (_staked[a] || 0) + Number(trx); return txid(); },
  async unfreezeEnergy(pk, trx) { const a = addrFromPk(String(pk).replace(/^0x/, "")); _staked[a] = Math.max(0, (_staked[a] || 0) - Number(trx)); return txid(); },
  async delegateEnergy() { return txid(); },
  async undelegateEnergy() { return txid(); },
  __name(addr) { return names[addr]; },
  async sendUsdt(pk, to, amount) {
    const from = addrFromPk(pk); amount = Number(amount);
    if ((usdt[from] || 0) + 1e-9 < amount) throw new Error("insufficient USDT (demo)");
    usdt[from] = (usdt[from] || 0) - amount; usdt[to] = (usdt[to] || 0) + amount; return txid();
  },
  async sendNative(pk, to, amount) {
    const from = addrFromPk(pk); amount = Number(amount);
    trx[from] = (trx[from] || 0) - amount; trx[to] = (trx[to] || 0) + amount; return txid();
  },
  // demo helpers (not part of the real adapter)
  __seedUsdt(addr, amt, from) {
    usdt[addr] = (usdt[addr] || 0) + amt;
    (incoming[addr] = incoming[addr] || []).push({
      from: from || randAddr(), to: addr, txid: txid(), amount: amt, ts: new Date().toISOString(),
    });
  },
  __seedTrx(addr, amt) { trx[addr] = (trx[addr] || 0) + amt; },
  __usdt(addr) { return usdt[addr] || 0; },
};
