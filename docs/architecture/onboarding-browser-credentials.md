# Restricted onboarding browser credentials

This #2680 foundation provides credential, cookie, CSRF, and server-record contracts only. It enables no routes, persistence, normal login, or invitation exchange. PostgreSQL persistence and atomic session replacement are a separate slice, followed by the claim page and GitHub enrollment integration. Record validation checks shape and lifetime; it does not authenticate anyone.

## Independent credentials

`OnboardingCredentials` reuses the existing 32-byte cryptographic opaque-value generator and keyed HMAC primitive. Owner, session, and CSRF values have separate hash domains, also distinct from ordinary console hashes. Persist only hashes. Never log, serialize into an audit event, or place raw credentials in a URL or browser storage. These values are not JWTs and cannot be used as `dh_session`, OAuth access tokens, or MCP credentials.

The stable browser owner and the restricted session have different lifetimes:

- The owner exists server-side **before** an invitation claim can consume its server-derived hash. Its cookie is `__Host-dh_onboarding_owner`. A validated current invitation may renew the same owner only within 168 hours of its original creation, also bounded by server-authoritative invitation expiry. The absolute owner deadline never slides with renewal. Renewal never extends an invitation. A browser may own multiple invitations; expiry may cover the latest still-valid owned invitation, but each claim is always checked against its own expiry.
- Successful claim exchange creates a fresh independent `__Host-dh_onboarding_session` and fresh CSRF token. Its maximum lifetime is 15 minutes, further capped by owner, claim, and invitation expiry. Expiry of this session does not discard the owner. Reopening the current invitation can therefore resume with the same owner while the invitation remains valid.
- Ending a session revokes that session and its CSRF token, retaining the owner for resume. Explicitly ending the owner revokes all of its sessions and clears both cookies. Loss of the owner credential cannot be repaired by trusting a browser-supplied hash; an operator must regenerate an already claimed invitation.

Both cookies are host-only (`__Host-`, no Domain), Path=/, Secure, HttpOnly, and SameSite=Lax. Lax permits the top-level GitHub OAuth callback. HTTPS is required; these helpers provide no HTTP relaxation. Cookie Max-Age must also be capped to the remaining server-record lifetime by the future caller. Clearing a cookie alone does not revoke a server record.

## Authority and transaction integration contract

Future persistence must use distinct owner/session namespaces, separate from normal console sessions, with hash keys and only the references defined in `OnboardingRecords`. Do not copy roles, raw invitation tokens, or recipient email into these records. The sole scope is `onboarding:github-enrollment`; no console, administrator, API, or MCP scope is accepted.

For both issuance and every session lookup, call the mandatory `OnboardingClaimAuthority.lockActivationCandidateWithTx` seam in the transaction. It locks and validates the pending account, current invitation generation, unexpired invitation, open unexpired claim, and matching owner binding. Compare the returned claim references and verified-email timestamp against the server session record. References and owner hash come from managed server records, never browser JSON. The helper's expiry calculation is only applied after this validation and is not a substitute for it.

Create a session only after a successful claim transaction. Future persistence must atomically validate live authority, revoke the prior session for the same owner, and insert the replacement with a fresh session credential and CSRF hash. A crash between claim and session creation is recoverable through the claim store's same-owner resume semantics. A failure must never set a cookie for an uncommitted session.

Multiple tabs retain the same owner. A new exchange may replace its restricted session, but must not silently replace the browser owner or transfer another owner's claim. Every mutation must validate the current session's invitation/generation/claim references as well as its CSRF hash: a stale tab's CSRF token then fails after replacement. Activation must revoke the restricted session and issue a separately authorized normal session only after the atomic activation commit.

## Browser mutation and claim-page contract

`onboardingMutationAllowed` requires POST, an exact canonical configured HTTPS Origin, and a synchronizer token matching the authenticated owner/session record. Missing, array-valued, or mismatched origin/CSRF inputs deny. The future same-origin, no-store bootstrap response supplies the raw CSRF token to page memory; credential cookies remain HttpOnly. The bootstrap must authenticate or create the managed owner without replacing a live owner. Apply this guard to explicit exchange/end-session actions; GitHub callbacks need their independent server-bound OAuth state and PKCE checks.

The agreed invitation link is `/auth/onboarding/invitation#token=...`. The fragment avoids sending the raw token in the initial HTTP request. The future claim page must promptly replace browser history with the clean URL, retain the token only in memory, and exchange through POST after explicit user action. A GET, preview, or email scanner must not consume a claim. Use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, restrictive CSP, and no third-party resources/analytics on onboarding pages. Never accept an owner hash from the browser as proof of ownership.

These integration requirements remain unimplemented until the persistence and route slices land; the unit tests here cover only the exported cryptographic, cookie, CSRF, record, and expiry boundaries.
