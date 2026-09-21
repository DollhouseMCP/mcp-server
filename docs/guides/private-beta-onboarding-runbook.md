# Private-beta onboarding enablement

Use this runbook only with a qualified `beta` candidate containing the guarded runtime wiring and its prerequisites. Merged foundations or a successful configuration check alone do not authorize enabling onboarding. Deployment/provider changes require the separate operator release decision. Track acceptance in [#2684](https://github.com/DollhouseMCP/mcp-server/issues/2684), artifact readiness in [#2460](https://github.com/DollhouseMCP/mcp-server/issues/2460), and hosted deployment in [#2461](https://github.com/DollhouseMCP/mcp-server/issues/2461).

## Candidate and offline evidence

Record the exact beta SHA, version, artifact digest, applicable CI results and review dispositions. Confirm compiled claim-page assets and hosted runtime files are present in the artifact actually being installed. Follow [beta release/CD](../developer-guide/beta-release-cd.md); verify registered manual workflows, source selection, environment protection and prerequisite package provenance. Never substitute a historical green run or publish to stable channels.

Before any live provider call, qualify on a disposable database with synthetic secrets:

- Pure configuration validation, default-off bootstrap, mismatched-database rejection and schema failure before SMTP/registration.
- Actual transport ordering: Host validation, exact claim-page CSP, 1 KB/no-inflate onboarding JSON and 2 KB/no-inflate administrator mutations before general JSON parsing.
- Invitation lifecycle, pending-account denial, GitHub-only cohort policy, restricted sessions, replay/expiry/concurrency, activation rollback and independent-instance HTTP journeys.
- Secret projections over responses, durable state and audits. Fake SMTP acceptance and fake GitHub responses are deterministic adapter evidence only.
- Built-browser claim-page behavior and the real BFF ordinary-login round trip when those qualification suites are available; record their exact results and remaining gaps rather than assuming the service journey covers them.

## Configuration inventory

The deployment's `.env.production` is loaded by generated Compose. Preserve its restricted permissions; inspect presence and validated status without printing values. Confirm effective container settings, since explicit Compose `environment` entries override `env_file` values.

| Setting | Required posture |
| --- | --- |
| `DOLLHOUSE_BETA_ONBOARDING_ENABLED` | Defaults `false`; enable only after every required gate below passes. |
| `DOLLHOUSE_TRANSPORT` | `streamable-http` |
| `DOLLHOUSE_AUTH_ENABLED`, `DOLLHOUSE_AUTH_PROVIDER` | `true`, `embedded` |
| `DOLLHOUSE_AUTH_METHODS` | Include `github`; exclude `trivial-consent`. Existing approved administrator/service methods may remain; cohort policy still denies alternative login. |
| `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED` | `true` |
| `DOLLHOUSE_STORAGE_BACKEND` | `database` |
| `DOLLHOUSE_AUTH_STORAGE_BACKEND`, `DOLLHOUSE_RATE_LIMIT_BACKEND` | `postgres`, `postgres` |
| `DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED`, `DOLLHOUSE_HTTP_WEB_CONSOLE` | `true`, `false` |
| `DOLLHOUSE_PUBLIC_BASE_URL` | Trusted HTTPS origin without credentials, path, query or fragment. |
| `DOLLHOUSE_ONBOARDING_SUPPORT_EMAIL` | Valid support address displayed in invitations and the claim page. |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID`, `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` | Explicit authentication-app credentials; no portfolio/device-flow fallback. |
| `DOLLHOUSE_DATABASE_URL`, `DOLLHOUSE_DATABASE_ADMIN_URL` | Approved application and system/migration connections to the intended database. |
| `DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME`, `DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER` | Expected production identity; the user check targets the application connection. |
| `DOLLHOUSE_MASTER_ENCRYPTION_KEY` | Existing database token-encryption key, preserved across replicas and restarts. |
| `DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY` | Shared base64-encoded 32-byte key; preserve to keep browser/owner bindings valid. |
| `DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY`, `DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID` | Existing 32-byte encryption key and stable key ID; preserve any retired decryption keys. |
| `DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY` | Shared base64-encoded 32-byte selector key. |
| `DOLLHOUSE_AUDIT_HMAC_SECRET` | If explicitly configured, preserve the shared hex key; otherwise verify the existing database-managed audit resolver/key material is shared. |
| `DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE` | Path to genuine, complete replacement evidence; never generate placeholder successes. |
| `DOLLHOUSE_HTTP_ALLOWED_HOSTS`, `DOLLHOUSE_TRUSTED_PROXIES` | Approved public Host allowlist and actual trusted immediate-proxy CIDRs. |
| `DOLLHOUSE_INVITE_TTL_HOURS` | Default 24; deliberate integer override 1–168. Existing issued expirations are unchanged. |
| `DOLLHOUSE_INVITE_RETENTION_DAYS` | Do not enable destructive invitation cleanup without preserving the durable GitHub-only cohort marker. |

Validate the existing TLS posture and public ingress boundary. An unrestricted all-interface bind preserves SDK behavior but does not establish a secure hosted deployment. Behind Caddy, trust the immediate app-facing proxy; `DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES` separately governs upstream edge proxies. See [hosted deployment automation](hosted-deployment-automation.md).

## Database and readiness gates

Apply and record the existing migration procedure before activation, including `0054_invitation_lifecycle.sql`. Application `database/bootstrap.ts` does not apply SQL migrations. The opt-in schema probe must resolve all five invitation tables, `users.activation_state`, `auth_kv` and `security_audit_events` before SMTP or registration.

A successful zero-row probe proves readable table/column shape only. Record migration provenance plus required constraints, unique indexes, RLS, write privileges and the actual database identity separately. Do not infer those properties from an empty SELECT or repair production by rerunning test DDL.

Existing console readiness and replacement-evidence checks remain mandatory. The evidence parser requires all 11 `WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS` from `WebConsoleReplacementReadiness.ts`, including database migrations, multi-replica invalidation, allowlist parity, login/step-up, audit projection and other console capabilities. Existing `/healthz`, `/readyz` and unauthenticated `/mcp` → 401 checks remain useful but do not qualify onboarding.

## Provider and log prerequisites

Register both exact authentication OAuth-app callbacks at the configured origin:

- `/auth/onboarding/github/callback` for invitation enrollment.
- `/auth/social/github/callback` for ordinary GitHub sign-in.

Local configuration cannot inspect the provider dashboard. Confirm exact matching and do not widen wildcards or substitute portfolio callbacks/scopes. Record provider configuration evidence without credentials, authorization codes, state or tokens.

For email, supply a complete validated `DOLLHOUSE_SMTP_HOST`, `DOLLHOUSE_SMTP_PORT`, `DOLLHOUSE_SMTP_USER`, `DOLLHOUSE_SMTP_PASSWORD`, `DOLLHOUSE_SMTP_FROM` configuration. The port may use the resolver's default. Enabled startup verifies SMTP TLS/auth before registration; verify real sender authorization and controlled-mailbox receipt separately. Provider acceptance means submitted, not delivered. Entirely absent SMTP selects manual-copy fallback; partial configuration fails, and `magic-link` authentication requires complete SMTP. Manual fallback does not qualify the emailed MVP.

Before enablement, require the Caddy custom-CSRF redaction fix from [#2739](https://github.com/DollhouseMCP/mcp-server/pull/2739) and the callback-error log-redaction fix from [#2741](https://github.com/DollhouseMCP/mcp-server/pull/2741). Broader sanitized operator telemetry remains a separate follow-up in [#2719](https://github.com/DollhouseMCP/mcp-server/issues/2719). Inspect the generated ingress configuration and any extra proxy/APM layer. Never log request bodies, cookies, `X-Onboarding-Csrf`, raw exceptions, OAuth code/state/query strings, claim credentials or tokens. The initial claim fragment is absent from HTTP requests but must also be removed from browser history. Verify captured logs using synthetic sentinels, not live secrets.

## Staged live acceptance and limits

After the separate enablement approval, start with controlled internal identities and a controlled mailbox. Prove issue → receipt/manual copy → explicit claim → GitHub enrollment → atomic activation → fresh ordinary BFF sign-in to the same user. Check a second instance, replays, expired/revoked/regenerated links, disabled users, role boundaries and no email-based account merge. Inspect sanitized audits and logs. Exercise keyboard, mobile/zoom, refresh/back and URL-history behavior in the built browser.

Enrollment treats optional provider email as unverified metadata. Ordinary `GithubSocialMethod` has a pre-existing requirement for a verified primary GitHub email; current enrollment acceptance does not remove it. Explicitly qualify the missing-primary-email adverse case and document the resulting ordinary-login limitation tracked in [#2743](https://github.com/DollhouseMCP/mcp-server/issues/2743). Do not silently change that policy or describe fake verified-email/provider tests as proof of support for every GitHub account.

Record real SMTP receipt, both provider callbacks, actual ordinary login, browser behavior, proxy headers and log redaction separately. Until each has evidence, the corresponding live behavior remains unproved even when unit, disposable-PostgreSQL and fake-provider journeys pass. Do not expand the cohort based on an incomplete result.

## Rollback and evidence retention

Disable `DOLLHOUSE_BETA_ONBOARDING_ENABLED` and restart every replica using a qualified candidate that retains pending-account and GitHub-only protections. Verify public onboarding and durable invitation-admin routes are absent while existing active GitHub users can still sign in. This disables new onboarding; it does not revoke established normal users. Outstanding invitations become temporarily inaccessible and may expire before re-enablement.

Preserve database schema, invitation cohort rows, identities, roles, allowlist entries, audit history and key material. Do not drop migration objects, delete cohort markers, rotate keys casually or roll back to a binary predating these guards. Existing hosted source rollback does not undo database migrations; a database restore needs a separate reviewed plan.

Attach to #2684/#2460/#2461 the source SHA/artifact, non-secret configuration status, migration evidence, CI/browser/BFF results, provider/SMTP acceptance, sanitized negative-case results, remaining limitations, approver and rollback validation. Keep secret values and raw captures out of issues, logs and attachments.
