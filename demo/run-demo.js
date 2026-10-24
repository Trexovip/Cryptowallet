// End-to-end demo of the custody console with a simulated chain (no real funds).
//   node demo/run-demo.js
const fs = require("fs");
const path = require("path");
const http = require("http");

// isolate demo data so it never touches a real data/ dir
process.env.CUSTODY_DATA_DIR = path.join(__dirname, "..", ".demo-data");
fs.rmSync(process.env.CUSTODY_DATA_DIR, { recursive: true, force: true });

// inject the simulated chain in place of src/chain.js
const chainPath = require.resolve("../src/chain");
const mock = require("./mockchain");
require.cache[chainPath] = { id: chainPath, filename: chainPath, loaded: true, exports: mock };

const { app } = require("../src/app");
const svc = require("../src/services");

const line = (s = "") => console.log(s);
const hr = (t) => { line(); line("\u2501".repeat(64)); line("  " + t); line("\u2501".repeat(64)); };
const money = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (a) => a ? a.slice(0, 7) + "\u2026" + a.slice(-5) : "\u2014";

const server = http.createServer(app).listen(0, "127.0.0.1", main);

async function main() {
  const base = `http://127.0.0.1:${server.address().port}`;
  const J = (r) => r.json();
  const get = (p, t) => fetch(base + p, { headers: t ? { Authorization: "Bearer " + t } : {} }).then(J);
  const post = (p, b, t) => fetch(base + p, {
    method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  }).then(J);

  hr("1. First launch \u2014 browser setup wizard");
  line("   needs_setup: " + (await get("/api/setup/status")).needs_setup);
  const setup = await post("/api/setup", {
    username: "ops.admin", password: "demo-password-123", tron_network: "nile",
    usdt_contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  });
  line("   setup complete \u2014 admin 'ops.admin' created, network: " + setup.network);
  line("   generated wallet encryption key: " + setup.wallet_enc_key.slice(0, 24) + "\u2026 (shown once for backup)");

  const admin = (await post("/auth/login", { username: "ops.admin", password: "demo-password-123" })).access_token;

  hr("2. Admin provisions wallets");
  const treasury = await post("/wallets/treasury", null, admin);
  const fee = await post("/wallets/fee", null, admin);
  const pool = await post("/wallets/disbursement-pool?count=3", null, admin);
  line("   treasury (master) : " + treasury.address);
  line("   gas wallet (TRX)  : " + fee.address);
  line("   disbursement pool : " + pool.map((w) => short(w.address)).join("  "));

  hr("3. Admin creates staff and assigns deposit addresses");
  const priya = await post("/users", { username: "staff.priya", password: "priya-pass-123", role: "staff" }, admin);
  const arun = await post("/users", { username: "staff.arun", password: "arun-pass-1234", role: "staff" }, admin);
  const depP = await post("/wallets/deposit", { staff_user_id: priya.id, label: "Counter 1" }, admin);
  const depA = await post("/wallets/deposit", { staff_user_id: arun.id, label: "Counter 2" }, admin);
  line("   staff.priya \u2192 " + depP.address + "  (Counter 1)");
  line("   staff.arun  \u2192 " + depA.address + "  (Counter 2)");

  hr("4. Customers send USDT to the deposit addresses  (simulated)");
  mock.__seedUsdt(depP.address, 1250);
  mock.__seedUsdt(depA.address, 800);
  mock.__seedTrx(fee.address, 100); // operator pre-funds the gas wallet with TRX
  line("   " + short(depP.address) + "  received 1,250.00 USDT");
  line("   " + short(depA.address) + "  received   800.00 USDT");
  line("   gas wallet funded with 100 TRX");

  hr("5. Background sweeper runs  (gas-funds, then sweeps to treasury)");
  const swept = await svc.scanAndSweep();
  swept.forEach((s) => line("   swept " + money(s.swept) + " USDT from " + short(s.wallet) + "  tx " + s.tx.slice(0, 12) + "\u2026"));
  line("   treasury now holds: " + money(mock.__usdt(treasury.address)) + " USDT");

  hr("6. Staff requests a payout; admin approves");
  const reqRow = await post("/disbursements", { to_address: "TPayeeExample000000000000000000000", amount: 500, reason: "settlement #4821" }, admin);
  line("   staff.priya requested 500.00 USDT \u2192 TPayee\u2026  (status: " + reqRow.status + ", id #" + reqRow.id + ")");
  const approved = await post("/disbursements/" + reqRow.id + "/approve", null, admin);
  const srcPool = pool.find((w) => w.id === approved.from_wallet_id);
  line("   admin approved \u2014 payout left from pool wallet #" + approved.from_wallet_id + " (" + short(srcPool.address) + "), NOT treasury");
  line("   tx " + approved.tx_hash.slice(0, 16) + "\u2026");

  hr("7. Admin dashboard");
  const dash = await get("/dashboard", admin);
  line("   network            : " + dash.network);
  line("   treasury balance   : " + money(dash.treasury.usdt) + " USDT");
  line("   disbursement pool  : " + money(dash.pool.reduce((s, w) => s + Number(w.usdt || 0), 0)) + " USDT across " + dash.pool.length + " wallets");
  line("   gas wallet         : " + money(dash.fee.native) + " TRX");
  line("   staff / deposits   : " + dash.staff_count + " staff, " + dash.deposit_wallet_count + " deposit addresses");
  line("   pending approvals  : " + dash.pending_approvals);

  hr("8. Movements ledger  (every value movement, append-only)");
  const moves = (await get("/movements", admin)).slice().reverse();
  line("   " + "kind".padEnd(14) + "from".padEnd(14) + "to".padEnd(14) + "amount".padStart(12) + "  status");
  moves.forEach((m) => line("   " + m.kind.padEnd(14) + short(m.from_address).padEnd(14) + short(m.to_address).padEnd(14) + (money(m.amount) + " " + m.token).padStart(12) + "  " + m.status));

  hr("9. Audit log  (who did what)");
  const audit = (await get("/audit", admin)).slice().reverse();
  audit.forEach((a) => line("   " + a.at.slice(11, 19) + "  user#" + (a.user_id ?? "-") + "  " + a.action.padEnd(22) + "  " + (a.detail || "")));

  line();
  line("Demo complete. (Simulated chain \u2014 no real funds moved.)");
  server.close(() => process.exit(0));
}
