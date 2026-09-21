# Durable invitation administration boundary

`createDurableInvitationAdminModule` is an **unregistered** console module. It does not change the legacy issuer, register routes, enable email delivery, create normal sessions, or add UI. Future assembly must use `assembleSecuredConsoleRouter`, its trusted console-origin/proxy configuration, bounded JSON parsing, and the existing account-admin security dependencies. Do not expose these routes before the full onboarding flow is ready.

The proposed resource is `/api/v1/admin/accounts/invitations`:

| Method and suffix | Input | Successful response |
| --- | --- | --- |
| POST root | `username`, `display_name` (string or null), `email`, `intended_roles`, optional `ttl_hours` | 201; explicit invitation metadata and one-time `claim_url` |
| GET `/:invitation_id` | No query or body fields | 200; metadata only |
| POST `/:invitation_id/regenerate` | Optional `ttl_hours` | 200; metadata and new one-time `claim_url` |
| POST `/:invitation_id/revoke` | Empty object | 200; revoked metadata; repeated revocation is domain-idempotent |

All routes require `console:admin:accounts` and current `admin_30m` elevation. Mutations inherit the console synchronizer CSRF/origin checks. Role authority uses the existing capability-tier policy, including immutable stored intended roles for existing invitations; inspection follows the same ceiling. Actor ID and audit context come from the authenticated session, never JSON. Unknown fields, query parameters, malformed identifiers, roles and TTLs fail before mutation. Shared management normalization handles Unicode names and email.

The module requires `IRateLimitStore`. Mutations share fixed one-minute budgets of 20 attempts per authenticated user and 100 per deployment. Keys contain only server-derived user IDs or a fixed deployment key. Exhaustion returns 429; store failure returns a sanitized 503 and performs no mutation. Future multi-replica mounting must supply the shared PostgreSQL rate store. GET inspection does not consume a mutation budget.

Every route explicitly uses `idempotency: 'not_applicable'`. Even a supplied `Idempotency-Key` cannot invoke persistent response caching. Responses are `Cache-Control: no-store`. Only issue/regenerate responses contain the fixed trusted-origin fragment link; inspection, revocation, durable records, and audits contain no recoverable credential. Do not add these responses to another generic response cache, request/response logger, persistent queue, or background job. A lost response requires authorized inspection and an explicit regeneration decision; automatic retries of issuance/regeneration are inappropriate.

`createDurableInvitationAdminAuditFactory` resolves the audit HMAC key before acquiring domain locks and uses the existing transaction-scoped security/admin audit appenders. Successful state changes and both audits commit together inside the management store; the console's outer account-mutation transaction runner must not wrap it. The injected `IAdminAuditWriter` records read/rejected/failed attempts separately. Repeated revocation of an already revoked invitation returns the terminal metadata through the store’s idempotent fast path and does not append a second success audit; the ledger records the state transition, not every successful retry. Audit exceptions are sanitized before reaching console diagnostics. No external work follows a successful mutation commit other than constructing the immediate response, preserving access to the one-time manual link.

Email composition is intentionally deferred to a subsequent slice. That slice must preserve the manual link after successful issuance even when delivery is unavailable, report submitted/failed/unknown/submitting truthfully, and never treat SMTP acceptance as delivery or retry an ambiguous attempt.
