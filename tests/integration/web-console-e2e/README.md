# Web Console E2E Suite

End-to-end tests for the `/api/v1` web console, run against a **real PostgreSQL
database** and the **real app** booted through the full production activation
gate. This is the regression baseline for the console rewrite — run it before and
after console/UI changes.

## Run

```bash
# HTTP breadth suite — boots an isolated app + DB, forges sessions at every tier,
# exercises every endpoint, tears down. Fully self-contained.
npm run test:console-e2e

# Real browser auth lifecycle — local-password login -> enroll TOTP -> step-up ->
# step-down -> logout (uses system Google Chrome). Boots its own isolated app.
npm run test:console-e2e:auth

# Target an already-running instance instead of auto-booting (dev loop):
E2E_BASE_URL=http://localhost:3001 \
E2E_DATABASE_ADMIN_URL='postgres://user:pw@localhost:5432/db' \
E2E_OPAQUE_HMAC_KEY='<base64>' \
npm run test:console-e2e:attach
```

Prerequisites: the dev PostgreSQL container reachable on `localhost:5432` with a
superuser (defaults to `dollhouse:dollhouse`, override via `E2E_PG_SUPERUSER_URL`).
The HTTP suite uses port **3101** / db `dollhousemcp_console_e2e`; the Playwright
suite uses port **3102** / db `dollhousemcp_console_e2e_pw` — neither collides
with the manual `docker/poc` smoke setup (`:3001`).

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
  login / TOTP / step-up code that forging skips.

## Findings

Issues surfaced by this suite are tracked in
`/dollhouse/docs/web-console/WEB-CONSOLE-E2E-FINDINGS.md`.
