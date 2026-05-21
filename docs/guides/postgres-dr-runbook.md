# Postgres Disaster Recovery Runbook

**Audience:** operators running DollhouseMCP with `DOLLHOUSE_STORAGE_BACKEND=database` (Postgres).
**Scope:** what to back up, how to restore to a scratch host, recovery targets, secret reconstruction, and the verification checklist.

This runbook assumes you have already followed [`deployment-configuration.md`](./deployment-configuration.md) and [`production-hosting-runbook.md`](./production-hosting-runbook.md) for initial setup. It picks up at *"the database is gone or corrupt — now what?"*.

---

## Recovery targets

Set these explicitly with your stakeholders before you need them. The defaults below are the minimum a production deployment should tolerate.

| Metric | Default target | Notes |
|---|---|---|
| **RPO** (recovery point objective — max acceptable data loss) | 24 hours | Daily `pg_dump`. Drop to 5 minutes with WAL archiving / PITR. |
| **RTO** (recovery time objective — max acceptable downtime) | 4 hours | Manual restore on scratch host + secret reconstruction. Drop to <30 min with hot-standby replica. |
| **Verification cadence** | Quarterly restore drill | Untested backups aren't backups. |

If your deployment can't tolerate 24-hour RPO, use a managed Postgres provider with PITR (RDS, Cloud SQL, Crunchy Bridge, Neon, Supabase) — most offer 5-minute RPO out of the box.

---

## Critical state — what to back up

A complete deployment depends on **two backup tracks** that must be kept synchronised. Lose one and you lose either user data or the ability to verify tokens against the data you restored.

### Track 1 — Postgres data

A `pg_dump` of the application database covers everything user-facing:

```bash
pg_dump \
  -U dollhouse \
  -h "$DB_HOST" \
  -d dollhousemcp \
  --no-owner --no-privileges \
  --format=custom \
  --file="dollhousemcp-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Or, when in-compose, run inside the container:

```bash
docker exec dollhousemcp-postgres pg_dump \
  -U dollhouse dollhousemcp \
  --format=custom > "dollhousemcp-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Tables this captures (the ones that matter for DR):

| Table | Contains | Reconstructable? |
|---|---|---|
| `auth_accounts` | User identities (sub, email, github_username, displayName) | No — would have to re-register everyone |
| `auth_allowlist` | Sign-in allowlist entries | Recreatable from `dollhouse-allowlist add` if you have the source list |
| `auth_kv` | Interactions, grants, refresh tokens, sessions, bootstrap state | Tokens / sessions expire naturally; not critical for DR but users have to re-auth |
| `auth_identity_events` | Audit log (append-only) | Lost = lost — audit gap |
| `signing_keys` | Active + rotated JWKS keys (encrypted at rest if cookie-secret rotation is on) | No — every outstanding access token becomes unverifiable |
| `operator_settings`, `user_settings` | `dollhouse_config` JSONB blobs | Recreatable from operator memory if simple |
| `element_*`, `memories`, `agents`, `ensembles`, `personas` | User portfolio content | No — user data |
| `agent_states` | Agent runtime state | Resets to default on restore — acceptable |

**Backup retention:** keep at least 7 dailies + 4 weeklies + 12 monthlies. Storage is cheap; old dumps are the only way to recover from corruption you didn't notice for a month.

### Track 2 — Secrets

These live outside Postgres and must be backed up separately. Lose them and the restored database is unverifiable.

| Secret | Source | Loss impact |
|---|---|---|
| `DOLLHOUSE_COOKIE_SIGNING_SECRET` | Env var (per-replica random if unset) | All active interaction cookies invalidated; users mid-OAuth must restart. Refresh-token IP/UA hash binding breaks. |
| `DOLLHOUSE_INVITE_TOKEN_SECRET` | Env var (per-replica random if unset) | All outstanding invite + magic-link tokens become unverifiable. |
| `DOLLHOUSE_DATABASE_ADMIN_URL` password | Env var | Admin role connection broken until rotated in Postgres. |
| `DOLLHOUSE_DATABASE_URL` password | Env var | App role connection broken until rotated in Postgres. |
| OAuth client secrets (`DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET`, `DOLLHOUSE_SMTP_PASSWORD`, etc.) | Env var | Re-issue from the upstream provider; doesn't invalidate existing user data, but the AS can't initiate new sign-ins until rotated. |
| Signing-key encryption envelope (when DB-store mode is on) | Bound to `DOLLHOUSE_COOKIE_SIGNING_SECRET` | If lost, `signing_keys` table is undecryptable — same effect as losing JWKS. |

**Store secrets encrypted, in a different location than the database backups.** A single compromised bucket should not yield both. Common options: `age` / `gpg`-encrypted file in a separate bucket, Vault / AWS Secrets Manager / Doppler / 1Password, or your CI/CD secrets store.

---

## Restore-to-scratch-host procedure

This is the standard recovery path: production is gone, you have a recent `pg_dump` + secrets, you need to bring it back somewhere new.

### 1. Provision a scratch host

A clean machine or container with:
- Postgres 15+ matching your production version
- Node.js matching the version in `package.json`'s `engines` field
- Network access to your IdP (GitHub, SMTP) and to whoever needs to reach the MCP endpoint
- Docker if you're restoring in-compose

### 2. Restore the database

```bash
# Create the empty database
createdb -h "$DB_HOST" -U "$ADMIN_USER" dollhousemcp

# Apply the role grants (use the same init script the original deployment used)
psql -h "$DB_HOST" -U "$ADMIN_USER" -d dollhousemcp -f docker/init-db.sql

# Restore the dump
pg_restore \
  -h "$DB_HOST" -U "$ADMIN_USER" -d dollhousemcp \
  --no-owner --no-privileges \
  --jobs=4 \
  dollhousemcp-2026-05-20T120000Z.dump

# Re-apply grants so they cover any newly-restored objects
psql -h "$DB_HOST" -U "$ADMIN_USER" -d dollhousemcp -f docker/init-db.sql
```

If the dump is plain SQL instead of custom format, swap `pg_restore` for `psql -f`.

### 3. Reconstruct secrets

The order matters — set everything before starting the server so the AS doesn't generate fresh per-replica random secrets that would conflict with the restored data.

```bash
# From your secret manager — exact same values as the lost deployment
export DOLLHOUSE_COOKIE_SIGNING_SECRET=<from backup>
export DOLLHOUSE_INVITE_TOKEN_SECRET=<from backup>
export DOLLHOUSE_DATABASE_URL=<rewrite for new host>
export DOLLHOUSE_DATABASE_ADMIN_URL=<rewrite for new host>

# Auth provider secrets (re-fetch from upstream if you didn't back these up)
export DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=<from GitHub OAuth app>
export DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=<from GitHub OAuth app>
# ... etc for magic-link / local-password / etc.
```

If you lost `DOLLHOUSE_COOKIE_SIGNING_SECRET` AND signing-key envelope encryption was on, the `signing_keys` table rows are undecryptable. The server will mint fresh keys on startup and every outstanding access token becomes invalid — users must re-authenticate. This is the "key envelope reconstruction" case below.

### 4. Start the server

```bash
npm run start:http
```

Watch the startup logs for:
- `[AuthStorage] backend=postgres` — confirms the DB connection works
- `[persistKeys] Loaded signing key from store (kid=...)` — confirms the signing-key envelope decrypted
- `[EmbeddedAuthorizationServer] initialized` — confirms the AS came up

If you see `[persistKeys] active jwks key in store is malformed; regenerating` or `[persistKeys] Generated new signing key in store`, that's the cookie-secret envelope mismatch — see "Key envelope reconstruction" below.

### 5. Verify with the health endpoints

```bash
curl -s https://<new-host>/healthz | jq .
curl -s https://<new-host>/readyz | jq .
```

`/healthz` should return `{"ok": true, ...}` with session telemetry. `/readyz` should return 200 (or 503 with `reason: 'bootstrap_required'` if the admin pre-claim was lost — re-run `dollhouse-admin-bootstrap` to restore admin access).

### 6. End-to-end smoke test

Sign in as a known user and verify their portfolio loads:

```bash
# From a client machine — exercise the full auth flow
mcp call dollhouse list_elements --transport=http --url=https://<new-host>/mcp
```

You should see the same elements that were in the database backup.

---

## Point-in-time recovery (managed Postgres)

If you're on a managed provider with PITR (RDS, Cloud SQL, Crunchy Bridge, Supabase Pro, Neon), use the provider's UI / CLI to restore to a target timestamp instead of `pg_restore`. The procedure differs per provider:

| Provider | Command |
|---|---|
| **AWS RDS** | `aws rds restore-db-instance-to-point-in-time --restore-time <ISO8601> --source-db-instance-identifier <prod> --target-db-instance-identifier <restored>` |
| **GCP Cloud SQL** | `gcloud sql backups restore <BACKUP_ID> --restore-instance=<target> --backup-instance=<source>` (uses the most recent automated backup) or use Console for PITR |
| **Crunchy Bridge** | `cb cluster restore-pitr <id> --target-time '2026-05-20 12:00:00 UTC'` |
| **Supabase / Neon** | Use their dashboard — both support branch-from-point-in-time |

The secret-reconstruction step (3) is identical regardless of the data restore method.

---

## Key envelope reconstruction

When `DOLLHOUSE_COOKIE_SIGNING_SECRET` is lost but the `signing_keys` table is restored, the AS cannot decrypt the rows. On startup it will mint a fresh signing key and:

- All outstanding access tokens become unverifiable — every user must re-authenticate
- The new `kid` will appear at `/jwks` — external resource servers must refresh their cached JWKS (most do this automatically)
- Refresh tokens stamped before the rotation are also invalidated

There is no recovery path for the encrypted rows without the original secret. The mitigation is to ensure cookie-secret backups are restored *before* the database, OR to accept the user re-auth event as part of the DR scenario.

**Operationally:** notify users that they'll be signed out and need to sign in again. Plan a maintenance window if possible.

---

## Verification checklist

After any restore, run through this before declaring DR complete:

- [ ] `/healthz` returns 200 with session telemetry
- [ ] `/readyz` returns 200 (not 503/bootstrap_required)
- [ ] `/jwks` exposes the expected `kid` (matches the original if cookie secret was restored intact)
- [ ] At least one known user can sign in via the configured auth method (GitHub OAuth, magic link, local password)
- [ ] Signed-in user sees their portfolio elements (personas, memories, etc.)
- [ ] `dollhouse-allowlist list` returns the expected entries (if allowlist is in use)
- [ ] Audit log query returns recent events (verifies `auth_identity_events` is intact and writable)
- [ ] `auth_kv` size is consistent with active session count (no stale data from a previous restore)
- [ ] `npm audit` or your dep-scanning tool reports no new high-severity issues (helps catch deps that drifted during the restore-host setup)
- [ ] Monitoring is re-pointed at the new host (Prometheus / Datadog / etc.)
- [ ] DNS / load balancer is re-pointed to the new host

---

## Quarterly drill

Run the full restore procedure quarterly against a scratch host that you tear down afterward. Time it — that's your real RTO. Use the most recent production backup; if it can't restore cleanly, that's a P0 backup-pipeline incident, not a DR exercise outcome.

Record drill results in your runbook log: date, RTO achieved, anomalies found, action items.

---

## See also

- [`production-hosting-runbook.md`](./production-hosting-runbook.md) — initial deployment, ongoing operations, secret rotation
- [`secret-rotation-runbook.md`](./secret-rotation-runbook.md) — secret rotation procedures (cookie signing, invite tokens, JWKS)
- [`deployment-configuration.md`](./deployment-configuration.md) — env var reference
