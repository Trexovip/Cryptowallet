# USDT Custody Console — Node.js

Self-hosted custodial USDT (TRC-20) system with admin/staff roles, per-staff
deposit addresses, automatic sweeping to a master treasury, and payouts that
leave from a random disbursement-pool wallet — with a full internal audit trail.
**All configuration is done in the browser on first launch.**

## Stack
- Node.js + Express (API + serves the web console)
- better-sqlite3 (embedded database — nothing separate to install or configure)
- TronWeb (TRON / TRC-20)
- Built-in `crypto`: scrypt for passwords, AES-256-GCM for private keys at rest
- JWT auth

## Install & use

Pick one. Either way, when it's running open **http://localhost:8000/** (or
`http://your-server:8000/`) and the setup wizard runs automatically on first launch.

### Option A — Docker (recommended, truly turnkey)

Requires Docker. Nothing else to install — no Node, no build tools.

```bash
unzip usdt-custody-node.zip && cd usdt-custody-node
docker compose up -d --build
```

That's it. Data (config + database) persists in a Docker volume across restarts.
Stop with `docker compose down`; update after code changes with
`docker compose up -d --build`.

### Option B — Node directly

Requires Node.js 18+.

```bash
unzip usdt-custody-node.zip && cd usdt-custody-node
bash install.sh      # or: npm install
npm start            # listens on :8000
```

### Try it first without real funds

```bash
node demo/run-demo.js   # full lifecycle on a simulated chain — no network, no funds
```

## Browser setup (first launch)

The wizard at `/setup` collects everything the old `.env` + CLI steps used to:

1. **Admin account** — your first admin username and password.
2. **Network** — Mainnet (live) or Nile testnet, plus your TronGrid API key
   (required for mainnet) and the USDT contract (prefilled for mainnet).
3. **Advanced policy** (optional) — sweep threshold, gas top-up, pool float,
   per-payout ceiling, scan interval. Sensible defaults are filled in.

On completion the app generates the app secret and the wallet-encryption key,
writes them to `data/config.json`, creates your admin user, and starts the
background sweeper — no restart, no file editing. The setup page shows the
encryption key once so you can back it up; after that, `/setup` redirects to the
app and can't be re-run while `data/config.json` exists.

After setup, everything else happens in the console: create the treasury, gas
wallet, and disbursement pool; assign deposit addresses to staff; approve payouts.

## Try it without real funds (demo)

A self-contained demo runs the whole lifecycle against a simulated chain (no
network, no real USDT) so you can see it work before connecting mainnet:

```bash
node demo/run-demo.js
```

It writes to an isolated `.demo-data/` folder (never your real `data/`), then
drives the real setup wizard, auth, wallet generation, the sweeper, and a payout
approval, printing the dashboard, the movements ledger, and the audit log. The
simulated chain lives in `demo/mockchain.js`; the application code it exercises is
the same code that runs in production.

## Data & reset
- `data/config.json` — configuration + secrets (written `chmod 600`).
- `data/custody.db` — the SQLite database.
- To re-run setup from scratch, stop the app and delete the `data/` folder.

## Run as a service

Use systemd or pm2. Example (pm2):

```bash
npm install -g pm2
pm2 start src/server.js --name custody
pm2 save
```

Put it behind nginx with TLS, and bind Node to `127.0.0.1` (set `HOST=127.0.0.1`)
so only nginx is public.

## Running on mainnet — do these first

The wizard defaults to mainnet because that's what you asked for. Since the app
now holds keys controlling real money:

1. **Move the encryption key out of `data/config.json`** into a KMS/HSM and
   inject it at runtime. On the current setup, anyone who reads that file plus
   the database can drain the hot wallets.
2. **Keep only a working float hot** — treasury and pool hold days, not months;
   sweep the rest to cold/multisig storage.
3. **Prove it with small amounts** — run one deposit → sweep → payout cycle for a
   few dollars before real volume. (Pick Nile testnet in the wizard to rehearse.)
4. **Add 2FA for admins and daily per-staff limits**; a per-payout ceiling is
   already enforced.

## Security notes
- Private keys are AES-256-GCM encrypted at rest and never leave the server or
  appear in API responses.
- Payouts require an admin approval step and never originate from treasury.
- Every gas-funding, sweep, top-up, and payout is written to an append-only
  ledger; sensitive actions are written to the audit log.
- Get a security review of the key-handling and sweep paths before real funds.

## Legal
Custodying and moving USDT for others is VASP / money-transmitter activity. In
India that means FIU-IND registration and PMLA obligations plus KYC/AML. The
audit trail supports that; it does not replace registration or a compliance
program.

## Adding Ethereum / BSC
Implement the five functions in `src/chain.js` (`newWallet`, `usdtBalance`,
`nativeBalance`, `sendUsdt`, `sendNative`) for an EVM chain with ethers.js, and
branch on network. The rest of the app is chain-agnostic.
