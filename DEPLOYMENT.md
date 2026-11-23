# UCB Cloudflare Workers redeploy notes

## Current state

The repository is prepared for a Cloudflare Worker build. `wrangler.toml` names the Worker `ucb`; its custom build hook runs `npm run compile:worker-views`, and the Worker renderer uses the generated EJS registry. Templates are packaged as text modules and routes are statically imported for Wrangler compatibility.

No live Firebase write was performed during development or local validation. The admin console reads real Firebase records when configured; there is no synthetic customer or financial data. Build/test success is not evidence of Firebase connectivity, settlement-provider connectivity, regulatory approval, or production banking readiness. `/api/health` intentionally reports `not_ready` with reason `durable_store_unconfigured`.

## Production write boundary

In production, `POST /auth/login` is permitted, along with only these admin route patterns:

- `/admin/users/create`
- `/admin/users/:id/update`, `/admin/users/:id/freeze`, `/admin/users/:id/unfreeze`, `/admin/users/:id/disable`, `/admin/users/:id/restore`, `/admin/users/:id/password-reset`, and `/admin/users/:id/accounts`
- `/admin/accounts/:id/update`, `/admin/accounts/:id/status`, and `/admin/accounts/:id/balance-adjustment`
- `/admin/cards/:id/status`
- `/admin/approvals/{kyc,transfers,cards,loans,bills}/:id/review`

These exact patterns are shared by the production financial and Worker persistence gates through `lib/admin-safe-write-allowlist.js`. Every admin write is behind `requireAdmin` and `requireSessionEncryptionReady`; the workflow rechecks that the acting administrator is still enabled and writes its audited changes through Firestore transactions. Unlisted mutations remain blocked. Do not broaden the allowlist to make unrelated writes work.

The allowed workflows create Firebase Auth-backed customer identities and zero-balance accounts; edit limited customer/account metadata; freeze, disable, restore, or request a Firebase password-reset email for customers; open zero-balance accounts; change account/card status; record bounded balance adjustments as an account update plus transaction, ledger entry, notification, idempotency record, and audit entry; and review KYC, pending transactions/transfers, bill payments, card applications, and loan applications. There is no hard-delete, transaction-history edit, backdate, or direct unrestricted balance write route.

Per-operation defaults are `ADMIN_MAX_ADJUSTMENT_MINOR=1000000` (AUD 10,000) and `ADMIN_MAX_SETTLEMENT_MINOR=10000000` (AUD 100,000). Optional overrides must be positive safe integers expressed in minor units. Reasons and supporting references are required where applicable; duplicate account-opening and balance-adjustment submissions are idempotent by operation ID.

### Provider and financial limitations

No bank, biller, card issuer, or lender integration is configured. Approval forms record manual administrative outcomes; they do not transfer funds or contact an external provider. Transfer, deposit, withdrawal, bill, and loan-disbursement approvals require a settlement/funding reference, but the application only validates its format and records the administrator-supplied value—it cannot independently verify the external settlement. Review the actual provider evidence out of band before approving.

Card approval is recorded as `awaiting_issuer` with `fulfillment_status=manual_pending`; activation is blocked unless trusted issuer fulfillment has been recorded as `fulfillment_status=issued`. No issuer connection or admin-side issuer confirmation endpoint is implemented. KYC approval requires the administrator to download/review the customer's real Firebase Storage documents, attest to that review, and pass Storage existence checks; the KYC status and customer verification flag are updated atomically with the audit entry. Customer-facing KYC submission remains subject to the separate production PII gate.

These administrative tools do not substitute for settlement reconciliation, dual control, fraud/AML review, lending underwriting, issuer fulfillment, legal/compliance approval, or independent security testing. Do not treat a green Worker build as authorization to process live financial decisions.

## Cloudflare Workers Builds settings

Use repository `Nyerho/ucb`, branch `main`, and root directory `/`.

- **Build command:** `None` is okay. Wrangler runs the `[build]` hook in `wrangler.toml` during `npx wrangler deploy`.
- **Deploy command:** `npx wrangler deploy`.
- **Worker name:** `ucb`, matching `wrangler.toml`.
- **Node.js version:** pinned to `22.23.4` in `.nvmrc`, matching the package's Node 22 engine requirement.
- **Build variables:** none are required to compile or bundle the Worker.
- **Build token:** select the valid Cloudflare Workers Builds token for this account. Never store token values in the repository.

## Cloudflare runtime variables and secrets

Configure these in the Worker environment under **Settings → Variables & Secrets** for the approved Firebase project:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_API_KEY`
- `FIREBASE_STORAGE_BUCKET`
- `SESSION_ENCRYPTION_KEY` (at least 32 characters; supported fallback: `SESSION_SECRET`)
- Firestore/Storage service account as either `FIREBASE_CLIENT_EMAIL` plus `FIREBASE_PRIVATE_KEY`, or `FIREBASE_SERVICE_ACCOUNT_JSON` with `project_id`, `client_email`, and `private_key`.

An explicit `FIREBASE_PROJECT_ID` overrides the ID inside service-account JSON. Store private keys and the session-encryption key as secrets, never in Git, `wrangler.toml`, or build variables. The service account is privileged and bypasses Firestore Rules; grant only the required access, protect it as a production credential, and restrict access to Worker bindings. Admin-created customer onboarding and password-reset emails also require Firebase Email/Password Authentication to be enabled and a functioning Firebase email action configuration. KYC document review requires the service account to read the approved Storage bucket.

Optional financial caps are `ADMIN_MAX_ADJUSTMENT_MINOR` and `ADMIN_MAX_SETTLEMENT_MINOR`; their values are integer minor units, not dollar amounts. If omitted, the code defaults above apply.

## Verify locally before redeploying

From the repository root, run:

```sh
npm ci
npm test
npm run build:worker
```

For a local Worker runtime smoke test, run `NODE_ENV=production npx wrangler dev --local`, then check a rendered page such as `/contact`, a static asset such as `/css/style.css`, and `/api/health`. Avoid submitting admin forms or creating records against any live Firebase project during a smoke test. Expected health status is `503` while durable storage is unconfigured; only login and the exact admin POST patterns above may reach their guarded handlers.

A dry-run build packages and validates the Worker but does not prove live Firebase credentials or Storage access. Actual redeployment is a separate, externally visible operation and must not be inferred from local validation.

## Production boundary

The new admin workflows have not been exercised against live Firebase data. Before relying on financial operations, verify the exact Firebase project and Cloudflare secrets, obtain the required financial/compliance/security approvals, and confirm the relevant provider procedures. A successful Git push or Worker deployment does not substitute for live Firebase, provider, compliance, or security validation.
