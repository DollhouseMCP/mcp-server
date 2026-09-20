# Invitation delivery attempts

This internal store implements #2691 for #2678 and #2314. It does not call SMTP,
construct invitation URLs, retain raw invitation credentials, or expose routes.

## Initialization and reservation

Migration 0054 keeps `state NOT NULL` with **no default**. The store writes an
explicit `submitting` state when reserving a provider attempt, with `requestedAt`
and `startedAt` set to database time after acquiring locks. `completedAt` remains
null. Omitting state is an error, not an implicit unsent record. An invitation
with no attempts is unsent; `not_attempted` is reserved for explicitly created
unsent records and is never the default for a reservation.

Reservation requires the current, unexpired pending invitation generation and a
pending, non-disabled, non-deleted account. Attempts are numbered monotonically
within their generation. The store uses the management store's lock order:
users table lock, invitation lock, then attempt lock where needed. Concurrent
reservations cannot authorize duplicate submissions.

The caller chooses a stable correlation UUID for one reservation. A new attempt
returns `submissionAuthorized: true`; repeating that reservation returns its
persisted record with `submissionAuthorized: false`. This flag is a transient
process decision. **Never persist or replay a true flag through generic API
idempotency storage.** Only the original winning call may submit, and only after
its transaction commits. A successful reservation must not be interpreted as a
successful send.

A crash after reservation leaves `submitting`, which is already an ambiguous
outcome: do not resend or attempt to recover the raw credential. Inspection and
explicit regeneration are the recovery path. The future SMTP/route integration
must own the raw credential transiently in the winning call and enforce this
submission contract; this store cannot prove that an external send happened.

## Results and retries

| Current state | Operation | Outcome |
| --- | --- | --- |
| No attempt (or explicitly unsent record) | Reserve | New `submitting` attempt |
| `submitting` | Record provider acceptance | `submitted` with completion time |
| `submitting` | Record certain non-submission/rejection | `failed` with completion time |
| `submitting` | Record ambiguous provider outcome | `unknown` with completion time |
| Terminal state | Repeat identical result | Same record, version and timestamps |
| Terminal state | Different result/metadata | Conflict; previous evidence remains |
| Latest attempt `failed` | Explicit fresh reservation | Next attempt number, `submitting` |
| Latest attempt `submitting`, `submitted`, or `unknown` | Fresh reservation | Conflict; no blind retry |

A repeated correlation never authorizes another send, including after failure.
A known failure can be retried only by explicitly choosing a new correlation.
`failed` supports `configuration`, `authentication`, `recipient_rejected`,
`rate_limited`, and `not_sent` classifications. Timeout or connection loss is
`unknown`, not confirmed failure. Unknown outcomes are terminal in this slice;
provider-event reconciliation needs a separate evidence-backed operation.

`submitted` means provider acceptance only. It does not mean delivered, accepted
invitation, or activated account. Results arriving after regeneration/revocation
remain evidence for their original generation and never mutate the invitation,
current generation, or account. A regenerated invitation can reserve its own
first attempt without rewriting earlier ambiguous evidence.

## Metadata and audit

Provider identifiers are bounded stable configuration names. Optional provider
message IDs accept a bounded opaque ID/SMTP Message-ID alphabet, excluding URLs,
query strings, whitespace and multiline responses. Provider IDs must come from
the trusted adapter's ID field, not arbitrary error text.

Diagnostic metadata is restricted to integer `durationMs` (0–86,400,000), integer
`smtpStatus` (100–599), and boolean `providerAccepted`. Unknown keys, strings,
nested payloads, unbounded numbers, and contradictions with the recorded state
are rejected. Raw errors, credentials, invitation URLs and SMTP/API secrets must
never enter these fields. Unknown outcomes cannot assert `providerAccepted`.

Every real reservation/result mutation appends security audit and, for an
administrator operation, administrator audit inside the same transaction.
Sanitized audit metadata contains invitation/user/attempt IDs, generation,
attempt number, state and correlation only. Audit failure rolls back the row
change. Exact idempotent repeats create neither duplicate evidence nor duplicate
audit events.
