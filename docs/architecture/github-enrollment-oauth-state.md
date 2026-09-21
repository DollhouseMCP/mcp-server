# GitHub enrollment OAuth state boundary

This slice prepares a one-time GitHub OAuth authorization request for an already authenticated restricted onboarding session. It does not register routes, exchange authorization codes, call GitHub, or link an identity.

GitHub's [OAuth web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow) strongly recommends an unguessable `state` and PKCE with an `S256` challenge. The enrollment service follows that contract with a dedicated callback path and only the `read:user` scope. It does not request repository or email scopes.

The browser receives a random 32-byte state in the GitHub authorization URL. Persistence contains only a server-keyed state hash, a server-generated correlation UUID, and the server-derived restricted-session context. A separate server-keyed HMAC purpose derives the PKCE verifier directly from the raw state; the verifier cannot be recovered from the stored state hash. Neither raw value is persisted. The state service returns the scalar account, invitation, claim, generation, and correlation context only to the internal orchestration layer; the browser response projects only the authorization URL and expiry.

The configured callback must be a canonical HTTPS URL with the exact `/auth/onboarding/github/callback` path and no user information, query, or fragment. The ordinary GitHub sign-in callback and interaction state are separate flows.

There is one state slot per onboarding owner. Starting again replaces the prior slot. The store revalidates the current owner/session/invitation/claim authority in the same transaction before creating or consuming state. A callback with the wrong state, owner, session, purpose, callback, or server-held account context cannot delete the valid record. A valid callback consumes the record before any later provider request, so replay and ambiguous token-exchange retries require a new authorization start. A cancellation may use the same consume operation only after this binding succeeds.

The state expires after five minutes or with the restricted session, whichever comes first. A later activation step must revalidate the live restricted session and invitation again after provider I/O before it links the immutable GitHub account ID.
