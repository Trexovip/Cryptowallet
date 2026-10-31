/* USDT Custody Console — front-end logic (vanilla JS, no build step). */
(() => {
"use strict";

const TOKEN_KEY = "cc_token";
let state = { token: localStorage.getItem(TOKEN_KEY) || null, user: null, network: null };

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
const shortAddr = (a) => a ? a.slice(0, 6) + "…" + a.slice(-6) : "—";

function fmtUsdt(v){
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return esc(v);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}
function fmtTrx(v){
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isNaN(n) ? esc(v) : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function toast(msg, isErr){
  const t = $("#toast"); t.textContent = msg; t.className = isErr ? "err show" : "show";
  setTimeout(() => (t.className = isErr ? "err" : ""), 2600);
}
function copy(text){ navigator.clipboard.writeText(text).then(() => toast("Copied")); }

function addrHtml(a){
  if (!a) return "—";
  return `<span class="addr"><span class="mono" title="${esc(a)}">${esc(shortAddr(a))}</span>` +
    `<button class="copy" data-copy="${esc(a)}" title="Copy address">⧉</button></span>`;
}
function statusBadge(s){
  const map = { confirmed:"b-confirmed", pending:"b-pending", failed:"b-failed" };
  return `<span class="badge ${map[s]||"b-pending"}"><span class="dot"></span>${esc(s)}</span>`;
}
const KIND_LABEL = {
  deposit_in:"Deposit in", gas_fund:"Gas funding", sweep:"Sweep → treasury",
  topup:"Treasury → pool", disburse_out:"Payout", treasury_out:"Treasury send"
};

/* ---------- API ---------- */
async function api(path, { method = "GET", body = null, form = false } = {}){
  const headers = {};
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  let payload = null;
  if (form){ headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = body; }
  else if (body !== null){ headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }

  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401){ doLogout(); throw new Error("Session expired — sign in again"); }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok){
    const msg = (data && (data.detail || data.message)) || `Request failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

/* ---------- confirm modal ---------- */
function confirmModal({ title, bodyHtml, okLabel = "Confirm", okClass = "btn-accent" }){
  return new Promise((resolve) => {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
    const ok = $("#modalOk"), cancel = $("#modalCancel"), back = $("#modalBack");
    ok.textContent = okLabel; ok.className = "btn " + okClass;
    const close = (val) => { back.classList.remove("show"); ok.onclick = cancel.onclick = null; resolve(val); };
    ok.onclick = () => close(true); cancel.onclick = () => close(false);
    back.classList.add("show");
  });
}

/* ---------- auth ---------- */
async function doLogin(){
  const u = $("#lu").value.trim(), p = $("#lp").value;
  $("#loginErr").textContent = "";
  if (!u || !p){ $("#loginErr").textContent = "Enter your username and password."; return; }
  const btn = $("#loginBtn"); btn.disabled = true; btn.textContent = "Signing in…";
  try{
    const data = await api("/auth/login", { method:"POST", form:true,
      body: new URLSearchParams({ username:u, password:p }).toString() });
    state.token = data.access_token; localStorage.setItem(TOKEN_KEY, state.token);
    await boot();
  }catch(e){ $("#loginErr").textContent = e.message; }
  finally{ btn.disabled = false; btn.textContent = "Sign in"; }
}
function doLogout(){
  state = { token:null, user:null, network:null };
  localStorage.removeItem(TOKEN_KEY);
  $("#app").style.display = "none"; $("#login").style.display = "grid";
  $("#lp").value = "";
}

/* ---------- nav ---------- */
const NAV = {
  admin: [
    ["dashboard","Dashboard","◧"], ["wallets","Wallets","▦"], ["payouts","Payouts","↗"],
    ["reports","Reports","▚"], ["transactions","Transactions","≋"], ["customers","Customers","☺"], ["mycustomers","My customers","☏"], ["addressbook","Address book","▤"],
    ["staff","Staff","☷"], ["settings","Settings","⚙"], ["apikeys","API keys","⚿"], ["backup","Backup","⤓"], ["audit","Audit log","❏"]
  ],
  staff: [
    ["dashboard","Dashboard","◧"], ["wallets","Receive","▦"], ["payouts","Payouts","↗"],
    ["transactions","Transactions","≋"], ["customers","Customers","☺"], ["mycustomers","My customers","☏"], ["addressbook","Address book","▤"]
  ],
  customer_depositor: [
    ["dashboard","Overview","◧"], ["wallets","Deposit address","▦"], ["payouts","Deposits","↙"], ["messages","Messages","✉"]
  ],
  customer_remittance: [
    ["dashboard","Overview","◧"], ["wallets","Whitelist","▦"], ["payouts","Transfers","↙"], ["messages","Messages","✉"]
  ]
};
const navKey = () => state.user.role === "customer" ? "customer_" + state.user.customer_type : state.user.role;
function buildNav(){
  const nav = $("#nav"); nav.innerHTML = "";
  (NAV[navKey()] || []).forEach(([key, label, ic]) => {
    const a = document.createElement("a");
    a.dataset.sec = key; a.innerHTML = `<span class="ic">${ic}</span>${label}`;
    a.onclick = () => route(key); nav.appendChild(a);
  });
}
let _dashTimer = null;
function stopDashTimer(){ if (_dashTimer) { clearInterval(_dashTimer); _dashTimer = null; } }
function route(sec){
  if (sec !== "dashboard") stopDashTimer();
  document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("active", a.dataset.sec === sec));
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  $("#sec-" + sec).classList.add("active");
  const map = state.user.role === "customer"
    ? { dashboard:renderCustomerDashboard, wallets:renderCustomerAssets, payouts:renderCustomerHistory, messages:renderCustomerMessages }
    : { dashboard:renderDashboard, wallets:renderWallets, payouts:renderPayouts,
        staff:renderStaff, audit:renderAudit, customers:renderCustomers,
        addressbook:renderAddressBook, settings:renderSettings, transactions:renderTransactions,
        apikeys:renderApiKeys, reports:renderReports, backup:renderBackup, mycustomers:renderMyCustomers };
  const fn = map[sec];
  if (fn) fn();
}

/* ---------- network badge ---------- */
function setNetwork(net){
  state.network = net;
  const live = net === "mainnet";
  const b = $("#netBadge"), t = $("#netText");
  b.className = "net-badge " + (live ? "net-live" : "net-test");
  t.textContent = live ? "MAINNET · live funds" : (net ? net.toUpperCase() + " · test funds" : "—");
}

/* ======================================================= DASHBOARD */
async function loadDash(fresh){
  try{
    const isAdmin = state.user.role === "admin";
    const [d, energy, report] = await Promise.all([
      api("/dashboard" + (fresh ? "?fresh=1" : "")),
      isAdmin ? api("/energy/status").catch(() => null) : Promise.resolve(null),
      isAdmin ? api("/reports/summary?days=14").catch(() => null) : Promise.resolve(null),
    ]);
    if (d.role === "admin") { d.energy = energy; d.report = report; }
    setNetwork(d.network);
    const body = $("#dashBody"); if (body) body.innerHTML = d.role === "admin" ? adminDash(d) : staffDash(d);
    const st = $("#dashUpdated"); if (st) st.textContent = "Updated " + new Date().toLocaleTimeString();
  }catch(e){
    const body = $("#dashBody"); if (body && !body.children.length) body.innerHTML = emptyState(e.message);
  }
}
async function renderDashboard(){
  const sec = $("#sec-dashboard");
  sec.innerHTML = `<div class="page-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
    <div><h1>Dashboard</h1><p>Overview of balances and recent activity.</p></div>
    <div style="display:flex;align-items:center;gap:10px"><span class="hint" id="dashUpdated"></span><button class="btn btn-ghost btn-sm" id="dashRefresh">↻ Refresh</button></div></div>
    <div id="dashBody">Loading…</div>`;
  $("#dashRefresh").onclick = () => { const b = $("#dashRefresh"); b.disabled = true; b.textContent = "…"; loadDash(true).finally(() => { b.disabled = false; b.textContent = "↻ Refresh"; }); };
  await loadDash(false);
  stopDashTimer();
  _dashTimer = setInterval(() => { if ($("#sec-dashboard") && $("#sec-dashboard").classList.contains("active")) loadDash(false); else stopDashTimer(); }, 30000);
}
function adminDash(d){
  const poolTotal = (d.pool || []).reduce((s,w) => s + (Number(w.usdt)||0), 0);
  const treasuryVal = d.treasury ? fmtUsdt(d.treasury.usdt) : "—";
  const _a = d.alerts || {}; const _al = [];
  if (_a.low_gas) _al.push(`Gas wallet low (below ${_a.gas_min} TRX) — fund it or payouts may fail`);
  if (_a.pending_approvals) _al.push(`${_a.pending_approvals} payout(s) awaiting approval`);
  if (_a.failed_payouts_24h) _al.push(`${_a.failed_payouts_24h} failed transaction(s) in last 24h`);
  return `
  ${_al.length ? `<div class="alert-box">⚠ <b>Needs attention:</b> ${_al.map(esc).join(" &middot; ")}</div>` : ""}
  <div class="readouts">
    <div class="readout">
      <div class="chip">◈</div>
      <div class="label">Treasury (master) balance</div>
      <div class="value lead num">${treasuryVal}<span class="unit">USDT</span></div>
      <div class="foot">${d.treasury ? addrHtml(d.treasury.address) : "No treasury wallet yet"}</div>
    </div>
    <div class="readout">
      <div class="chip">▦</div>
      <div class="label">Disbursement pool</div>
      <div class="value num">${fmtUsdt(poolTotal)}<span class="unit">USDT</span></div>
      <div class="foot">${(d.pool||[]).length} wallets · payouts leave from here</div>
    </div>
    <div class="readout">
      <div class="chip">⛽</div>
      <div class="label">Gas wallet (TRX)</div>
      <div class="value num">${d.fee ? fmtTrx(d.fee.native) : "—"}<span class="unit">TRX</span></div>
      <div class="foot">${d.fee ? "funds sweep fees" : "No gas wallet yet"}</div>
    </div>
    ${d.energy && d.energy.configured ? `<div class="readout">
      <div class="chip">⚡</div>
      <div class="label">Energy available</div>
      <div class="value num">${Math.floor((d.energy.energyAvailable || 0) / 65000).toLocaleString()}<span class="unit">transfers</span></div>
      <div class="foot">${(d.energy.mode && d.energy.mode !== "burn") ? `${Number(d.energy.energyAvailable || 0).toLocaleString()} energy` : "burning TRX — stake to cut fees"}</div>
    </div>` : ""}
  </div>
  <div class="panel"><div class="panel-head"><h2>At a glance</h2></div>
    <div class="panel-body"><div class="stat-row">
      <div class="s"><div class="n num">${fmtUsdt((d.today && d.today.deposits.volume) || 0)}</div><div class="l">Deposits &middot; 24h (${d.today ? d.today.deposits.count : 0})</div></div>
      <div class="s"><div class="n num">${fmtUsdt((d.today && d.today.payouts.volume) || 0)}</div><div class="l">Payouts &middot; 24h (${d.today ? d.today.payouts.count : 0})</div></div>
      <div class="s"><div class="n num">${fmtUsdt(((d.today ? d.today.deposits.volume : 0) - (d.today ? d.today.payouts.volume : 0)))}</div><div class="l">Net flow &middot; 24h</div></div>
      <div class="s"><div class="n num">${d.energy_month ? Number(d.energy_month).toLocaleString() : 0}</div><div class="l">Energy used &middot; this month</div></div>
      <div class="s"><div class="n num">${d.pending_approvals}</div><div class="l">Payouts awaiting approval</div></div>
      <div class="s"><div class="n num">${d.staff_count}</div><div class="l">Staff</div></div>
      <div class="s"><div class="n num">${d.deposit_wallet_count}</div><div class="l">Deposit addresses</div></div>
    </div></div>
  </div>
  ${d.report ? `<div class="panel"><div class="panel-head"><h2>Deposits vs payouts — last ${d.report.days} days</h2>
    <div style="font-size:12px;color:var(--muted)"><span style="color:var(--accent-ink)">■</span> deposits &nbsp; <span style="color:var(--warn)">■</span> payouts</div></div>
    <div class="panel-body">${barChartSVG(d.report.series)}</div></div>
  ${d.report.top_customers && d.report.top_customers.length ? `<div class="panel"><div class="panel-head"><h2>Top customers by received</h2></div><div class="panel-body flush">
    <table><thead><tr><th>Customer</th><th class="amt">Received (USDT)</th><th class="amt">Transfers</th></tr></thead><tbody>${d.report.top_customers.slice(0,5).map(c=>`<tr><td>${esc(c.username)}</td><td class="amt num">${fmtUsdt(c.v)}</td><td class="amt num">${c.c}</td></tr>`).join("")}</tbody></table></div></div>` : ""}` : ""}
  ${movementsPanel(d.recent_movements)}`;
}
function staffDash(d){
  return `
  <div class="readouts">
    <div class="readout"><div class="label">Your deposit addresses</div>
      <div class="value num">${(d.my_deposit_wallets||[]).length}</div>
      <div class="foot">Go to Receive to view &amp; share them</div></div>
    <div class="readout"><div class="label">Your payout requests</div>
      <div class="value num">${(d.my_requests||[]).length}</div>
      <div class="foot">Recent, on Payouts</div></div>
  </div>
  ${movementsPanel(d.recent_movements)}`;
}
function movementsPanel(moves){
  const rows = (moves||[]).map(m => `<tr>
    <td><span class="kind">${esc(KIND_LABEL[m.kind]||m.kind)}</span></td>
    <td>${addrHtml(m.from_address)}</td>
    <td>${addrHtml(m.to_address)}</td>
    <td class="amt num">${fmtUsdt(m.amount)} <span class="unit" style="font-size:11px">${esc(m.token)}</span></td>
    <td>${statusBadge(m.status)}</td>
    <td>${m.tx_hash ? `<span class="mono" title="${esc(m.tx_hash)}">${esc(m.tx_hash.slice(0,10))}…</span>` : "—"}</td>
    <td class="row-actions"><button class="btn btn-ghost btn-sm" data-receipt="${m.id}">Receipt</button></td>
  </tr>`).join("");
  return `<div class="panel"><div class="panel-head"><h2>Recent movements</h2></div>
    <div class="panel-body flush">
    ${rows ? `<table><thead><tr><th>Type</th><th>From</th><th>To</th>
      <th class="amt">Amount</th><th>Energy</th><th>Status</th><th>Tx</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : emptyState("No movements yet.")}
    </div></div>`;
}

/* ======================================================= WALLETS */
async function renderWallets(){
  const sec = $("#sec-wallets");
  if (state.user.role === "staff") return renderReceive(sec);

  sec.innerHTML = `<div class="page-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px"><div><h1>Wallets</h1>
    <p>Treasury, gas, disbursement pool, and per-staff deposit addresses.</p></div>
    <button id="wReconAll" class="btn btn-ghost btn-sm">Reconcile all from chain</button></div>
    <div id="wBody">Loading…</div>`;
  { const ra = $("#wReconAll"); if (ra) ra.onclick = async () => {
      const ok = await confirmModal({ title: "Reconcile all wallets", okLabel: "Reconcile all", bodyHtml: `<p style="margin:0;font-size:14px;color:var(--muted)">Pull on-chain history for every wallet (deposits for deposit wallets, payouts for pool/treasury) and backfill anything missing. Safe to run repeatedly.</p>` });
      if (!ok) return;
      await withBusy(ra, "Reconciling…", async () => {
        try { const r = await api("/reconcile", { method: "POST", body: { mode: "all" } }); toast(`Reconciled ${r.wallets} wallet(s) — scanned ${r.scanned}, added ${r.inserted}`); }
        catch (e) { toast(e.message, true); }
      });
    }; }
  try{
    const [wallets, users, settings, book, customers] = await Promise.all([
      api("/wallets"), api("/users"), api("/settings"), api("/address-book").catch(() => []), api("/customers").catch(() => [])
    ]);
    const active = wallets.filter(w => w.is_active);
    const inactive = wallets.filter(w => !w.is_active);
    const byType = t => active.filter(w => w.wtype === t);
    const treasury = byType("treasury")[0];
    const fee = byType("fee")[0];
    const pool = byType("disbursement");
    const deposits = byType("deposit");
    const staff = users.filter(u => u.role === "staff");
    const uname = id => (users.find(u => u.id === id) || customers.find(c => c.id === id) || {}).username || "—";
    const fr = t => ({ treasury: "Treasury", fee: "Gas", disbursement: "Pool", deposit: "Deposit" }[t] || t);

    $("#wBody").innerHTML = `
    <div class="tabbar" id="walTabs"><button data-tab="operator" class="active">Treasury &amp; gas</button><button data-tab="pool">Pool</button><button data-tab="deposit">Deposit</button><button data-tab="manage">Import / removed</button></div>
    <div class="tab-pane active" data-tab="operator">
    <div class="panel"><div class="panel-head"><h2>Treasury (master)</h2>
      ${treasury ? "" : `<button class="btn btn-primary btn-sm" id="mkTreasury">Create treasury</button>`}</div>
      <div class="panel-body">${treasury
        ? `<div class="recv-addr">${esc(treasury.address)}</div>
           <div class="form-actions"><button class="btn btn-ghost btn-sm bal" data-id="${treasury.id}">Check balance</button>
           <button class="btn btn-ghost btn-sm" data-secret="${treasury.id}">Key</button>
           <button class="btn btn-ghost btn-sm" data-wname="${treasury.id}" data-wlabel="${esc(treasury.label||'')}">Name</button>
           <button class="btn btn-ghost btn-sm" data-proof="${treasury.id}">Tronscan</button>
           <button class="btn btn-ghost btn-sm" data-qr="${esc(treasury.address)}" data-qrlabel="${esc(treasury.label||'treasury')}">QR</button>
           <button class="btn btn-ghost btn-sm wdeact" data-id="${treasury.id}" data-kind="treasury">Remove</button>
           <span class="hint" id="bal-${treasury.id}"></span></div>`
        : `<span class="hint">Deposits are swept here automatically. Keep the bulk of funds in cold storage.</span>`}
      </div></div>

    ${treasury ? `<div class="panel"><div class="panel-head"><h2>Treasury &amp; admin send <span class="role-pill">admin</span></h2></div><div class="panel-body">
      <div class="form-actions"><button class="btn btn-accent btn-sm" id="trDistribute">Distribute to pool (keep ${esc(settings.treasury_hold_percent)}%)</button>
        <span class="hint">Splits treasury USDT evenly across the pool, holding back ${esc(settings.treasury_hold_percent)}%.</span></div>
      <div style="height:14px"></div>
      <div class="form-grid">
        <div class="field"><label>Send from</label><select id="trFrom" class="input">
          <option value="treasury">Treasury (master)</option>
          ${pool.map(w => `<option value="${w.id}">Pool wallet #${w.id} — ${esc(shortAddr(w.address))}</option>`).join("")}
        </select></div>
        <div class="field"><label>Amount (USDT)</label><input id="trAmt" class="input" type="number" step="0.01" min="0" placeholder="0.00"></div>
      </div>
      <div class="field"><label>To address</label>
        <input id="trTo" class="input mono" placeholder="T… or pick from address book" list="wbList">
        <datalist id="wbList">${(book || []).map(e => `<option value="${esc(e.address)}">${esc(e.label ? e.label + " — " : "")}${esc(e.address)}</option>`).join("")}</datalist></div>
      <button class="btn btn-primary" id="trSend">Send</button>
      <div class="hint" style="margin-top:6px">Admin only — sends immediately, no approval. Staff cannot send from treasury.</div>
    </div></div>` : ""}

    <div class="panel"><div class="panel-head"><h2>Gas wallet (TRX)</h2>
      ${fee ? "" : `<button class="btn btn-primary btn-sm" id="mkFee">Create gas wallet</button>`}</div>
      <div class="panel-body">${fee
        ? `<div class="recv-addr">${esc(fee.address)}</div>
           <div class="hint">Fund this address with TRX so the system can pay sweep fees.</div>
           <div class="form-actions"><button class="btn btn-ghost btn-sm bal" data-id="${fee.id}">Check balance</button>
           <button class="btn btn-ghost btn-sm" data-secret="${fee.id}">Key</button>
           <button class="btn btn-ghost btn-sm" data-wname="${fee.id}" data-wlabel="${esc(fee.label||'')}">Name</button>
           <button class="btn btn-ghost btn-sm" data-proof="${fee.id}">Tronscan</button>
           <button class="btn btn-ghost btn-sm" data-qr="${esc(fee.address)}" data-qrlabel="${esc(fee.label||'gas wallet')}">QR</button>
           <button class="btn btn-ghost btn-sm wdeact" data-id="${fee.id}" data-kind="fee">Remove</button>
           <span class="hint" id="bal-${fee.id}"></span></div>`
        : `<span class="hint">Needed to pay the network fee when sweeping TRC-20 deposits.</span>`}
      </div></div>

    </div>
    <div class="tab-pane" data-tab="pool">
    <div class="panel"><div class="panel-head"><h2>Disbursement pool (${pool.length})</h2>
      <div class="row-actions">
        <input id="poolCount" class="input" style="width:72px" type="number" min="1" max="50" value="5">
        <button class="btn btn-primary btn-sm" id="mkPool">Add wallets</button></div></div>
      <div class="panel-body flush">${pool.length
        ? `<table><thead><tr><th>Label</th><th>Address</th><th class="amt">USDT</th><th class="amt">TRX</th><th></th></tr></thead><tbody>
           ${pool.map(w => `<tr><td>${esc(w.label||"—")}</td><td>${addrHtml(w.address)}</td>
             <td class="amt num" id="pbal-${w.id}">—</td>
             <td class="amt num" id="ptrx-${w.id}">—</td>
             <td class="row-actions"><button class="btn btn-ghost btn-sm bal" data-id="${w.id}" data-cell="pbal-${w.id}" data-trxcell="ptrx-${w.id}">Check</button><button class="btn btn-ghost btn-sm" data-secret="${w.id}">Key</button><button class="btn btn-ghost btn-sm" data-wname="${w.id}" data-wlabel="${esc(w.label||'')}">Name</button><button class="btn btn-ghost btn-sm" data-qr="${esc(w.address)}" data-qrlabel="${esc(w.label||'')}">QR</button><button class="btn btn-ghost btn-sm" data-recon="${esc(w.address)}">Reconcile</button><button class="btn btn-ghost btn-sm wdeact" data-id="${w.id}" data-kind="pool">Remove</button></td></tr>`).join("")}
           </tbody></table>`
        : emptyState("No pool wallets yet. Payouts draw from these, topped up from treasury.")}
      </div></div>

    </div>
    <div class="tab-pane" data-tab="deposit">
    <div class="panel"><div class="panel-head"><h2>Deposit addresses (${deposits.length})</h2></div>
      <div class="panel-body">
        <div class="form-grid">
          <div class="field"><label>Assign to staff</label>
            <select id="depStaff" class="input">
              ${staff.length ? staff.map(u => `<option value="${u.id}">${esc(u.username)}</option>`).join("")
                : `<option value="">No staff yet — add one first</option>`}
            </select></div>
          <div class="field"><label>Label (optional)</label>
            <input id="depLabel" class="input" placeholder="e.g. Counter 3"></div>
        </div>
        <button class="btn btn-primary" id="mkDeposit" ${staff.length?"":"disabled"}>Create deposit address</button>
      </div>
      <div class="panel-body flush">${deposits.length
        ? `<table><thead><tr><th>Owner</th><th>Label</th><th>Address</th><th></th></tr></thead><tbody>
           ${deposits.map(w => `<tr><td>${esc(uname(w.owner_user_id))}</td>
             <td>${esc(w.label||"—")}</td><td>${addrHtml(w.address)}</td>
             <td class="row-actions"><span class="hint" id="bal-${w.id}"></span><button class="btn btn-ghost btn-sm" data-bal="${w.id}">Balance</button><button class="btn btn-ghost btn-sm" data-secret="${w.id}">Key</button><button class="btn btn-ghost btn-sm" data-wname="${w.id}" data-wlabel="${esc(w.label||'')}">Name</button><button class="btn btn-ghost btn-sm" data-qr="${esc(w.address)}" data-qrlabel="${esc(w.label||'')}">QR</button><button class="btn btn-ghost btn-sm" data-recon="${esc(w.address)}">Reconcile</button><button class="btn btn-ghost btn-sm wdeact" data-id="${w.id}" data-kind="deposit">Remove</button></td></tr>`).join("")}</tbody></table>`
        : emptyState("No deposit addresses yet.")}
      </div></div>

    </div>
    <div class="tab-pane" data-tab="manage">
    ${inactive.length?`<div class="panel"><div class="panel-head"><h2>Removed wallets (${inactive.length})</h2></div><div class="panel-body flush">
      <table><thead><tr><th>Type</th><th>Owner</th><th>Address</th><th></th></tr></thead><tbody>
      ${inactive.map(w=>`<tr><td>${esc(fr(w.wtype))}</td><td>${esc(uname(w.owner_user_id))}</td><td>${addrHtml(w.address)}</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm wact" data-id="${w.id}">Re-add</button><button class="btn btn-ghost btn-sm" data-secret="${w.id}">Key</button></td></tr>`).join("")}
      </tbody></table></div></div>`:""}

    <div class="panel"><div class="panel-head"><h2>Import a wallet <span class="role-pill">admin</span></h2></div><div class="panel-body">
      <div class="form-grid">
        <div class="field"><label>Private key</label><input id="impKey" class="input mono" placeholder="existing TRON private key"></div>
        <div class="field"><label>Use as</label><select id="impType" class="input">
          <option value="disbursement">Pool wallet</option>
          <option value="fee">Gas wallet</option>
          <option value="treasury">Treasury (only if none)</option>
          <option value="deposit">Deposit wallet</option></select></div>
        <div class="field"><label>Owner (deposit only)</label><select id="impOwner" class="input"><option value="">— none —</option>
          ${staff.length?`<optgroup label="Staff">${staff.map(u=>`<option value="${u.id}">${esc(u.username)}</option>`).join("")}</optgroup>`:""}
          ${customers.length?`<optgroup label="Customers">${customers.map(c=>`<option value="${c.id}">${esc(c.username)}</option>`).join("")}</optgroup>`:""}
        </select></div>
      </div>
      <div class="field"><label>Label (optional)</label><input id="impLabel" class="input" placeholder="e.g. cold-storage import"></div>
      <button class="btn btn-primary" id="impBtn">Import wallet</button>
      <div class="hint" style="margin-top:6px">The key is encrypted at rest, same as generated wallets. Admin only.</div>
    </div></div>
    </div>`;

    wireWalletActions();
  }catch(e){ $("#wBody").innerHTML = emptyState(e.message); }
}

function wireWalletActions(){
  const on = (id, fn) => { const el = $("#"+id); if (el) el.onclick = fn; };
  on("mkTreasury", () => act(() => api("/wallets/treasury", {method:"POST"}), "Treasury created", renderWallets));
  on("trDistribute", async () => {
    const ok = await confirmModal({ title:"Distribute treasury to pool", okLabel:"Distribute",
      bodyHtml:`<p style="margin:0;font-size:14px;color:var(--muted)">This sends treasury USDT out to every pool wallet, keeping the configured hold-back in treasury. Proceed?</p>` });
    if (ok) act(() => api("/treasury/distribute", {method:"POST"}), "Treasury distributed to pool", renderWallets);
  });
  on("trSend", async () => {
    const from = $("#trFrom").value, to = $("#trTo").value.trim(), amt = parseFloat($("#trAmt").value);
    if (!to) return toast("Enter a recipient address", true);
    if (!(amt > 0)) return toast("Enter a valid amount", true);
    const live = state.network === "mainnet";
    const srcLabel = from === "treasury" ? "Treasury (master)" : "Pool wallet #" + from;
    const ok = await confirmModal({ title:"Send USDT", okLabel:"Send",
      bodyHtml:`<div class="kv"><span class="k">From</span><span class="v">${esc(srcLabel)}</span></div>
        <div class="kv"><span class="k">Amount</span><span class="v num">${fmtUsdt(amt)} USDT</span></div>
        <div class="kv"><span class="k">To</span><span class="v mono" style="font-size:12px">${esc(shortAddr(to))}</span></div>
        ${live?`<div class="live-note">This sends real USDT on mainnet. It cannot be reversed.</div>`:""}` });
    if (!ok) return;
    await withBusy($("#trSend"), "Sending…", async () => {
      try { await api("/admin/send", {method:"POST", body:{ from, to_address: to, amount: amt }}); toast("Sent — confirming…"); renderWallets(); }
      catch (e) { toast(e.message, true); }
    });
  });
  on("mkFee", () => act(() => api("/wallets/fee", {method:"POST"}), "Gas wallet created", renderWallets));
  on("mkPool", () => {
    const n = parseInt($("#poolCount").value, 10) || 5;
    act(() => api(`/wallets/disbursement-pool?count=${n}`, {method:"POST"}), `${n} pool wallets added`, renderWallets);
  });
  on("mkDeposit", () => {
    const sid = parseInt($("#depStaff").value, 10);
    if (!sid) return toast("Pick a staff member", true);
    act(() => api("/wallets/deposit", {method:"POST",
      body:{ staff_user_id: sid, label: $("#depLabel").value.trim() }}), "Deposit address created", renderWallets);
  });
  on("impBtn", () => {
    const private_key = $("#impKey").value.trim();
    if (!private_key) return toast("Enter a private key", true);
    const wtype = $("#impType").value;
    const body = { private_key, wtype, label: $("#impLabel").value.trim() };
    if (wtype === "deposit") { const o = $("#impOwner") && $("#impOwner").value; if (o) body.owner_user_id = Number(o); }
    act(() => api("/wallets/import", {method:"POST", body}), "Wallet imported", renderWallets);
  });
  document.querySelectorAll(".wdeact").forEach(b => b.onclick = async () => {
    const kind = b.dataset.kind, critical = kind === "treasury" || kind === "fee";
    const ok = await confirmModal({ title: "Remove wallet", okLabel: "Remove", okClass: "btn-danger",
      bodyHtml: `<p style="margin:0;font-size:14px;color:var(--muted)">This removes the wallet from active use — it won't receive sweeps or send payouts. History is kept and you can re-add it later.${critical ? " <b>Move any funds out first.</b>" : ""}</p>` });
    if (ok) act(() => api(`/wallets/${b.dataset.id}/deactivate`, { method: "POST" }), "Wallet removed", renderWallets);
  });
  document.querySelectorAll(".wact").forEach(b => b.onclick = () => act(() => api(`/wallets/${b.dataset.id}/activate`, { method: "POST" }), "Wallet re-added", renderWallets));
  document.querySelectorAll(".bal").forEach(b => b.onclick = async () => {
    const id = b.dataset.id, cell = b.dataset.cell;
    b.disabled = true; const prev = b.textContent; b.textContent = "…";
    try{
      const r = await api(`/wallets/${id}/balance`);
      const txt = `${fmtUsdt(r.usdt)} USDT · ${fmtTrx(r.native)} TRX`;
      if (cell) $("#"+cell).textContent = fmtUsdt(r.usdt);
      if (b.dataset.trxcell) { const tc = $("#"+b.dataset.trxcell); if (tc) tc.textContent = fmtTrx(r.native); }
      const hint = $("#bal-"+id); if (hint) hint.textContent = txt;
      if (!cell && !hint) toast(txt);
    }catch(e){ toast(e.message, true); }
    finally{ b.disabled = false; b.textContent = prev; }
  });
}

/* staff "Receive" view with QR codes */
async function renderReceive(sec){
  sec.innerHTML = `<div class="page-head"><div><h1>Receive USDT</h1>
    <p>Share one of your addresses to receive TRC-20 USDT. Deposits settle to treasury automatically.</p></div></div>
    <div id="rBody">Loading…</div>`;
  try{
    const wallets = (await api("/wallets")).filter(w => w.wtype === "deposit");
    if (!wallets.length){ $("#rBody").innerHTML = emptyState("No deposit address assigned yet. Ask an admin to create one for you."); return; }
    $("#rBody").innerHTML = wallets.map((w,i) => receiveCard({ name: state.user.username, walletLabel: w.label || ("Deposit address " + (i+1)), address: w.address })).join("");
    await mountReceiveCards($("#rBody"));
  }catch(e){ $("#rBody").innerHTML = emptyState(e.message); }
}

/* ======================================================= PAYOUTS */
async function renderPayouts(){
  const sec = $("#sec-payouts");
  sec.innerHTML = `<div class="page-head"><div><h1>Payouts</h1>
    <p>${state.user.role === "admin"
      ? "Make a payout, or review and approve staff requests. Payouts leave from a random pool wallet."
      : "Request a USDT payout from the pool."}</p></div></div>
    <div id="pBody">Loading…</div>`;
  try{
    const canPay = state.user.role === "staff" || state.user.role === "admin";
    const [reqs, settings, book, liq] = await Promise.all([
      api("/disbursements"), api("/settings").catch(() => ({})), api("/address-book").catch(() => []), api("/liquidity").catch(() => null)
    ]);
    const liqCard = liq ? `<div class="readouts" style="margin-bottom:18px"><div class="readout">
      <div class="label">Available to send (treasury + pool)</div>
      <div class="value lead num">${fmtUsdt(liq.total)}<span class="unit">USDT</span></div>
      <div class="foot">treasury ${fmtUsdt(liq.treasury)} · pool ${fmtUsdt(liq.pool_total)} across ${liq.pool_count} wallet${liq.pool_count === 1 ? "" : "s"}</div></div></div>` : "";
    $("#pBody").innerHTML = liqCard + (canPay ? staffRequestForm(settings, book) : "") + payoutTable(reqs);
    if (canPay) $("#pSubmit").onclick = submitRequest;
    if (state.user.role === "admin")
      document.querySelectorAll(".approve").forEach(b => b.onclick = () => approve(b.dataset, b));
  }catch(e){ $("#pBody").innerHTML = emptyState(e.message); }
}
function staffRequestForm(settings, book){
  const isAdmin = state.user.role === "admin";
  const own = state.user.auto_approve_limit;
  const eff = own != null ? Number(own) : (settings && settings.staff_auto_approve_limit ? Number(settings.staff_auto_approve_limit) : 0);
  const hint = isAdmin
    ? "Your payouts are sent immediately."
    : (eff > 0 ? `Payouts up to ${fmtUsdt(eff)} USDT are sent immediately; above that needs admin approval.` : "All your payouts require admin approval.");
  const title = isAdmin ? "Make a payout" : "New payout request";
  const btn = isAdmin ? "Send payout" : "Submit request";
  const opts = (book || []).map(e => `<option value="${esc(e.address)}">${esc(e.label ? e.label + " — " : "")}${esc(e.address)}</option>`).join("");
  return `<div class="panel"><div class="panel-head"><h2>${title}</h2></div>
    <div class="panel-body"><div class="form-grid">
      <div class="field"><label>Recipient address (TRC-20)</label>
        <input id="pTo" class="input mono" placeholder="T… or pick from address book" list="abList">
        <datalist id="abList">${opts}</datalist></div>
      <div class="field"><label>Amount (USDT)</label>
        <input id="pAmt" class="input" type="number" step="0.000001" min="0" placeholder="0.00"></div>
    </div>
    <div class="field"><label>Reason / reference (optional)</label>
      <input id="pReason" class="input" placeholder="e.g. settlement #4821"></div>
    <button class="btn btn-primary" id="pSubmit">${btn}</button>
    <div class="hint" style="margin-top:6px">${hint}</div>
    </div></div>`;
}
function payoutTable(reqs){
  const admin = state.user.role === "admin";
  const rows = (reqs||[]).map(r => {
    const pending = r.status === "pending" && !r.tx_hash;
    return `<tr>
      <td>#${r.id}</td>
      <td>${addrHtml(r.to_address)}</td>
      <td class="amt num">${fmtUsdt(r.amount)} USDT</td>
      <td>${r.awaiting_second_approval ? `<span class="badge b-pending"><span class="dot"></span>awaiting 2nd approval</span>` : statusBadge(r.status)}</td>
      <td>${r.from_wallet_id ? "pool #" + r.from_wallet_id : "—"}</td>
      <td>${r.tx_hash ? `<span class="mono" title="${esc(r.tx_hash)}">${esc(r.tx_hash.slice(0,10))}…</span>` : "—"}</td>
      ${admin ? `<td class="row-actions">${pending
        ? `<button class="btn btn-accent btn-sm approve" data-id="${r.id}" data-to="${esc(r.to_address)}" data-amt="${esc(r.amount)}">Approve &amp; send</button>`
        : "—"}</td>` : ""}
      <td class="row-actions">${r.tx_hash ? `<button class="btn btn-ghost btn-sm" data-receipt-tx="${esc(r.tx_hash)}">Receipt</button>` : "—"}</td>
    </tr>`;
  }).join("");
  return `<div class="panel"><div class="panel-head"><h2>${admin?"All payout requests":"Your requests"}</h2></div>
    <div class="panel-body flush">${rows
      ? `<table><thead><tr><th>Req</th><th>Recipient</th><th class="amt">Amount</th>
        <th>Status</th><th>Source</th><th>Tx</th>${admin?"<th></th>":""}<th></th></tr></thead><tbody>${rows}</tbody></table>`
      : emptyState(admin ? "No payout requests." : "You have not requested any payouts yet.")}
    </div></div>`;
}
async function submitRequest(){
  const btn = $("#pSubmit");
  const to = $("#pTo").value.trim(), amt = parseFloat($("#pAmt").value);
  if (!to){ return toast("Enter a recipient address", true); }
  if (!(amt > 0)){ return toast("Enter a valid amount", true); }
  await withBusy(btn, "Sending…", async () => {
    try{
      const r = await api("/disbursements", {method:"POST", body:{ to_address: to, amount: amt, reason: $("#pReason").value.trim() }});
      toast(r.tx_hash ? "Payout sent — confirming…" : "Payout request submitted for approval");
      renderPayouts(); refreshSoon("sec-payouts", renderPayouts);
    }catch(e){ toast(e.message, true); }
  });
}
async function approve({ id, to, amt }, btn){
  const live = state.network === "mainnet";
  const ok = await confirmModal({
    title: "Approve and send payout",
    okLabel: "Send payout",
    bodyHtml: `
      <div class="kv"><span class="k">Amount</span><span class="v num">${fmtUsdt(amt)} USDT</span></div>
      <div class="kv"><span class="k">Recipient</span><span class="v mono" style="font-size:12px">${esc(shortAddr(to))}</span></div>
      <div class="kv"><span class="k">Source</span><span class="v">rotating pool wallet</span></div>
      ${live ? `<div class="live-note">This sends real USDT on mainnet. It cannot be reversed.</div>` : ""}`
  });
  if (!ok) return;
  await withBusy(btn, "Sending…", async () => {
    try { await api(`/disbursements/${id}/approve`, {method:"POST"}); toast("Payout sent — confirming…"); renderPayouts(); refreshSoon("sec-payouts", renderPayouts); }
    catch (e) { toast(e.message, true); }
  });
}

/* ======================================================= STAFF (admin) */
async function renderStaff(){
  const sec = $("#sec-staff");
  sec.innerHTML = `<div class="page-head"><div><h1>Staff</h1>
    <p>Create accounts and manage access.</p></div></div><div id="sBody">Loading…</div>`;
  try{
    const users = await api("/users");
    $("#sBody").innerHTML = `
    <div class="panel"><div class="panel-head"><h2>Add user</h2></div>
      <div class="panel-body"><div class="form-grid">
        <div class="field"><label>Username</label><input id="nuUser" class="input"></div>
        <div class="field"><label>Role</label>
          <select id="nuRole" class="input"><option value="staff">Staff</option><option value="admin">Admin</option></select></div>
      </div>
      <div class="field"><label>Temporary password</label>
        <input id="nuPass" class="input" type="text" placeholder="min 8 characters">
        <div class="hint">Share securely; ask the user to change it after first sign-in.</div></div>
      <button class="btn btn-primary" id="nuCreate">Create user</button>
      </div></div>
    <div class="panel"><div class="panel-head"><h2>Users (${users.length})</h2></div>
      <div class="panel-body flush"><table><thead><tr><th>ID</th><th>Username</th><th>Role</th><th>Status</th><th>Auto-approve limit (USDT)</th><th></th></tr></thead>
        <tbody>${users.map(u => `<tr><td>#${u.id}</td><td>${esc(u.username)}</td>
          <td><span class="role">${esc(u.role)}</span></td>
          <td>${u.is_active ? statusBadge("confirmed").replace("confirmed","active") : statusBadge("failed").replace("failed","disabled")}</td>
          <td>${u.role === "staff"
            ? `<input class="input lim-inp" data-id="${u.id}" type="number" step="0.01" min="0" value="${u.auto_approve_limit != null ? esc(u.auto_approve_limit) : ""}" placeholder="default" style="width:96px;display:inline-block;padding:6px 8px">
               <button class="btn btn-ghost btn-sm lim-save" data-id="${u.id}">Set</button>`
            : "—"}</td>
          <td class="row-actions">
            <button class="btn btn-ghost btn-sm" data-usertx="${u.id}">Transactions</button>
            <button class="btn btn-ghost btn-sm pw-reset" data-id="${u.id}" data-name="${esc(u.username)}">Reset pw</button>
            ${u.id !== state.user.id ? `<button class="btn btn-ghost btn-sm act-toggle" data-id="${u.id}" data-name="${esc(u.username)}" data-active="${u.is_active ? 1 : 0}">${u.is_active ? "Disable" : "Enable"}</button>` : ""}
          </td></tr>`).join("")}
        </tbody></table></div></div>`;
    $("#nuCreate").onclick = () => {
      const username = $("#nuUser").value.trim(), password = $("#nuPass").value, role = $("#nuRole").value;
      if (username.length < 3) return toast("Username too short", true);
      if (password.length < 8) return toast("Password must be at least 8 characters", true);
      act(() => api("/users", {method:"POST", body:{ username, password, role }}), "User created", renderStaff);
    };
    document.querySelectorAll(".lim-save").forEach(b => b.onclick = () => {
      const id = b.dataset.id;
      const inp = document.querySelector(`.lim-inp[data-id="${id}"]`);
      const v = inp.value.trim();
      act(() => api("/users/" + id + "/limit", {method:"POST", body:{ limit: v === "" ? null : parseFloat(v) }}),
        v === "" ? "Limit cleared (uses default)" : "Limit updated", renderStaff);
    });
    document.querySelectorAll(".pw-reset").forEach(b => b.onclick = async () => {
      const ok = await confirmModal({ title:"Reset password", okLabel:"Reset",
        bodyHtml:`<p style="margin:0 0 10px;font-size:13.5px;color:var(--muted)">Set a new password for <b>${esc(b.dataset.name)}</b> (min 8 characters). Share it securely.</p>
          <input id="rpwInput" class="input" type="text" placeholder="new password" autocomplete="off">` });
      if (!ok) return;
      const pw = (document.getElementById("rpwInput") || {}).value || "";
      if (pw.length < 8) return toast("Password must be at least 8 characters", true);
      act(() => api("/users/" + b.dataset.id + "/password", {method:"POST", body:{ password: pw }}), "Password reset", () => {});
    });
    document.querySelectorAll(".act-toggle").forEach(b => b.onclick = async () => {
      const target = b.dataset.active !== "1"; // currently inactive -> enable
      const verb = target ? "Enable" : "Disable";
      const ok = await confirmModal({ title:`${verb} user`, okLabel:verb, okClass: target ? "btn-accent" : "btn-ghost",
        bodyHtml:`<p style="margin:0;font-size:14px;color:var(--muted)">${verb} <b>${esc(b.dataset.name)}</b>? ${target ? "They will be able to sign in again." : "They will be signed out and blocked from signing in."}</p>` });
      if (!ok) return;
      act(() => api("/users/" + b.dataset.id + "/active", {method:"POST", body:{ active: target }}), verb + "d", renderStaff);
    });
  }catch(e){ $("#sBody").innerHTML = emptyState(e.message); }
}

/* ======================================================= AUDIT (admin) */
async function renderAudit(){
  const sec = $("#sec-audit");
  sec.innerHTML = `<div class="page-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px"><div><h1>Audit log</h1>
    <p>Every sensitive action, in order.</p></div><button id="auExport" class="btn btn-ghost btn-sm">Export CSV</button></div><div id="aBody">Loading…</div>`;
  { const ex = $("#auExport"); if (ex) ex.onclick = () => downloadCsv("/audit.csv", "audit.csv"); }
  try{
    const rows = await api("/audit");
    $("#aBody").innerHTML = `<div class="panel"><div class="panel-body flush">${rows.length
      ? `<table><thead><tr><th>Time (UTC)</th><th>User</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td class="mono" style="font-size:12px">${esc((r.at||"").replace("T"," ").slice(0,19))}</td>
          <td>#${r.user_id ?? "—"}</td><td><span class="kind">${esc(r.action)}</span></td>
          <td>${esc(r.detail)}</td><td class="mono" style="font-size:12px">${esc(r.ip||"—")}</td></tr>`).join("")}
        </tbody></table>` : emptyState("No audit entries yet.")}
      </div></div>`;
  }catch(e){ $("#aBody").innerHTML = emptyState(e.message); }
}

/* ---------- shared ---------- */
function emptyState(msg){ return `<div class="empty">${esc(msg)}</div>`; }
async function act(fn, okMsg, after){
  try{ await fn(); toast(okMsg); if (after) after(); }
  catch(e){ toast(e.message, true); }
}
// Disable a button and show a busy label while an async action runs — prevents double-clicks
// and makes it clear something is happening.
async function withBusy(btn, label, run){
  if (btn && btn.disabled) return;           // already in flight — ignore repeat clicks
  const prev = btn ? btn.textContent : null;
  if (btn){ btn.disabled = true; btn.textContent = label || "Working…"; }
  try { return await run(); }
  finally { if (btn && btn.isConnected){ btn.disabled = false; btn.textContent = prev; } }
}
// Re-render a section shortly after, so a just-broadcast "pending" row flips to confirmed/failed.
function refreshSoon(secId, fn, ms = 5000){ setTimeout(() => { const s = $("#" + secId); if (s && s.classList.contains("active")) fn(); }, ms); }

/* global copy-button delegation */
/* ---------- receipts ---------- */
function ensureReceiptModal(){
  if ($("#rcptBack")) return;
  const d = document.createElement("div");
  d.id = "rcptBack"; d.className = "modal-back";
  d.innerHTML = `<div class="modal receipt" id="rcptCard">
    <div class="receipt-head">
      <div class="receipt-brand"><span class="rb-mark">K</span> KryvonWallet — Receipt</div>
      <div class="receipt-id mono" id="rcptId"></div>
    </div>
    <div class="receipt-body" id="rcptBody"></div>
    <div class="modal-foot no-print">
      <button class="btn btn-ghost" id="rcptClose">Close</button>
      <button class="btn btn-accent" id="rcptPrint">Print / Save PDF</button>
    </div></div>`;
  document.body.appendChild(d);
  $("#rcptClose").onclick = () => d.classList.remove("show");
  $("#rcptPrint").onclick = () => window.print();
  d.addEventListener("click", (e) => { if (e.target === d) d.classList.remove("show"); });
}
function rRow(k, v){ return `<div class="r-row"><div class="r-k">${k}</div><div class="r-v">${v}</div></div>`; }
function showReceipt(r){
  ensureReceiptModal();
  const dt = (r.datetime || "").replace("T", " ").slice(0, 19) + " UTC";
  const amount = `${fmtUsdt(r.amount)} ${esc(r.token)}`;
  const usd = r.amount_usd != null ? `$${Number(r.amount_usd).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : "—";
  const rate = r.usd_rate != null ? `1 USDT = $${Number(r.usd_rate).toFixed(4)}` : "—";
  $("#rcptId").textContent = r.receipt_id;
  $("#rcptBody").innerHTML =
    rRow("Type", `${esc(KIND_LABEL[r.kind] || r.kind)} &nbsp; ${statusBadge(r.status)}`) +
    rRow("Date &amp; time", esc(dt)) +
    rRow("Network", esc((r.network || "").toUpperCase())) +
    rRow("Asset", r.token === "TRX" ? "TRX" : "USDT (TRC-20)") +
    `<div class="r-sep"></div>` +
    rRow("Sender address", r.sender_address ? `<span class="mono brk">${esc(r.sender_address)}</span>` : "External") +
    rRow("Receiver wallet", r.receiver_address ? `<span class="mono brk">${esc(r.receiver_address)}</span>` : "—") +
    `<div class="r-sep"></div>` +
    rRow("Amount", `<b>${amount}</b>`) +
    (r.deposit_fee_percent ? rRow(`Deposit fee (${esc(r.deposit_fee_percent)}%)`, `${fmtUsdt(r.fee_amount)} USDT`) : "") +
    (r.net_amount != null ? rRow("Net credited", `<b>${fmtUsdt(r.net_amount)} USDT</b>`) : "") +
    rRow("Value (USD)", `${usd} <span class="r-sub">(${rate})</span>`) +
    `<div class="r-sep"></div>` +
    rRow("Transaction ID", `<span class="mono">${esc(r.receipt_id)}</span>`) +
    rRow("Hash key (tx)", r.tx_hash
      ? `<span class="mono brk">${esc(r.tx_hash)}</span>${r.explorer_url ? ` &middot; <a class="no-print" href="${esc(r.explorer_url)}" target="_blank" rel="noopener">View on Tronscan \u2197</a>` : ""}`
      : "—");
  $("#rcptBack").classList.add("show");
}
async function openReceipt(key){
  try { showReceipt(await api("/receipts/" + encodeURIComponent(key))); }
  catch (e) { toast(e.message, true); }
}

async function reconcileOneWallet(btn){
  const address = btn.getAttribute("data-recon");
  await withBusy(btn, "Reconciling…", async () => {
    try { const r = await api("/reconcile", { method: "POST", body: { mode: "wallet", address } }); toast(`Reconciled — scanned ${r.scanned}, added ${r.inserted}`); }
    catch (e) { toast(e.message, true); }
  });
}
async function checkWalletBalance(btn){
  const id = btn.dataset.bal, span = document.getElementById("bal-" + id);
  const prev = btn.textContent; btn.disabled = true; btn.textContent = "…";
  try {
    const r = await api("/wallets/" + id + "/balance");
    const txt = `${fmtUsdt(r.usdt)} USDT · ${fmtTrx(r.native)} TRX`;
    if (span) span.textContent = txt; else toast(txt);
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = prev; }
}
document.addEventListener("click", (e) => {
  const tb = e.target.closest(".tabbar button[data-tab]");
  if (tb){ const bar = tb.closest(".tabbar"), scope = bar.parentElement, tab = tb.dataset.tab;
    bar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === tb));
    scope.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("active", p.dataset.tab === tab));
    return; }
  const pf = e.target.closest("[data-proof]");
  if (pf){ showProof(pf.dataset.proof); return; }
  const wn = e.target.closest("[data-wname]");
  if (wn){ openWalletName(wn.dataset.wname, wn.dataset.wlabel || ""); return; }
  const sk = e.target.closest("[data-secret]");
  if (sk){ showSecret(sk.dataset.secret); return; }
  const bl = e.target.closest("[data-bal]");
  if (bl){ checkWalletBalance(bl); return; }
  const rcn = e.target.closest("[data-recon]");
  if (rcn){ reconcileOneWallet(rcn); return; }
  const ut = e.target.closest("[data-usertx]");
  if (ut){ openUserTx(ut.dataset.usertx); return; }
  const q = e.target.closest("[data-qr]");
  if (q){ showQr(q.dataset.qr, q.dataset.qrlabel, q.dataset.qrcustomer); return; }
  const c = e.target.closest("[data-copy]");
  if (c){ copy(c.dataset.copy); return; }
  const rc = e.target.closest("[data-receipt]");
  if (rc){ openReceipt(rc.dataset.receipt); return; }
  const rt = e.target.closest("[data-receipt-tx]");
  if (rt){ openReceipt(rt.dataset.receiptTx); return; }
});

/* ---------- boot ---------- */
/* ---------- messaging ---------- */
function threadBubble(m){
  const mine = m.sender_user_id === state.user.id;
  const who = esc(m.sender_name || "—") + (m.sender_role ? ` · ${esc(m.sender_role)}` : "");
  const tag = m.kind === "receipt" ? ' <span class="role-pill">receipt</span>' : m.kind === "ack" ? ' <span class="role-pill">ack</span>' : "";
  return `<div style="display:flex;justify-content:${mine ? "flex-end" : "flex-start"};margin:6px 0">
    <div style="max-width:80%;background:${mine ? "var(--accent-soft)" : "var(--surface-2)"};border:1px solid var(--line);border-radius:12px;padding:8px 12px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${who}${tag}</div>
      <div style="font-size:14px;white-space:pre-wrap;word-break:break-word">${esc(m.body)}</div>
      <div style="font-size:10px;color:var(--faint);margin-top:3px">${esc((m.created_at || "").replace("T", " ").slice(0, 16))}</div>
    </div></div>`;
}
async function mountThread(rootEl, customerId, opts = {}){
  rootEl.innerHTML = `<div class="th-messages" style="max-height:46vh;overflow-y:auto;padding:4px 2px;border:1px solid var(--line);border-radius:10px;background:var(--surface)"></div>
    <div class="form-actions" style="margin-top:10px"><input class="input th-input" placeholder="Type a message…" style="flex:1"><button class="btn btn-primary btn-sm th-send">Send</button></div>
    <div class="form-actions th-quick" style="margin-top:8px"></div>`;
  const msgsEl = rootEl.querySelector(".th-messages");
  const load = async () => { try { const msgs = await api("/customers/" + customerId + "/messages"); msgsEl.innerHTML = msgs.length ? msgs.map(threadBubble).join("") : `<div class="empty">No messages yet.</div>`; msgsEl.scrollTop = msgsEl.scrollHeight; } catch (e) { msgsEl.innerHTML = emptyState(e.message); } };
  const send = async (body, kind) => { if (!String(body || "").trim()) return; try { await api("/customers/" + customerId + "/messages", { method: "POST", body: { body, kind: kind || "text" } }); await load(); } catch (e) { toast(e.message, true); } };
  rootEl.querySelector(".th-send").onclick = () => { const i = rootEl.querySelector(".th-input"); const v = i.value; i.value = ""; send(v, "text"); };
  rootEl.querySelector(".th-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { const v = e.target.value; e.target.value = ""; send(v, "text"); } });
  const quick = rootEl.querySelector(".th-quick"); let q = "";
  if (opts.canAck) q += `<button class="btn btn-ghost btn-sm th-ack">Acknowledge received</button>`;
  if (opts.receiptSeed) q += `<button class="btn btn-ghost btn-sm th-receipt">Send receipt</button>`;
  quick.innerHTML = q;
  const ab = rootEl.querySelector(".th-ack"); if (ab) ab.onclick = () => send("Payment received — thank you.", "ack");
  const rb = rootEl.querySelector(".th-receipt"); if (rb) rb.onclick = () => send(opts.receiptSeed, "receipt");
  await load();
}
function ensureThreadModal(){
  if ($("#thBack")) return;
  const d = document.createElement("div"); d.id = "thBack"; d.className = "modal-back";
  d.innerHTML = `<div class="modal"><div class="modal-head"><h3 id="thTitle">Messages</h3></div><div class="modal-body" id="thRoot"></div><div class="modal-foot"><button class="btn btn-ghost" id="thClose">Close</button></div></div>`;
  document.body.appendChild(d);
  $("#thClose").onclick = () => d.classList.remove("show");
  d.addEventListener("click", (e) => { if (e.target === d) d.classList.remove("show"); });
}
async function openThread(customerId, title, opts){
  ensureThreadModal();
  $("#thTitle").textContent = title || "Messages";
  $("#thBack").classList.add("show");
  await mountThread($("#thRoot"), customerId, opts || {});
}
function receiptSeedFrom(rec){
  if (!rec || !rec.length) return "";
  const r = rec[0];
  const amt = r.amount != null ? fmtUsdt(r.amount) : "";
  const tx = r.tx_hash || "";
  return `KryvonWallet receipt\nAmount: ${amt} USDT\n${r.to_address ? "To: " + r.to_address + "\n" : ""}${tx ? "Tx: " + tx : ""}`;
}

/* ---------- my customers (staff/admin) ---------- */
async function renderMyCustomers(){
  const sec = $("#sec-mycustomers");
  sec.innerHTML = `<div class="page-head"><h1>My customers</h1><p>Customers assigned to you — received funds and messaging.</p></div><div id="mcBody">Loading…</div>`;
  try{
    const list = await api("/my/customers");
    if (!list.length) { $("#mcBody").innerHTML = emptyState("No customers assigned to you yet."); return; }
    $("#mcBody").innerHTML = list.map((c) => `<div class="panel"><div class="panel-head">
        <h2>${esc(c.username)} <span class="role-pill">${esc(c.customer_type)}</span></h2>
        <div class="row-actions">
          <button class="btn btn-ghost btn-sm mc-msg" data-id="${c.id}" data-name="${esc(c.username)}" data-phone="${esc(c.phone || "")}">Messages</button>
          ${c.customer_type === "depositor" && c.pay_token ? `<button class="btn btn-ghost btn-sm" data-copy="${esc(location.origin + "/pay/" + c.pay_token)}">Pay link</button>` : ""}
        </div></div>
      <div class="panel-body">
        <div class="stat-row"><div class="s"><div class="n num">${fmtUsdt(c.total_received)}</div><div class="l">Total received (USDT)</div></div>
          ${c.phone ? `<div class="s"><div class="n" style="font-size:14px">${esc(c.phone)}</div><div class="l">Phone</div></div>` : ""}</div>
        <div class="panel-body flush" style="padding:0;margin-top:10px">${(c.recent && c.recent.length)
          ? `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>${c.customer_type === "remittance" ? "To" : "From"}</th><th class="amt">Amount</th><th>Energy</th><th>Status</th></tr></thead><tbody>
             ${c.recent.map((r) => `<tr><td>${esc((r.created_at || "").replace("T", " ").slice(0, 16))}</td>
               <td>${addrHtml(c.customer_type === "remittance" ? r.to_address : r.from_address)}</td>
               <td class="amt num">${fmtUsdt(r.amount)} USDT</td><td>${statusBadge(r.status)}</td></tr>`).join("")}</tbody></table></div>`
          : emptyState("No activity yet.")}</div>
      </div></div>`).join("");
    list.forEach((c) => {});
    document.querySelectorAll(".mc-msg").forEach((b) => b.onclick = () => openThread(Number(b.dataset.id), "Messages · " + b.dataset.name, { phone: b.dataset.phone || null, receiptSeed: receiptSeedFrom(list.find((x) => x.id === Number(b.dataset.id)).recent) }));
  }catch(e){ $("#mcBody").innerHTML = emptyState(e.message); }
}

/* ---------- customer messages (portal) ---------- */
async function renderCustomerMessages(){
  const sec = $("#sec-messages");
  sec.innerHTML = `<div class="page-head"><h1>Messages</h1><p>Chat with your account team.</p></div><div class="panel"><div class="panel-body" id="cmRoot">Loading…</div></div>`;
  await mountThread($("#cmRoot"), state.user.id, { canAck: true });
}

/* ---------- customers management (admin/staff) ---------- */
let selectedCustomer = null;
async function renderCustomers(){
  const sec = $("#sec-customers");
  sec.innerHTML = `<div class="page-head"><h1>Customers</h1><p>Create depositor and remittance customers, manage whitelists, and send customer payouts.</p></div><div id="cBody">Loading…</div>`;
  try{
    const list = await api("/customers");
    $("#cBody").innerHTML = customerForm() + customerTable(list) + `<div id="custDetail"></div>`;
    wireCustomerForm();
    document.querySelectorAll(".manage-cust").forEach(b => b.onclick = () => openCustomer(Number(b.dataset.id)));
    if (selectedCustomer && list.some(c => c.id === selectedCustomer)) openCustomer(selectedCustomer);
  }catch(e){ $("#cBody").innerHTML = emptyState(e.message); }
}
function customerForm(){
  return `<div class="panel"><div class="panel-head"><h2>Add customer</h2></div><div class="panel-body">
    <div class="form-grid">
      <div class="field"><label>Type</label><select id="cType" class="input">
        <option value="depositor">Depositor — gets a deposit address</option>
        <option value="remittance">Remittance — we pay out to their whitelisted address</option></select></div>
      <div class="field"><label>Username</label><input id="cUser" class="input"></div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Temporary password</label><input id="cPass" class="input" type="text" placeholder="min 8 characters"></div>
      <div class="field"><label>Label (optional)</label><input id="cLabel" class="input" placeholder="name / reference"></div>
    </div>
    <div class="field"><label>Phone (optional)</label><input id="cPhone" class="input" placeholder="+15551234567"></div>
    <div class="field" id="cWlField" style="display:none"><label>Whitelisted payout address (TRC-20)</label><input id="cWl" class="input mono" placeholder="T…"></div>
    <div class="field" id="cImpField"><label>Import existing wallet (private key, optional)</label><input id="cImpKey" class="input mono" placeholder="leave blank to auto-generate a deposit wallet"></div>
    <button class="btn btn-primary" id="cCreate">Create customer</button></div></div>`;
}
function wireCustomerForm(){
  const typeSel = $("#cType");
  const toggle = () => { const dep = typeSel.value === "depositor"; $("#cWlField").style.display = dep ? "none" : ""; $("#cImpField").style.display = dep ? "" : "none"; };
  typeSel.onchange = toggle; toggle();
  $("#cCreate").onclick = () => {
    const body = { username: $("#cUser").value.trim(), password: $("#cPass").value, customer_type: typeSel.value, label: $("#cLabel").value.trim(), phone: $("#cPhone").value.trim() };
    if (typeSel.value === "remittance") body.whitelist_address = $("#cWl").value.trim();
    if (typeSel.value === "depositor") { const pk = $("#cImpKey").value.trim(); if (pk) body.private_key = pk; }
    if (body.username.length < 3) return toast("Username too short", true);
    if (body.password.length < 8) return toast("Password must be at least 8 characters", true);
    act(() => api("/customers", { method:"POST", body }), "Customer created", renderCustomers);
  };
}
function customerTable(list){
  const rows = (list||[]).map(c => `<tr>
    <td>#${c.id}</td><td>${esc(c.username)}</td>
    <td><span class="role-pill">${esc(c.customer_type)}</span></td>
    <td>${c.customer_type === "depositor" ? addrHtml(c.deposit_address) : (c.whitelist_count + " address" + (c.whitelist_count === 1 ? "" : "es"))}</td>
    <td class="row-actions"><button class="btn btn-ghost btn-sm" data-usertx="${c.id}">Transactions</button><button class="btn btn-ghost btn-sm manage-cust" data-id="${c.id}">Manage</button></td></tr>`).join("");
  return `<div class="panel"><div class="panel-head"><h2>Customers <span class="cnt">${(list||[]).length}</span></h2></div>
    <div class="panel-body flush">${rows ? `<table><thead><tr><th>ID</th><th>Username</th><th>Type</th><th>Deposit / whitelist</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("No customers yet.")}</div></div>`;
}
async function openCustomer(id){
  selectedCustomer = id;
  const d = $("#custDetail"); d.innerHTML = "Loading…";
  try{
    const [c, users] = await Promise.all([api("/customers/" + id), api("/users")]);
    let main = "";
    if (c.customer_type === "depositor"){
      main = `<div class="panel"><div class="panel-head"><h2>${esc(c.username)} · depositor</h2></div><div class="panel-body">
        ${c.deposit_addresses.map(w => `<div style="margin-bottom:14px"><div class="recv-addr">${esc(w.address)}</div>
          <div class="form-actions" style="margin-top:6px">
            <button class="btn btn-ghost btn-sm" data-copy="${esc(w.address)}">Copy</button>
            <button class="btn btn-ghost btn-sm" data-qr="${esc(w.address)}" data-qrlabel="${esc(w.label || c.username)}" data-qrcustomer="${esc(c.username)}">QR</button>
            <button class="btn btn-ghost btn-sm" data-bal="${w.id}">Balance</button>
            <button class="btn btn-ghost btn-sm" data-secret="${w.id}">Key</button>
            <span class="hint" id="bal-${w.id}"></span>
          </div></div>`).join("") || emptyState("No deposit address.")}
        <div class="hint">Deposits here settle to treasury automatically; the customer sees them in their portal.</div></div></div>`;
    } else {
      const wl = c.whitelist.map(w => `<tr><td>${addrHtml(w.address)}</td><td>${esc(w.label||"—")}</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm wl-del" data-wid="${w.id}">Remove</button></td></tr>`).join("");
      main = `<div class="panel"><div class="panel-head"><h2>${esc(c.username)} · remittance</h2></div>
        <div class="panel-body flush">${c.whitelist.length ? `<table><thead><tr><th>Whitelisted address</th><th>Label</th><th></th></tr></thead><tbody>${wl}</tbody></table>` : emptyState("No whitelisted addresses yet.")}</div>
        <div class="panel-body"><div class="form-grid">
          <div class="field"><label>Add whitelisted address</label><input id="wlAddr" class="input mono" placeholder="T…"></div>
          <div class="field"><label>Label</label><input id="wlLabel" class="input" placeholder="optional"></div>
        </div><button class="btn btn-ghost btn-sm" id="wlAdd">Add address</button></div></div>
        <div class="panel"><div class="panel-head"><h2>Send payout to ${esc(c.username)}</h2></div><div class="panel-body">
        ${c.whitelist.length ? `<div class="form-grid">
          <div class="field"><label>Amount (USDT)</label><input id="poAmt" class="input" type="number" step="0.01" min="0" placeholder="0.00"></div>
          <div class="field"><label>To whitelisted address</label><select id="poAddr" class="input">${c.whitelist.map(w => `<option value="${esc(w.address)}">${esc(w.label ? w.label + " — " : "")}${esc(shortAddr(w.address))}</option>`).join("")}</select></div>
        </div>
        <div class="field"><label>Reason / reference (optional)</label><input id="poReason" class="input" placeholder="e.g. invoice #123"></div>
        <button class="btn btn-primary" id="poSend">Create payout</button>
        <div class="hint" style="margin-top:6px">Creates a payout to a whitelisted address; an admin approves it in Payouts.</div>`
        : emptyState("Add a whitelisted address before sending a payout.")}
        </div></div>`;
    }

    const assigned = c.assigned_staff || [];
    const staffOptions = users.filter(u => ["staff", "admin"].includes(u.role) && !assigned.some(a => a.id === u.id))
      .map(u => `<option value="${u.id}">${esc(u.username)} (${esc(u.role)})</option>`).join("");
    const staffPanel = `<div class="panel"><div class="panel-head"><h2>Assigned staff</h2></div>
      <div class="panel-body flush">${assigned.length ? `<table><thead><tr><th>User</th><th></th></tr></thead><tbody>${assigned.map(s => `<tr><td>${esc(s.username)}</td><td class="row-actions"><button class="btn btn-ghost btn-sm as-del" data-sid="${s.id}">Remove</button></td></tr>`).join("")}</tbody></table>` : emptyState("No staff assigned.")}</div>
      <div class="panel-body"><div class="form-actions">
        <select id="asSel" class="input" style="max-width:280px">${staffOptions || '<option value="">Everyone already assigned</option>'}</select>
        <button class="btn btn-primary btn-sm" id="asAdd" ${staffOptions ? "" : "disabled"}>Assign staff</button></div></div></div>`;
    const commsPanel = `<div class="panel"><div class="panel-head"><h2>Messaging</h2></div><div class="panel-body">
      <div class="hint" style="margin-bottom:8px">Phone: ${c.phone ? esc(c.phone) : "—"}</div>
      <div class="form-actions"><button class="btn btn-primary btn-sm" id="cuMsg">Open messages</button></div></div></div>`;

    const payUrl = c.pay_token ? (location.origin + "/pay/" + c.pay_token) : "";
    const payPanel = `<div class="panel"><div class="panel-head"><h2>Payment link</h2></div><div class="panel-body">
      ${(c.deposit_addresses && c.deposit_addresses.length && payUrl) ? `<div class="recv-addr">${esc(payUrl)}</div>
        <div class="form-actions" style="margin-top:8px"><button class="btn btn-ghost btn-sm" data-copy="${esc(payUrl)}">Copy link</button><a class="btn btn-ghost btn-sm" href="${esc(payUrl)}" target="_blank" rel="noopener">Open</a></div>
        <div class="hint" style="margin-top:6px">Share with anyone who needs to pay ${esc(c.username)} — a branded page with their deposit address and QR.</div>`
        : `<div class="hint">A payment link needs a deposit address${c.customer_type === "remittance" ? " (remittance customers receive payouts, not deposits)" : ""}.</div>`}
    </div></div>`;
    const importPanel = `<div class="panel"><div class="panel-head"><h2>Import a deposit wallet</h2></div><div class="panel-body">
      <div class="form-grid">
        <div class="field"><label>Private key</label><input id="cimpKey" class="input mono" placeholder="existing TRON private key"></div>
        <div class="field"><label>Label (optional)</label><input id="cimpLabel" class="input" placeholder="e.g. migrated address"></div>
      </div>
      <button class="btn btn-primary btn-sm" id="cimpBtn">Import for ${esc(c.username)}</button>
      <div class="hint" style="margin-top:6px">Adds an existing address as this customer's deposit wallet. The key is encrypted at rest.</div>
    </div></div>`;
    const mapPanel = (state.user.role === "admin") ? `<div class="panel"><div class="panel-head"><h2>Map an existing deposit address</h2></div><div class="panel-body">
      <div class="field"><label>Existing deposit wallet</label><select id="cMapSel" class="input"><option value="">Loading…</option></select></div>
      <button class="btn btn-primary btn-sm" id="cMapBtn">Map to ${esc(c.username)}</button>
      <div class="hint" style="margin-top:6px">Re-assigns a deposit wallet already in the system to this customer — no private key needed.</div>
    </div></div>` : "";
    d.innerHTML = main + staffPanel + commsPanel + payPanel + importPanel + mapPanel;

    if (state.user.role === "admin") {
      const sel = $("#cMapSel");
      api("/wallets").then((ws) => {
        const dep = ws.filter((w) => w.wtype === "deposit" && w.is_active && w.owner_user_id !== id);
        sel.innerHTML = dep.length
          ? dep.map((w) => `<option value="${w.id}">${esc(w.label || w.address.slice(0, 10))} — ${esc(shortAddr(w.address))}${w.owner_user_id ? " (currently owned)" : " (unassigned)"}</option>`).join("")
          : `<option value="">No other deposit wallets available</option>`;
      }).catch(() => { sel.innerHTML = `<option value="">Could not load wallets</option>`; });
      const mb = $("#cMapBtn");
      if (mb) mb.onclick = () => { const wid = sel.value; if (!wid) return toast("Choose a deposit wallet", true); act(() => api(`/wallets/${wid}/assign`, { method: "POST", body: { owner_user_id: id } }), "Deposit address mapped", () => openCustomer(id)); };
    }

    const cimp = $("#cimpBtn");
    if (cimp) cimp.onclick = () => {
      const private_key = $("#cimpKey").value.trim();
      if (!private_key) return toast("Enter a private key", true);
      act(() => api("/wallets/import", { method: "POST", body: { private_key, wtype: "deposit", owner_user_id: id, label: $("#cimpLabel").value.trim() } }), "Wallet imported", () => openCustomer(id));
    };

    if (c.customer_type === "remittance") {
      document.querySelectorAll(".wl-del").forEach(b => b.onclick = () =>
        act(() => api("/customers/" + id + "/whitelist/" + b.dataset.wid, { method:"DELETE" }), "Address removed", () => openCustomer(id)));
      const add = $("#wlAdd");
      if (add) add.onclick = () => { const address = $("#wlAddr").value.trim(); if (!address) return toast("Enter an address", true);
        act(() => api("/customers/" + id + "/whitelist", { method:"POST", body:{ address, label: $("#wlLabel").value.trim() } }), "Address whitelisted", () => openCustomer(id)); };
      const send = $("#poSend");
      if (send) send.onclick = () => { const amt = parseFloat($("#poAmt").value); if (!(amt > 0)) return toast("Enter a valid amount", true);
        withBusy(send, "Sending…", async () => { try { const r = await api("/disbursements", { method:"POST", body:{ customer_id: id, amount: amt, to_address: $("#poAddr").value, reason: $("#poReason").value.trim() } }); toast(r.tx_hash ? "Payout sent — confirming…" : "Payout created — pending admin approval"); openCustomer(id); } catch (e) { toast(e.message, true); } }); };
    }
    document.querySelectorAll(".as-del").forEach(b => b.onclick = () =>
      act(() => api("/customers/" + id + "/staff/" + b.dataset.sid, { method:"DELETE" }), "Staff unassigned", () => openCustomer(id)));
    const asAdd = $("#asAdd");
    if (asAdd) asAdd.onclick = () => { const sid = $("#asSel").value; if (!sid) return; act(() => api("/customers/" + id + "/staff", { method:"POST", body:{ staff_id: Number(sid) } }), "Staff assigned", () => openCustomer(id)); };
    const cuMsg = $("#cuMsg"); if (cuMsg) cuMsg.onclick = () => openThread(id, "Messages · " + c.username, { phone: c.phone || null });
  }catch(e){ d.innerHTML = emptyState(e.message); }
}

/* ---------- customer portal (read-only) ---------- */
async function renderCustomerDashboard(){
  const sec = $("#sec-dashboard");
  sec.innerHTML = `<div class="page-head"><h1>Overview</h1><p>Your account summary.</p></div><div id="cdBody">Loading…</div>`;
  try{
    const d = await api("/customer/dashboard"); setNetwork(d.network);
    if (d.customer_type === "depositor"){
      $("#cdBody").innerHTML = `<div class="readouts"><div class="readout"><div class="label">Total received</div>
        <div class="value lead num">${fmtUsdt(d.total_received)}<span class="unit">USDT</span></div>
        <div class="foot">${d.deposit_addresses.length} deposit address${d.deposit_addresses.length === 1 ? "" : "es"}</div></div></div>
        ${depositsPanel(d.recent, "Recent deposits")}`;
    } else {
      $("#cdBody").innerHTML = `<div class="readouts"><div class="readout"><div class="label">Total received</div>
        <div class="value lead num">${fmtUsdt(d.total_received)}<span class="unit">USDT</span></div>
        <div class="foot">${d.whitelist.length} whitelisted address${d.whitelist.length === 1 ? "" : "es"}</div></div></div>
        ${transfersPanel(d.recent, "Recent transfers")}`;
    }
  }catch(e){ $("#cdBody").innerHTML = emptyState(e.message); }
}
async function renderCustomerAssets(){
  const sec = $("#sec-wallets");
  try{
    const me = await api("/customer/me");
    if (me.customer_type === "depositor"){
      sec.innerHTML = `<div class="page-head"><h1>Your deposit address</h1><p>Send TRC-20 USDT here. Deposits are credited automatically.</p></div>
        ${me.deposit_addresses.map(w => receiveCard({ name: state.user.username, walletLabel: w.label, address: w.address })).join("") || emptyState("No deposit address assigned yet.")}`;
      await mountReceiveCards(sec);
    } else {
      sec.innerHTML = `<div class="page-head"><h1>Your whitelisted addresses</h1><p>Payouts can only be sent to these approved addresses. Contact support to change them.</p></div>
        <div class="panel"><div class="panel-body flush">${me.whitelist.length ? `<table><thead><tr><th>Address</th><th>Label</th></tr></thead><tbody>
        ${me.whitelist.map(w => `<tr><td>${addrHtml(w.address)}</td><td>${esc(w.label||"—")}</td></tr>`).join("")}</tbody></table>` : emptyState("No whitelisted addresses yet.")}</div></div>`;
    }
  }catch(e){ sec.innerHTML = emptyState(e.message); }
}
async function renderCustomerHistory(){
  const sec = $("#sec-payouts");
  try{
    if (state.user.customer_type === "depositor"){
      sec.innerHTML = `<div class="page-head"><h1>Deposits</h1><p>Funds received at your deposit address.</p></div>${depositsPanel(await api("/customer/deposits"), "All deposits")}`;
    } else {
      sec.innerHTML = `<div class="page-head"><h1>Transfers</h1><p>USDT we have sent to your whitelisted address.</p></div>${transfersPanel(await api("/customer/transfers"), "All transfers")}`;
    }
  }catch(e){ sec.innerHTML = emptyState(e.message); }
}
function depositsPanel(rows, title){
  const body = (rows||[]).map(m => `<tr>
    <td>${esc((m.created_at||"").replace("T"," ").slice(0,16))}</td>
    <td>${addrHtml(m.from_address)}</td>
    <td class="amt num">${fmtUsdt(m.amount)} ${esc(m.token)}</td>
    <td>${statusBadge(m.status)}</td>
    <td class="row-actions"><button class="btn btn-ghost btn-sm" data-receipt="${m.id}">Receipt</button></td></tr>`).join("");
  return `<div class="panel"><div class="panel-head"><h2>${esc(title)}</h2></div><div class="panel-body flush">
    ${body ? `<table><thead><tr><th>Date (UTC)</th><th>From</th><th class="amt">Amount</th><th>Energy</th><th>Status</th><th></th></tr></thead><tbody>${body}</tbody></table>` : emptyState("No deposits yet.")}</div></div>`;
}
function transfersPanel(rows, title){
  const body = (rows||[]).map(r => `<tr>
    <td>${esc((r.created_at||"").replace("T"," ").slice(0,16))}</td>
    <td>${addrHtml(r.to_address)}</td>
    <td class="amt num">${fmtUsdt(r.amount)} USDT</td>
    <td>${statusBadge(r.status)}</td>
    <td class="row-actions">${r.tx_hash ? `<button class="btn btn-ghost btn-sm" data-receipt-tx="${esc(r.tx_hash)}">Receipt</button>` : "—"}</td></tr>`).join("");
  return `<div class="panel"><div class="panel-head"><h2>${esc(title)}</h2></div><div class="panel-body flush">
    ${body ? `<table><thead><tr><th>Date (UTC)</th><th>To</th><th class="amt">Amount</th><th>Energy</th><th>Status</th><th></th></tr></thead><tbody>${body}</tbody></table>` : emptyState("No transfers yet.")}</div></div>`;
}

/* ---------- CSV export helper ---------- */
async function downloadCsv(path, filename){
  try{
    const res = await fetch(path, { headers: { Authorization: "Bearer " + state.token } });
    if (!res.ok) throw new Error("export failed (" + res.status + ")");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Export downloaded");
  }catch(e){ toast(e.message, true); }
}

/* ---------- inline SVG bar chart (deposits vs payouts) ---------- */
function barChartSVG(series){
  const w = 720, h = 210, pad = 30;
  const n = Math.max(1, series.length);
  const slot = (w - pad * 2) / n;
  const bw = Math.max(3, Math.min(14, slot / 2.6));
  const max = Math.max(1, ...series.map(d => Math.max(d.deposits, d.payouts)));
  const x = (i) => pad + (i + 0.5) * slot;
  const y = (v) => h - pad - (v / max) * (h - pad * 2);
  let bars = "", labels = "";
  const step = Math.ceil(n / 7);
  series.forEach((d, i) => {
    const cx = x(i);
    bars += `<rect x="${(cx - bw - 1).toFixed(1)}" y="${y(d.deposits).toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad - y(d.deposits)).toFixed(1)}" rx="2" fill="var(--accent)"></rect>`;
    bars += `<rect x="${(cx + 1).toFixed(1)}" y="${y(d.payouts).toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad - y(d.payouts)).toFixed(1)}" rx="2" fill="var(--warn)"></rect>`;
    if (i % step === 0) labels += `<text x="${cx.toFixed(1)}" y="${h - 8}" font-size="10" text-anchor="middle" fill="var(--faint)">${esc(d.date.slice(5))}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block;overflow:visible">
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--line)"></line>${bars}${labels}</svg>`;
}

/* ---------- reveal / export private key (admin) ---------- */
async function showSecret(id){
  try{
    const s = await api("/wallets/" + id + "/secret");
    confirmModal({ title:"Private key", okLabel:"Done", okClass:"btn-accent",
      bodyHtml:`<div class="live-note">Anyone with this key controls this wallet's funds. Never share it; close this when you're done.</div>
        <div class="field" style="margin-top:12px"><label>Address</label><div class="recv-addr">${esc(s.address)}</div></div>
        <div class="field"><label>Private key (import into any TRON wallet)</label>
          <div class="recv-addr" style="user-select:all">${esc(s.private_key)}</div>
          <div class="form-actions" style="margin-top:8px"><button class="btn btn-ghost btn-sm" data-copy="${esc(s.private_key)}">Copy key</button></div></div>` });
  }catch(e){ toast(e.message, true); }
}

/* ---------- reports (admin) ---------- */
async function renderReports(){
  const sec = $("#sec-reports");
  sec.innerHTML = `<div class="page-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
    <div><h1>Reports</h1><p>Volumes, trends, and breakdowns.</p></div>
    <button id="repExport" class="btn btn-ghost btn-sm">Export transactions CSV</button></div><div id="repBody">Loading…</div>`;
  { const ex = $("#repExport"); if (ex) ex.onclick = () => downloadCsv("/transactions.csv", "transactions.csv"); }
  try{
    const r = await api("/reports/summary?days=14");
    sec.querySelector("#repBody").innerHTML = `
      <div class="readouts">
        <div class="readout"><div class="label">Deposits (total)</div><div class="value lead num">${fmtUsdt(r.deposits.volume)}<span class="unit">USDT</span></div><div class="foot">${r.deposits.count} deposits</div></div>
        <div class="readout"><div class="label">Payouts (total)</div><div class="value num">${fmtUsdt(r.payouts.volume)}<span class="unit">USDT</span></div><div class="foot">${r.payouts.count} payouts</div></div>
        <div class="readout"><div class="label">Pending approvals</div><div class="value num">${r.counts.pending_approvals}</div><div class="foot">${r.counts.customers} customers · ${r.counts.staff} staff</div></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Deposits vs payouts — last ${r.days} days</h2>
        <div style="font-size:12px;color:var(--muted)"><span style="color:var(--accent-ink)">■</span> deposits &nbsp; <span style="color:var(--warn)">■</span> payouts</div></div>
        <div class="panel-body">${barChartSVG(r.series)}</div></div>
      <div class="panel"><div class="panel-head"><h2>Top customers by received</h2></div><div class="panel-body flush">
        ${r.top_customers.length ? `<table><thead><tr><th>Customer</th><th class="amt">Received (USDT)</th><th class="amt">Transfers</th></tr></thead><tbody>${r.top_customers.map(c => `<tr><td>${esc(c.username)}</td><td class="amt num">${fmtUsdt(c.v)}</td><td class="amt num">${c.c}</td></tr>`).join("")}</tbody></table>` : emptyState("No customer payouts yet.")}</div></div>
      <div class="panel"><div class="panel-head"><h2>Payout volume by user</h2></div><div class="panel-body flush">
        ${r.by_staff.length ? `<table><thead><tr><th>User</th><th class="amt">Paid out (USDT)</th><th class="amt">Payouts</th></tr></thead><tbody>${r.by_staff.map(s => `<tr><td>${esc(s.username)}</td><td class="amt num">${fmtUsdt(s.v)}</td><td class="amt num">${s.c}</td></tr>`).join("")}</tbody></table>` : emptyState("No payouts yet.")}</div></div>`;
  }catch(e){ sec.querySelector("#repBody").innerHTML = emptyState(e.message); }
}

/* ---------- wallet naming ---------- */
async function showProof(id){
  try {
    const r = await api("/wallets/" + id + "/ownership-proof", { method: "POST", body: { project: (state.branding && state.branding.app_name) || "KryvonWallet" } });
    await confirmModal({ title: "Tronscan ownership proof", okLabel: "Done", okClass: "btn-primary",
      bodyHtml: `<div class="hint" style="margin-bottom:10px">Submit these at <b>tronscan.org \u2192 Contact Us \u2192 Submit Tag</b> to request a public name tag for this address.</div>
        <div class="field"><label>Address</label><div class="recv-addr">${esc(r.address)}</div></div>
        <div class="field"><label>Message</label><div class="recv-addr">${esc(r.message)}</div><div class="form-actions" style="margin-top:6px"><button class="btn btn-ghost btn-sm" data-copy="${esc(r.message)}">Copy message</button></div></div>
        <div class="field"><label>Signature</label><div class="recv-addr" style="user-select:all;word-break:break-all">${esc(r.signature)}</div><div class="form-actions" style="margin-top:6px"><button class="btn btn-ghost btn-sm" data-copy="${esc(r.signature)}">Copy signature</button></div></div>` });
  } catch (e) { toast(e.message, true); }
}
async function openWalletName(id, label){
  const ok = await confirmModal({ title:"Wallet name", okLabel:"Save",
    bodyHtml:`<div class="field"><label>Display name (shown in this app)</label><input id="wnName" class="input" value="${esc(label || "")}"></div>
      <label style="display:inline-flex;align-items:center;gap:8px;font-weight:400;cursor:pointer"><input type="checkbox" id="wnChain"> Also write this name on-chain (permanent, one-time, costs a little TRX)</label>
      <div class="hint" style="margin-top:8px">On-chain names can be set only once and can't be changed. Tronscan's public label is curated by Tronscan, so a self-set name may not appear there.</div>` });
  if (!ok) return;
  const name = ((document.getElementById("wnName") || {}).value || "").trim();
  const onChain = (document.getElementById("wnChain") || {}).checked;
  try{
    await api("/wallets/" + id + "/name", {method:"POST", body:{ name }});
    if (onChain && name) { await api("/wallets/" + id + "/onchain-name", {method:"POST", body:{ name }}); toast("Name saved + written on-chain"); }
    else toast("Name saved");
    renderWallets();
  }catch(e){ toast(e.message, true); }
}

/* ---------- backup & restore (admin) ---------- */
function parseCsv(text){
  const rows = []; let i = 0, field = "", row = [], q = false;
  while (i < text.length) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; } field += ch; i++; continue; }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && r.some((c) => c !== ""));
}
function csvToWallets(text){
  const rows = parseCsv(text); if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (names) => { for (const n of names) { const k = header.indexOf(n); if (k >= 0) return k; } return -1; };
  const iType = idx(["type", "wtype"]), iLabel = idx(["label", "name"]), iAddr = idx(["address"]),
        iKey = idx(["private_key", "privatekey", "key", "privkey"]), iOwner = idx(["owner", "owner_username", "customer"]);
  return rows.slice(1).map((r) => ({
    type: iType >= 0 ? (r[iType] || "").trim() : "",
    label: iLabel >= 0 ? (r[iLabel] || "").trim() : "",
    address: iAddr >= 0 ? (r[iAddr] || "").trim() : "",
    private_key: iKey >= 0 ? (r[iKey] || "").trim() : "",
    owner: iOwner >= 0 ? (r[iOwner] || "").trim() : "",
  }));
}
function csvToMovements(text){
  const rows = parseCsv(text); if (!rows.length) return [];
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const gi = (...names) => { for (const n of names) { const k = h.indexOf(n); if (k >= 0) return k; } return -1; };
  const iKind = gi("kind"), iTok = gi("token"), iFrom = gi("from_address", "from"), iTo = gi("to_address", "to"),
        iAmt = gi("amount"), iRate = gi("usd_rate", "rate"), iStat = gi("status"), iTx = gi("tx_hash", "tx", "txid"),
        iBy = gi("initiated_by", "user"), iNote = gi("note"), iAt = gi("created_at", "date", "time");
  const v = (r, i) => (i >= 0 ? (r[i] || "").trim() : "");
  return rows.slice(1).map((r) => ({
    kind: v(r, iKind), token: v(r, iTok), from_address: v(r, iFrom), to_address: v(r, iTo), amount: v(r, iAmt),
    usd_rate: v(r, iRate), status: v(r, iStat), tx_hash: v(r, iTx), initiated_by: v(r, iBy), note: v(r, iNote), created_at: v(r, iAt),
  }));
}
async function renderBackup(){
  const sec = $("#sec-backup");
  sec.innerHTML = `<div class="page-head"><h1>Backup &amp; restore</h1><p>Export or import every wallet — address, label, type, and private key.</p></div>
    <div class="panel"><div class="panel-head"><h2>Export all wallets</h2></div><div class="panel-body">
      <div class="live-note">The export file contains <b>private keys for every wallet</b> (treasury, gas, pool, and customer). Anyone who has it controls all funds — store it encrypted and offline.</div>
      <div class="form-actions" style="margin-top:12px"><button class="btn btn-primary" id="bkExport">Download JSON</button><button class="btn btn-ghost" id="bkExportCsv">Download CSV</button></div>
    </div></div>
    <div class="panel"><div class="panel-head"><h2>Import wallets</h2></div><div class="panel-body">
      <div class="field"><label>Backup file (.json or .csv)</label><input type="file" id="bkFile" accept=".json,.csv,application/json,text/csv" class="input"></div>
      <div class="field"><label>…or paste JSON / CSV</label><textarea id="bkPaste" class="input" rows="6" placeholder='type,label,address,owner,private_key
pool,pool-1,T...,,abc123...'></textarea></div>
      <button class="btn btn-primary" id="bkImport">Import wallets</button>
      <div id="bkResult" class="hint" style="margin-top:10px"></div>
      <div class="hint">Wallets that already exist (same address) and a second treasury are skipped. Imported wallets aren't pre-funded — they already hold their on-chain balances.</div>
    </div></div>

    <div class="panel"><div class="panel-head"><h2>Full backup <span class="role-pill">customers + wallets + transactions</span></h2></div><div class="panel-body">
      <div class="live-note">A complete snapshot: <b>customers</b> (with whitelists, staff assignments and login), <b>staff</b>, <b>all wallets with private keys</b>, and the <b>transaction history</b>. Restore re-creates missing customers and <b>maps their wallets correctly</b>. Store it encrypted and offline.</div>
      <div class="form-actions" style="margin-top:12px"><button class="btn btn-primary" id="fbExport">Download full backup (JSON)</button></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
      <div class="field"><label>Restore from full backup (.json)</label><input type="file" id="fbFile" accept=".json,application/json" class="input"></div>
      <button class="btn btn-primary" id="fbImport">Restore full backup</button>
      <div id="fbResult" class="hint" style="margin-top:10px"></div>
      <div class="hint">Existing customers, wallets and transactions are detected and skipped (no duplicates). Customers are created first so their wallets link by username.</div>
    </div></div>`;
  $("#fbExport").onclick = () => downloadCsv("/backup/export", "kryvonwallet-full-backup.json");
  $("#fbImport").onclick = async () => {
    const f = $("#fbFile").files && $("#fbFile").files[0];
    if (!f) return toast("Choose a full-backup .json file", true);
    let data; try { data = JSON.parse(await f.text()); } catch (e) { return toast("Invalid JSON file", true); }
    const btn = $("#fbImport");
    await withBusy(btn, "Restoring…", async () => {
      try {
        const r = await api("/backup/import", { method: "POST", body: data });
        $("#fbResult").textContent = `Restored — customers ${r.customers}, staff ${r.staff}, wallets ${r.wallets}, transactions ${r.transactions}, assignments ${r.assignments}, whitelist ${r.whitelist}; skipped ${r.skipped}${r.errors && r.errors.length ? `, errors ${r.errors.length}` : ""}.`;
        toast("Full backup restored");
      } catch (e) { toast(e.message, true); }
    });
  };
  $("#bkExport").onclick = () => downloadCsv("/wallets/export", "kryvonwallet-wallets-backup.json");
  $("#bkExportCsv").onclick = () => downloadCsv("/wallets/export.csv", "kryvonwallet-wallets-backup.csv");
  $("#bkImport").onclick = async () => {
    let text = $("#bkPaste").value.trim();
    const f = $("#bkFile").files && $("#bkFile").files[0];
    if (!text && f) { try { text = await f.text(); } catch (e) { return toast("Could not read file", true); } }
    if (!text) return toast("Choose a file or paste JSON/CSV", true);
    let wallets;
    const looksCsv = (f && /\.csv$/i.test(f.name)) || (!/^\s*[\[{]/.test(text) && /address/i.test(text.split(/\r?\n/)[0] || ""));
    try {
      if (looksCsv) wallets = csvToWallets(text);
      else { const data = JSON.parse(text); wallets = Array.isArray(data) ? data : (data.wallets || []); }
    } catch (e) { return toast("Could not parse the file (expected JSON or CSV)", true); }
    if (!wallets || !wallets.length) return toast("No wallets found in the file", true);
    try {
      const r = await api("/wallets/import-bulk", { method: "POST", body: { wallets } });
      $("#bkResult").textContent = `Imported ${r.imported}, skipped ${r.skipped}${r.errors && r.errors.length ? `, errors: ${r.errors.length}` : ""}.`;
      toast("Import complete");
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- API keys (admin) ---------- */
async function renderApiKeys(){
  const sec = $("#sec-apikeys");
  sec.innerHTML = `<div class="page-head"><h1>API keys</h1><p>Programmatic access for your own systems. A key is shown once — store it securely.</p></div><div id="akBody">Loading…</div>`;
  try{
    const list = await api("/apikeys");
    const rows = list.map(k => `<tr>
      <td>${esc(k.name||"—")}</td><td class="mono">${esc(k.prefix)}…</td>
      <td>${k.scopes.map(s => `<span class="role-pill">${esc(s)}</span>`).join(" ")}</td>
      <td>${k.last_used ? esc(k.last_used.replace("T"," ").slice(0,16)) : "—"}</td>
      <td>${k.is_active ? `<span class="badge b-confirmed"><span class="dot"></span>active</span>` : `<span class="badge b-failed"><span class="dot"></span>revoked</span>`}</td>
      <td class="row-actions">${k.is_active ? `<button class="btn btn-ghost btn-sm ak-revoke" data-id="${k.id}">Revoke</button>` : "—"}</td></tr>`).join("");
    $("#akBody").innerHTML = `
      <div class="panel"><div class="panel-head"><h2>Create key</h2></div><div class="panel-body">
        <div class="field"><label>Name / label</label><input id="akName" class="input" placeholder="e.g. DMT backend"></div>
        <div class="field"><label>Scopes</label><div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:4px">
          <label style="display:inline-flex;align-items:center;gap:7px;font-weight:400"><input type="checkbox" class="ak-scope" value="read" checked> read</label>
          <label style="display:inline-flex;align-items:center;gap:7px;font-weight:400"><input type="checkbox" class="ak-scope" value="deposits"> deposits</label>
          <label style="display:inline-flex;align-items:center;gap:7px;font-weight:400"><input type="checkbox" class="ak-scope" value="payouts"> payouts</label>
        </div></div>
        <button class="btn btn-primary" id="akCreate">Create key</button></div></div>
      <div class="panel"><div class="panel-head"><h2>Keys <span class="cnt">${list.length}</span></h2></div>
        <div class="panel-body flush">${rows ? `<div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("No API keys yet.")}</div></div>
      <div class="panel"><div class="panel-head"><h2>Using the API</h2></div><div class="panel-body">
        <div class="recv-addr">curl -H "X-API-Key: YOUR_KEY" ${esc(location.origin)}/api/v1/ping</div>
        <div class="hint" style="margin-top:8px">Endpoints: <span class="mono">GET /api/v1/ping</span> · <span class="mono">GET /api/v1/wallets/:address/balance</span> · <span class="mono">POST /api/v1/deposit-wallets</span> · <span class="mono">POST /api/v1/payouts</span> (accepts <span class="mono">idempotency_key</span>) · <span class="mono">GET /api/v1/transactions</span>.</div>
      </div></div>`;
    $("#akCreate").onclick = () => {
      const name = $("#akName").value.trim();
      const scopes = Array.from(document.querySelectorAll(".ak-scope:checked")).map(c => c.value);
      if (!scopes.length) return toast("Select at least one scope", true);
      api("/apikeys", {method:"POST", body:{ name, scopes }})
        .then(r => { showApiKeyOnce(r.key, r.scopes); renderApiKeys(); })
        .catch(e => toast(e.message, true));
    };
    document.querySelectorAll(".ak-revoke").forEach(b => b.onclick = () =>
      act(() => api("/apikeys/" + b.dataset.id + "/revoke", {method:"POST"}), "Key revoked", renderApiKeys));
  }catch(e){ $("#akBody").innerHTML = emptyState(e.message); }
}
function showApiKeyOnce(key, scopes){
  confirmModal({ title:"Your new API key", okLabel:"Done", okClass:"btn-accent",
    bodyHtml:`<p style="margin:0 0 10px;font-size:13.5px;color:var(--muted)">Copy this now — it won't be shown again. Scopes: ${(scopes||[]).map(esc).join(", ")}</p>
      <div class="recv-addr" style="user-select:all">${esc(key)}</div>
      <div class="form-actions" style="margin-top:10px"><button class="btn btn-ghost btn-sm" data-copy="${esc(key)}">Copy key</button></div>` });
}

/* ---------- transactions (admin: all + filter by user; staff: own) ---------- */
let txFilterUser = null, txFrom = "", txTo = "", txAddr = "", txKind = "", txStatus = "", txSearch = "", txOrder = "desc", txPage = 1, txPageSize = 50;
function openUserTx(id){ txFilterUser = String(id); route("transactions"); }
async function renderTransactions(){
  const sec = $("#sec-transactions");
  const isAdmin = state.user.role === "admin";
  sec.innerHTML = `<div class="page-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
    <div><h1>Transactions</h1><p>${isAdmin ? "Full ledger — filter, search, paginate and export." : "History of movements you initiated."}</p></div>
    ${isAdmin ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
      <button id="txExport" class="btn btn-ghost btn-sm">Export CSV</button>
      <button id="txExportJson" class="btn btn-ghost btn-sm">Export JSON</button>
      <button id="txImport" class="btn btn-ghost btn-sm">Import</button>
      <input type="file" id="txImportFile" accept=".json,.csv,application/json,text/csv" style="display:none">
    </div>` : ""}</div><div id="txBody">Loading…</div>`;
  const qsFilters = () => { const q = [];
    if (txSearch) q.push("q=" + encodeURIComponent(txSearch));
    if (txAddr) q.push("address=" + encodeURIComponent(txAddr));
    if (txFilterUser) q.push("user_id=" + encodeURIComponent(txFilterUser));
    if (txKind) q.push("kind=" + encodeURIComponent(txKind));
    if (txStatus) q.push("status=" + encodeURIComponent(txStatus));
    if (txFrom) q.push("from=" + txFrom);
    if (txTo) q.push("to=" + txTo);
    if (txOrder === "asc") q.push("order=asc");
    return q; };
  if (isAdmin) {
    const exportQs = () => { const q = qsFilters(); return q.length ? "?" + q.join("&") : ""; };
    $("#txExport").onclick = () => downloadCsv("/transactions.csv" + exportQs(), "transactions.csv");
    $("#txExportJson").onclick = () => downloadCsv("/transactions.json" + exportQs(), "transactions.json");
    const f = $("#txImportFile");
    $("#txImport").onclick = () => f.click();
    f.onchange = async () => {
      const file = f.files && f.files[0]; if (!file) return;
      let text; try { text = await file.text(); } catch { f.value = ""; return toast("Could not read file", true); }
      let transactions;
      const looksCsv = /\.csv$/i.test(file.name) || (!/^\s*[\[{]/.test(text) && /kind|amount|tx_hash/i.test(text.split(/\r?\n/)[0] || ""));
      try { if (looksCsv) transactions = csvToMovements(text); else { const d = JSON.parse(text); transactions = Array.isArray(d) ? d : (d.transactions || []); } }
      catch (e) { f.value = ""; return toast("Could not parse the file (expected JSON or CSV)", true); }
      if (!transactions || !transactions.length) { f.value = ""; return toast("No transactions found in the file", true); }
      try { const r = await api("/transactions/import", { method: "POST", body: { transactions } }); toast(`Imported ${r.imported}, skipped ${r.skipped}`); renderTransactions(); }
      catch (e) { toast(e.message, true); }
      f.value = "";
    };
  }
  try {
    let users = [], customers = [], walletsList = [];
    if (isAdmin) { users = await api("/users"); try { customers = await api("/customers"); } catch (e) {} try { walletsList = await api("/wallets"); } catch (e) {} }

    if (!isAdmin) {
      let rows = []; const PAGE = 100;
      async function loadMore() {
        const q = ["limit=" + PAGE]; if (rows.length) q.push("before=" + rows[rows.length - 1].id);
        const page = await api("/transactions?" + q.join("&"));
        rows = rows.concat(page); const more = page.length === PAGE;
        $("#txBody").innerHTML = txTable(rows, false) + (more ? `<div style="text-align:center;margin-top:12px"><button id="txMore" class="btn btn-ghost btn-sm">Load older</button></div>` : (rows.length ? `<div class="hint" style="text-align:center;margin-top:10px">End of history — ${rows.length} shown</div>` : ""));
        const mb = $("#txMore"); if (mb) mb.onclick = () => withBusy(mb, "Loading…", loadMore);
      }
      await loadMore(); return;
    }

    const kinds = [["","All types"],["deposit_in","Deposit"],["disburse_out","Payout"],["treasury_out","Treasury send"],["sweep","Sweep"],["topup","Top-up"],["gas_fund","Gas"],["gas_swap","Gas swap"]];
    const filter = `<div class="panel"><div class="panel-body">
      <div class="form-grid">
        <div class="field" style="margin:0"><label>User</label><select id="txUser" class="input"><option value="">Everyone</option>
          <optgroup label="Staff / admin">${users.map(u => `<option value="${u.id}"${String(txFilterUser)===String(u.id)?" selected":""}>${esc(u.username)} (${esc(u.role)})</option>`).join("")}</optgroup>
          ${customers.length ? `<optgroup label="Customers">${customers.map(c => `<option value="${c.id}"${String(txFilterUser)===String(c.id)?" selected":""}>${esc(c.username)}</option>`).join("")}</optgroup>` : ""}
        </select></div>
        <div class="field" style="margin:0"><label>Type</label><select id="txKind" class="input">${kinds.map(k => `<option value="${k[0]}"${txKind===k[0]?" selected":""}>${k[1]}</option>`).join("")}</select></div>
        <div class="field" style="margin:0"><label>Status</label><select id="txStatus" class="input">${[["","Any"],["confirmed","Confirmed"],["pending","Pending"],["failed","Failed"]].map(s => `<option value="${s[0]}"${txStatus===s[0]?" selected":""}>${s[1]}</option>`).join("")}</select></div>
      </div>
      <div class="form-grid" style="margin-top:10px">
        <div class="field" style="margin:0"><label>From (date)</label><input id="txFrom" type="date" class="input" value="${txFrom}"></div>
        <div class="field" style="margin:0"><label>To (date)</label><input id="txTo" type="date" class="input" value="${txTo}"></div>
        <div class="field" style="margin:0"><label>Sort</label><select id="txOrder" class="input"><option value="desc"${txOrder==="desc"?" selected":""}>Newest first</option><option value="asc"${txOrder==="asc"?" selected":""}>Oldest first</option></select></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Search (tx hash or address)</label><input id="txSearch" class="input mono" placeholder="tx hash / T-address…" value="${esc(txSearch)}"></div>
      <div class="form-actions" style="margin-top:10px"><button id="txApply" class="btn btn-primary btn-sm">Apply filters</button><button id="txClear" class="btn btn-ghost btn-sm">Clear</button><span class="hint">All history is kept — filter by any range, type, status, user or address.</span></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
      <div class="hint" style="margin-bottom:8px"><b>Reconcile from chain (Tronscan/TronGrid)</b> — pull on-chain history and backfill anything missing.</div>
      <div class="field" style="margin:0"><label>Address (external beneficiary, or one of your wallets)</label><input id="txAddr" class="input mono" placeholder="T…" value="${esc(txAddr)}"></div>
      <div class="form-actions" style="margin-top:8px;flex-wrap:wrap">
        <button id="txAddrGo" class="btn btn-ghost btn-sm">Search this address</button>
        <button id="rcToGo" class="btn btn-ghost btn-sm">Save payouts to address</button>
        <select id="rcWallet" class="input" style="max-width:260px"><optgroup label="Deposit (fetch deposits)">${walletsList.filter(w=>w.wtype==="deposit").map(w=>`<option value="${esc(w.address)}">${esc(w.label||("deposit "+w.id))}</option>`).join("")}</optgroup><optgroup label="Pool / treasury (fetch payouts)">${walletsList.filter(w=>w.wtype==="disbursement"||w.wtype==="treasury").map(w=>`<option value="${esc(w.address)}">${esc(w.wtype)} ${w.id}</option>`).join("")}</optgroup></select>
        <button id="rcWalletGo" class="btn btn-ghost btn-sm">Reconcile wallet</button>
        <button id="rcAll" class="btn btn-ghost btn-sm">Reconcile all</button>
      </div>
    </div></div>`;
    $("#txBody").innerHTML = filter + `<div id="txSummary"></div><div id="txList">Loading…</div><div id="txPager"></div>`;

    async function loadPage() {
      const q = qsFilters(); q.push("page=" + txPage); q.push("page_size=" + txPageSize);
      let d; try { d = await api("/transactions/query?" + q.join("&")); } catch (e) { $("#txList").innerHTML = emptyState(e.message); return; }
      txPage = d.page;
      const net = d.volume_in - d.volume_out;
      $("#txSummary").innerHTML = `<div class="stat-row" style="margin-bottom:14px">
        <div class="s"><div class="n num">${d.total.toLocaleString()}</div><div class="l">Transactions (filter)</div></div>
        <div class="s"><div class="n num">${fmtUsdt(d.volume_in)}</div><div class="l">Volume in (USDT)</div></div>
        <div class="s"><div class="n num">${fmtUsdt(d.volume_out)}</div><div class="l">Volume out (USDT)</div></div>
        <div class="s"><div class="n num">${fmtUsdt(net)}</div><div class="l">Net (USDT)</div></div>
        <div class="s"><div class="n num">${Number(d.energy_total||0).toLocaleString()}</div><div class="l">Energy used</div></div>
      </div>`;
      $("#txList").innerHTML = txTable(d.rows, true);
      const start = d.total === 0 ? 0 : ((d.page - 1) * d.page_size + 1);
      const end = Math.min(d.total, d.page * d.page_size);
      $("#txPager").innerHTML = `<div class="pager">
        <span class="hint">${start.toLocaleString()}–${end.toLocaleString()} of ${d.total.toLocaleString()}</span>
        <span class="pager-ctrls">
          <button class="btn btn-ghost btn-sm" data-pg="first" ${d.page<=1?"disabled":""}>« First</button>
          <button class="btn btn-ghost btn-sm" data-pg="prev" ${d.page<=1?"disabled":""}>‹ Prev</button>
          <span class="hint">Page <input id="txJump" class="input" type="number" min="1" max="${d.pages}" value="${d.page}" style="width:60px;display:inline-block;padding:4px 6px"> / ${d.pages}</span>
          <button class="btn btn-ghost btn-sm" data-pg="next" ${d.page>=d.pages?"disabled":""}>Next ›</button>
          <button class="btn btn-ghost btn-sm" data-pg="last" ${d.page>=d.pages?"disabled":""}>Last »</button>
          <select id="txSize" class="input" style="width:auto;display:inline-block">${[25,50,100,200].map(n=>`<option value="${n}"${txPageSize===n?" selected":""}>${n}/page</option>`).join("")}</select>
        </span></div>`;
      $("#txPager").querySelectorAll("[data-pg]").forEach(b => b.onclick = () => { const a = b.getAttribute("data-pg");
        if (a==="first") txPage=1; else if (a==="prev") txPage=Math.max(1,d.page-1); else if (a==="next") txPage=Math.min(d.pages,d.page+1); else if (a==="last") txPage=d.pages; loadPage(); });
      const jp = $("#txJump"); if (jp) jp.onchange = () => { txPage = Math.max(1, Math.min(d.pages, parseInt(jp.value,10)||1)); loadPage(); };
      const sz = $("#txSize"); if (sz) sz.onchange = () => { txPageSize = parseInt(sz.value,10)||50; txPage=1; loadPage(); };
    }
    const applyFilters = () => { txPage = 1; loadPage(); };
    $("#txUser").onchange = (e) => { txFilterUser = e.target.value || null; applyFilters(); };
    $("#txKind").onchange = (e) => { txKind = e.target.value || ""; applyFilters(); };
    $("#txStatus").onchange = (e) => { txStatus = e.target.value || ""; applyFilters(); };
    $("#txOrder").onchange = (e) => { txOrder = e.target.value || "desc"; applyFilters(); };
    $("#txApply").onclick = () => { txFrom = $("#txFrom").value || ""; txTo = $("#txTo").value || ""; txSearch = ($("#txSearch").value||"").trim(); applyFilters(); };
    $("#txClear").onclick = () => { txFilterUser=null; txKind=""; txStatus=""; txFrom=""; txTo=""; txSearch=""; txAddr=""; txOrder="desc"; txPage=1; renderTransactions(); };
    $("#txAddrGo").onclick = () => { txAddr = ($("#txAddr").value||"").trim(); applyFilters(); };
    const runRecon = async (btn, body, label) => withBusy(btn, "Reconciling…", async () => { try { const r = await api("/reconcile", { method: "POST", body }); toast(`${label} — scanned ${r.scanned}, added ${r.inserted}`); if (body.address && body.mode !== "payouts-to") txAddr = body.address; applyFilters(); } catch (e) { toast(e.message, true); } });
    $("#rcToGo").onclick = () => { const a = ($("#txAddr").value||"").trim(); if (!a) return toast("Enter an address", true); runRecon($("#rcToGo"), { mode:"payouts-to", address:a }, "Payouts check"); };
    $("#rcWalletGo").onclick = () => { const a = $("#rcWallet").value; if (!a) return toast("No wallet selected", true); runRecon($("#rcWalletGo"), { mode:"wallet", address:a }, "Wallet reconcile"); };
    $("#rcAll").onclick = async () => { const ok = await confirmModal({ title:"Reconcile all wallets", okLabel:"Reconcile all", bodyHtml:`<p style="margin:0;font-size:14px;color:var(--muted)">Pull on-chain history for every wallet and backfill anything missing. Safe to run repeatedly.</p>` }); if (ok) runRecon($("#rcAll"), { mode:"all" }, "Reconcile all"); };
    await loadPage();
  } catch (e) { $("#txBody").innerHTML = emptyState(e.message); }
}
function txTable(rows, showWho){
  const body = (rows||[]).map(m => `<tr>
    <td>${esc((m.created_at||"").replace("T"," ").slice(0,16))}</td>
    <td><span class="kind">${esc(KIND_LABEL[m.kind]||m.kind)}</span></td>
    <td>${addrHtml(m.from_address)}</td><td>${addrHtml(m.to_address)}</td>
    <td>${m.customer?`<span class="role-pill">${esc(m.customer)}</span>`:"—"}</td>
    <td class="amt num">${fmtUsdt(m.amount)} ${esc(m.token)}${m.amount_usd!=null?`<div class="r-sub">$${fmtUsdt(m.amount_usd)}</div>`:""}</td>
    <td class="num">${m.energy?Number(m.energy).toLocaleString():"—"}</td>
    <td>${statusBadge(m.status)}</td>
    ${showWho?`<td>${esc(m.initiated_by_name||"—")}</td>`:""}
    <td class="row-actions"><button class="btn btn-ghost btn-sm" data-receipt="${m.id}">Receipt</button></td></tr>`).join("");
  return `<div class="panel"><div class="panel-head"><h2>History <span class="cnt">${(rows||[]).length}</span></h2></div>
    <div class="panel-body flush">${body ? `<div class="tbl-wrap"><table><thead><tr><th>Date (UTC)</th><th>Type</th><th>From</th><th>To</th><th>Customer</th><th class="amt">Amount</th><th>Energy</th><th>Status</th>${showWho?"<th>By</th>":""}<th></th></tr></thead><tbody>${body}</tbody></table></div>` : emptyState("No transactions.")}</div></div>`;
}

/* ---------- address book (admin/staff) ---------- */
async function renderAddressBook(){
  const sec = $("#sec-addressbook");
  sec.innerHTML = `<div class="page-head"><h1>Address book</h1><p>Saved destination addresses with QR codes. Pick these when sending payouts.</p></div><div id="abBody">Loading…</div>`;
  try{
    const list = await api("/address-book");
    const rows = list.map(e => `<tr><td>${esc(e.label||"—")}</td><td>${addrHtml(e.address)}</td>
      <td class="row-actions"><button class="btn btn-ghost btn-sm" data-qr="${esc(e.address)}" data-qrlabel="${esc(e.label||"")}">QR</button>
      <button class="btn btn-ghost btn-sm ab-del" data-id="${e.id}">Remove</button></td></tr>`).join("");
    $("#abBody").innerHTML = `
      <div class="panel"><div class="panel-head"><h2>Add address</h2></div><div class="panel-body">
        <div class="form-grid"><div class="field"><label>Label</label><input id="abLabel" class="input" placeholder="e.g. Vendor A"></div>
        <div class="field"><label>Address (TRC-20)</label><input id="abAddr" class="input mono" placeholder="T…"></div></div>
        <button class="btn btn-primary" id="abAdd">Save address</button></div></div>
      <div class="panel"><div class="panel-head"><h2>Saved addresses <span class="cnt">${list.length}</span></h2></div>
        <div class="panel-body flush">${rows ? `<table><thead><tr><th>Label</th><th>Address</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : emptyState("No saved addresses yet.")}</div></div>`;
    $("#abAdd").onclick = () => { const address = $("#abAddr").value.trim(); if (!address) return toast("Enter an address", true);
      act(() => api("/address-book", {method:"POST", body:{ address, label: $("#abLabel").value.trim() }}), "Address saved", renderAddressBook); };
    document.querySelectorAll(".ab-del").forEach(b => b.onclick = () => act(() => api("/address-book/" + b.dataset.id, {method:"DELETE"}), "Removed", renderAddressBook));
  }catch(e){ $("#abBody").innerHTML = emptyState(e.message); }
}

/* ---------- settings (admin) ---------- */
let _brandPick = {};
function fileToDataUrl(file){ return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
function brandRow(label, id, key, cur){
  return `<div class="field"><label>${label}</label>
    <div class="form-actions">
      <span id="prev-${id}" style="display:inline-flex;width:40px;height:40px;border:1px solid var(--line);border-radius:8px;overflow:hidden;align-items:center;justify-content:center;background:var(--surface-2)">${cur ? `<img src="${cur}" style="width:100%;height:100%;object-fit:contain">` : '<span class="hint">none</span>'}</span>
      <input type="file" accept="image/*" class="input brand-file" data-key="${key}" data-prev="prev-${id}" style="max-width:260px">
      <button class="btn btn-ghost btn-sm brand-clear" data-key="${key}" data-prev="prev-${id}">Remove</button>
    </div></div>`;
}
async function renderSettings(){
  _brandPick = {};
  const sec = $("#sec-settings");
  sec.innerHTML = `<div class="page-head"><h1>Settings</h1><p>Operational configuration, keys, and policy.</p></div><div id="stBody">Loading…</div>`;
  try{
    const c = await api("/admin/config");
    $("#stBody").innerHTML = `
    <div class="tabbar" id="setTabs"><button data-tab="policy" class="active">Policy</button><button data-tab="network">Network &amp; keys</button><button data-tab="fees">Fees &amp; energy</button><button data-tab="branding">Branding</button><button data-tab="security">Security</button></div>
    <div class="tab-pane active" data-tab="policy">
    <div class="panel"><div class="panel-head"><h2>Payout &amp; deposit policy</h2></div><div class="panel-body">
      <div class="form-grid">
        <div class="field"><label>Default staff auto-approve limit (USDT)</label>
          <input id="cfgLimit" class="input" type="number" step="0.01" min="0" value="${esc(c.staff_auto_approve_limit)}">
          <div class="hint">Used for staff without their own limit (set per-staff on the Staff screen).</div></div>
        <div class="field"><label>Deposit fee (%)</label>
          <input id="cfgFee" class="input" type="number" step="0.01" min="0" max="100" value="${esc(c.deposit_fee_percent)}">
          <div class="hint">Shown on deposit receipts as fee + net credited.</div></div>
      </div>
      <div class="field"><label>Treasury hold-back on distribute (%)</label>
        <input id="cfgHold" class="input" type="number" step="1" min="0" max="100" value="${esc(c.treasury_hold_percent)}"></div>
    </div></div>

    </div>
    <div class="tab-pane" data-tab="network">
    <div class="panel"><div class="panel-head"><h2>Network &amp; keys</h2></div><div class="panel-body">
      <div class="form-grid">
        <div class="field"><label>Network</label><select id="cfgNet" class="input">
          <option value="mainnet"${c.tron_network==="mainnet"?" selected":""}>Mainnet (live funds)</option>
          <option value="nile"${c.tron_network==="nile"?" selected":""}>Nile testnet</option>
          <option value="shasta"${c.tron_network==="shasta"?" selected":""}>Shasta testnet</option></select></div>
        <div class="field"><label>TronGrid API key</label>
          <input id="cfgKey" class="input mono" placeholder="${c.has_trongrid_key?esc(c.trongrid_api_key_masked)+'  (leave blank to keep)':'required for mainnet'}">
          <div class="form-actions" style="margin-top:6px">${c.has_trongrid_key?`<button type="button" class="btn btn-ghost btn-sm" id="cfgKeyReveal">Reveal current key</button>`:""}</div>
          <div class="hint">Leave blank to keep the current key.</div></div>
      </div>
      <div class="field"><label>USDT contract (TRC-20)</label><input id="cfgContract" class="input mono" value="${esc(c.usdt_contract)}"></div>
      <div class="form-grid">
        <div class="field"><label>Min sweep (USDT)</label><input id="cfgSweep" class="input" type="number" step="0.01" min="0" value="${esc(c.sweep_min_usdt)}"></div>
        <div class="field"><label>Gas top-up (TRX)</label><input id="cfgGas" class="input" type="number" step="1" min="0" value="${esc(c.gas_fund_trx)}"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Pool float (USDT)</label><input id="cfgFloat" class="input" type="number" step="1" min="0" value="${esc(c.disbursement_float_usdt)}"></div>
        <div class="field"><label>Deposit scan interval (seconds)</label><input id="cfgPoll" class="input" type="number" step="1" min="5" value="${esc(c.poll_interval_seconds)}">
          <div class="hint">Takes effect on next restart.</div></div>
      </div>
      <div class="field"><label>Pre-load new wallets with (TRX)</label><input id="cfgPreload" class="input" type="number" step="1" min="0" value="${esc(c.wallet_preload_trx)}">
        <div class="hint">Sent from the gas wallet to each newly created wallet so it's activated and ready. 0 = off.</div></div>
    </div></div>

    <div class="panel"><div class="panel-head"><h2>Controls &amp; integrations</h2></div><div class="panel-body">
      <div class="form-grid">
        <div class="field"><label>Dual-control threshold (USDT)</label>
          <input id="cfgDual" class="input" type="number" step="0.01" min="0" value="${esc(c.dual_control_threshold)}">
          <div class="hint">Payouts at or above this need a second admin's approval. 0 = off.</div></div>
        <div class="field"><label>Webhook URL</label>
          <input id="cfgHook" class="input mono" value="${esc(c.webhook_url || "")}" placeholder="https://your-system/webhook">
          <div class="hint">POST on deposit.received and payout.sent.</div></div>
      </div>
      <div class="field"><label style="display:inline-flex;align-items:center;gap:8px;font-weight:400;cursor:pointer"><input type="checkbox" id="cfgAllow" ${c.payout_allowlist_only ? "checked" : ""}> Allow-list mode — pool payouts only to address-book / whitelisted addresses</label></div>
      <div class="field"><label style="display:inline-flex;align-items:center;gap:8px;font-weight:400;cursor:pointer"><input type="checkbox" id="cfgAuto" ${c.auto_distribute_enabled ? "checked" : ""}> Auto-distribute treasury surplus to the pool periodically</label></div>
    </div></div>

    </div>
    <div class="tab-pane" data-tab="fees">
    <div class="panel"><div class="panel-head"><h2>Gas &amp; energy</h2></div><div class="panel-body">
      <div class="hint" style="margin-bottom:10px">USDT (TRC-20) transfers cost <b>Energy</b>. Without energy, TRON burns TRX per transfer (expensive). Use staked or rented energy to cut fees dramatically.</div>
      <div class="field"><label>Fee strategy</label>
        <select id="cfgEnergyMode" class="input">
          <option value="auto"${(c.energy_mode||'auto')==='auto'?' selected':''}>Auto — gas-free (rent energy via API, else staked, else burn)</option>
          <option value="burn"${c.energy_mode==='burn'?' selected':''}>Burn TRX (simple, highest cost)</option>
          <option value="stake"${c.energy_mode==='stake'?' selected':''}>Self-staked energy (freeze TRX, delegate per send)</option>
          <option value="rental"${c.energy_mode==='rental'?' selected':''}>Rent energy from a provider</option>
        </select></div>
      <div class="field"><label>Delegate per send — TRX of staked balance (stake mode)</label><input id="cfgEnergyDelegate" class="input" type="number" min="0" step="1" value="${Number(c.energy_delegate_trx||0)}"><div class="hint">Enough frozen TRX to cover ~65,000 energy for one USDT transfer; tune on testnet for your network's energy price.</div></div>
      <div class="field"><label>Energy provider (auto / rental mode)</label>
        <select id="cfgEnergyProvider" class="input">
          <option value=""${(c.energy_provider||'')===''?' selected':''}>Generic rental URL (below)</option>
          <option value="tronzap"${c.energy_provider==='tronzap'?' selected':''}>TronZap (recommended — signed API)</option>
        </select>
        <div class="hint">TronZap: create an API token + secret at dash.tronzap.com and fund your TronZap balance. Energy is auto-rented (~65k) before each payout — fully gas-free. Can also be set via env TRONZAP_API_TOKEN / TRONZAP_API_SECRET.</div></div>
      <div class="field"><label>TronZap API token</label><input id="cfgTzToken" class="input" value="${esc(c.tronzap_api_token||'')}" placeholder="from dash.tronzap.com"></div>
      <div class="field"><label>TronZap API secret</label><input id="cfgTzSecret" class="input" value="${esc(c.tronzap_api_secret_masked||'')}" placeholder="${c.has_tronzap_secret?'saved — leave to keep':'from dash.tronzap.com'}"></div>
      <div class="field"><label>TronZap bandwidth per transfer</label><input id="cfgTzBw" class="input" type="number" min="0" step="1" value="${Number(c.tronzap_bandwidth!=null?c.tronzap_bandwidth:345)}"><div class="hint">Rented with energy so transfers need zero TRX (345 ≈ one USDT transfer; 0 = energy only, relies on free daily bandwidth).</div></div>
      <label class="check" style="margin-top:8px"><input type="checkbox" id="cfgTzSmartBw" ${(c.tronzap_smart_bandwidth!==false)?"checked":""}> Only rent bandwidth when free bandwidth is insufficient (saves cost)</label>
      <div class="field"><label>Generic rental endpoint URL</label><input id="cfgRentUrl" class="input" value="${esc(c.energy_rental_url||'')}" placeholder="https://provider.example/api/delegate"></div>
      <div class="field"><label>Generic rental API key</label><input id="cfgRentKey" class="input" value="${esc(c.energy_rental_api_key||'')}"></div>
      <div class="field"><label>Energy per transfer</label><input id="cfgRentAmt" class="input" type="number" min="0" step="1000" value="${Number(c.energy_rental_amount!=null?c.energy_rental_amount:65000)}"></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
      <div class="hint" style="margin-bottom:8px">Auto top-up the gas wallet by swapping USDT → TRX (SunSwap, mainnet) when it runs low.</div>
      <label style="display:flex;align-items:center;gap:9px;font-size:14px;cursor:pointer"><input type="checkbox" id="cfgAutoSwap" ${c.auto_swap_enabled?"checked":""}> Enable auto-swap (USDT → TRX)</label>
      <div class="form-grid" style="margin-top:12px">
        <div class="field"><label>Refill when gas below (TRX)</label><input id="cfgGasMin" class="input" type="number" min="0" step="1" value="${Number(c.gas_min_trx!=null?c.gas_min_trx:100)}"></div>
        <div class="field"><label>USDT to swap per refill</label><input id="cfgSwapUsdt" class="input" type="number" min="0" step="1" value="${Number(c.auto_swap_usdt!=null?c.auto_swap_usdt:50)}"></div>
      </div>
      <div class="field"><label>Max slippage (%)</label><input id="cfgSlip" class="input" type="number" min="0" max="50" step="0.5" value="${Number(c.swap_slippage_percent!=null?c.swap_slippage_percent:5)}" style="max-width:160px"></div>
      <div class="form-actions"><input id="swapNowAmt" class="input" type="number" min="0" step="1" placeholder="USDT" style="max-width:140px"><button class="btn btn-ghost btn-sm" id="swapNow">Top up gas now (swap USDT→TRX)</button></div>
      <div class="hint" style="margin-top:6px">New wallets are auto-funded with ${esc(c.wallet_preload_trx!=null?c.wallet_preload_trx:20)} TRX from the gas wallet on creation. Swaps pull USDT from treasury.</div>
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
      <div class="hint" id="enStatus">Loading energy status…</div>
      <div class="form-actions" style="margin-top:10px"><input id="enStakeAmt" class="input" type="number" min="0" step="1" placeholder="TRX" style="max-width:140px"><button class="btn btn-ghost btn-sm" id="enStake">Stake for energy</button><button class="btn btn-ghost btn-sm" id="enUnstake">Unstake</button></div>
      <div class="hint" style="margin-top:6px">Staking freezes TRX on the gas wallet to produce energy (reversible by unstaking; TRON enforces an unstake waiting period). Delegation to the sending wallet happens automatically on each transfer.</div>
    </div></div>

    </div>
    <div class="tab-pane" data-tab="branding">
    <div class="panel"><div class="panel-head"><h2>Branding</h2></div><div class="panel-body">
      <div class="field"><label>App name</label><input id="cfgAppName" class="input" value="${esc(c.app_name || "KryvonWallet")}"></div>
      <div class="field"><label>Customer wallet on-chain name (TRON)</label>
        <input id="cfgOnName" class="input" value="${esc(c.customer_onchain_name != null ? c.customer_onchain_name : "KryvonWalletcustodial")}">
        <div class="hint">Set on each new customer deposit wallet (one-time, permanent on TRON; costs a little TRX). Placeholders: <code>{id}</code>, <code>{username}</code>, <code>{app}</code>. Blank = off.</div>
        <div class="form-actions" style="margin-top:6px"><button class="btn btn-ghost btn-sm" id="cfgNameExisting">Apply to existing customer wallets</button></div></div>
      ${brandRow("Brand logo (header + QR centre)", "logo", "brand_logo", c.brand_logo)}
      ${brandRow("Favicon", "fav", "favicon", c.favicon)}
      ${brandRow("QR logo (centre of QR — falls back to brand logo)", "qrl", "qr_logo", c.qr_logo)}
      <div class="hint">PNG/SVG, square works best, keep under ~500 KB.</div>
    </div></div>

    </div>
    <div class="tab-pane" data-tab="security">
    <div class="panel"><div class="panel-head"><h2>Security</h2></div><div class="panel-body">
      <div class="field"><label>Database engine</label><div><span class="role-pill">${esc((c.db_engine || "sqlite").toUpperCase())}</span> <span class="hint">${c.db_engine === "mysql" ? "MySQL / MariaDB" : "embedded SQLite"}</span></div></div>
      <div class="hint">The wallet encryption key and app secret live in server config / your KMS and are never shown or editable here — changing the encryption key would make existing wallets unrecoverable.</div>
    </div></div>
    <div class="panel"><div class="panel-head"><h2>License</h2></div><div class="panel-body">
      <div id="licBox" class="hint">Loading license…</div>
    </div></div>
    </div>
    <button class="btn btn-primary" id="cfgSave" style="margin-top:16px">Save settings</button>`;
    $("#cfgSave").onclick = () => {
      const body = {
        staff_auto_approve_limit: parseFloat($("#cfgLimit").value) || 0,
        deposit_fee_percent: parseFloat($("#cfgFee").value) || 0,
        treasury_hold_percent: parseFloat($("#cfgHold").value) || 0,
        tron_network: $("#cfgNet").value,
        usdt_contract: $("#cfgContract").value.trim(),
        sweep_min_usdt: parseFloat($("#cfgSweep").value) || 0,
        gas_fund_trx: parseFloat($("#cfgGas").value) || 0,
        disbursement_float_usdt: parseFloat($("#cfgFloat").value) || 0,
        poll_interval_seconds: parseInt($("#cfgPoll").value, 10) || 30,
        wallet_preload_trx: parseFloat($("#cfgPreload").value) || 0,
        dual_control_threshold: parseFloat($("#cfgDual").value) || 0,
        webhook_url: $("#cfgHook").value.trim(),
        payout_allowlist_only: $("#cfgAllow").checked,
        auto_distribute_enabled: $("#cfgAuto").checked,
        app_name: $("#cfgAppName").value.trim() || "KryvonWallet",
        customer_onchain_name: $("#cfgOnName").value.trim(),
        energy_mode: $("#cfgEnergyMode").value,
        energy_provider: $("#cfgEnergyProvider") ? $("#cfgEnergyProvider").value : undefined,
        tronzap_api_token: $("#cfgTzToken") ? $("#cfgTzToken").value.trim() : undefined,
        tronzap_api_secret: ($("#cfgTzSecret") && !/[\u2022\u2026*]/.test($("#cfgTzSecret").value)) ? $("#cfgTzSecret").value.trim() : undefined,
        tronzap_bandwidth: $("#cfgTzBw") ? (parseInt($("#cfgTzBw").value,10)||0) : undefined,
        tronzap_smart_bandwidth: $("#cfgTzSmartBw") ? $("#cfgTzSmartBw").checked : undefined,
        energy_delegate_trx: parseFloat($("#cfgEnergyDelegate").value) || 0,
        energy_rental_url: $("#cfgRentUrl").value.trim(),
        energy_rental_api_key: $("#cfgRentKey").value.trim(),
        energy_rental_amount: parseFloat($("#cfgRentAmt").value) || 0,
        auto_swap_enabled: $("#cfgAutoSwap").checked,
        gas_min_trx: parseFloat($("#cfgGasMin").value) || 0,
        auto_swap_usdt: parseFloat($("#cfgSwapUsdt").value) || 0,
        swap_slippage_percent: parseFloat($("#cfgSlip").value) || 0,
        ..._brandPick,
      };
      const key = $("#cfgKey").value.trim(); if (key) body.trongrid_api_key = key;
      act(() => api("/admin/config", {method:"POST", body}), "Settings saved", () => { applyBranding(); renderSettings(); });
    };
    const nameExisting = $("#cfgNameExisting");
    if (nameExisting) nameExisting.onclick = async () => {
      const ok = await confirmModal({ title: "Name existing customer wallets", okLabel: "Apply",
        bodyHtml: `<p style="margin:0;font-size:14px;color:var(--muted)">Set the on-chain name on all customer deposit wallets. This is permanent per wallet and costs a little TRX each; already-named wallets are skipped.</p>` });
      if (!ok) return;
      try { const r = await api("/wallets/name-customers", { method: "POST" }); toast(`Named ${r.named}, skipped/failed ${r.failed} of ${r.total}`); }
      catch (e) { toast(e.message, true); }
    };
    document.querySelectorAll(".brand-file").forEach((inp) => inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      if (f.size > 500000) return toast("Image too large — keep under 500 KB", true);
      const url = await fileToDataUrl(f); _brandPick[inp.dataset.key] = url;
      const prev = document.getElementById(inp.dataset.prev); if (prev) prev.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:contain">`;
    });
    document.querySelectorAll(".brand-clear").forEach((b) => b.onclick = () => {
      _brandPick[b.dataset.key] = "";
      const prev = document.getElementById(b.dataset.prev); if (prev) prev.innerHTML = '<span class="hint">none</span>';
      const inp = document.querySelector(`.brand-file[data-key="${b.dataset.key}"]`); if (inp) inp.value = "";
    });
    async function loadEnergy(){
      try {
        const s = await api("/energy/status");
        $("#enStatus").innerHTML = s.configured
          ? `Mode: <b>${esc(s.mode)}</b> · Energy available: <b>${Number(s.energyAvailable||0).toLocaleString()}</b> (~${Math.floor(Number(s.energyAvailable||0)/65000)} USDT transfers) · Staked (TronPower): <b>${Number(s.tronPowerLimit||0).toLocaleString()}</b> · Gas wallet TRX: <b>${Number(s.trx||0).toFixed(2)}</b>`
          : "No gas/energy wallet yet — create the gas wallet first.";
      } catch (e) { $("#enStatus").textContent = e.message; }
    }
    loadEnergy();
    (async () => {
      const box = $("#licBox"); if (!box) return;
      try {
        const l = await api("/license");
        const badge = l.licensed ? (l.in_grace ? "IN GRACE" : "LICENSED") : "UNLICENSED";
        const quota = l.included_transactions != null ? `${l.usage.month} / ${l.included_transactions} this month` : `${l.usage.month} this month (metered)`;
        box.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">
          <div><b>${esc(l.licensee || "—")}</b> <span class="role-pill">${badge}</span> ${l.plan ? `· ${esc(l.plan)}` : ""}</div>
          <div>Billing: ${esc(l.billing || "—")} · Transactions: <b>${quota}</b> · Lifetime: ${l.usage.total}</div>
          ${l.expires_at ? `<div>Expires: ${esc(l.expires_at.slice(0, 10))}${l.in_grace ? " (in grace period)" : ""}</div>` : ""}
          ${!l.licensed ? `<div style="color:var(--danger)">${esc(l.reason || "license invalid")} — contact your vendor</div>` : ""}
          <div class="hint">Install via the <code>LICENSE_KEY</code> env var or <code>data/license.key</code>, then restart. Enforcement is on when <code>LICENSE_ENFORCE=1</code>.</div>
        </div>`;
      } catch (e) { box.textContent = "License status unavailable."; }
    })();
    $("#enStake").onclick = () => { const trx = parseFloat($("#enStakeAmt").value); if (!(trx > 0)) return toast("Enter TRX to stake", true); act(() => api("/energy/stake", { method: "POST", body: { trx } }), "Staked for energy", loadEnergy); };
    $("#enUnstake").onclick = () => { const trx = parseFloat($("#enStakeAmt").value); if (!(trx > 0)) return toast("Enter TRX to unstake", true); act(() => api("/energy/unstake", { method: "POST", body: { trx } }), "Unstake requested", loadEnergy); };
    const sn = $("#swapNow");
    if (sn) sn.onclick = () => { const usdt = parseFloat($("#swapNowAmt").value) || parseFloat($("#cfgSwapUsdt").value); if (!(usdt > 0)) return toast("Enter a USDT amount", true); act(() => api("/gas/refill", { method: "POST", body: { usdt } }), "Swapped USDT → TRX to gas", loadEnergy); };
    const rv = $("#cfgKeyReveal");
    if (rv) rv.onclick = async () => {
      try { const r = await api("/admin/config/apikey"); $("#cfgKey").value = r.trongrid_api_key || ""; toast("Key shown in the field"); }
      catch (e) { toast(e.message, true); }
    };
  }catch(e){ $("#stBody").innerHTML = emptyState(e.message); }
}

/* ---------- QR modal ---------- */
let _qrCur = { address: "", label: "" };
function ensureQrModal(){
  if ($("#qrBack")) return;
  const d = document.createElement("div");
  d.id = "qrBack"; d.className = "modal-back";
  d.innerHTML = `<div class="modal" style="max-width:340px">
    <div class="modal-head"><h3 id="qrTitle">Receive</h3></div>
    <div class="modal-body" style="text-align:center">
      <div class="rc-asset" style="margin-bottom:14px"><span class="rc-coin">&#8366;</span> USDT (TRC20)</div>
      <div id="qrBox" class="rc-qr"></div>
      <div class="rc-addr" id="qrAddr" style="margin-top:14px"></div>
      <div class="form-actions" style="justify-content:center;margin-top:14px">
        <button class="btn btn-ghost btn-sm" id="qrCopy">Copy</button>
        <button class="btn btn-ghost btn-sm" id="qrDownload">Download</button>
        <button class="btn btn-accent btn-sm" id="qrShare">Share</button>
      </div>
      <div class="rc-warn" style="margin-top:14px"><span class="rc-warn-ic">i</span><span>This address accepts only <b>USDT (TRC20)</b>. Other tokens sent here will be lost.</span></div></div>
    <div class="modal-foot"><button class="btn btn-ghost" id="qrClose">Close</button></div></div>`;
  document.body.appendChild(d);
  $("#qrClose").onclick = () => d.classList.remove("show");
  d.addEventListener("click", (e) => { if (e.target === d) d.classList.remove("show"); });
  $("#qrCopy").onclick = () => navigator.clipboard.writeText(_qrCur.address).then(() => toast("Address copied"));
  $("#qrDownload").onclick = qrDownload;
  $("#qrShare").onclick = qrShare;
}
function roundRect(ctx, x, y, w, h, r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
function loadImg(src){ return new Promise((res) => { if (!src) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
// Render a QR straight into a (visible, attached) element — most reliable across QR-lib builds —
// and overlay the brand logo in the centre via the DOM.
function renderQrInto(box, address, px){
  if (!box) return;
  box.innerHTML = ""; box.style.position = "relative";
  try { new QRCode(box, { text: String(address || ""), width: px, height: px, correctLevel: QRCode.CorrectLevel.H }); }
  catch (e) { box.textContent = "QR unavailable"; return; }
  const cv = box.querySelector("canvas"), im = box.querySelector("img");
  if (cv) { cv.style.display = "block"; if (im) im.style.display = "none"; }
  else if (im) { im.style.display = "block"; }
  const logoSrc = (state.branding && (state.branding.qr_logo || state.branding.brand_logo)) || "";
  if (logoSrc) {
    const s = Math.round(px * 0.24), lg = document.createElement("img");
    lg.src = logoSrc; lg.alt = "";
    lg.style.cssText = `position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:${s}px;height:${s}px;object-fit:contain;background:#fff;border-radius:7px;padding:3px;box-shadow:0 0 0 3px #fff`;
    box.appendChild(lg);
  }
}
async function makeQrCanvas(address, size){
  const tmp = document.createElement("div");
  try { new QRCode(tmp, { text: address, width: size, height: size, correctLevel: QRCode.CorrectLevel.H }); } catch (e) {}
  let canvas = tmp.querySelector("canvas");
  if (!canvas) {
    const img = tmp.querySelector("img");
    canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
    if (img) { await new Promise((r) => { if (img.complete) r(); else img.onload = r; }); try { canvas.getContext("2d").drawImage(img, 0, 0, size, size); } catch (e) {} }
  }
  const logoSrc = (state.branding && (state.branding.qr_logo || state.branding.brand_logo)) || "";
  const logo = await loadImg(logoSrc);
  if (logo) {
    const ctx = canvas.getContext("2d"); const s = Math.round(size * 0.22); const x = (size - s) / 2, y = (size - s) / 2, pad = s * 0.14;
    ctx.fillStyle = "#fff"; roundRect(ctx, x - pad, y - pad, s + pad * 2, s + pad * 2, 8); ctx.fill();
    try { ctx.drawImage(logo, x, y, s, s); } catch (e) {}
  }
  return canvas;
}
async function composeCard(){
  const qr = await makeQrCanvas(_qrCur.address, 300);
  const W = 560, H = 760, c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#EEF2F7"; ctx.fillRect(0, 0, W, H);
  const m = 24, cardW = W - m * 2, cardH = H - m * 2, cx = m, cy = m;
  ctx.save(); ctx.shadowColor = "rgba(16,24,40,0.12)"; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
  ctx.fillStyle = "#ffffff"; roundRect(ctx, cx, cy, cardW, cardH, 20); ctx.fill(); ctx.restore();
  ctx.strokeStyle = "#E7ECF3"; ctx.lineWidth = 1; roundRect(ctx, cx + 0.5, cy + 0.5, cardW - 1, cardH - 1, 20); ctx.stroke();
  const bandH = 92;
  ctx.save(); roundRect(ctx, cx, cy, cardW, bandH + 24, 20); ctx.clip();
  const g = ctx.createLinearGradient(cx, cy, cx + cardW, cy); g.addColorStop(0, "#0FA678"); g.addColorStop(1, "#0A7D5A");
  ctx.fillStyle = g; ctx.fillRect(cx, cy, cardW, bandH); ctx.restore();
  ctx.textAlign = "center";
  const name = (state.branding && state.branding.app_name) || "KryvonWallet";
  const logo = await loadImg((state.branding && state.branding.brand_logo) || "");
  if (logo) { const lh = 44, lw = Math.min(140, lh * ((logo.width / logo.height) || 1)); ctx.drawImage(logo, (W - lw) / 2, cy + (bandH - lh) / 2, lw, lh); }
  else { ctx.fillStyle = "#ffffff"; ctx.font = "800 24px Inter, Arial, sans-serif"; ctx.fillText(name, W / 2, cy + bandH / 2 + 8); }
  let y = cy + bandH + 48;
  ctx.fillStyle = "#0B1220"; ctx.font = "700 22px Inter, Arial, sans-serif";
  ctx.fillText(_qrCur.customerName ? ("Pay " + _qrCur.customerName) : (_qrCur.label || "Wallet address"), W / 2, y);
  if (_qrCur.customerName && _qrCur.label) { y += 24; ctx.font = "500 14px Inter, Arial, sans-serif"; ctx.fillStyle = "#5A6472"; ctx.fillText(_qrCur.label, W / 2, y); }
  y += 28; const qs = 300, tile = qs + 28, tx = (W - tile) / 2, ty = y;
  ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#E7ECF3"; roundRect(ctx, tx, ty, tile, tile, 16); ctx.fill(); ctx.stroke();
  ctx.drawImage(qr, tx + 14, ty + 14, qs, qs); y = ty + tile + 30;
  ctx.font = "600 12px Inter, Arial, sans-serif"; const pill = "TRC-20 USDT only"; const pw = ctx.measureText(pill).width + 26;
  ctx.fillStyle = "#E7F6F0"; roundRect(ctx, (W - pw) / 2, y - 17, pw, 27, 13); ctx.fill(); ctx.fillStyle = "#0A7D5A"; ctx.fillText(pill, W / 2, y + 1); y += 36;
  ctx.font = "13px ui-monospace, monospace"; ctx.fillStyle = "#0B1220";
  const a = _qrCur.address, mid = Math.ceil(a.length / 2);
  ctx.fillText(a.slice(0, mid), W / 2, y); ctx.fillText(a.slice(mid), W / 2, y + 18);
  ctx.font = "12px Inter, Arial, sans-serif"; ctx.fillStyle = "#94A0B0"; ctx.fillText("Powered by " + name, W / 2, cy + cardH - 22);
  return c.toDataURL("image/png");
}
function cardFileName(){ return ((_qrCur.customerName || _qrCur.label || "wallet") + "").replace(/\s+/g, "-") + "-qr.png"; }
async function qrDownload(){
  try { const url = await composeCard(); const a = document.createElement("a"); a.href = url; a.download = cardFileName(); document.body.appendChild(a); a.click(); a.remove(); toast("QR card downloaded"); }
  catch (e) { toast("Could not build QR", true); }
}
async function qrShare(){
  const text = `${_qrCur.label || "KryvonWallet"}${_qrCur.customerName ? " — " + _qrCur.customerName : ""}\nUSDT (TRC-20): ${_qrCur.address}`;
  try {
    const url = await composeCard();
    if (navigator.canShare) {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], cardFileName(), { type: "image/png" });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: _qrCur.label || "KryvonWallet", text }); return; }
    }
    if (navigator.share) { await navigator.share({ title: _qrCur.label || "KryvonWallet", text }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  navigator.clipboard.writeText(text).then(() => toast("Details copied — ready to share"));
}
function colorAddr(a){ const g1 = a.slice(0, 6), g2 = a.slice(-6), mid = a.slice(6, -6); return `<span class="g">${esc(g1)}</span>${esc(mid)}<span class="g">${esc(g2)}</span>`; }
function receiveCard(opts){
  const a = opts.address;
  return `<div class="rc">
    <div class="rc-name"><span class="rc-name-ic">&#128100;</span> ${esc(opts.name || opts.walletLabel || "Receive")}</div>
    <div class="rc-card">
      <div class="rc-asset"><span class="rc-coin">&#8366;</span> USDT (TRC20)</div>
      <div class="rc-qr" data-qrbox="${esc(a)}"></div>
      <div class="rc-addr">${colorAddr(a)}</div>
      <div class="rc-btns">
        <button class="btn btn-ghost rc-share" data-addr="${esc(a)}" data-name="${esc(opts.name || "")}" data-label="${esc(opts.walletLabel || "")}">Share</button>
        <button class="btn btn-primary" data-copy="${esc(a)}">Copy</button>
      </div>
    </div>
    <div class="rc-warn"><span class="rc-warn-ic">i</span><span>This address accepts only <b>USDT (TRC20)</b>. Sending any other token to it will result in permanent loss.</span></div>
  </div>`;
}
async function mountReceiveCards(root){
  const r = root || document;
  for (const box of r.querySelectorAll(".rc-qr[data-qrbox]")){ renderQrInto(box, box.dataset.qrbox, 200); }
  r.querySelectorAll(".rc-share").forEach((b) => b.onclick = () => showQr(b.dataset.addr, b.dataset.label || "Receive", b.dataset.name));
}
async function showQr(address, label, customerName){
  ensureQrModal();
  _qrCur = { address, label: label || "KryvonWallet", customerName: customerName || "" };
  $("#qrTitle").textContent = customerName || label || "Receive";
  $("#qrAddr").innerHTML = colorAddr(address);
  renderQrInto($("#qrBox"), address, 190);
  $("#qrBack").classList.add("show");
}

async function boot(){
  const me = await api("/users/me");
  state.user = me;
  $("#login").style.display = "none"; $("#app").style.display = "grid";
  $("#whoName").textContent = me.username; $("#whoRole").textContent = me.role;
  buildNav(); route("dashboard");
}

$("#loginBtn").onclick = doLogin;
$("#lp").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("#logoutBtn").onclick = doLogout;
if ($("#themeBtn")) $("#themeBtn").onclick = () => {
  const isDark = (document.documentElement.getAttribute("data-theme")
    || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
  const next = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("cc_theme", next); } catch (e) {}
};
$("#modalBack").addEventListener("click", (e) => { if (e.target === $("#modalBack")) $("#modalBack").classList.remove("show"); });

async function applyBranding(){
  try {
    const b = await (await fetch("/branding")).json();
    state.branding = b;
    if (b.app_name) { document.querySelectorAll(".brand-name").forEach((e) => e.textContent = b.app_name); document.title = b.app_name; }
    if (b.brand_logo) {
      document.querySelectorAll(".brand-mark").forEach((e) => { e.innerHTML = `<img src="${b.brand_logo}" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:inherit">`; e.style.background = "transparent"; });
    }
    if (b.favicon) { let l = document.querySelector("link[rel~='icon']"); if (!l) { l = document.createElement("link"); l.rel = "icon"; document.head.appendChild(l); } l.href = b.favicon; }
  } catch (e) { /* keep defaults */ }
}

(async () => {
  applyBranding();
  if (state.token){ try { await boot(); } catch { doLogout(); } }
  else { $("#login").style.display = "grid"; }
})();

})();
