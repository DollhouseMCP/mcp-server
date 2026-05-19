# Secret Rotation Runbook

Procedures for rotating each secret a DollhouseMCP production deployment depends on. Each section covers what the secret protects, when to rotate, the rotation procedure, the invalidation impact (what stops working immediately, what limps along), multi-replica coordination, and recovery if you make a mistake.

**Cadence baseline:** rotate every secret annually OR immediately after any suspected compromise. Some rotations are zero-downtime; some kick every active session. Read the impact column before flipping anything in production.

---

## Contents

- [The secrets](#the-secrets)
- [Cookie signing secret](#cookie-signing-secret)
- [Invite token secret](#invite-token-secret)
- [JWKS signing key](#jwks-signing-key)
- [GitHub OAuth client secret](#github-oauth-client-secret)
- [Postgres passwords](#postgres-passwords)
- [Console token (web console)](#console-token-web-console)
- [Master encryption key (storage-level encryption)](#master-encryption-key-storage-level-encryption)
- [Generic rotation principles](#generic-rotation-principles)

---

## The secrets

| Secret | Env var | Default behavior | Compromise impact |
|---|---|---|---|
| Cookie signing | `DOLLHOUSE_COOKIE_SIGNING_SECRET` | Per-replica random if unset | Anyone with it can forge an authenticated `/interaction` session cookie |
| Invite token | `DOLLHOUSE_INVITE_TOKEN_SECRET` | Per-replica random if unset | Anyone with it can forge an invite or magic-link redemption |
| JWKS signing key | Stored in `auth_signing_keys` table (DB) or `~/.dollhouse/run/oauth-signing-key.json` (filesystem) | Auto-generated on first run | Anyone with it can mint valid access tokens for any subject |
| GitHub OAuth secret | `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` | None (mandatory for `github` method) | Allows impersonation of your OAuth app on GitHub |
| Postgres app password | embedded in `DOLLHOUSE_DATABASE_URL` | None | Full read/write on user data (constrained by RLS) |
| Postgres admin password | embedded in `DOLLHOUSE_DATABASE_ADMIN_URL` | None | Full superuser DB access |
| Console token | Stored in `~/.dollhouse/run/console-token.auth.json` | Auto-generated on first run | Full web-console operator access |
| Master encryption key | `DOLLHOUSE_ENCRYPTION_SECRET` / `DOLLHOUSE_MASTER_ENCRYPTION_KEY` | None | Decrypts encrypted columns (user OAuth tokens) — only relevant if encryption is enabled |

---

## Cookie signing secret

**Env var:** `DOLLHOUSE_COOKIE_SIGNING_SECRET`
**Format:** 64+ hex characters (256 bits). Generate via `openssl rand -hex 32`.
**Where used:** Signing `/interaction` session cookies during the OAuth consent flow. Also serves as the HMAC salt for IP/UA hashes when the `refreshRotationCheckIpUa: true` rotation-grace gate is enabled.

### When to rotate

- Annually as baseline
- Immediately on suspected compromise (e.g., a config dump leaked)
- Before allowing any new admin operator access if the secret has been on a shared host that's about to lose trust

### Rotation procedure (single replica)

1. Generate the new value:
   ```bash
   openssl rand -hex 32
   ```
2. Update `.env.production` (or your secret store).
3. Restart the server:
   ```bash
   docker compose up -d dollhousemcp   # Path A
   # or
   sudo systemctl restart dollhousemcp # Path B
   ```
4. Verify the server restarts cleanly. The `kid` published at `/jwks` should not change (cookie secret is independent of JWKS). If startup fails with a length error, the secret didn't decode to ≥32 bytes — regenerate with `openssl rand -hex 32`.

### Multi-replica coordination

All replicas must use the **same** value. Update your secret store and roll replicas one at a time. Mid-rotation, in-flight `/interaction` sessions on the replica that hasn't restarted yet will fail signature verification against new cookies; users mid-OAuth see a "please retry" error. Window is the rolling-restart duration.

### Invalidation impact

- **Active `/interaction` sessions:** invalidated. A user mid-OAuth must restart the flow.
- **Issued access tokens:** unaffected. Tokens are signed by the JWKS key, not this cookie key.
- **Active MCP sessions:** unaffected.

### Recovery

If you set a bad value (e.g., the wrong length) and the server refuses to start, revert `.env.production` and restart. If you lost the previous value and tokens still need to validate: there's no recovery — the previous value is required to unmark already-issued cookies. New OAuth flows work fine.

---

## Invite token secret

**Env var:** `DOLLHOUSE_INVITE_TOKEN_SECRET`
**Format:** Hex-encoded, decodes to at least 16 bytes. Generate via `openssl rand -hex 32` (gives 32 bytes).
**Where used:** Signing invite tokens (`local-password` invites) and magic-link tokens.

### When to rotate

- Annually as baseline
- Immediately on suspected compromise
- If invite tokens have been emailed through an untrusted relay and you suspect logging

### Rotation procedure

1. Generate:
   ```bash
   openssl rand -hex 32
   ```
2. Update `.env.production`.
3. Restart the server (same as cookie secret).

### Invalidation impact

- **Unredeemed invite tokens:** invalidated immediately. Anyone holding an un-clicked invite URL gets "invite expired" on click.
- **Unredeemed magic-link emails:** invalidated. Anyone with a magic link in their inbox needs a fresh one.
- **Existing accounts:** unaffected. Already-redeemed invites have done their job.
- **Active sessions:** unaffected.

### Multi-replica coordination

Same as cookie secret — all replicas use the same value, roll one at a time. Outstanding invites/magic-links that were issued by replica A and clicked while replica B has the new key will fail; reissue them.

### Recovery

If you rotate before users have redeemed outstanding invites, you must reissue each invite via `dollhouse-create-user` or the equivalent CLI. Magic-link recipients just request a new one.

---

## JWKS signing key

**Storage:** `auth_signing_keys` table (DB mode) or `~/.dollhouse/run/oauth-signing-key.json` (filesystem mode).
**Where used:** Signing all access tokens and ID tokens the AS issues. The `kid` (key ID) is published at `/jwks` for client validation.

### Built-in rotation

The AS supports key rotation through the `auth_signing_keys` table — the rotation invariant is "at most one active per kind." Adding a new active key effectively retires the old one, but both remain in the JWKS so already-issued tokens with the old `kid` continue to validate until they expire (1h for access tokens by default, longer for refresh tokens).

### When to rotate

- Annually as baseline (more frequently if you have a compliance requirement)
- Immediately on suspected compromise of the keyfile or DB row
- After a `DOLLHOUSE_AUTH_METHODS` change — the AS auto-rotates the key as part of mode-fingerprint invalidation (this is deliberate; see `auth-server-setup.md` troubleshooting)

### Rotation procedure (DB mode, recommended)

Currently rotation is operator-triggered through a SQL-level operation; a dedicated CLI is planned. The procedure:

1. Connect to Postgres as the admin role:
   ```bash
   docker compose exec postgres psql -U dollhouse -d dollhousemcp
   ```
2. Insert a new active signing key. The server picks up the new key automatically on next startup (or restart to force pickup):
   ```sql
   -- Example: deactivate current, insert new
   UPDATE auth_signing_keys SET active = false WHERE kind = 'oauth-signing' AND active = true;
   INSERT INTO auth_signing_keys (kid, kind, private_pem, public_jwks, active, created_at)
     VALUES ('dh-' || encode(gen_random_bytes(16), 'hex'), 'oauth-signing',
             <generate ECDSA P-256 key pair>, <jwks JSON>, true, NOW());
   ```
3. Restart the server.
4. The JWKS endpoint will publish both keys until the old one's referenced tokens expire (~24h for refresh tokens).
5. After the grace period, optionally delete the old key row:
   ```sql
   DELETE FROM auth_signing_keys WHERE kind = 'oauth-signing' AND active = false AND created_at < NOW() - INTERVAL '7 days';
   ```

**Note:** A proper `dollhouse-rotate-jwks` CLI is on the roadmap. Until then, the SQL approach above is the supported path. The key-generation step is the part that needs care — see the AS source for the exact JWK format (ECDSA P-256 / ES256). The simplest approach is to extract the keypair from a fresh AS-generated key and rewrite the row.

### Rotation procedure (filesystem mode)

```bash
# Remove the existing keyfile
rm ~/.dollhouse/run/oauth-signing-key.json
# Restart — a new key is auto-generated with a new kid
docker compose restart dollhousemcp
# or
sudo systemctl restart dollhousemcp
```

This is the nuclear option for filesystem mode — there's no two-key transition. All previously-issued tokens become invalid on restart.

### Invalidation impact

- **DB mode with proper rotation (insert new, deactivate old):** zero immediate invalidation. Old-`kid` tokens validate until expiration; new tokens use the new `kid`.
- **DB mode with row replacement (delete then insert, or filesystem mode):** all existing tokens fail validation. Every user must re-authenticate.
- **OAuth grants / refresh tokens:** survive a graceful rotation but not a hard-replace. After hard replace, every client needs a fresh `/authorize` flow.

### Multi-replica coordination

In DB mode the key is shared via the table — all replicas see the same key. In filesystem mode there is no multi-replica support without env-var-overridden file paths pointing at shared storage.

### Recovery

If you accidentally delete a still-needed key row, tokens issued under that `kid` become uninvalidatable. There's no recovery beyond having every user re-auth. **Always insert the new key before deactivating the old one in DB mode.**

---

## GitHub OAuth client secret

**Env var:** `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET`
**Storage:** Generated by GitHub when you create the OAuth app.
**Where used:** Exchanging GitHub OAuth authorization codes for access tokens during user sign-in.

### When to rotate

- Annually as baseline
- Immediately on suspected leak (anyone with this can impersonate your OAuth app)
- After any operator with access to the env file or secret store leaves the project

### Rotation procedure

1. Go to [github.com/settings/developers](https://github.com/settings/developers) → your DollhouseMCP OAuth app.
2. Click **Generate a new client secret**. GitHub allows two secrets to coexist for ~7 days — both are valid during the transition.
3. Note the new secret value. **Don't delete the old one yet.**
4. Update `.env.production` with the new secret.
5. Restart the server:
   ```bash
   docker compose up -d dollhousemcp
   ```
6. Verify a sign-in flow works end-to-end.
7. After confirming the new secret is in use, return to the GitHub OAuth app settings and delete the old secret.

### Invalidation impact

- **In-flight OAuth code exchanges:** if a user is mid-flow and presents a code that was issued under the old secret while the server is using the new one, GitHub will accept either secret during the overlap window. After deleting the old secret, in-flight codes succeed if the server has the matching secret.
- **Issued JWTs:** unaffected. The GitHub secret is only used during the GitHub→AS code exchange; once a user has a JWT from your AS, this secret isn't checked again.
- **Active MCP sessions:** unaffected.

### Multi-replica coordination

All replicas must use the same value. Roll one at a time during the GitHub-overlap window (7 days is plenty).

### Recovery

If you set the wrong value, sign-in fails with a clear error from GitHub. Revert `.env.production` and restart. The old secret remains valid on GitHub's side until you delete it from the app config.

---

## Postgres passwords

**Env vars:** `DOLLHOUSE_DATABASE_URL` (app role), `DOLLHOUSE_DATABASE_ADMIN_URL` (admin role).
**Storage:** Inside the connection URLs in your env file.
**Where used:** Server-to-Postgres authentication.

### When to rotate

- Annually as baseline
- Immediately on suspected compromise of either the env file or the DB host
- Mandatory if `NODE_ENV=production` and the password is still `dollhouse` or `dollhouse_app` — the server refuses to start with the development defaults

### Rotation procedure (app role)

1. Generate a new password:
   ```bash
   openssl rand -hex 24
   ```
2. Change it in Postgres:
   ```bash
   docker compose exec postgres psql -U dollhouse -d dollhousemcp <<SQL
   ALTER ROLE dollhouse_app WITH PASSWORD 'new-password-here';
   SQL
   ```
3. Update `DOLLHOUSE_DATABASE_URL` in `.env.production` with the new password (URL-encode special characters).
4. Restart the server. Existing pooled connections drop; new connections use the new password. There's a ~1-2 second window where in-flight queries may fail with a connection error and retry.

### Rotation procedure (admin role)

Same procedure but for the `dollhouse` superuser. Note that the admin role is only used during startup (bootstrap, migrations) — runtime never holds the superuser credential. Rotation is essentially zero-impact on running traffic; the next migration or restart uses the new password.

### Invalidation impact

- **In-flight queries:** brief failure during the connection-pool refresh. Retry succeeds.
- **Active MCP sessions:** unaffected after the connection pool reconnects.
- **Backups:** if your backup script uses `pg_dump -h host -U dollhouse` and stores a password in `.pgpass` or env, update that too. Test the backup after rotation.

### Multi-replica coordination

All replicas use the same DB password (or, more cleanly, a per-replica password if you operate that way). Update the secret store, roll one at a time. The brief connection-failure window per replica is tolerable.

### Recovery

If you set the wrong password in the env file, the server fails to start with a Postgres auth error. Revert the env file and restart. If you set the wrong password in Postgres (e.g., a typo in the ALTER ROLE), connect as superuser and re-ALTER.

---

## Console token (web console)

**Storage:** `~/.dollhouse/run/console-token.auth.json` (mode 0600).
**Where used:** Bearer token for `:41715/api/*` endpoints — the web management console.

The console token has a first-class rotation flow built into the server, including TOTP confirmation and a 15-second grace window for in-flight requests. See [Console Authentication → Token rotation](./console-auth.md#token-rotation) for the complete procedure.

**Summary:**

```bash
# Via the CLI
dollhouse-console-token rotate --code <6-digit TOTP>

# Or via the HTTP endpoint
curl -s -H "Authorization: Bearer $TOKEN" \
     -X POST http://localhost:41715/api/console/token/rotate \
     -H 'Content-Type: application/json' \
     -d '{"confirmationCode":"<6-digit TOTP>"}'
```

After rotation:
- The old token is accepted for 15 more seconds (grace window for in-flight requests).
- Browser tabs with the old token cached automatically refresh to the new value.
- Followers / external scripts must re-read the token file.

### When to rotate

- After enabling TOTP (rotate to bake in TOTP confirmation as a precondition for future rotations)
- Immediately on suspected leak
- Periodically as good hygiene (no fixed cadence — the token never reaches the public internet, so the threat surface is bounded to local processes)

### Recovery

If you lose access (TOTP device gone, no backup codes left), delete the token file and restart the server. The leader regenerates a fresh token on next startup. You'll need to re-enroll TOTP.

---

## Master encryption key (storage-level encryption)

**Env vars:** `DOLLHOUSE_ENCRYPTION_SECRET` + `DOLLHOUSE_ENCRYPTION_SALT` (memory pattern encryption); `DOLLHOUSE_MASTER_ENCRYPTION_KEY` is referenced in some planning materials as the envelope key for encrypted columns (notably user OAuth tokens stored in `auth_accounts`).
**Where used:** Encrypting sensitive columns and memory patterns at rest.

> **Status note.** As of this writing, storage-level envelope encryption with a master key is a partial feature. The memory-pattern encryption (`DOLLHOUSE_ENCRYPTION_SECRET`/`SALT`) is in place; the column-level envelope is not universally applied across `auth_accounts.access_token` and similar columns. If your deployment requires column-level encryption at rest, confirm coverage by inspecting `EncryptionService` in the codebase before assuming rotation procedures apply.

### When to rotate

- Annually as baseline
- Immediately on suspected leak of the key
- After any operator with access to the env file leaves

### Rotation procedure (memory pattern encryption)

Rotating `DOLLHOUSE_ENCRYPTION_SECRET` is **destructive to encrypted patterns** — the previous secret is required to decrypt previously-stored data. To rotate without losing data:

1. Backup the database (`pg_dump`).
2. Export all encrypted patterns to plaintext via the running server (`npm run db:export` covers element content).
3. Change `DOLLHOUSE_ENCRYPTION_SECRET` in `.env.production`.
4. Re-import the plaintext content — the server re-encrypts on insert with the new key.
5. Restart.

For column-level envelope encryption (if applicable in your deployment), the procedure depends on the specific column. Consult the codebase or open an issue if you're unsure.

### Invalidation impact

- **Existing encrypted data:** unreadable with the new key. Re-encrypt via export-then-import.
- **Active sessions:** unaffected if the encryption is only for stored data, not for session validation.

### Recovery

If you rotate without re-encrypting, the data is unrecoverable from the new key alone — restore from a backup taken with the previous key, decrypt, then re-encrypt under the new key.

---

## Generic rotation principles

### Test before rotating in production

Every rotation procedure here should be exercised at least once on a staging deploy before you run it in production. The "what gets invalidated" matters in practice — you'd rather discover it on a staging server than learn about it at 2am.

### Coordinate calendar reminders

The biggest risk to secrets isn't a sophisticated attacker — it's letting them age until nobody on the team remembers what they protect. Schedule a calendar event for every annual rotation. If a deploy outlives its first year without rotation, the dev who set it up may have moved on. Keep the runbook fresh by exercising it.

### Multi-replica means same secret across replicas

For every secret that the AS reads from env (cookie, invite token, GitHub OAuth secret), all replicas must agree. The deploy pattern is:

1. Update the secret store with the new value.
2. Restart replicas one at a time.
3. Mid-rotation window (seconds to minutes depending on rolling-restart speed), some requests may hit a replica with one value and a follow-up request hits a replica with the other. For cookie-signing this means a fraction of `/interaction` sessions need to retry; for GitHub OAuth secret it's nearly invisible (the GitHub-side overlap covers the gap).

### Backups must be encrypted separately

The biggest "compromise of secrets" scenario is "the daily backup tarball got mailed to the wrong S3 bucket." If your DB backup contains the encrypted columns AND your `.env.production` is in the same bucket, both go together. Two backups, two destinations, two encryption keys.

### Never commit `.env.production`

Use `.gitignore`. Use `git secrets` or `pre-commit` hooks if you've ever had a near-miss. Once a secret is in git history, treat it as compromised even if you force-push it out — assume it was indexed.

### After a confirmed compromise

If you have reason to believe any of these secrets was actually exposed (config leaked, log file with secrets, infected host):

1. Rotate the leaked secret first (fastest stop-the-bleeding).
2. Rotate every other secret on the same host within the hour (the attacker may have moved laterally).
3. Audit the `auth_audit_events` / `auth_identity_events` tables for unusual sign-in activity since the suspected leak time.
4. Force re-auth on all users (rotate the JWKS key hard — every existing token becomes invalid). Users see a "please sign in again" prompt on next MCP request.
5. Notify your users that a re-auth was required, with whatever level of detail is appropriate for the audience.

---

## Related

- [Production Hosting Runbook](./production-hosting-runbook.md) — the end-to-end deploy this runbook supports
- [Auth Server Setup](./auth-server-setup.md) — auth model, storage backends, methods
- [Console Authentication](./console-auth.md) — full console-token rotation flow with TOTP
- [Disaster Recovery Runbook](../../../docs/SECTION-8.1-DR-RUNBOOK.md) — filesystem-only DR procedures (Postgres DR is a planned follow-up)
