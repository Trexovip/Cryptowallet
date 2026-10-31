# KryvonWallet — custodial USDT (TRC-20) platform

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

## Customers

Admins and staff can create two kinds of customer (who log in to the same URL and
get a read-only portal — no payout controls):

- **Depositor** — automatically gets a TRC-20 deposit address. In their portal they
  see the address (with QR) and their full deposit history. Deposits sweep to treasury
  as usual.
- **Remittance** — has one or more **whitelisted** payout addresses. Staff send USDT
  only to those addresses (a payout to a non-whitelisted address is rejected); an admin
  approves it like any other payout. In their portal the customer sees the funds they've
  received — what, when, and how much — and can open/print a receipt for each.

Manage all of this under **Customers** in the console: create customers, add/remove
whitelist addresses, and send a customer payout. Customers cannot create payouts,
view other customers, or see the audit log.

## Transaction history

- **Admin** gets a **Transactions** screen showing every value movement (deposits, sweeps,
  pool top-ups, payouts, treasury sends) with date, type, from/to, amount in USDT and USD,
  status, and who initiated it — plus a **filter by user** (any staff member or customer).
- **Per-user drill-down**: a Transactions button on each row in the Staff and Customers lists
  jumps straight to that person's history.
- **Staff** see the same screen scoped to their own activity only. **Customers** see their own
  history in their portal (deposits for depositors, received transfers for remittance).
- Every row opens a printable receipt.

## Address book, treasury & approvals

- **Address book** — save labelled destination addresses (Address book screen). Each has
  a copy button and a QR code, and saved addresses appear as suggestions when staff fill
  in a payout recipient.
- **Treasury distribution** — on the Wallets screen, admins can **Distribute to pool**,
  which splits the treasury's USDT evenly across all pool wallets while holding back a
  configurable percentage (default 10%) in treasury.
- **Admin send (choose the source)** — admins can send USDT to any address, choosing the
  source: the **treasury** or any **pool (normal) wallet**. It goes out immediately with no
  approval step. Staff can never send from the treasury or use this direct send — staff move
  funds only through the normal payout flow (subject to the auto-approve limit).
- **Admin payouts** — admins can make a payout straight from the Payouts screen; it executes
  immediately from the pool, no approval needed.
- **Auto-approve limits, global and per-staff** — Settings holds a *default* staff limit;
  each staff member can be given their own limit on the Staff screen (blank = use the default).
  A staff payout at or below their limit is sent immediately; above it, it waits for admin
  approval; an admin can approve any amount. A staff member's limit is their hard cap for
  sending without approval — set it as high as you need (e.g. lakhs/millions of USDT).

## Admin settings & controls

The **Settings** screen (admin) now exposes the full operational config, editable live:

- **Network & keys** — switch network (mainnet/nile/shasta), rotate the **TronGrid API key**
  (shown masked; leave blank to keep), change the **USDT contract**, and tune min-sweep,
  gas top-up, pool float, and the deposit scan interval. Switching to mainnet requires a key.
- **Policy** — default staff auto-approve limit, treasury hold-back %, and a new **deposit fee %**
  (shown on deposit receipts as fee + net credited).
- The wallet **encryption key and app secret are never shown or editable** here (changing the
  encryption key would make existing wallets unrecoverable) — manage those in server config / KMS.

**User controls** (Staff screen): per-staff auto-approve limits, **enable/disable a user**
(disabled users are blocked from signing in; you can't disable yourself or the last admin),
and **reset a user's password**.

## Available-to-send & QR codes

- **Branded QR card**: any QR dialog can **Copy**, **Download**, or **Share** a composed card
  showing your **logo in the centre of the QR**, the **wallet name**, the **customer name**, and the
  **address** — as a PNG (share uses the device share sheet on mobile).

- The **Payouts** screen shows an **Available to send** figure — total USDT across the treasury
  and all pool wallets — so staff can see the ceiling before attempting a large payout.
- **QR codes** are available for every wallet — treasury, gas, pool, deposit, and customer
  deposit addresses (and saved address-book entries) — via a **QR** button.
- Admins can reveal the **private key** of customer deposit wallets too (Customers → Manage, or
  the Wallets → Deposit addresses table), audit-logged like all key reveals.

## How a payout is funded

Payouts **rotate through the pool wallets in round-robin order** — each payout uses the next wallet, not always the first. If the rotated wallet is short, it's topped up (treasury first, then other pool wallets) and then pays out.

## How a payout is funded

Every payout reaches the recipient in **one on-chain transfer from a single pool wallet** (never
from the treasury directly). Selection works like this:

1. If a pool wallet already holds enough, one is chosen **at random** among those that do.
2. If none holds enough, the system **consolidates** into one wallet — pulling from the
   **treasury first**, then from other **pool wallets** — until it covers the amount, then sends.
   So a 50,000 payout works whether the funds sit in the treasury, are spread across pool
   wallets (e.g. 5 × 10,000), or a mix.
3. If the **total** liquidity across treasury + pool still can't cover it, the payout is rejected
   with a clear "insufficient liquidity" message (it is not partially sent).

Keep the gas wallet funded with TRX, since each internal consolidation transfer and the final
payout consume a little TRX.

## Wallet names

- **In-app name**: every wallet has a Name button to set a display name (and optionally write it
  on-chain).
- **Customer wallets on-chain**: new customer deposit wallets are automatically given a per-customer
  on-chain TRON account name from a template (default **`KryvonWallet-{id}`**; placeholders `{id}`,
  `{username}`, `{app}`; blank turns it off) — set in Settings → Branding. Use **Apply to existing
  customer wallets** to name wallets created earlier. A TRON account name can be set only **once**,
  can't be changed, and costs a little TRX; Tronscan's public *label* is curated separately (see below).
- **Tronscan public tag**: on the Treasury/Gas wallet rows, **Tronscan** generates the signed
  ownership proof (message + signature) Tronscan needs to grant a public name tag. See
  `Tronscan-NameTag-Application.md` for the full application pack and submission steps.

Every wallet (treasury, gas, pool, deposit) has a **Name** button (admin). You can:
- set an **in-app display name** (rename anytime; shows throughout the console), and optionally
- write the name **on-chain** (TRON account name). Note: an on-chain name can be set **only once
  and never changed**, costs a little TRX, and the account must be activated first. Tronscan's
  prominent public label is curated by Tronscan (verified entities apply for it), so a self-set
  on-chain name is not guaranteed to appear there.

## Full backup (customers + wallets + transactions)

Backup & restore → **Full backup** exports a complete snapshot — **customers** (with whitelists,
staff assignments and their login hash), **staff**, **all wallets with private keys**, and the
**transaction history** — as one JSON file. **Restore** re-creates any missing customers/staff first,
then imports wallets and **maps each wallet back to its customer by username**, then imports the
ledger. Everything is de-duplicated, so re-importing is safe and nothing moves on-chain. (The
wallet-only backup is still there for quick key export/import.)

## Managing wallets (import, remove, re-add)

- **Import to a customer**: a customer's **Manage** page has *Import a deposit wallet* (add an
  existing address as that customer's deposit wallet). The admin **Wallets → Import** panel also has
  an *Owner* picker (staff or customer) for deposit imports.
- **Remove / re-add**: every wallet has a **Remove** action — a soft-delete that stops the wallet
  receiving sweeps or sending payouts while keeping its history. Removed wallets appear in a
  **Removed wallets** section with **Re-add**. Only one active treasury and one active gas wallet are
  allowed at a time.

## Payment links

Every customer gets a unique **payment link** (Customers → Manage, and the staff "My customers"
screen). Opening it shows a **public, branded page** — your logo/name, the customer's name, their
**deposit address and a logo-in-the-middle QR**, and a copy button — so anyone can pay that
customer in USDT (TRC-20). The link uses an unguessable token (no login, nothing sensitive beyond
the receive address, which is public). Remittance customers have no deposit address, so their link
shows a "contact support" message instead.

Share dialogs also produce a polished **branded QR card** (logo-in-QR, wallet/customer name, and
address) you can download or send.

## Staff visibility

Staff see **only their assigned customers** and **only transactions involving those customers**
(their deposits and payouts) plus anything the staff member initiated. Admins see everyone. Assign
customers to staff from a customer's Manage page.

## Staff assignments & messaging

- **Assign customers to staff** (admin, Customers → Manage → Assigned staff). A customer can be
  assigned to multiple staff.
- **My customers** (staff): each assigned customer with their **total received**, recent activity,
  a **Messages** button, and a **WhatsApp** button.
- **In-app messaging**: a chat thread per customer between the customer and their assigned staff
  (and admins) — normal chat, **Send receipt** (staff), and **Acknowledge received** (customer).
  Access is enforced: staff only see threads for customers assigned to them.
## Backup & restore (all wallets)

A **Backup** page (admin) exports **every wallet** — type (treasury / gas / pool / customer),
label, address, and **private key** — as a single JSON file, and imports it back:

- **Export** as **JSON** (`kryvonwallet-wallets-backup.json`) or **CSV** (`...-backup.csv`). Both
  contain all private keys, so store them encrypted/offline — anyone with them controls every wallet.
- **Import** accepts a JSON **or CSV** file (or pasted JSON/CSV; CSV columns: `type,label,address,owner,private_key`). It recreates wallets, re-links customer deposit
  wallets to their owner by username, skips any address that already exists and a second treasury,
  and does **not** pre-fund imported wallets (they already hold their on-chain balances).

Admin-only; every export and import is written to the audit log.

## Advanced features

- **Private key export / import** — admins can reveal any wallet's private key (admin-only,
  audit-logged, with a warning) to back up or import into an external TRON wallet, and import
  an existing key as a treasury/pool/gas/deposit wallet. Keys stay AES-256-GCM encrypted at rest.
- **Reports & charts** — a Reports screen with deposit/payout volumes, a deposits-vs-payouts
  trend chart, top customers, and payout volume by user, plus CSV export.
- **Dual-control approvals** — set a USDT threshold; payouts at/above it require a *second,
  distinct* admin to approve before they execute.
- **Webhooks** — set a URL and the system POSTs `deposit.received` and `payout.sent` events to it.
- **Allow-list mode** — when on, pool payouts are only allowed to address-book / whitelisted
  addresses (admin direct-send is exempt by design).
- **Login rate-limiting** — repeated failed logins are locked out for a cooldown window.
- **Scheduled auto-distribute** — optionally have the worker periodically distribute treasury
  surplus to the pool (respecting the hold-back %).

### Branding

Settings → **Branding**: set the **app name**, **logo** (shown in the header and in the centre of
QR codes), **favicon**, and an optional separate **QR logo**. Upload PNG/SVG (kept under ~500 KB,
stored in config). Branding is served publicly so the login and setup pages theme correctly.

## Gas & energy (lower fees)

On TRON a USDT (TRC-20) transfer costs **Energy**. If a wallet has no energy, the network **burns
TRX** for every transfer — the single biggest fee. Low-fee wallets avoid this by paying with Energy
instead. Settings → **Gas & energy** offers three strategies:

- **Burn TRX** (default): simplest, highest cost — no setup.
- **Self-staked energy**: freeze (stake) TRX on the gas wallet to produce Energy, then the app
  **delegates energy to the sending wallet automatically before each transfer** (Stake 2.0:
  `freezeBalanceV2` + `delegateResource`). Frozen TRX is recoverable by unstaking (TRON enforces an
  unstake waiting period). Set *Delegate per send* to enough frozen TRX to cover ~65,000 energy per
  USDT transfer.
- **Rent energy**: point the app at an energy-market provider endpoint (URL + API key + energy per
  transfer); the app requests energy for the sending wallet before each transfer.

The **Gas & energy** panel shows live energy available, staked TronPower, and the gas wallet's TRX,
with **Stake / Unstake** controls. Energy provisioning is best-effort: if it fails, the transfer
still goes through by burning TRX, so payouts never block.

> Exact savings and how much to stake/rent depend on your transfer volume and the network's current
> energy price — **rehearse on Nile testnet** and tune *Delegate per send* before going live.

## Auto gas top-up (swap USDT → TRX)

The gas wallet needs TRX. The platform can keep it funded automatically:

- **New wallets** are auto-funded with **20 TRX** from the gas wallet on creation (configurable as
  *wallet preload* on the Controls panel).
- **Gas auto-refill**: when the gas wallet drops **below a threshold** (default 100 TRX), the worker
  **swaps USDT → TRX** (from treasury, via **SunSwap** on mainnet) and sends the TRX to the gas
  wallet. Toggle it on/off and set the **threshold** and **USDT amount per refill** (and max
  slippage) in Settings → **Gas & energy**. There's also a **Top up gas now** button for a manual
  swap.

Notes: the on-chain swap uses the SunSwap V2 router and WTRX (both addresses configurable). It moves
real funds — **test on mainnet with a small amount first**, and keep a little TRX/energy on the
treasury so it can pay for the swap transaction. Auto-refill is **off by default** and has a 5-minute
cooldown between swaps.

## Dashboard refresh & TronGrid throttle

- **Dashboard** has a **↻ Refresh** button (forces a live read, bypassing the cache) and
  **auto-refreshes every 30s** while open, showing an "Updated HH:MM" time. Balances are cached ~15s
  and, on a rate-limit, fall back to the last known value instead of showing 0.
- **TronGrid throttle**: every chain request goes through a global queue that caps requests per
  second and concurrency (defaults `trongrid_rps: 8`, `trongrid_concurrency: 3`), so bursts (like the
  dashboard reading many wallets) won't trip the free-tier 429 limit. Tune these in config if you
  have a higher-tier key.

## Programmatic API & exports

**API keys** (admin → API keys): mint scoped keys (`read`, `deposits`, `payouts`). The key is
shown once; only a hash is stored. External systems authenticate with an `X-API-Key` header:

```
curl -H "X-API-Key: ck_live_xxx" https://your-host/api/v1/ping
```

Endpoints: `GET /api/v1/ping`, `GET /api/v1/wallets/:address/balance`,
`POST /api/v1/deposit-wallets`, `POST /api/v1/payouts` (accepts an `idempotency_key` to make
retries safe), `GET /api/v1/transactions`. API payouts follow the same auto-approve/approval
rules; anything above the limit waits for an admin. Keys can be revoked instantly.

**CSV export** (admin): download the full transaction ledger and audit log as CSV from the
Transactions and Audit screens (`/transactions.csv`, `/audit.csv`) for accounting/compliance.

.. _mysql-runtime:

## Gas-free payouts (default)

Customers are gas-free by design (custodial — they never hold TRX or sign a transaction; the platform
pays). The platform's own gas is handled automatically:

- **Default energy mode is `auto`** — before every payout/sweep the platform provisions TRON **energy**
  so transfers don't burn TRX. No per-payout configuration is required.
- **`auto` tries, in order:** (1) **rent energy via the built-in provider API**, (2) delegate
  **self-staked** energy, (3) fall back to **burning TRX** so the payout still succeeds if no energy
  source is set.
- **Make it truly gas-free with zero in-app settings** by pointing the built-in rental client at your
  energy provider via env (so you never touch the UI):
  ```bash
  ENERGY_RENTAL_URL=https://your-energy-provider/api/delegate
  ENERGY_RENTAL_API_KEY=your-key
  ENERGY_RENTAL_AMOUNT=65000     # energy per USDT transfer (~65k)
  ```
  The client POSTs `{ "address": "<wallet>", "energy": <amount> }` with `Authorization: Bearer <key>`
  and treats any 2xx as success. (Alternatively, switch to self-staked energy in Settings and freeze TRX.)
- When energy is provisioned, wallets receive only a tiny **bandwidth** top-up (`bandwidth_trx`,
  default 2) instead of a full burn top-up — keeping real TRX spend ~0.

### TronZap (built-in, recommended)

TronZap is integrated natively. To make every payout gas-free:
1. Create an API **token** and **secret** at `dash.tronzap.com` and **fund your TronZap balance** (it's prepaid).
2. Provide the credentials either in **Settings → Gas & energy → provider = TronZap**, or via env (zero in-app setup):
   ```bash
   TRONZAP_API_TOKEN=your_token
   TRONZAP_API_SECRET=your_secret
   # TRONZAP_BASE_URL=https://api.tronzap.com   # optional override
   ```
Before each payout/sweep the app calls `POST https://api.tronzap.com/v1/transaction/new` with
`Authorization: Bearer <token>` and `X-Signature: sha256(rawBody + secret)`, renting ~65,000 energy to
the sending wallet so the transfer burns no TRX. Default mode `auto` selects TronZap automatically when a
token is present. The secret is only used to sign requests and is never transmitted.

> Honest note: TRON energy is never literally free — you either rent it or stake TRX for it. `auto`
> makes the platform use the cheapest configured source automatically and always keeps payouts working;
> plug in a rental key (or stake) and payouts become gas-free with no other setup. A brand-new address
> also needs a one-time ~1 TRX activation.

## Transaction history, address search & on-chain reconciliation

- **No row cap:** the Transactions API accepts `limit=all` (or `limit=0`) to return the full history;
  the UI uses it for address searches. Date range (`from`/`to`) and `before` (id cursor) also work.
- **Search by wallet address:** `GET /transactions?address=T...` returns every movement in or out of
  that address across **all** wallets (pool, treasury, deposit) — and any external destination.
- **Reconcile from chain (Tronscan/TronGrid):** `POST /reconcile {address?}` pulls an address's full
  on-chain USDT transfer history and **inserts any transaction missing from the ledger** (classified as
  deposit / payout / treasury-out by matching your wallets). With no address it scans **all** your
  wallets. Idempotent — safe to run repeatedly. In the UI: Transactions → "Reconcile from chain".
  (Set a TronGrid API key in Settings for reliable history pulls.)

## Licensing & per-transaction billing (SaaS, self-hosted)

Deploy the app on a customer's server and bill per transaction, gated by a signed license.

- **How it works:** you mint an **Ed25519-signed license token** with `license-server/` (your private key).
  The app ships with your **public key** and verifies the token locally — customers can't forge or
  extend a license. Each payout is **metered** and reported to your license server for invoicing.
- **Install on the customer:** set `LICENSE_KEY=<token>` (or drop the token in `data/license.key`) and
  run with `LICENSE_ENFORCE=1`. **Settings → Security → License** shows status, plan, expiry, and
  transactions used this month.
- **Billing models:**
  - **prepaid** — `included_transactions` per month; payouts are **blocked** once the quota is hit
    until you re-issue/top-up.
  - **postpaid** — unlimited; invoice by the reported transaction count × `price_per_txn`.
- **Enforcement:** with `LICENSE_ENFORCE=1`, an expired (past grace) or invalid license, or an
  exhausted prepaid quota, blocks new payouts with a clear "contact your vendor" message. Metering
  always runs so usage is captured even before enforcement is turned on.
- **Your side:** run `license-server/` on your own infra (it issues licenses and ingests usage —
  `license-server/README.md` has the commands). **Never ship `license-server/` or its private key to
  customers** (it's excluded from the Docker image via `.dockerignore`).

> Note: software running on a customer's own machine can ultimately be patched by a determined
> operator. The signed license prevents forged upgrades/renewals and the usage reporting gives you
> accurate billing; combine with contracts and gating updates/support on a valid license.

## Running on MySQL / MariaDB (or SQLite)

The app runs on either **SQLite** (default, embedded, zero-config) or **MySQL/MariaDB**, chosen at
startup — the same code, tested green against both. Pick the engine with env vars:

```bash
# default — embedded SQLite in the data volume, nothing to set
DB_CLIENT=sqlite

# OR run on MySQL / MariaDB:
DB_CLIENT=mysql
MYSQL_HOST=db  MYSQL_PORT=3306  MYSQL_USER=kryvon  MYSQL_PASSWORD=secret  MYSQL_DATABASE=kryvon
# or a single URL:
MYSQL_URL=mysql://kryvon:secret@db:3306/kryvon
```

On first start the app creates its schema automatically (from `db/mysql-schema.sql` for MySQL).
`docker-compose.yml` has the env vars wired and a ready-to-uncomment `db:` MariaDB service.

**One command to run app + MariaDB together:**
```bash
docker compose -f docker-compose.yml -f docker-compose.mysql.yml up -d --build
```
This starts a MariaDB service and the app configured for it (the app waits for the DB to be healthy).
The live engine is shown in **Settings → Security → Database engine**.

**Moving existing SQLite data into MySQL** (one-time): dump with the export tool and import it.
```bash
node tools/sql-export.js --dialect mysql --out data.sql
mysql -u kryvon -p kryvon < data.sql
```
Then switch `DB_CLIENT=mysql` and restart.

> Notes: the adapter translates the few SQLite-isms to MySQL automatically (null-safe `IS ?` → `<=>`,
> `CAST(.. AS REAL)` → `DECIMAL`, and returns aggregate sums as numbers). `better-sqlite3` is still
> used for the SQLite engine; `mysql2` for MySQL.

## Using MySQL / PostgreSQL for data management

The app itself runs on an embedded **SQLite** database (in the Docker volume) — reliable and
zero-admin for a self-hosted node. To manage, report on, or centralize the data in **MySQL** or
**PostgreSQL**, use the built-in export tool, which dumps the whole database as ready-to-import SQL:

```bash
# inside the container (or locally from the project root)
node tools/sql-export.js --dialect mysql    --out kryvonwallet.mysql.sql
node tools/sql-export.js --dialect postgres --out kryvonwallet.pg.sql
# or:  npm run db:export:mysql   /   npm run db:export:postgres

# then import into your server DB
mysql -u USER -p DBNAME < kryvonwallet.mysql.sql
psql "$DATABASE_URL" -f kryvonwallet.pg.sql
```

It reads the live schema (so it always matches, migrations included), maps types, preserves primary
keys (AUTO_INCREMENT / BIGSERIAL), and escapes values. Re-run it any time to refresh the copy
(it DROPs + recreates the tables). This is a one-way export for reporting/BI/reconciliation — the app
keeps writing to SQLite.

> Running the app *directly on* MySQL/Postgres at runtime is a larger change (the data layer is
> synchronous SQLite; server DBs are async), done as a dedicated migration with a switchable adapter.
> Ask if you want that.

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

## Gas (TRX) & the "account does not exist" error

On TRON, a wallet can only **send** a TRC-20 transfer if its account is activated on-chain and
holds some **TRX** for energy/bandwidth. The system handles this two ways: every newly created
wallet is **pre-loaded with TRX** from the gas wallet (default 30, set in Settings), and any
sending wallet is **topped up again** from the gas wallet whenever it runs low. So the one thing
you must do is **keep the gas wallet funded with TRX** (Wallets → Gas wallet). If you ever see
`contract validation error ... account ... does not exist`, it means that wallet isn't yet
activated/funded — fund the gas wallet (and, once, send a little TRX to the treasury address).
For heavy volume, consider staking TRX for energy on the sending wallets to cut fees.

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
