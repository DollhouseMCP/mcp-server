# Private beta onboarding configuration

`DOLLHOUSE_BETA_ONBOARDING_ENABLED` defaults to false. This configuration slice
does not mount or enable onboarding: the bootstrap and transport integration must
consume the resolver after the complete path has passed qualification.

The pure resolver requires Streamable HTTP, embedded GitHub authentication,
`DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=true`, database storage, PostgreSQL auth storage
and PostgreSQL rate limiting. The descriptor console must be enabled and the
legacy HTTP console disabled. Existing console replacement evidence and readiness
checks remain mandatory; this flag does not override them.

Set `DOLLHOUSE_PUBLIC_BASE_URL` to the exact trusted HTTPS origin and
`DOLLHOUSE_ONBOARDING_SUPPORT_EMAIL` to the support mailbox shown in the invitation
email and claim page. Explicit `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` and
`DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` are required. Portfolio integration
credentials and legacy device-flow credentials are never used as a fallback.

Before enabling a candidate, register the exact enrollment callback
`https://<configured-origin>/auth/onboarding/github/callback` with the authentication
OAuth app alongside its ordinary login callback. Validating local configuration
does not verify the provider dashboard. Do not broaden callback matching to make
the two routes work.

SMTP settings reuse the shared TLS-enforcing resolver. All absent means explicit
manual-copy fallback; partial or invalid settings fail configuration. The emailed
MVP still requires complete SMTP settings and delivery qualification. This
resolver does not connect to SMTP or GitHub, send messages, or log configuration.

Existing administrator or service login methods may remain configured. The
invitation cohort's backend GitHub-only policy is a separate mandatory protection.
