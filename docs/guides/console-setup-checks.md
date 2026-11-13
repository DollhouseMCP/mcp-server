# Console setup checks

A hosted console deployment is measured against eleven checks. This guide says what each one proves, how the server knows its state, and what to do when it has not passed.

Nothing in this guide gates anything. The server starts and serves whatever the checks say. The one hard gate is at start-up: the server refuses to start the console when its database, storage adapters, allowlist or invalidation processor are not ready, and the start-up message names what to set. The checks here are for the operator: they answer "is this deployment fully working?" after it has started.

The only check result that takes a replica out of service is a database that is behind this release's migrations. See [Database schema is fully migrated](#database-schema-is-fully-migrated).

## Reading the status

`GET /api/v1/admin/operate/setup-status` returns every check with its state, the reason, and when the thing it rests on last happened, where that is recorded. It needs a console session that holds the operator capability and has elevated with a one-time code. Each request is recorded in the admin audit as `operate.setup_status.show`.

There is no page for it in the console yet. Until there is, request the address from a browser that is signed in to the console and elevated; a `GET` needs nothing beyond the session.

Reading the status tests nothing and starts nothing. Each check is answered by something that already knows: a probe the server runs anyway, the last result of the canary, or a record left by real use. One reading is reused for ten seconds.

The server-run checks also appear in the console's Operations health, which is polled. The checks that depend on somebody doing something appear only in the setup status.

### States

| State | Meaning |
|---|---|
| `passed` | The server verified it, or the record of it exists. |
| `pending` | Not verified yet. Nothing is known to be wrong. A check that depends on somebody doing something stays pending until they have. |
| `failed` | The server looked and found a fault. |
| `not_applicable` | The thing the check is about does not exist in this deployment. |

If a check's source cannot answer, for example because a query fails, that check reads `pending` with "could not be checked just now" and the database error code. The other checks still answer.

### What the status does not tell you

- **Other replicas.** Each replica answers for itself. With several replicas, a request may reach any of them.
- **The network path.** No check goes over the network. None of them shows that a real client can connect through your proxy.
- **Whose record it was.** The checks that read usage records say that something has happened in the deployment and when. They do not say who did it.

## Checks the server runs

### Database schema is fully migrated

`production_database_migrations`. Operations health: `database_migrations`.

**A pass proves** that every migration in this release has been applied to the database, and that the record of what was applied matches this release.

**How the server knows.** It compares this release's migrations with the applied-migration ledger. While the database is behind, or the ledger cannot be read, it looks again when asked, at most every 15 seconds. Once the database is not behind, the answer stands until the server restarts: a release's migrations do not change, and a ledger does not lose entries.

| Result | State | The server |
|---|---|---|
| A migration in this release is newer than anything applied | `failed` | Takes this replica out of service: `/readyz` returns 503. |
| Everything is applied, but an applied entry's content hash differs from this release | `failed` | Keeps serving. Logs one error naming the first entry that differs. |
| The ledger, or this release's own list of migrations, cannot be read | `pending` | Keeps serving. Logs a warning with the reason, which the setup status also gives: the server's database role lacks a grant on the ledger (the warning names it), the database has no ledger, the build is incomplete, or the database did not answer. |

**What to do.** If migrations are missing, run the migration job for this release. If the ledger does not match, a migration file was changed after a database had applied it: compare the schema with this release before relying on it. See [Updates](./production-hosting-runbook.md#updates) in the hosting runbook.

### Security changes reach every replica

`security_invalidation_multi_replica`. Operations health: `security_invalidation`.

**A pass proves** that revoking a session, disabling an account or changing a role takes effect on this replica.

**How the server knows.** Each replica holds a lease and works through a shared queue of security changes. The check reports whether this replica's processor is running, its lease is live, and nothing is waiting for it.

| Result | State |
|---|---|
| The processor is not running, or the lease is not live | `failed` |
| Changes are waiting to be applied | `pending`. That is work in hand, not a fault. |

**What to do.** Check that every replica is running, reaches the same database and has a distinct replica ID.

### Sign-in allowlist sources agree

`allowlist_authority_parity`. Operations health: `allowlist_parity`.

**A pass proves** that every entry in the earlier sign-in allowlist is present in the allowlist the console manages, so nobody loses access by accident.

**How the server knows.** It compares the two allowlists with the rule it enforces at start-up, where a gap stops the server from starting. A gap found on a running server is the same gap a restart would refuse.

It is `not_applicable` where the deployment has only one allowlist.

**What to do.** Run `dollhouse-allowlist reconcile` to list the entries, then `reconcile --carry` to add them to the allowlist sign-in uses or `reconcile --discard` to drop them. See [Built-in sign-in allowlist](./production-hosting-runbook.md#pattern-1-built-in-sign-in-allowlist-recommended).

### Audit events and telemetry display correctly

`audit_telemetry_projection`. Operations health: `audit_telemetry`.

**A pass proves** that admin audit events are intact and readable, and that session telemetry can be read.

**How the server knows.** It runs the audit and telemetry page queries read-only and verifies the tamper-evident chain over the first admin audit events, as the audit page does. The result is reused for 30 seconds.

**What to do.** Check the server log for the failing query or chain break. A chain break needs investigation before the audit trail is trusted.

### Approvals and executions display correctly

`approval_execution_projection`. Operations health: `approval_execution_projection`.

**A pass proves** that a pending approval and an agent execution, made the way a live session makes them, can be read through the console, which shows only the fields it is allowed to.

**How the server knows.** Unlike the other checks, this one writes. Approvals and executions are stored per user and per session, and the server does not look at a real user's. It keeps one reserved user, `dollhousemcp-canary`, which is disabled, holds no role and has no sign-in identity. A canary run opens a session for that user, makes one approval request and one execution, reads both back through the console's own handlers, and removes everything it made.

It runs only when an admin asks, or on a schedule that is off unless configured. So:

- it is `pending` until it has run on this replica, and again once a pass is more than 24 hours old;
- a fault it found stays `failed` until a later run passes or the server restarts;
- it is `not_applicable` without a database.

**What to do.** Run it: `POST /api/v1/admin/operate/canary/run`. If it fails, the result names what the console did not show. [The approvals and executions canary](./production-hosting-runbook.md#the-approvals-and-executions-canary) in the hosting runbook has the result codes and the schedule setting.

### Every replica uses the same signing key and auth policy

`signing_key_auth_policy_multi_replica`.

**A pass would prove** that tokens issued by one replica are accepted by all the others, and that all apply the same sign-in policy.

**How the server knows.** It does not. The server does not compare replicas yet, so this check is always `pending` and says so. Each replica refuses token requests while its own signing key is out of date, so the fault only shows when a sign-in reaches that replica.

**What to do.** After rotating the signing key, restart every replica so each reloads the current key.

## Checks that depend on somebody doing something

These are `pending` until the thing has been done once, and never `failed`. Each is read from the record that doing it leaves.

### Admin sign-in and step-up work

`embedded_as_login_step_up`.

**A pass proves** that an administrator can sign in to the console, enrol an authenticator app and elevate to admin with a one-time code.

**The record.** The authorization server records each accepted one-time code or backup code. A refused code does not count.

**What to do.** Sign in as the administrator, set up an authenticator app under Security, then elevate. Reading the setup status needs an elevated session, so by the time you can read it this check has normally passed.

### An invite can be redeemed

`account_invite_redemption`.

**A pass proves** that an invitation sent from the console can be turned into a working account by the person invited.

**The record.** An invitation in the state "accepted". It is `not_applicable` where the deployment does not offer invitations that are recorded when accepted.

**What to do.** Invite someone from Accounts and have them accept. This needs a second person, so it is usually the last check to pass.

### Revoking a client grant cuts its access

`oauth_grant_revocation`.

**A pass proves** that an administrator has revoked an account's credentials, which removes its MCP client grants and refuses their tokens.

**The record.** The admin audit entry written after the account's sessions and client grants were actually revoked. An attempt that failed part-way does not count.

**What to do.** Nothing to fix. This stays pending until credentials are revoked for the first time.

### GitHub can be connected to an account

`github_integration_connect_callback`.

**A pass proves** that the GitHub connection flow completes and the connection is stored for the account.

**The record.** An account with GitHub connected now. If the only account that had GitHub connected disconnects it, this check goes back to `pending`.

**What to do.** Connect GitHub under Integrations. If that fails, check the GitHub app client ID, secret and callback URL.

### Portfolio sync works against a real repository

`portfolio_sync_live_repository`.

**A pass proves** that a portfolio sync against a real GitHub repository finished successfully.

**The record.** A sync job that succeeded and whose repository answered at least one request. A job can succeed without that: a push from an empty portfolio asks the repository nothing, and a repository that does not exist answers "not found", which reads as an empty folder. Neither counts. Nor does a sync made on a version from before this evidence was recorded, so on an existing deployment the check is pending until the next sync.

The reason names the repository. That name is the deployment's setting, the same for every account; each account syncs with its own repository of that name.

**What to do.** Connect GitHub, then run a sync from Portfolio with at least one element to transfer.

## Qualifying a deployment

To record that a deployment is qualified, for example before enabling onboarding:

1. Start the server and confirm `/readyz` returns 200.
2. Sign in as the administrator, enrol an authenticator app and elevate.
3. Run the canary.
4. Do each thing the remaining checks depend on: accept an invitation, connect GitHub, run a sync, revoke a test account's credentials.
5. Read the setup status and record it. Every check should read `passed` or `not_applicable`, except the cross-replica signing key check, which is always `pending`.
6. With several replicas, read the status from each one.

A check that reads `failed` is a fault to fix. A check that reads `pending` is something that has not been done or verified yet; decide whether your deployment needs it before treating it as a gap.
