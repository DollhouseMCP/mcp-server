# Activation resource preflight

`lockAuthMutationResourcesWithTx` is an internal, unused prerequisite for #2681.
It does not activate an account or change any existing writer's policy. It must
run at the beginning of the outer activation transaction, before advisory locks,
row locks or writes, and be followed by the complete principal/allowlist try-lock
set and fresh invitation/account/policy/expiry validation.

The helper first takes `users EXCLUSIVE`, then takes `EXCLUSIVE NOWAIT` on the
fixed downstream resource set in one statement. Ordinary readers retain access.
Any downstream conflict raises PostgreSQL `55P03` and aborts the transaction;
previously acquired locks cannot remain committed as partial work. No hidden
retry, provider call, email or session issuance occurs in this helper.

| Resource | Actual writer / reason for preflight |
| --- | --- |
| `auth_accounts` | Identity linking updates a row before users foreign-key checks; ordinary provisioning upserts the same provider identity. |
| `user_admin_roles` | Role grants insert/check uniqueness before users foreign-key checks and authz-version updates. |
| `account_allowlist_entries` | Authority add/remove writes rows with creator/revoker user foreign keys while holding identity advisory locks. |
| `admin_audit_chain_heads` | The ordinary administrator audit writer inserts/locks the global head before writing the users-referencing event. The table lock covers initial INSERT/unique checks too. |
| `admin_audit_events` | Administrator event inserts contain actor/target user foreign keys. |
| `security_invalidation_events` | The durable authz-change invalidation outbox inserts user/creator foreign keys. |

Without the downstream NOWAIT step, an existing writer could own a row, unique
entry or chain head and wait for a users foreign-key lock while activation holds
users and waits for that writer. Conflicting table modes are already held by those
writers before their foreign-key checks. Preflight fails instead of completing
that cycle. It must precede mutation writes even if a later operation would be a
no-op. Existing user-first deletion serializes before the initial users lock.

The resource list is deliberately fixed and coarse for the private beta. Do not
remove a table or add new activation writes without auditing their lock order and
foreign keys. Invitation/generation/claim writers must retain the users-first
protocol. Plain security/identity audit inserts have no users foreign keys and no
global head; normal session issuance and runtime termination are excluded from
this transaction. A future change that uses those other paths must audit them
explicitly. Outbox consumers' acknowledgements and replica cursor updates are not
part of activation; only the authz-change event append is reserved here.

Resolve audit HMAC material before opening the transaction and pass a resolver
that returns that material without opening another connection. Otherwise a small
pool can be exhausted by transactions holding locks while waiting for a separate
key-resolution connection. No network I/O belongs under these locks.

Real PostgreSQL tests exercise the actual role, identity-link, allowlist add/remove,
administrator audit, invalidation, sign-in provisioning and deletion functions.
They verify transaction abort/released locks and successful writer completion,
not merely equivalent hand-written DML. This prerequisite does not replace the
separate immutable GitHub identity, deny-precedence, role-policy or idempotent
activation contracts.
