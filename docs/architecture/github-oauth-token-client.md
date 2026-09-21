# GitHub authorization-code exchange

`GitHubOAuthTokenClient` sends one form POST to GitHub's fixed token endpoint.
The exact configured callback accompanies the code. Redirects are rejected,
the default timeout covers headers and body (15 seconds), and response reading
is bounded to 64 KiB even without a Content-Length header. Configuration can
reduce these limits; hard ceilings are 60 seconds and 1 MiB.

Only a bounded bearer access-token string is returned. OAuth errors in successful
HTTP responses fail closed; refresh tokens and other response fields are not
returned or persisted. The client neither logs provider text nor retains an
upstream error cause. Errors contain a fixed category and `retryable: false`:
a network failure may have consumed the authorization code, so the browser must
start a fresh authorization flow rather than automatically retry the same code.

The optional PKCE verifier follows RFC 7636's 43–128 unreserved-character syntax.
The enrollment-state service owns verifier generation and S256 challenge binding;
this client only sends the corresponding verifier during exchange. GitHub's
[OAuth application documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
supports S256 PKCE and requires the original verifier when a challenge was sent.

Ordinary `GithubSocialMethod` sign-in now uses this client without changing its
interaction, scopes, or account policy. Enrollment will use its separate state
and callback. HTTP callbacks remain supported for existing local development;
hosted enrollment must independently pin its trusted HTTPS callback. Every
successful exchange must still be followed by an authenticated `/user` lookup.

This is a partial implementation of #2709. Bounding the ordinary `/user/emails`
lookup remains separate. No enrollment route, new login intent, token persistence,
automatic retry, or live provider request is introduced by this change.
