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

All invitation foreign keys use `ON DELETE RESTRICT` to preserve security history. A user referenced as either recipient or inviter therefore takes the existing anonymized-tombstone deletion path. No live route uses these records in this foundation slice.

Account deletion redacts invitations only where the deleted user is the recipient. It replaces both email fields with the unique `deleted-<invitation-id>@deleted.invalid` tombstone, replaces the intended username with `deleted-<invitation-id>`, clears the intended display name, and clears delivery provider message IDs, failure classifications, and sanitized detail payloads. Invitation IDs, recipient tombstone links, inviter IDs, correlation IDs, roles, credential hashes, delivery enums/times, and terminal lifecycle states and timestamps remain as minimal audit history. Pending invitation aggregates and generations become revoked, and open claims become revoked, using one database timestamp. Accepted, expired, revoked, superseded, and completed history remains terminal. Invitations for which the deleted account was only the inviter retain their other recipient's data.

Deletion first locks the `users` row and then recipient invitation aggregates in UUID order. Invitation management's coarse `users EXCLUSIVE` gate conflicts with that initial `FOR UPDATE` table lock before management can lock an invitation, so either transaction completes before the other enters the shared users-before-invitations sequence. Claim, delivery, activation, and future cleanup writers must use that same order. A delivery worker must lock and re-check the recipient before persisting a provider result; once the recipient is deleted or its invitation is redacted, a late result must leave provider metadata null. Transactions must not call providers while holding these locks.
