# License server (VENDOR ONLY — do not deploy to customers)

Signs licenses and collects per-transaction usage for billing.

## Keys
`keys/private.pem` signs licenses — **keep secret**. `keys/public.pem` is embedded in the app
(`src/license.js` DEFAULT_PUBKEY). Rotate for production: generate your own keypair, replace both.

```bash
node -e 'const c=require("crypto"),fs=require("fs");const k=c.generateKeyPairSync("ed25519");fs.writeFileSync("keys/private.pem",k.privateKey.export({type:"pkcs8",format:"pem"}));fs.writeFileSync("keys/public.pem",k.publicKey.export({type:"spki",format:"pem"}));console.log(k.publicKey.export({type:"spki",format:"pem"}));'
# paste the printed public key into src/license.js (DEFAULT_PUBKEY) of the app you ship.
```

## Run
```bash
npm install
ADMIN_TOKEN=your-secret PORT=9000 npm start
```

## Mint a license for a customer
```bash
# via CLI:
node mint.js --licensee "Acme Pay" --plan pro --days 365 --billing prepaid \
  --included 10000 --price 0.10 --report-url https://license.yourco.com/usage --out acme.license.key
# or via API:
curl -s -XPOST localhost:9000/issue -H "Authorization: Bearer your-secret" -H "Content-Type: application/json" \
  -d '{"licensee":"Acme Pay","plan":"pro","days":365,"billing":"prepaid","included_transactions":10000,"price_per_txn":0.10,"report_url":"https://license.yourco.com/usage"}'
```
Give the customer the token. They set `LICENSE_KEY=<token>` (or save it as `data/license.key`) and run
the app with `LICENSE_ENFORCE=1`.

## See a customer's billable usage
```bash
curl -s localhost:9000/usage/lic_xxxx -H "Authorization: Bearer your-secret"
```

## Billing models
- **prepaid**: `included_transactions` per month; the app blocks payouts once exhausted until you re-issue/top-up.
- **postpaid**: unlimited; you invoice by the `total_transactions` reported here × `price_per_txn`.
