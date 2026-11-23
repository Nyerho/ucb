# UCB Cloudflare Workers redeploy notes

## Current state

The repository is prepared for a Cloudflare Worker build and a protected preview. No Cloudflare deployment was triggered from this task. The `wrangler.toml` Worker name now matches the CI name `ucb`, and its custom build hook precompiles all EJS templates before Wrangler packages the Worker. The templates are included as read-only text modules so Express can locate them; the Worker renderer uses the generated registry instead of runtime `new Function` evaluation. Routes are statically imported for Wrangler compatibility.

This preparation does not make UCB production-ready for financial services. The production Worker allows only `POST /auth/login` so existing Firebase users can authenticate; registration, password reset, and all other mutating requests remain blocked with HTTP 503. `/api/health` intentionally reports `not_ready` with reason `durable_store_unconfigured`. A successful admin login grants read access to customer, account, transaction, and KYC records, so use only an approved non-production Firebase project with synthetic data. Do not enable real transfers, payments, or identity-document workflows.

## Cloudflare Workers Builds settings

Use the repository `Nyerho/ucb`, branch `main`, and root directory `/`.

- **Build command:** `None` is okay. Wrangler runs the `[build]` hook in `wrangler.toml` automatically as part of `wrangler deploy`; the hook runs `npm run compile:worker-views`.
- **Deploy command:** `npx wrangler deploy`.
- **Worker name:** `ucb`, matching `wrangler.toml`.
- **Node.js version:** pinned to `22.23.4` in `.nvmrc`, matching the package’s Node 22 engine requirement.
- **Build variables:** none are required for compiling or bundling.
- **Build token:** keep the valid Cloudflare Workers Builds token selected for this account. Do not paste token values into the repository.

The Firebase values used by the app are runtime configuration, not build variables. Configure them in the Worker’s Cloudflare **Settings → Variables & Secrets** when needed for an approved non-production Firebase project: `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_STORAGE_BUCKET`, and `SESSION_ENCRYPTION_KEY`. Store private keys and the session key as secrets, never in Git, `wrangler.toml`, or the build-variable panel. For preview, use a non-production Firebase project and synthetic accounts.

## Verify locally before redeploying

From the repository root, run:

```sh
npm ci
npm test
npm run build:worker
```

For a local Worker runtime smoke test, run `NODE_ENV=production npx wrangler dev --local` using a synthetic Firebase account, then check a rendered page such as `/contact`, a static asset such as `/css/style.css`, `/api/health`, and a harmless POST to a non-login route. Expected behavior: rendered/static responses succeed, login is handled by Firebase, health returns `503`, and all non-login mutations return `503`.

Wrangler’s custom build command runs before both `wrangler dev` and `wrangler deploy`; Workers Builds’ separate Build command is optional. See Cloudflare’s [Wrangler custom builds](https://developers.cloudflare.com/workers/wrangler/custom-builds/) and [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## Production boundary

A passing Worker build confirms compatibility and packaging, not banking, legal, or security readiness. Do not remove the mutation and readiness gates to make health checks appear green. Do not enable real transfers, payments, cards, loans, or identity-document handling without appropriate licensed providers, exact-money ledger controls, authorization and idempotency review, reconciliation, audit controls, compliance approval, and independent security testing.
