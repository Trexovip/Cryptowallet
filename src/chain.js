// TRON / TRC-20 adapter (TronWeb). TronWeb is required lazily so the rest of the
// app loads even before dependencies for the chain are needed.
const { get } = require("./config");
const USDT_DECIMALS = 6;

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
async function usdtBalance(address) {
  const tw = base();
  tw.setAddress(address);
  const contract = await tw.contract().at(get().usdt_contract);
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

module.exports = { newWallet, usdtBalance, nativeBalance, sendUsdt, sendNative, listIncomingUsdt, addressFromPrivateKey, setAccountName };
