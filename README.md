# payment-gateway-api

The Paywize gateway: REST API + the hosted checkout page.

```
/pg/*        the API paywize-pg calls   (secret key required)
/checkout    the page paywize-js opens  (no secret; scoped to a session id)
```

## Run

```bash
npm install
npm run dev          # http://localhost:8080
```

## Test credentials

```
x-client-id:     TEST_paywize_clientid_demo
x-client-secret: cfsk_TEST_paywize_secret_demo_00000000
```

## Deploy (Render)

- Build: `npm install && npm run build`
- Start: `npm start`
- Env: `PORT` (Render sets it), `CORS_ORIGINS`, `MERCHANT_WEBHOOK_URL`

## Note on storage

State is in memory — restart and it is gone. That is deliberate: it keeps the repo
deployable with no database while you build and test the SDKs. A real gateway puts
orders, payments and a double-entry ledger in Postgres.
