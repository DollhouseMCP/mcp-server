/**
 * Authentication Provider Interface
 *
 * The pluggable contract for credential validation. Implementations
 * validate a bearer token and return identity claims. The provider
 * knows nothing about Express, sessions, or the database — those
 * concerns live in the middleware and session wiring layers.
 *
 * Three implementations ship today (selected via DOLLHOUSE_AUTH_PROVIDER):
 * - `EmbeddedAuthorizationServer` (DOLLHOUSE_AUTH_PROVIDER=embedded):
 *   the §8.1 on-box authorization server. Issues + validates ES256
 *   `at+jwt` access tokens. Multi-method (GitHub, magic-link,
 *   local-password, trivial-consent). The recommended choice for
 *   production deployments.
 * - `OidcAuthProvider` (DOLLHOUSE_AUTH_PROVIDER=oidc): bridge mode that
 *   validates tokens issued by an external OIDC provider against its
 *   JWKS. Use when an upstream IdP already exists.
 * - `LocalDevAuthProvider` (DOLLHOUSE_AUTH_PROVIDER=local): self-signed
 *   ES256 JWTs for solo dev. Generates a keypair on first use.
 *
 * Swapping providers is a config change (DOLLHOUSE_AUTH_PROVIDER env var),
 * not a code change.
 *
 * @module auth/IAuthProvider
 */

/** Claims extracted from a validated credential. */
export interface AuthClaims {
  /** Unique subject identifier (e.g. "todd", a UUID, an OIDC sub claim). */
  sub: string;
  /** Human-readable display name, if available. */
  displayName?: string;
  /** Email address, if available. */
  email?: string;
  /** Tenant ID for multi-tenant deployments. null for single-tenant. */
  tenantId?: string | null;
  /** OAuth scopes granted by the token (e.g. `['mcp', 'offline_access']`). */
  scopes?: string[];
  /**
   * Authorization roles assigned to the subject. Sourced from
   * `StoredAccount.roles` and emitted by `extraTokenClaims` as the JWT
   * `roles` claim. Distinct from `scopes` — scopes describe what the
   * token CAN do (OAuth permission), roles describe what the user IS
   * (org-level role assignment). The bootstrap CLI sets `['admin']` on
   * the pre-claimed admin identity (must-fix #22 / spec L923).
   */
  roles?: string[];
  /** Token expiration as Unix epoch seconds, if applicable. */
  exp?: number;
}

/** Result of a credential validation attempt. */
export type AuthResult =
  | { ok: true; claims: AuthClaims }
  | { ok: false; reason: string };

/** The pluggable authentication provider interface. */
export interface IAuthProvider {
  /** Human-readable provider name for logging (e.g. "local-dev", "auth0"). */
  readonly name: string;

  /**
   * Validate a bearer token extracted from an HTTP request.
   * Returns claims on success or a reason string on failure.
   */
  validate(token: string): Promise<AuthResult>;

  /**
   * Issue a signed token for a subject. Implemented only by
   * `LocalDevAuthProvider` for the dev-convenience startup token path.
   * The embedded authorization server issues tokens via the standard
   * OAuth flow (oidc-provider's grant machinery) so every issued token
   * has a Grant, an `accountId`, and is reachable from
   * `revokeByGrantId`. The OIDC bridge does not issue at all.
   */
  issue?(sub: string, options?: IssueOptions): Promise<string>;
}

/** Options for IAuthProvider.issue(). */
export interface IssueOptions {
  displayName?: string;
  email?: string;
  scopes?: string[];
  /** Token lifetime in seconds. Default: provider-specific. */
  ttlSeconds?: number;
}
