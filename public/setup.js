(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let net = "mainnet";

  document.querySelectorAll(".opt").forEach((o) => {
    o.onclick = () => {
      document.querySelectorAll(".opt").forEach((x) => x.classList.remove("sel"));
      o.classList.add("sel");
      net = o.dataset.net;
      $("apiKeyField").style.display = net === "mainnet" ? "" : "none";
    };
  });

  function val(id) { return $(id).value.trim(); }
  function numVal(id) { return $(id).value; }

  $("go").onclick = async () => {
    $("err").textContent = "";
    const username = val("username"), password = $("password").value, password2 = $("password2").value;
    if (username.length < 3) return ($("err").textContent = "Username must be at least 3 characters.");
    if (password.length < 8) return ($("err").textContent = "Password must be at least 8 characters.");
    if (password !== password2) return ($("err").textContent = "Passwords do not match.");
    if (net === "mainnet" && !val("trongrid_api_key")) return ($("err").textContent = "A TronGrid API key is required for mainnet.");

    const body = {
      username, password, tron_network: net,
      trongrid_api_key: val("trongrid_api_key"),
      usdt_contract: val("usdt_contract"),
      sweep_min_usdt: numVal("sweep_min_usdt"),
      gas_fund_trx: numVal("gas_fund_trx"),
      disbursement_float_usdt: numVal("disbursement_float_usdt"),
      max_disburse_usdt: numVal("max_disburse_usdt"),
      poll_interval_seconds: numVal("poll_interval_seconds"),
    };
    const btn = $("go"); btn.disabled = true; btn.textContent = "Setting up…";
    try {
      const res = await fetch("/api/setup", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Setup failed");
      $("encKey").textContent = data.wallet_enc_key;
      $("form").hidden = true; $("done").hidden = false;
      window.scrollTo(0, 0);
    } catch (e) {
      $("err").textContent = e.message;
      btn.disabled = false; btn.textContent = "Complete setup";
    }
  };

  $("copyKey").onclick = () => {
    navigator.clipboard.writeText($("encKey").textContent).then(() => {
      $("copyKey").textContent = "Copied";
      setTimeout(() => ($("copyKey").textContent = "Copy key"), 1500);
    });
  };
})();
