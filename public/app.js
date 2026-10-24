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
    ["transactions","Transactions","≋"], ["customers","Customers","☺"], ["addressbook","Address book","▤"],
    ["staff","Staff","☷"], ["settings","Settings","⚙"], ["audit","Audit log","❏"]
  ],
  staff: [
    ["dashboard","Dashboard","◧"], ["wallets","Receive","▦"], ["payouts","Payouts","↗"],
    ["transactions","Transactions","≋"], ["customers","Customers","☺"], ["addressbook","Address book","▤"]
  ],
  customer_depositor: [
    ["dashboard","Overview","◧"], ["wallets","Deposit address","▦"], ["payouts","Deposits","↙"]
  ],
  customer_remittance: [
    ["dashboard","Overview","◧"], ["wallets","Whitelist","▦"], ["payouts","Transfers","↙"]
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
function route(sec){
  document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("active", a.dataset.sec === sec));
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  $("#sec-" + sec).classList.add("active");
  const map = state.user.role === "customer"
    ? { dashboard:renderCustomerDashboard, wallets:renderCustomerAssets, payouts:renderCustomerHistory }
    : { dashboard:renderDashboard, wallets:renderWallets, payouts:renderPayouts,
        staff:renderStaff, audit:renderAudit, customers:renderCustomers,
        addressbook:renderAddressBook, settings:renderSettings, transactions:renderTransactions };
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
    const [wallets, users, settings, book] = await Promise.all([
      api("/wallets"), api("/users"), api("/settings"), api("/address-book").catch(() => [])
    ]);
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
    if (ok) act(() => api("/admin/send", {method:"POST", body:{ from, to_address: to, amount: amt }}), "Sent", renderWallets);
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
      ? "Make a payout, or review and approve staff requests. Payouts leave from a random pool wallet."
      : "Request a USDT payout from the pool."}</p></div></div>
    <div id="pBody">Loading…</div>`;
  try{
    const canPay = state.user.role === "staff" || state.user.role === "admin";
    const [reqs, settings, book] = await Promise.all([
      api("/disbursements"), api("/settings").catch(() => ({})), api("/address-book").catch(() => [])
    ]);
    $("#pBody").innerHTML = (canPay ? staffRequestForm(settings, book) : "") + payoutTable(reqs);
    if (canPay) $("#pSubmit").onclick = submitRequest;
    if (state.user.role === "admin")
      document.querySelectorAll(".approve").forEach(b => b.onclick = () => approve(b.dataset));
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
  try{
    const r = await api("/disbursements", {method:"POST", body:{ to_address: to, amount: amt, reason: $("#pReason").value.trim() }});
    toast(r.tx_hash ? "Payout sent" : "Payout request submitted for approval");
    renderPayouts();
  }catch(e){ toast(e.message, true); }
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

document.addEventListener("click", (e) => {
  const ut = e.target.closest("[data-usertx]");
  if (ut){ openUserTx(ut.dataset.usertx); return; }
  const q = e.target.closest("[data-qr]");
  if (q){ showQr(q.dataset.qr, q.dataset.qrlabel); return; }
  const c = e.target.closest("[data-copy]");
  if (c){ copy(c.dataset.copy); return; }
  const rc = e.target.closest("[data-receipt]");
  if (rc){ openReceipt(rc.dataset.receipt); return; }
  const rt = e.target.closest("[data-receipt-tx]");
  if (rt){ openReceipt(rt.dataset.receiptTx); return; }
});

/* ---------- boot ---------- */
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
    <div class="field" id="cWlField" style="display:none"><label>Whitelisted payout address (TRC-20)</label><input id="cWl" class="input mono" placeholder="T…"></div>
    <button class="btn btn-primary" id="cCreate">Create customer</button></div></div>`;
}
function wireCustomerForm(){
  const typeSel = $("#cType");
  const toggle = () => { $("#cWlField").style.display = typeSel.value === "remittance" ? "" : "none"; };
  typeSel.onchange = toggle; toggle();
  $("#cCreate").onclick = () => {
    const body = { username: $("#cUser").value.trim(), password: $("#cPass").value, customer_type: typeSel.value, label: $("#cLabel").value.trim() };
    if (typeSel.value === "remittance") body.whitelist_address = $("#cWl").value.trim();
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
    const c = await api("/customers/" + id);
    if (c.customer_type === "depositor"){
      d.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(c.username)} · depositor</h2></div><div class="panel-body">
        ${c.deposit_addresses.map(w => `<div class="recv-addr">${esc(w.address)}</div>`).join("") || emptyState("No deposit address.")}
        <div class="hint" style="margin-top:8px">Deposits here settle to treasury automatically; the customer sees them in their portal.</div></div></div>`;
      return;
    }
    const wl = c.whitelist.map(w => `<tr><td>${addrHtml(w.address)}</td><td>${esc(w.label||"—")}</td>
      <td class="row-actions"><button class="btn btn-ghost btn-sm wl-del" data-wid="${w.id}">Remove</button></td></tr>`).join("");
    d.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(c.username)} · remittance</h2></div>
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
    document.querySelectorAll(".wl-del").forEach(b => b.onclick = () =>
      act(() => api("/customers/" + id + "/whitelist/" + b.dataset.wid, { method:"DELETE" }), "Address removed", () => openCustomer(id)));
    const add = $("#wlAdd");
    if (add) add.onclick = () => { const address = $("#wlAddr").value.trim(); if (!address) return toast("Enter an address", true);
      act(() => api("/customers/" + id + "/whitelist", { method:"POST", body:{ address, label: $("#wlLabel").value.trim() } }), "Address whitelisted", () => openCustomer(id)); };
    const send = $("#poSend");
    if (send) send.onclick = () => { const amt = parseFloat($("#poAmt").value); if (!(amt > 0)) return toast("Enter a valid amount", true);
      act(() => api("/disbursements", { method:"POST", body:{ customer_id: id, amount: amt, to_address: $("#poAddr").value, reason: $("#poReason").value.trim() } }), "Payout created — pending admin approval", () => openCustomer(id)); };
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
        ${me.deposit_addresses.map((w,i) => `<div class="panel"><div class="panel-head"><h2>${esc(w.label||"Deposit address "+(i+1))}</h2></div>
          <div class="panel-body"><div class="qr-wrap"><div class="qr-box" id="cqr-${w.id}"></div>
          <div style="flex:1;min-width:220px"><div class="hint" style="margin-bottom:6px">TRC-20 USDT only</div>
          <div class="recv-addr">${esc(w.address)}</div>
          <div class="form-actions"><button class="btn btn-ghost btn-sm" data-copy="${esc(w.address)}">Copy address</button></div></div></div></div></div>`).join("") || emptyState("No deposit address assigned yet.")}`;
      me.deposit_addresses.forEach(w => { try { new QRCode($("#cqr-" + w.id), { text:w.address, width:132, height:132, correctLevel: QRCode.CorrectLevel.M }); } catch(e){} });
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
    ${body ? `<table><thead><tr><th>Date (UTC)</th><th>From</th><th class="amt">Amount</th><th>Status</th><th></th></tr></thead><tbody>${body}</tbody></table>` : emptyState("No deposits yet.")}</div></div>`;
}
function transfersPanel(rows, title){
  const body = (rows||[]).map(r => `<tr>
    <td>${esc((r.created_at||"").replace("T"," ").slice(0,16))}</td>
    <td>${addrHtml(r.to_address)}</td>
    <td class="amt num">${fmtUsdt(r.amount)} USDT</td>
    <td>${statusBadge(r.status)}</td>
    <td class="row-actions">${r.tx_hash ? `<button class="btn btn-ghost btn-sm" data-receipt-tx="${esc(r.tx_hash)}">Receipt</button>` : "—"}</td></tr>`).join("");
  return `<div class="panel"><div class="panel-head"><h2>${esc(title)}</h2></div><div class="panel-body flush">
    ${body ? `<table><thead><tr><th>Date (UTC)</th><th>To</th><th class="amt">Amount</th><th>Status</th><th></th></tr></thead><tbody>${body}</tbody></table>` : emptyState("No transfers yet.")}</div></div>`;
}

/* ---------- transactions (admin: all + filter by user; staff: own) ---------- */
let txFilterUser = null;
function openUserTx(id){ txFilterUser = String(id); route("transactions"); }
async function renderTransactions(){
  const sec = $("#sec-transactions");
  const isAdmin = state.user.role === "admin";
  sec.innerHTML = `<div class="page-head"><h1>Transactions</h1><p>Full history of value movements${isAdmin ? " — filter by any user." : " you initiated."}</p></div><div id="txBody">Loading…</div>`;
  try{
    let users = [], customers = [];
    if (isAdmin){
      users = await api("/users");
      try { customers = await api("/customers"); } catch(e){}
    }
    const rows = await api("/transactions" + (txFilterUser ? "?user_id=" + encodeURIComponent(txFilterUser) : ""));
    const filter = isAdmin ? `<div class="panel"><div class="panel-body"><div class="field" style="margin:0">
      <label>Filter by user</label>
      <select id="txUser" class="input"><option value="">Everyone</option>
        <optgroup label="Staff / admin">${users.map(u => `<option value="${u.id}"${String(txFilterUser)===String(u.id)?" selected":""}>${esc(u.username)} (${esc(u.role)})</option>`).join("")}</optgroup>
        ${customers.length ? `<optgroup label="Customers">${customers.map(c => `<option value="${c.id}"${String(txFilterUser)===String(c.id)?" selected":""}>${esc(c.username)} (${esc(c.customer_type)})</option>`).join("")}</optgroup>` : ""}
      </select></div></div></div>` : "";
    $("#txBody").innerHTML = filter + txTable(rows, isAdmin);
    if (isAdmin) $("#txUser").onchange = (e) => { txFilterUser = e.target.value || null; renderTransactions(); };
  }catch(e){ $("#txBody").innerHTML = emptyState(e.message); }
}
function txTable(rows, showWho){
  const body = (rows||[]).map(m => `<tr>
    <td>${esc((m.created_at||"").replace("T"," ").slice(0,16))}</td>
    <td><span class="kind">${esc(KIND_LABEL[m.kind]||m.kind)}</span></td>
    <td>${addrHtml(m.from_address)}</td><td>${addrHtml(m.to_address)}</td>
    <td class="amt num">${fmtUsdt(m.amount)} ${esc(m.token)}${m.amount_usd!=null?`<div class="r-sub">$${fmtUsdt(m.amount_usd)}</div>`:""}</td>
    <td>${statusBadge(m.status)}</td>
    ${showWho?`<td>${esc(m.initiated_by_name||"—")}</td>`:""}
    <td class="row-actions"><button class="btn btn-ghost btn-sm" data-receipt="${m.id}">Receipt</button></td></tr>`).join("");
  return `<div class="panel"><div class="panel-head"><h2>History <span class="cnt">${(rows||[]).length}</span></h2></div>
    <div class="panel-body flush">${body ? `<div class="tbl-wrap"><table><thead><tr><th>Date (UTC)</th><th>Type</th><th>From</th><th>To</th><th class="amt">Amount</th><th>Status</th>${showWho?"<th>By</th>":""}<th></th></tr></thead><tbody>${body}</tbody></table></div>` : emptyState("No transactions.")}</div></div>`;
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
async function renderSettings(){
  const sec = $("#sec-settings");
  sec.innerHTML = `<div class="page-head"><h1>Settings</h1><p>Operational configuration, keys, and policy.</p></div><div id="stBody">Loading…</div>`;
  try{
    const c = await api("/admin/config");
    $("#stBody").innerHTML = `
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

    <div class="panel"><div class="panel-head"><h2>Network &amp; keys</h2></div><div class="panel-body">
      <div class="form-grid">
        <div class="field"><label>Network</label><select id="cfgNet" class="input">
          <option value="mainnet"${c.tron_network==="mainnet"?" selected":""}>Mainnet (live funds)</option>
          <option value="nile"${c.tron_network==="nile"?" selected":""}>Nile testnet</option>
          <option value="shasta"${c.tron_network==="shasta"?" selected":""}>Shasta testnet</option></select></div>
        <div class="field"><label>TronGrid API key</label>
          <input id="cfgKey" class="input mono" placeholder="${c.has_trongrid_key?esc(c.trongrid_api_key_masked)+'  (leave blank to keep)':'required for mainnet'}">
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
    </div></div>

    <div class="panel"><div class="panel-head"><h2>Security</h2></div><div class="panel-body">
      <div class="hint">The wallet encryption key and app secret live in server config / your KMS and are never shown or editable here — changing the encryption key would make existing wallets unrecoverable.</div>
    </div></div>

    <button class="btn btn-primary" id="cfgSave">Save settings</button>`;
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
      };
      const key = $("#cfgKey").value.trim(); if (key) body.trongrid_api_key = key;
      act(() => api("/admin/config", {method:"POST", body}), "Settings saved", renderSettings);
    };
  }catch(e){ $("#stBody").innerHTML = emptyState(e.message); }
}

/* ---------- QR modal ---------- */
function ensureQrModal(){
  if ($("#qrBack")) return;
  const d = document.createElement("div");
  d.id = "qrBack"; d.className = "modal-back";
  d.innerHTML = `<div class="modal" style="max-width:300px">
    <div class="modal-head"><h3 id="qrTitle">Address</h3></div>
    <div class="modal-body" style="text-align:center"><div id="qrBox" class="qr-box" style="display:inline-block"></div>
      <div class="recv-addr" id="qrAddr" style="margin-top:12px"></div></div>
    <div class="modal-foot"><button class="btn btn-ghost" id="qrClose">Close</button></div></div>`;
  document.body.appendChild(d);
  $("#qrClose").onclick = () => d.classList.remove("show");
  d.addEventListener("click", (e) => { if (e.target === d) d.classList.remove("show"); });
}
function showQr(address, label){
  ensureQrModal();
  $("#qrTitle").textContent = label || "Address";
  $("#qrAddr").textContent = address;
  const box = $("#qrBox"); box.innerHTML = "";
  try { new QRCode(box, { text: address, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M }); } catch(e){}
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

(async () => {
  if (state.token){ try { await boot(); } catch { doLogout(); } }
  else { $("#login").style.display = "grid"; }
})();

})();
