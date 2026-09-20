# Invitation lifecycle foundation

Issue #2678 introduces durable state for private-beta invitations without enabling a live onboarding route. The first slice is deliberately limited to migration `0054`, schema declarations, token/configuration primitives, and typed service/storage contracts. Pending users cannot be created through the live invitation route until a later slice enforces `activation_state` in both console and MCP authorization.

## Independent state

The schema keeps four concerns separate:

* `users.activation_state` is `active` or `pending_activation`, with `active` as the compatibility default. `disabled_at` and `deleted_at` remain independent controls.
* `account_invitations` is the stable aggregate. A regenerated expired invitation returns to pending with a new generation. Accepted invitations are immutable, and revoked invitations require a future explicit re-invite operation.
* `account_invitation_generations` stores credential hashes and generation history. It never stores a raw credential or URL.
* claim assertions and delivery attempts have their own states. SMTP submission is not invitation acceptance, and email claim is not account activation.

Intended roles are durable intent only. The foundation does not write `user_admin_roles`, create an auth identity, or issue a session. Issue #2681 will apply roles, attach/confirm GitHub identity, activate the account, accept the invitation, complete the claim, and append audit in one transaction.

## Credential and claim ownership

Invitation credentials contain 256 random bits. Storage receives only a SHA-256 digest bound to the purpose/version, invitation ID, generation, normalized email, and persisted expiry. A raw credential may be returned only by issue or regeneration and cannot be recovered later.

The first successful claim consumes that credential and binds a durable assertion to a hash of #2680's random browser-owner secret. The same browser owner may exchange again while both assertion and invitation remain valid, allowing recovery from a short restricted-session expiry. Another owner is rejected as replay. Losing the owner binding requires administrator regeneration; storage never reconstructs the original credential.

## Configuration and retention

`DOLLHOUSE_INVITE_TTL_HOURS` is a strict integer from 1 through 168 and defaults to 24. It is independent of magic-link TTL. Existing generations keep their persisted expiration when configuration changes.

Terminal cleanup is disabled unless `DOLLHOUSE_INVITE_RETENTION_DAYS` is explicitly set to a strict integer from 1 through 3650. The later cleanup implementation may remove only unaccepted terminal credential, claim, and delivery records. It must retain users, identities, roles, audit records, and accepted invitation history.

## Transaction and audit contract

The future Postgres implementation must make the database the cross-replica authority. Issuance takes a normalized-email advisory transaction lock. Other transitions lock the invitation aggregate and current generation in a stable order and use database time.

Every mutation runs through `IInvitationStore.runMutation` with a required transaction-scoped security-audit writer. Administrator issue, regenerate, and revoke calls additionally require the existing `appendConsoleAdminAuditEventWithTx` callback. There is no production no-op audit path. Issue #2681 uses `lockActivationCandidateWithTx` inside its wider activation transaction rather than calling a separately committing activation service.

All invitation foreign keys use `ON DELETE RESTRICT` to preserve security history. This means account deletion may need the existing anonymized-tombstone fallback. No live route uses these records in this foundation slice; purge behavior must receive focused integration coverage before invitation issuance is enabled.

## Transactional management slice

`PostgresInvitationManagementStore` implements the deliberately narrow
`IInvitationManagementStore`: issue, inspect, regenerate and revoke. Its exported
`createInvitationManagementMutation(tx, audit)` composes into a future lifecycle
transaction without claiming to implement claim, delivery, activation or cleanup.
There are no live route or dependency-container registrations in this slice.

Issuance creates the pending user, invitation, intended-role references and first
credential hash in one transaction. It creates no authentication identity, actual
role assignment or normal session. Existing accounts (including disabled/deleted
accounts retaining an email) are conflicts; account identity is never merged by
email. Existing email values use the same NFC, Unicode trim and lowercase rules as
new invitations. Administrator issuer IDs must match the audit actor.

All management mutations acquire `EXCLUSIVE` on `users` before locking
an invitation. This deliberately coarse beta safeguard blocks account inserts and
updates from existing writers that do not share an invitation advisory lock, and
closes the missing-row race around non-unique account email. It also conflicts
with the `ROW SHARE` table lock acquired by existing account writers' `SELECT FOR
UPDATE`, avoiding a table-lock upgrade cycle when those writers subsequently
update/delete the locked user. Plain reads remain compatible. The canonical email
check currently scans account identifiers/emails under that lock. A later scaling
change must introduce shared canonical uniqueness/locking across **all** account
writers before narrowing it. Composing claim/activation code must preserve the
users-before-invitation lock order. Transactions must remain short and must not
perform provider/network operations while holding these locks.

Generation expiry uses millisecond-precision PostgreSQL `clock_timestamp()` read
after locks, plus the validated TTL. Pending and explicitly expired invitations
can regenerate; accepted and revoked invitations cannot. Regeneration supersedes
the previous generation and revokes open claims atomically. Revocation is
idempotent and also revokes open claims. Neither operation clears a user's
disabled/deleted flag or activates an account. Inspection returns persisted state
and expiry metadata and never writes an expiration transition or exposes hashes.

The required transaction-scoped audit callbacks use the existing security/admin
streams: `appendSecurityAuditEventWithTx` and
`appendConsoleAdminAuditEventWithTx`. Audit failure rolls back the mutation and
both audit streams. Production composition must supply durable implementations;
there is no fallback/no-op writer. Admin context comes from authenticated server
state. Audit metadata contains IDs/generation/correlation only, with no email,
credential or invitation URL. No-op revocations do not duplicate transition audit.

The transaction runner copies audit context before waiting for a connection;
individual mutation methods copy secrets and role lists before their first await.
A service that captures input before calling `runMutation` must copy it at its own
async boundary as well. Credential copies are cleared when each mutation ends.

This is partial progress on #2678/#2690. Claim-owner verification, activation,
expiry jobs, delivery-attempt initialization (#2691), routes and pending-account
authorization enforcement remain separate slices. No delivery records are created
here, and migration 0054's explicit delivery-state requirement remains unchanged.
