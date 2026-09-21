# Immediate invitation email orchestration

`InvitationDeliveryService` is an internal #2314 service that connects the durable
#2691 ledger, invitation template, and typed transactional SMTP interface. It
mounts no routes, changes no configuration, and opens no transport itself.

Its input is the trusted immediate `IssuedInvitation` returned by issue or
regeneration, plus authorized audit context and a correlation ID. Never construct
that view from browser JSON: recipient, display name, roles, timestamps and
credential must come from the server-owned issuance result. Token parsing binds
its public ID/generation to that view; this is not a replacement for the issue
service's authorization or a general credential-verification endpoint. All inputs
used by rendering are snapshotted before awaiting. The role description callback
supplies human-facing catalog text without duplicating role definitions here.

With no configured sender, delivery returns `manual_fallback/not_configured` and
creates no provider attempt. The caller already owns the one-time issue response
for manual copying. No returned outcome contains a token or copyable link.

With a sender, the service renders before reservation so template errors cannot
leave a reserved attempt. It then commits a current-generation ledger reservation
and submits exactly once only if the returned transient `submissionAuthorized`
flag is true. Duplicate correlation IDs return safe existing-attempt references;
this service never returns, caches or persists the authorization flag. A crashed
reservation remains `submitting` and cannot authorize another submission.

Typed SMTP acceptance maps to `submitted`, never delivered. Authentication maps
to confirmed `authentication` failure, TLS to `configuration`, and confirmed
connection/rejection failures to `not_sent`. Indeterminate outcomes, unexpected
throws and malformed results map to `unknown`, without retaining exception text,
causes, provider responses, or extra fields. Only a bounded actual provider ID
can be persisted; RFC Message-ID is not one. A provider result echoing the known
credential secret is discarded as unknown. Known acceptance metadata is limited
to a boolean; the ledger independently validates every stored result.

Result persistence occurs after the external submission in a separate audited
transaction. If it fails (including an ambiguous commit acknowledgement), the
service returns `uncertain` with the last known reservation ID, generation,
version and state. That snapshot may be older than the database's committed
state. It never invents confirmed failure or sends again. Repeating the same
correlation only reads its existing attempt; an unknown/submitting/submitted
latest attempt blocks a new send. A known failed attempt permits an explicit new
correlation retry while the caller still holds the raw issuance response. The
future authorized caller must enforce its bounded retry/rate-limit policy.

Regeneration or revocation can race after reservation and before SMTP. Any old
link sent in that window is inert under current generation/claim checks. The
result stays attached to its original attempt and cannot restore invitation or
account state. Deletion can reject a late result to preserve scrubbed metadata;
that is also returned as uncertainty, without re-submission.

Message bodies and the raw credential exist only in the current call and the
caller's one-time response. There is no durable outbox, token recovery, log entry,
or automatic retry. After response loss/navigation or an uncertain attempt,
operators inspect metadata and explicitly regenerate; they cannot retrieve the
old credential from this service. Do not persist the issuance input in a generic
idempotency cache. Tests use real PostgreSQL plus a fake typed sender only.
