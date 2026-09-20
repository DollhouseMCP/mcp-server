# PostgreSQL restricted onboarding persistence

`PostgresOnboardingStore` is the internal #2680 persistence slice. It enables no routes, mail, OAuth, or ordinary sessions. Its constructor requires the current-claim authority supplied by `PostgresInvitationClaimStore`; there is no permissive fallback or cache.

## Bounded storage and lock order

The existing `auth_kv` table contains two distinct namespaces, `DollhouseOnboardingOwnerV1` and `DollhouseOnboardingSessionV1`. Both use the owner's keyed hash as their primary-key ID. One owner has at most one session slot; that payload contains the separate restricted session hash. Every read/delete targets a namespace and exact owner key, without scanning all sessions. Neither namespace is an oidc-provider model or a normal console session. Only hashes and the strict server record references are persisted, with no raw credential, CSRF token, recipient address, roles, or provider tokens.

Issuance and session lookup acquire the authority's users → invitation → claim locks, then owner → session. An unlocked session hint may resolve server-held claim references but never grants access; the session is read again under locks. End-owner, end-session, and owner-CSRF operations acquire owner → session as needed and never subsequently acquire user/claim locks. Database time is read after locks. Any non-null revokedAt denies, even if it names a future time. Missing, malformed, expired, mismatched, disabled/deleted/active-account or superseded/revoked claim context denies.

## Store operations

- `createOwner` inserts a fresh server-generated owner hash and CSRF hash with a 15-minute bootstrap lifetime. Conflicting IDs never overwrite an owner. `findOwner` resolves only an active managed owner. The cookie orchestrator must preserve an existing valid owner before invoking the claim store; it must never accept an owner hash from browser JSON.
- `replaceSession` runs only after a successful claim. It revalidates live authority in its transaction, refreshes the owner no later than original creation +168 hours, and atomically replaces the single session slot with fresh session and CSRF hashes. The new session expires at the earliest of 15 minutes, owner, claim, or invitation expiry. The owner deadline never slides past its original cap; renewal cannot extend an invitation. A live session for a different invitation/generation/claim is a conflict until explicitly ended, preventing silent context switches across tabs.
- `findSession` requires both owner and restricted-session hashes derived by the server from their separate HttpOnly cookies. It rechecks live authority plus user, invitation, generation, claim, verified-email time, owner binding and expiry. Ordinary auth scopes fail shape validation. Authority/database outages propagate rather than returning a cached session; route integration must sanitize those errors.
- `endSession` deletes only a matching session slot and retains the stable owner. `endOwner` deletes both and explicitly loses resume ability. A stale session cannot end a replacement. After session expiry or lost exchange response, the same owner can resume the still-valid invitation claim and receive fresh credentials; after owner loss, an already consumed invitation needs operator regeneration.

Raw values are minted outside the store with `OnboardingCredentials`; only their purpose-specific hashes enter these methods. The server emits cookies only after successful commit. It must not persist or replay a generic idempotency result containing credentials. Claim consumption already carries the claim store's transaction audit; these methods follow the existing session-store separation and do not themselves create account/claim/admin audit events. Future route orchestration owns its session/security event integration.

## CSRF bootstrap after reload

Only hashes are persisted, so a reload cannot recover an old raw CSRF token. `rotateOwnerCsrf` and `rotateSessionCsrf` accept a freshly generated CSRF hash and replace only the relevant hash. They preserve ownership, session ID, references, and every expiry. Owner rotation requires a live owner; session rotation also locks and validates the current claim authority. Wrong/stale session or ended owner fails. The future explicit bootstrap POST must require exact configured HTTPS Origin and the appropriate Secure/HttpOnly cookie(s), but may omit the previous CSRF token solely for this nonce bootstrap. It returns the new raw token in a no-store same-origin response, never in a cookie or persistent browser storage. It must not permit CORS to untrusted origins.

Other mutations still require the ordinary synchronizer-token guard. An older tab whose nonce was superseded must fetch a fresh bootstrap token and retry its explicit action, after verifying its displayed invitation context still matches. Session CSRF refresh must never fall back to owner context to bypass a stale/revoked restricted session.

The future claim page must preserve the fragment-only invitation credential contract, remove the fragment promptly, and consume it only through explicit CSRF-protected POST. No page or exchange handler is mounted by this slice.
