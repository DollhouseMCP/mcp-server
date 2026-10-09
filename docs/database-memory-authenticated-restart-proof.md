# Authenticated compiled memory qualification

This proof exercises the guarded database profile through actual compiled `dist/index.js` HTTP entrypoints in separately owned processes. It builds on the production wiring in #3042 and the read-fidelity and boot qualification contract in #3038. It changes tests and documentation only. It does not authorize deployment or activate a live cohort.

The required PostgreSQL integration configuration runs two suites with nine cases. The fixture creates a unique migrated database and an ordinary non-BYPASSRLS application role, complete raw/child/tag/volume state, explicit tenant modes and quotas, and actual authentication account links. Historical fixtures must pass real equivalent reconciliation before protected boot. Every child runs the actual main dispatcher without inherited Jest/Test-mode environment. Startup executes the real registry and whole-tenant qualifier.

| Case | Actual boundary and expected outcome |
| --- | --- |
| 1,000 and 1,001 permanent entries | Signed ES256 SDK request and selected manager preserve every entry; full append refuses without pruning, handoff creation or owner changes. |
| Large legacy UTF-8 | Eight complete historical entries above 2 MiB UTF-8 but below 2 Mi JavaScript units remain readable; the smaller 256 Ki-unit write cap refuses without loss. |
| Above recovery bound | A controlled unsupported historical head above 2 Mi JavaScript units fails read inspection and actual cold boot before listen; storage remains unchanged. This is not an acknowledged supported write. |
| Trusted internal central CAS | Two independent runtimes prepare complete candidates at the same original revision. One known winner and one exact retained loser follow a real owner lock wait. Fresh cold boot refuses retained evidence; configuration-off boot also refuses protected state. |
| Permitted public AQL CAS | Two genuine signed CREATE requests pass their actual gates and prepare at the same revision. Exactly one structured success names the persisted entry, and one structured refusal retains its unchanged complete canonical envelope. |
| Clean AQL restart | Permitted signed append is acknowledged, then a new compiled process requalifies the exact winner. Anonymous/invalid tokens, foreign subject and wrong READ endpoint cannot write. Same-tenant sessions share the manager while activation state stays isolated. |
| Console authority and restart | Actual cookie middleware, subject lookup, Origin/double-submit CSRF, target, If-Match and owning completion execute. Authorized GET/PATCH roundtrip and fresh compiled restart preserve the owner. Anonymous/expired/foreign/CSRF/Origin/stale requests refuse. |
| Console CAS | Two fresh embedded/Postgres runtimes enter the actual owner CAS with two prepared candidates at the same revision; one HTTP 200 and one 412 preserve the winner and unchanged complete loser. |

The three races use a uniquely owned trigger installed after verified boot to hold the genuine owner UPDATE. Before release, the test observes both prepared durable envelopes with the same original owner/user/revision and an actual waiting owner UPDATE. It compares the complete canonical envelope, not unnormalized request bytes, and checks exact retained quota rows and bytes. A stale ETag refusal before preparation is a separate no-mutation control. The successful handoff is retired by its genuine owner; the unresolved loser remains. Storage revision can advance multiple times because the existing parent/tag/child triggers increment it within the one winning transaction.

A test-only preloader delegates to the actual provider, container and session methods with their original receiver and arguments. For the trusted internal central save only, it holds a real signed READ invocation inside its original ContextTracker scope. Opaque handles identify the original child-local provider, manager, operation and invocation; they cannot select a tenant or manufacture authority. Unknown/other-child handles, commands during another internal command, and commands after release/disposal/disconnect refuse. The originating SDK/session remains live until release. This proves owner/admission/CAS/retention for an internal API; a provider operation is not a public write grant. The separate real AQL and console controls establish their public authorization. Invalidation does not cancel or roll back an already-running write, and this fixture introduces no production request-expiry contract.

The console cases boot a separate fresh embedded/Postgres child using the real ordinary-role database readiness verifier, registrar, auth/session stores, actual auth_accounts subject, startup allowlist cutover and guarded qualifier. Generated cookies are inserted using the existing session/HMAC representation. They do not prove login, browser/OIDC authentication or allowlist sign-in admission. A healthy session without console:self is rejected by the actual schema CHECK; the normal un-elevated session cannot access the admin route and receives its actual step-up refusal.

The private console mount evidence explicitly supplies fixture assertions for all eleven external checks below. **None is proved by these console tests**, even when related actual startup components execute:

- production_database_migrations
- security_invalidation_multi_replica
- allowlist_authority_parity
- embedded_as_login_step_up
- account_invite_redemption
- oauth_grant_revocation
- github_integration_connect_callback
- portfolio_sync_live_repository
- signing_key_auth_policy_multi_replica
- approval_execution_projection
- audit_telemetry_projection

Each case owns its child processes, SDK sessions, database connections, barriers, directories and generated keys from setup onward. Explicit protocol session termination and transport close preserve both failure causes and have finite settlement bounds. A rejected held SDK request is cancelled through its own signal to clear the pinned SDK's otherwise retained request timer. Child final close, rather than exit alone, precedes database/role/directory cleanup. Unproven child close preserves those resources and fails the case. The conflict restart and clean restart use separate owned databases; unresolved evidence is never deleted to manufacture successful boot.

Compile with the normal project build and runtime-asset copy step before the required PostgreSQL integration invocation. Run both AuthenticatedMemoryCompiledRestart.test.ts and AuthenticatedMemoryConsoleRuntime.test.ts with tests/jest.integration.config.cjs and the existing required service environment. The observer requires the actual compiled tree and owned IPC child; it is not loaded by production. Local ARM/Node 24/PostgreSQL 17.10 execution is separate from hosted platform qualification. Inherited stack dependency audit/type failures remain recorded, and final front reconciliation plus actual installed graph and full CI qualification remain required.

This bounded proof establishes neither live cohort eligibility nor deployment-wide old-writer exclusion, production quotas/provisioning, global drain, actual replacement readiness, or activation authority.
