# Pending-account authorization

Issue #2678 adds `users.activation_state`. Normal authenticated access requires
`active`, `disabled_at IS NULL`, and `deleted_at IS NULL`. Activation never
supersedes disablement or deletion.

## Enforcement paths

| Boundary | Authoritative check |
| --- | --- |
| Console BFF callback, existing session, elevation, TOTP | `PostgresConsoleIdentityResolver.resolveEnabledPrincipal` joins the canonical user and filters all three state controls on each call. |
| MCP and legacy console JWT requests | `AuthServiceRegistrar` supplies the database subject gate to unified bearer middleware, including requests to existing MCP sessions. |
| MCP database identity resolution | `UserIdentityService.resolveUserForSub` reloads the canonical link and validates the resolved user. It does not reuse the local username cache. |
| Embedded login completion (all methods and resumed consent) | `finishInteractionWithIdentity` checks eligibility before creating a grant or finishing login. |
| OAuth authorization-code/refresh redemption | `EmbeddedASOidcAccount.findAccount` checks eligibility; `extraTokenClaims` checks again before issuing token claims. |
| Embedded direct token issuance and validation | `EmbeddedAuthorizationServer.issue` and `validate` consult the same storage eligibility contract. |

`isSubjectAccountAllowed` uses the canonical `auth_accounts.user_id` when present.
An unlinked identity uses the existing provisioning convention, `users.username
= sub`. A pending username match is denied. A subject with neither a link nor a
user remains eligible for existing first-login provisioning; this gate is not an
invite-only enrollment policy. No email matching or automatic identity merging
is introduced. A dangling canonical link is denied. Physical account deletion
continues to rely on the existing grant/runtime revocation and sign-in identity
tombstones: this predicate cannot distinguish a never-seen subject from one
whose identity mapping and username have both been removed.

Database failures reject authentication. Eligibility is never cached. These
checks apply at authentication/request boundaries; they do not cancel work
already admitted or terminate an already-open response stream.

## Compatibility and scope

Existing migrated users default to active. Database-backed deployments apply the
user gate even when OAuth state uses filesystem or memory storage. Deployments
without a user database retain their existing authentication behavior. Local
stdio operator identity selection and offline CLI administration are unchanged.

This change does not create pending accounts, expose invitation routes, activate
users, grant roles, or issue restricted onboarding sessions. Those routes must
use their own restricted-session contract before they are enabled.
