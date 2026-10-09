# Dormant database memory legacy mutation denial

The mode-enforcing factory is internal composition, not a production activation.
It extends the ordinary database factory, delegates non-memory elements unchanged,
and always binds its memory layer to the actual database and trusted tenant
resolver. The production registrar does not select this factory automatically.
Adapter presence or a feature flag is not durable legacy-write permission.

Legacy memory DML requires an explicit mode row: database backend, protocol 1,
profile `legacy-memory-writes-v1`, mode `legacy`, and a positive PostgreSQL bigint
generation. Missing, unavailable, malformed, guarded, and read-only mode state
refuses; none implies legacy permission. The application role cannot create or
change mode rows. Migration 0060 retains identity/deletion/generation protections
and forbids guarded or read-only rows returning to legacy, even through privileged
profile changes. Provisioning and transitions remain maintenance responsibilities.

The layer verifies its captured database/tenant and ordinary role, locks the mode
row with `FOR SHARE`, executes DML, and rechecks context in that same transaction.
The row lock protects against a competing mode transition through completion;
it is not a tenant-wide callback mutex. JavaScript context is checked at specified
boundaries, not atomically frozen by a PostgreSQL lock.

Protected entrypoints are raw write, ordinary head CAS, child add/remove/expiry
purge, and inherited identity deletion (including ordinary deletion). The existing
admitted conditional-write capability stays separate: only its gate-owned
transaction and known-commit publication can authorize guarded updates. Non-memory
and unconfigured ordinary database layers retain their existing behavior; they
are not thereby safe for guarded data.

Failure observation occurs after the outer transaction settles and contains
observer exceptions. Events carry fixed boundary/stage information and a random
invocation identifier, without tenant, content, locator, token, or raw error data.
Original errors and existing storage wrapping remain; a commit/rollback transport
failure is not asserted to be a known rollback. Events are best effort, not a
crash-durable delivery or lifecycle-outcome guarantee.

This slice closes a persistence bypass, not the entire #2906 writer inventory.
Early caller/RAM refusal, pending acceptance and timer/queue drain, mandatory boot
composition and old-process exclusion remain before activation. Fresh owner/data,
capacity, restore and owner-aware rollback qualification also remain; no live mode
row is created or changed by this implementation.
