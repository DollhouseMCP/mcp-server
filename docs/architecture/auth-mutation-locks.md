# Authentication mutation lock boundaries

`authPrincipalLock.ts` owns the existing principal and allowlist advisory-lock
namespaces. Blocking helpers retain their current behavior. The new
`tryLockAuthMutationIdentitiesWithTx` acquires a complete supplied principal set,
then a complete supplied allowlist set, using the same sorted/de-duplicated keys
without waiting for another transaction. Callers must supply canonical identity
values exactly as they do to the blocking helpers.

If any key is busy, PostgreSQL raises SQLSTATE `40001` inside the transaction.
Previously acquired transaction locks and writes roll back. A callback cannot
catch the JavaScript rejection and commit partial work: further statements fail
with `25P02`, and the postgres.js transaction itself rejects. The helper must run
in the outer mutation transaction, not an independently recoverable savepoint.
There is no automatic retry. A caller may retry a complete database transaction
only after revalidating state; it must not replay OAuth exchanges or external
side effects. Mutable key inputs are copied before waiting on the first query.

## Existing writers

| Entry point | Lock sequence / mutation boundary |
| --- | --- |
| `PostgresConsoleAccountAllowlistStore.provisionAccountIfAllowed` | Principal advisory → allowlist advisory → bootstrap row → authority decision → auth account upsert. |
| `deleteConsolePrincipalWithTx` / `purgeNonCascadeUserIdentity` | Users row → principal advisory → allowlist advisory → bootstrap/grants/identity/allowlist purge → identity/role/user removal. |
| `addAccountAllowlistEntryWithTx` / `removeAccountAllowlistEntryWithTx` | Allowlist advisory → authority row write, including user foreign keys. |
| `linkConsoleIdentityWithTx` | Auth account update → user foreign-key checks. |
| `grantConsoleAdminRoleWithTx` | Role insert/unique check → user foreign-key checks → user authz version update. |
| `appendConsoleAdminAuditEventWithTx` | Global audit chain head → audit insert with user foreign keys. |

Invitation management serializes account checks with a `users EXCLUSIVE` table
lock. A future activation transaction holding that lock must not then wait for
principal or allowlist advisory owners: those writers may themselves be waiting
for users. The try-lock helper provides an explicit abort path while preserving
existing sign-in and deletion guards and deletion tombstone precedence.

## Remaining activation preflight

Advisory try-locks are a prerequisite, **not a complete activation protocol**.
Identity-link, role, allowlist and audit writers can already own a row, unique
entry or audit chain head while waiting for user foreign-key checks. Waiting for
those resources while holding the users lock could still form a cycle. Before
#2681 activation is enabled, its complete acquisition protocol must cover these
later resources too (for example, transaction-aborting NOWAIT preflight on the
necessary tables/rows before writes), with real PostgreSQL races against the
actual writers. Do not interpret a successful advisory acquisition as permission
to block on arbitrary subsequent identity, role or audit locks.

The focused PostgreSQL tests exercise contention with actual sign-in provisioning
and deletion, aborted callbacks, rollback of prior writes/partial advisory locks,
and preservation of the deletion deny tombstone on a later sign-in attempt.
This prerequisite does not enable invitation activation or alter allowlist policy.
