# Web Console E2E Suite

End-to-end tests for the `/api/v1` web console, run against a **real PostgreSQL
database** and the **real app** booted through the full production activation
gate. This is the regression baseline for the console rewrite — run it before and
after console/UI changes.

## Run

For a standard checkout, start the repository PostgreSQL container once and run
the compiled browser gate:

```bash
docker compose -f docker/docker-compose.db.yml up -d
npm run test:console-e2e:auth:compiled
```

The browser commands run a fast prerequisite check before building or provisioning.
They require system Google Chrome and a PostgreSQL superuser on `localhost:5432`.
If Chrome, PostgreSQL, or the dedicated test port is unavailable, the command fails
immediately with a targeted setup message. It does not silently skip a requested
delivery gate, and it is not part of the normal `npm test` suite. Do not run
`npx playwright install`; this suite intentionally uses system Google Chrome.

```bash
# HTTP breadth suite — boots an isolated app + DB, forges sessions at every tier,
# exercises every endpoint, tears down. Fully self-contained.
npm run test:console-e2e

# Real browser auth lifecycle — local-password login -> enroll TOTP -> step-up ->
# step-down -> logout (uses system Google Chrome). Boots its own isolated app.
npm run test:console-e2e:auth

# Same browser suite against a fresh compiled server and dist/web-console/ui.
# This is the production-delivery gate for replacement-console changes.
npm run test:console-e2e:auth:compiled

# Supported manual development loop (isolated port 3199 + preview database).
npm run web-console:preview
npm run web-console:preview:compiled

# Target an already-running instance instead of auto-booting (dev loop):
E2E_BASE_URL=http://localhost:3001 \
E2E_DATABASE_ADMIN_URL='postgres://user:pw@localhost:5432/db' \
E2E_OPAQUE_HMAC_KEY='<base64>' \
npm run test:console-e2e:attach
```

The PostgreSQL superuser defaults to `dollhouse:dollhouse`; override it with
`E2E_PG_SUPERUSER_URL` when using a different local database. Set `E2E_PW_PORT`
to use a different browser-test port.
The HTTP suite uses port **3101** / db `dollhousemcp_console_e2e`; the Playwright
suite uses port **3102** / db `dollhousemcp_console_e2e_pw` — neither collides
with the supported preview (`:3199`) or manual `docker/poc` smoke setup (`:3001`).

## How it works

- **Auto-boot** (`setup/globalSetup.ts`): provisions an isolated DB + app role +
  grants, runs migrations, marks auth bootstrap, generates ephemeral secrets +
  readiness evidence, boots the app via `tsx`, waits for health, tears down after.
- **Sessions** (`harness/forgeSession.ts`): the HTTP suite plants
  `console_sessions` rows directly to get a session at any privilege tier
  (anonymous / user / admin-unelevated / admin-elevated) without driving login —
  the endpoints, authorization, CSRF, elevation, and idempotency middleware all
  run for real. `auth_sub` must match a seeded `auth_accounts.sub` (the auth
  middleware re-resolves the principal each request).
- **Client** (`harness/ConsoleClient.ts`): cookie + CSRF + idempotency + ETag
  aware fetch wrapper, plus SSE reading.
- **Seed** (`harness/seed.ts`): two normal users + one admin, plus
  `seedRuntimeSession()` for telemetry/SSE data.
- **Real auth** (`specs/console-auth.pw-spec.ts`): Playwright drives the actual
  login / TOTP / step-up code that forging skips. It also opens `/ui`, verifies
  the manifest and role catalog bootstrap, and proves a real tab lazy-loads with
  no failed UI asset requests. `test:console-e2e:auth:compiled` runs this against
  `dist/index.js` after a clean build.

## Findings

Issues surfaced by this suite are tracked in
`/dollhouse/docs/web-console/WEB-CONSOLE-E2E-FINDINGS.md`.
