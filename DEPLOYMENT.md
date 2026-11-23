# Cloudflare + Firebase deployment and migration runbook

## Status: migration required; do not deploy this application yet

The requested target is Cloudflare Workers with Firebase as the sole system of record for authentication and application data. The checked-out application has not yet been migrated to that architecture. It is still an Express/EJS application with SQLite as its primary database and Firebase Admin/Firestore as a best-effort replica. Deploying it to Workers now would not make Firebase authoritative and is expected to fail: the app imports `better-sqlite3`, uses file-backed sessions, and writes identity uploads to disk.

This checkout also lacks Cloudflare account credentials and Firebase server credentials. No Cloudflare deployment has been attempted. Do not send real users, financial information, credentials, or identity documents to a preview or production deployment.

## What must change before a Cloudflare preview can run

1. **Firebase Authentication becomes the only authentication authority.** Replace the locally stored passwords, login, registration, password reset, and session identity in `routes/auth.js`, `middleware/auth.js`, and `routes/user.js` with Firebase Authentication. A Worker-side session must be backed by verified Firebase ID tokens, not by a local user database or a locally persisted session store. Use secure, HttpOnly, Secure, SameSite cookies where a server-managed browser session is needed. Protect state-changing routes against CSRF and rotate/expire sessions correctly.
2. **Firestore becomes the only application-data authority.** Replace all SQL reads and writes in `database.js`, `middleware/auth.js`, `services/firestore-sync.js`, and the route files with a documented Firestore repository and explicit document schema. The current code has over 300 SQL call sites across the routes. Reads must not fall back to SQLite; writes must not commit locally and sync later. Any operation touching more than one document needs a Firestore transaction or a deliberate idempotent workflow. Monetary values must use integer minor units and ledger entries must be immutable.
3. **Firebase Admin access must be Worker-compatible.** The existing `firebase-admin` Firestore integration is not an approved Workers adapter. Cloudflare’s Express-on-Workers guide demonstrates an Express Worker using the Worker HTTP handler and `nodejs_compat`, but the current application additionally uses native SQLite and file-backed middleware. The Worker migration must replace unsupported dependencies and validate the final bundle locally. Firebase REST APIs are available from Workers; if using privileged REST access, service-account secrets must be held only as Cloudflare Worker secrets and least-privilege IAM must be configured. Never place a service-account key in source code or browser assets.
4. **Identity documents must never touch the Worker filesystem.** Replace Multer disk storage in `routes/kyc.js` with a private Firebase Storage upload flow. Enforce file size/type checks, authorization, malware scanning, access logging, retention, and deletion policy. Firebase Storage rules must deny public access.
5. **Remove all local persistence dependencies and paths.** Once replacement adapters and tests are in place, remove `better-sqlite3`, the SQLite database and schema initialization, `express-session`, `session-file-store`, and all local session/upload writes. Check that no import of `database.js`, local-file fallback, or local-first-then-sync behavior remains. Keep only immutable build assets in the Worker bundle; those are not application data stores.
6. **Review all banking-style workflows.** Transfer, bill-pay, cards, loans, and admin routes currently contain demo or simulated behavior. A Firebase migration does not make these real financial services. Do not enable real funds or represent these operations as live banking without licensed providers, exact-money accounting, authorization, idempotency, reconciliation, audit controls, compliance sign-off, and independent security testing.

## Data migration decision

The local SQLite database is ignored by Git and is not included in source control. The user has not specified whether its records should be imported or discarded, or reconfirmed which Firebase project is the destination. The app currently contains a fallback Firebase project ID (`unitedcb-4845b`), but that alone is not authorization to import records into that project.

Do not delete, bulk-import, or overwrite records. Before migration, confirm the target project and whether existing records are to be migrated or abandoned. Any approved migration must be a one-time, reviewed script with dry-run mode, record counts, per-collection mapping, duplicate handling, idempotency, integrity checks, access controls, backup/rollback strategy, and a reconciliation report. Do not use ordinary application startup to backfill or reconcile data.

## Cloudflare preview deployment — only after the Worker migration is implemented

Cloudflare documents Express on Workers using Wrangler, a Worker HTTP server handler, and Node compatibility. Static assets are configured separately in Wrangler and should not be confused with writable persistent storage. Firebase documents user ID-token verification and a Firestore REST API suitable for environments where a full server SDK is unavailable. The repository does not yet contain the required Worker entry point or Worker-compatible Firebase adapter, so the commands below are preparation steps rather than a working deploy recipe.

1. Connect the approved GitHub repository to the intended Cloudflare account and confirm that Preview uses a non-production hostname.
2. Confirm the Firebase project and configure Auth providers. Add only the preview Worker hostname to Firebase Auth’s authorized domains. Configure Firestore rules, Storage rules, indexes, and account roles in that project. Use synthetic test accounts and documents only.
3. Implement and test the Worker entry point, Wrangler configuration, static asset manifest, token verification/session flow, Firestore repository, and Firebase Storage integration. Store secrets with Wrangler’s secret manager; do not put values in `wrangler.toml`, source files, `.env` checked into Git, or client bundles.
4. Run dependency installation, unit/integration tests, syntax/type checks, production dependency audit, and a local Workers runtime test. Tests must prove that no SQL adapter, local filesystem write, local session store, or Firestore fallback path is reachable.
5. Only after the above checks pass, use an authenticated Cloudflare CLI session to run a non-production preview deployment. Inspect the diff and bindings before deploying. Run smoke tests for Auth, authorization boundaries, Firestore reads/writes, file upload/access controls, CSRF/session expiry, static assets, and logs using synthetic data.
6. Keep production data and public-domain promotion disabled until the financial/legal/security gates above are signed off. Production promotion requires a separate explicit approval.

Cloudflare’s current Express Worker setup uses `nodejs_compat` where required and the Worker's HTTP server handler; consult the official guide for the compatibility date current at implementation time. Do not copy a stale compatibility date from this document.

## Current verification state

The previous local hardening pass passed `npm ci`, eight tests, JavaScript syntax checks, `npm audit --audit-level=low`, and `git diff --check`. Those checks validate only the existing Node/SQLite application and its fail-closed guards. They do **not** validate a Cloudflare Worker build, Firebase-only persistence, or a deployment. Rerun all checks after the migration and add Worker-runtime integration tests.

## References

[1]: https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/ "Deploy an Express application on Cloudflare Workers"
[2]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/ "Cloudflare Workers Node.js compatibility"
[3]: https://developers.cloudflare.com/workers/static-assets/ "Cloudflare Workers static assets"
[4]: https://firebase.google.com/docs/admin/setup "Firebase Admin SDK setup"
[5]: https://firebase.google.com/docs/auth/admin/verify-id-tokens "Firebase ID token verification"
[6]: https://firebase.google.com/docs/firestore/use-rest-api "Cloud Firestore REST API"
[7]: https://firebase.google.com/docs/reference/rest/auth "Firebase Authentication REST API"
