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
  topup:"Treasury → pool", disburse_out:"Payout"
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
    ["dashboard","Dashboard","◧"], ["wallets","Wallets","▦"],
    ["payouts","Payouts","↗"], ["staff","Staff","☷"], ["audit","Audit log","❏"]
  ],
  staff: [
    ["dashboard","Dashboard","◧"], ["wallets","Receive","▦"], ["payouts","Payouts","↗"]
  ]
};
function buildNav(){
  const nav = $("#nav"); nav.innerHTML = "";
  NAV[state.user.role].forEach(([key, label, ic]) => {
    const a = document.createElement("a");
    a.dataset.sec = key; a.innerHTML = `<span class="ic">${ic}</span>${label}`;
    a.onclick = () => route(key); nav.appendChild(a);
  });
}
function route(sec){
  document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("active", a.dataset.sec === sec));
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  $("#sec-" + sec).classList.add("active");
  const fn = { dashboard:renderDashboard, wallets:renderWallets, payouts:renderPayouts,
    staff:renderStaff, audit:renderAudit }[sec];
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
async function renderDashboard(){
  const sec = $("#sec-dashboard");
  sec.innerHTML = `<div class="page-head"><div><h1>Dashboard</h1>
    <p>Overview of balances and recent activity.</p></div></div>
    <div id="dashBody">Loading…</div>`;
  try{
    const d = await api("/dashboard");
    setNetwork(d.network);
    $("#dashBody").innerHTML = d.role === "admin" ? adminDash(d) : staffDash(d);
  }catch(e){ $("#dashBody").innerHTML = emptyState(e.message); }
}
function adminDash(d){
  const poolTotal = (d.pool || []).reduce((s,w) => s + (Number(w.usdt)||0), 0);
  const treasuryVal = d.treasury ? fmtUsdt(d.treasury.usdt) : "—";
  return `
  <div class="readouts">
    <div class="readout">
      <div class="label">Treasury (master) balance</div>
      <div class="value lead num">${treasuryVal}<span class="unit">USDT</span></div>
      <div class="foot">${d.treasury ? addrHtml(d.treasury.address) : "No treasury wallet yet"}</div>
    </div>
    <div class="readout">
      <div class="label">Disbursement pool</div>
      <div class="value num">${fmtUsdt(poolTotal)}<span class="unit">USDT</span></div>
      <div class="foot">${(d.pool||[]).length} wallets · payouts leave from here</div>
    </div>
    <div class="readout">
      <div class="label">Gas wallet (TRX)</div>
      <div class="value num">${d.fee ? fmtTrx(d.fee.native) : "—"}<span class="unit">TRX</span></div>
      <div class="foot">${d.fee ? "funds sweep fees" : "No gas wallet yet"}</div>
    </div>
  </div>
  <div class="panel"><div class="panel-head"><h2>At a glance</h2></div>
    <div class="panel-body"><div class="stat-row">
      <div class="s"><div class="n num">${d.pending_approvals}</div><div class="l">Payouts awaiting approval</div></div>
      <div class="s"><div class="n num">${d.staff_count}</div><div class="l">Staff</div></div>
      <div class="s"><div class="n num">${d.deposit_wallet_count}</div><div class="l">Deposit addresses</div></div>
    </div></div>
  </div>
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
      <th class="amt">Amount</th><th>Status</th><th>Tx</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : emptyState("No movements yet.")}
    </div></div>`;
}

/* ======================================================= WALLETS */
async function renderWallets(){
  const sec = $("#sec-wallets");
  if (state.user.role === "staff") return renderReceive(sec);

  sec.innerHTML = `<div class="page-head"><div><h1>Wallets</h1>
    <p>Treasury, gas, disbursement pool, and per-staff deposit addresses.</p></div></div>
    <div id="wBody">Loading…</div>`;
  try{
    const [wallets, users] = await Promise.all([api("/wallets"), api("/users")]);
    const byType = t => wallets.filter(w => w.wtype === t);
    const treasury = byType("treasury")[0];
    const fee = byType("fee")[0];
    const pool = byType("disbursement");
    const deposits = byType("deposit");
    const staff = users.filter(u => u.role === "staff");
    const uname = id => (users.find(u => u.id === id) || {}).username || "—";

    $("#wBody").innerHTML = `
    <div class="panel"><div class="panel-head"><h2>Treasury (master)</h2>
      ${treasury ? "" : `<button class="btn btn-primary btn-sm" id="mkTreasury">Create treasury</button>`}</div>
      <div class="panel-body">${treasury
        ? `<div class="recv-addr">${esc(treasury.address)}</div>
           <div class="form-actions"><button class="btn btn-ghost btn-sm bal" data-id="${treasury.id}">Check balance</button>
           <span class="hint" id="bal-${treasury.id}"></span></div>`
        : `<span class="hint">Deposits are swept here automatically. Keep the bulk of funds in cold storage.</span>`}
      </div></div>

    <div class="panel"><div class="panel-head"><h2>Gas wallet (TRX)</h2>
      ${fee ? "" : `<button class="btn btn-primary btn-sm" id="mkFee">Create gas wallet</button>`}</div>
      <div class="panel-body">${fee
        ? `<div class="recv-addr">${esc(fee.address)}</div>
           <div class="hint">Fund this address with TRX so the system can pay sweep fees.</div>
           <div class="form-actions"><button class="btn btn-ghost btn-sm bal" data-id="${fee.id}">Check balance</button>
           <span class="hint" id="bal-${fee.id}"></span></div>`
        : `<span class="hint">Needed to pay the network fee when sweeping TRC-20 deposits.</span>`}
      </div></div>

    <div class="panel"><div class="panel-head"><h2>Disbursement pool (${pool.length})</h2>
      <div class="row-actions">
        <input id="poolCount" class="input" style="width:72px" type="number" min="1" max="50" value="5">
        <button class="btn btn-primary btn-sm" id="mkPool">Add wallets</button></div></div>
      <div class="panel-body flush">${pool.length
        ? `<table><thead><tr><th>Label</th><th>Address</th><th class="amt">USDT</th><th></th></tr></thead><tbody>
           ${pool.map(w => `<tr><td>${esc(w.label||"—")}</td><td>${addrHtml(w.address)}</td>
             <td class="amt num" id="pbal-${w.id}">—</td>
             <td class="row-actions"><button class="btn btn-ghost btn-sm bal" data-id="${w.id}" data-cell="pbal-${w.id}">Check</button></td></tr>`).join("")}
           </tbody></table>`
        : emptyState("No pool wallets yet. Payouts draw from these, topped up from treasury.")}
      </div></div>

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
        ? `<table><thead><tr><th>Owner</th><th>Label</th><th>Address</th></tr></thead><tbody>
           ${deposits.map(w => `<tr><td>${esc(uname(w.owner_user_id))}</td>
             <td>${esc(w.label||"—")}</td><td>${addrHtml(w.address)}</td></tr>`).join("")}</tbody></table>`
        : emptyState("No deposit addresses yet.")}
      </div></div>`;

    wireWalletActions();
  }catch(e){ $("#wBody").innerHTML = emptyState(e.message); }
}

function wireWalletActions(){
  const on = (id, fn) => { const el = $("#"+id); if (el) el.onclick = fn; };
  on("mkTreasury", () => act(() => api("/wallets/treasury", {method:"POST"}), "Treasury created", renderWallets));
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
  document.querySelectorAll(".bal").forEach(b => b.onclick = async () => {
    const id = b.dataset.id, cell = b.dataset.cell;
    b.disabled = true; const prev = b.textContent; b.textContent = "…";
    try{
      const r = await api(`/wallets/${id}/balance`);
      const txt = `${fmtUsdt(r.usdt)} USDT · ${fmtTrx(r.native)} TRX`;
      if (cell) $("#"+cell).textContent = fmtUsdt(r.usdt);
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
    $("#rBody").innerHTML = wallets.map((w,i) => `
      <div class="panel"><div class="panel-head"><h2>${esc(w.label || "Deposit address " + (i+1))}</h2></div>
        <div class="panel-body"><div class="qr-wrap">
          <div class="qr-box" id="qr-${w.id}"></div>
          <div style="flex:1;min-width:220px">
            <div class="hint" style="margin-bottom:6px">TRC-20 USDT only</div>
            <div class="recv-addr">${esc(w.address)}</div>
            <div class="form-actions"><button class="btn btn-ghost btn-sm" data-copy="${esc(w.address)}">Copy address</button></div>
          </div></div></div></div>`).join("");
    wallets.forEach(w => { new QRCode($("#qr-"+w.id), { text:w.address, width:132, height:132,
      correctLevel: QRCode.CorrectLevel.M }); });
  }catch(e){ $("#rBody").innerHTML = emptyState(e.message); }
}

/* ======================================================= PAYOUTS */
async function renderPayouts(){
  const sec = $("#sec-payouts");
  sec.innerHTML = `<div class="page-head"><div><h1>Payouts</h1>
    <p>${state.user.role === "admin"
      ? "Review and approve payout requests. Approved payouts leave from a random pool wallet."
      : "Request a USDT payout. An admin approves before it is sent."}</p></div></div>
    <div id="pBody">Loading…</div>`;
  try{
    const reqs = await api("/disbursements");
    $("#pBody").innerHTML = (state.user.role === "staff" ? staffRequestForm() : "") + payoutTable(reqs);
    if (state.user.role === "staff") $("#pSubmit").onclick = submitRequest;
    if (state.user.role === "admin")
      document.querySelectorAll(".approve").forEach(b => b.onclick = () => approve(b.dataset));
  }catch(e){ $("#pBody").innerHTML = emptyState(e.message); }
}
function staffRequestForm(){
  return `<div class="panel"><div class="panel-head"><h2>New payout request</h2></div>
    <div class="panel-body"><div class="form-grid">
      <div class="field"><label>Recipient address (TRC-20)</label>
        <input id="pTo" class="input mono" placeholder="T…"></div>
      <div class="field"><label>Amount (USDT)</label>
        <input id="pAmt" class="input" type="number" step="0.000001" min="0" placeholder="0.00"></div>
    </div>
    <div class="field"><label>Reason / reference (optional)</label>
      <input id="pReason" class="input" placeholder="e.g. settlement #4821"></div>
    <button class="btn btn-primary" id="pSubmit">Submit request</button>
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
      <td>${statusBadge(r.status)}</td>
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
  const to = $("#pTo").value.trim(), amt = parseFloat($("#pAmt").value);
  if (!to){ return toast("Enter a recipient address", true); }
  if (!(amt > 0)){ return toast("Enter a valid amount", true); }
  act(() => api("/disbursements", {method:"POST",
    body:{ to_address: to, amount: amt, reason: $("#pReason").value.trim() }}),
    "Payout request submitted", renderPayouts);
}
async function approve({ id, to, amt }){
  const live = state.network === "mainnet";
  const ok = await confirmModal({
    title: "Approve and send payout",
    okLabel: "Send payout",
    bodyHtml: `
      <div class="kv"><span class="k">Amount</span><span class="v num">${fmtUsdt(amt)} USDT</span></div>
      <div class="kv"><span class="k">Recipient</span><span class="v mono" style="font-size:12px">${esc(shortAddr(to))}</span></div>
      <div class="kv"><span class="k">Source</span><span class="v">random pool wallet</span></div>
      ${live ? `<div class="live-note">This sends real USDT on mainnet. It cannot be reversed.</div>` : ""}`
  });
  if (!ok) return;
  act(() => api(`/disbursements/${id}/approve`, {method:"POST"}), "Payout sent", renderPayouts);
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
      <div class="panel-body flush"><table><thead><tr><th>ID</th><th>Username</th><th>Role</th><th>Status</th></tr></thead>
        <tbody>${users.map(u => `<tr><td>#${u.id}</td><td>${esc(u.username)}</td>
          <td><span class="role">${esc(u.role)}</span></td>
          <td>${u.is_active ? statusBadge("confirmed").replace("confirmed","active") : statusBadge("failed").replace("failed","disabled")}</td></tr>`).join("")}
        </tbody></table></div></div>`;
    $("#nuCreate").onclick = () => {
      const username = $("#nuUser").value.trim(), password = $("#nuPass").value, role = $("#nuRole").value;
      if (username.length < 3) return toast("Username too short", true);
      if (password.length < 8) return toast("Password must be at least 8 characters", true);
      act(() => api("/users", {method:"POST", body:{ username, password, role }}), "User created", renderStaff);
    };
  }catch(e){ $("#sBody").innerHTML = emptyState(e.message); }
}

/* ======================================================= AUDIT (admin) */
async function renderAudit(){
  const sec = $("#sec-audit");
  sec.innerHTML = `<div class="page-head"><div><h1>Audit log</h1>
    <p>Every sensitive action, in order.</p></div></div><div id="aBody">Loading…</div>`;
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

/* global copy-button delegation */
/* ---------- receipts ---------- */
function ensureReceiptModal(){
  if ($("#rcptBack")) return;
  const d = document.createElement("div");
  d.id = "rcptBack"; d.className = "modal-back";
  d.innerHTML = `<div class="modal receipt" id="rcptCard">
    <div class="receipt-head">
      <div class="receipt-brand"><span class="rb-mark">₮</span> USDT Custody — Receipt</div>
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

document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-copy]");
  if (c){ copy(c.dataset.copy); return; }
  const rc = e.target.closest("[data-receipt]");
  if (rc){ openReceipt(rc.dataset.receipt); return; }
  const rt = e.target.closest("[data-receipt-tx]");
  if (rt){ openReceipt(rt.dataset.receiptTx); return; }
});

/* ---------- boot ---------- */
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
$("#modalBack").addEventListener("click", (e) => { if (e.target === $("#modalBack")) $("#modalBack").classList.remove("show"); });

(async () => {
  if (state.token){ try { await boot(); } catch { doLogout(); } }
  else { $("#login").style.display = "grid"; }
})();

})();
