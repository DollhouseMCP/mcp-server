# Atomic invitation activation store

`PostgresInvitationActivationStore.activate` is an internal, unwired database
boundary for #2681. Its input must be assembled by the trusted GitHub OAuth client
and the restricted, browser-bound invitation session. Neither a public JSON
`githubId` nor a caller-asserted `providerEmailVerified` is authentication evidence.
The method snapshots both cookie hashes and scalar metadata before awaiting.
A mandatory `OnboardingSessionAuthority` locks and validates the current owner
and restricted session in this same transaction, holding their rows until commit.
Returned server-held references must match the invitation, claim, owner, session
and user. Ended, replaced or expired sessions cannot activate a pending account.

The immutable decimal GitHub ID selects the identity. Email and login are profile
metadata, may differ from the invited account, and never select or merge users.
Missing provider email is supported; an absent email is never marked verified.
Unverified provider email is retained only as unverified profile metadata and
never participates in allowlist or deny-policy matching.
The invited email was proved by the consumed invitation credential/claim.

The transaction first uses the resource preflight from #2705 and the nonblocking
identity locks from #2701. It locks the complete principal and matching allowlist
key set, then checks the current invitation generation, browser owner, claim,
pending account, issuer activity and issuer capabilities for every intended role.
It rejects conflicting GitHub ownership, including the existing resolver’s legacy
`users.username === sub` owner, and current matching deny tombstones;
an explicit stable-ID tombstone cannot be bypassed by a newer email grant.
Expiry uses database time after the locks and authority checks, including the
restricted session lifetime as well as the invitation and claim.

On success the same transaction binds the GitHub identity, creates an authoritative
`github_id` sign-in grant if needed, applies exactly the intended roles, activates
the account, accepts the invitation/generation, completes the claim, appends an
authorization invalidation and writes the mandatory security events. A real admin
audit is additionally written only when the caller supplies actual authorized
admin context. Self-service activation does not impersonate the inviter. Audit
HMAC material must already be loaded before opening this transaction. After all
writes and audit, the same transaction deletes the exact locked restricted owner
and session through `completeEnrollmentWithTx`, checking both cookie hashes and
live expiry again after locks. A mismatch or failed cleanup aborts activation;
audit or cleanup failure rolls back every effect and retains the original records. Contention aborts the transaction and returns
`concurrent_update`; there is no automatic OAuth retry.

`already_activated` is a historical acknowledgement for the same browser owner,
claim, generation, immutable GitHub ID and still-active, available account. It may
acknowledge completion after the invitation/claim lifetime, but performs no writes,
role or authority restoration, metadata refresh, or additional audit. Disabled or
deleted accounts are rejected. This historical branch does not request live
pending-session authority because its claim has already completed. Neither result authorizes a normal session: a
future caller must pass current normal-session authorization checks separately.

The store creates no routes, OAuth exchanges, email sends, runtime sessions or
normal console sessions. The actual ordinary provisioning authority accepts the
stable-ID grant and preserves canonical user ownership after a GitHub rename.
The existing ordinary GitHub profile fetch still requires a verified primary
email: a later dedicated onboarding/login slice must remove that enrollment gate
for the invited cohort before this flow can be enabled end to end.

Focused PostgreSQL coverage exercises atomic rollback through security/admin
audit failures, current issuer capability and status changes, all matching deny
keys, identity ownership/races, revoked/superseded claims, different browser owners,
claim/session expiry during lock waits, ended/replaced session rejection, session
row-lock retention through activation versus a real session-ending writer, optional/unrelated email, renamed identities, real
future provisioning and history-only retries without regranting revoked authority.
