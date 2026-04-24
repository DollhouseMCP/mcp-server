/**
 * Authentication Provider Interface
 *
 * The pluggable contract for credential validation. Implementations
 * validate a bearer token and return identity claims. The provider
 * knows nothing about Express, sessions, or the database — those
 * concerns live in the middleware and session wiring layers.
 *
 * Two implementations:
 * - LocalDevAuthProvider: self-signed ES256 JWTs for development
 * - OidcAuthProvider: validates against an external OIDC provider's JWKS
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
  /** Scopes or roles granted by the token. */
  scopes?: string[];
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
   * Issue a signed token for a subject. Only implemented by providers
   * that control their own signing keys (LocalDevAuthProvider).
   * Production OIDC providers do not implement this — tokens are
   * issued by the external identity provider.
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
