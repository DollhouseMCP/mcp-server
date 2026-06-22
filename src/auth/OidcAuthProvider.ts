/**
 * OIDC Authentication Provider
 *
 * Validates JWTs against an external OIDC provider's JWKS endpoint.
 * Does not issue tokens — that's the identity provider's job.
 *
 * Supports any OIDC-compliant provider: Auth0, Keycloak, Google,
 * Azure AD, Okta, etc. Configured via:
 *   - DOLLHOUSE_AUTH_ISSUER: the issuer URL (e.g. https://tenant.auth0.com/)
 *   - DOLLHOUSE_AUTH_AUDIENCE: the expected audience claim
 *   - DOLLHOUSE_AUTH_JWKS_URI: JWKS endpoint (auto-derived from issuer if omitted)
 *
 * Keys are fetched and cached automatically by jose's createRemoteJWKSet.
 *
 * @module auth/OidcAuthProvider
 */

import { jwtVerify, createRemoteJWKSet, errors as joseErrors } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { logger } from '../utils/logger.js';
import type { IAuthProvider, AuthResult, AuthClaims } from './IAuthProvider.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

export interface OidcAuthProviderOptions {
  /** OIDC issuer URL (e.g. "https://tenant.auth0.com/"). */
  issuer: string;
  /** Expected audience claim. */
  audience: string;
  /** JWKS endpoint URL. Defaults to {issuer}/.well-known/jwks.json */
  jwksUri?: string;
  /**
   * Allowlist of acceptable JWT signing algorithms. The peer providers
   * (EmbeddedAuthorizationServer and LocalDevAuthProvider) pin
   * algorithms explicitly. OIDC bridge mode must accept whatever the
   * upstream IdP signs with — typically RS256/RS384/RS512 or
   * ES256/ES384/ES512 — but should still refuse `none` and HS-family
   * algorithms (HMAC keys would be derivable from the public JWKS).
   *
   * Default covers the standard asymmetric set that managed IdPs
   * (Auth0, Okta, Keycloak, Azure AD, Google) use.
   */
  algorithms?: readonly string[];
  /**
   * Test injection point: pre-built JWTVerifyGetKey, used in place of
   * the remote JWKS fetcher. Production code should never set this —
   * `jwksUri` is the operator-facing knob. Tests use this to exercise
   * the validate() error-classification branches without standing up
   * a JWKS HTTP server.
   */
  jwksGetter?: JWTVerifyGetKey;

  /**
   * Cycle 19 / security-#6: when true, require RFC 9068 `typ: at+jwt`
   * on incoming JWTs. Defaults to `false` because many managed IdPs
   * (Auth0, Okta, Keycloak depending on config, AWS Cognito) do NOT
   * stamp `typ` on access tokens, and hard-requiring it would break
   * those deployments.
   *
   * The hardening matters because the same issuer can mint both
   * `id_token` and access-token JWTs with overlapping `aud` and a
   * `scope` claim. Without this check, an id_token carrying `mcp`
   * scope (some configs surface scopes in id_tokens) would satisfy
   * the resource-server check despite never being intended as an
   * access token. Operators whose IdP stamps `typ: at+jwt` on access
   * tokens should set this true to close the gap.
   *
   * The peer EmbeddedAuthorizationServer always enforces this — it
   * controls its own issuance and stamps `typ: at+jwt` on every
   * access token it mints.
   */
  requireAccessTokenTyp?: boolean;
}

/**
 * Default JWT signing algorithm allowlist for OIDC bridge mode.
 * Asymmetric only — refuses `none` and HMAC algorithms which would
 * be derivable from the public JWKS material. Operators with an IdP
 * that signs with something exotic can override via the
 * `algorithms` option.
 */
export const DEFAULT_OIDC_ALGORITHMS: readonly string[] = [
  'RS256', 'RS384', 'RS512',
  'ES256', 'ES384', 'ES512',
  'PS256', 'PS384', 'PS512',
];

export class OidcAuthProvider implements IAuthProvider {
  readonly name: string;

  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwks: JWTVerifyGetKey;
  private readonly algorithms: readonly string[];
  private readonly requireAccessTokenTyp: boolean;

  constructor(options: OidcAuthProviderOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.name = `oidc:${new URL(options.issuer).hostname}`;
    this.algorithms = options.algorithms ?? DEFAULT_OIDC_ALGORITHMS;
    this.requireAccessTokenTyp = options.requireAccessTokenTyp ?? false;

    const jwksUri = options.jwksUri
      ?? new URL('.well-known/jwks.json', options.issuer).toString();

    this.jwks = options.jwksGetter ?? createRemoteJWKSet(new URL(jwksUri));

    logger.info(`[OidcAuthProvider] Configured for issuer ${this.issuer}`, {
      audience: this.audience,
      jwksUri,
      algorithms: this.algorithms,
      requireAccessTokenTyp: this.requireAccessTokenTyp,
      injected: options.jwksGetter !== undefined,
    });
  }

  async validate(token: string): Promise<AuthResult> {
    try {
      // Cycle-12 fix (M12-1): pin algorithms explicitly. jose's default
      // is permissive (any alg the JWKS keys support); explicit allowlist
      // refuses `none`/HMAC even if the upstream JWKS were ever
      // compromised in a way that included symmetric keys.
      // Cycle 19 / security-#6: opt-in RFC 9068 typ enforcement — default
      // off for compat with IdPs that don't stamp typ; on closes the
      // id-token-as-access-token gap.
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: [...this.algorithms],
        ...(this.requireAccessTokenTyp ? { typ: 'at+jwt' } : {}),
      });
      const result = buildOidcAuthResult(payload);
      if (!result.ok) {
        this.logTokenValidationFailure(result.reason);
      }
      return result;
    } catch (error) {
      const reason = mapOidcVerifyError(error);
      this.logTokenValidationFailure(reason);
      return { ok: false, reason };
    }
  }

  private logTokenValidationFailure(reason: string): void {
    SecurityMonitor.logSecurityEvent({
      type: 'TOKEN_VALIDATION_FAILURE',
      severity: 'MEDIUM',
      source: 'OidcAuthProvider.validate',
      details: 'OIDC access token validation failed',
      additionalData: { provider: this.name, issuer: this.issuer, reason },
    });
  }
}

/**
 * Build an AuthResult from a verified OIDC JWT payload. Enforces the
 * required `mcp` scope (defence-in-depth: an external IdP token issued
 * for our audience but lacking `mcp` represents a different permission
 * surface and must not satisfy the resource-server check here).
 * Extracted from validate() to keep its cognitive complexity ≤15 (S3776).
 */
function buildOidcAuthResult(payload: Record<string, unknown>): AuthResult {
  if (!payload.sub || typeof payload.sub !== 'string') {
    return { ok: false, reason: 'token missing sub claim' };
  }

  const scopes = extractScopes(payload);
  if (!scopes?.includes('mcp')) {
    return { ok: false, reason: 'token missing mcp scope' };
  }

  const claims: AuthClaims = {
    sub: payload.sub,
    displayName: extractStringClaim(payload, 'name', 'display_name', 'preferred_username'),
    email: extractStringClaim(payload, 'email'),
    tenantId: extractStringClaim(payload, 'tenant_id', 'org_id') ?? null,
    scopes,
    roles: Array.isArray(payload.roles)
      ? payload.roles.filter((r): r is string => typeof r === 'string')
      : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
  return { ok: true, claims };
}

/**
 * Map a jose JWT-verification error to a stable, operator-friendly
 * reason string. Cycle-11 / M11-1 fix: use jose's typed errors instead
 * of substring-matching .message — substrings like 'exp' / 'signature'
 * collide with unrelated error text and produce misleading reasons in
 * operator logs. Reasons aligned across all three providers so
 * operator log-grep is consistent regardless of which provider is
 * mounted. Extracted from validate() for the cognitive-complexity
 * refactor; behaviour is identical to the inline cascade it replaced.
 */
function mapOidcVerifyError(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) {
    return 'token expired';
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'invalid signature';
  }
  if (error instanceof joseErrors.JOSEAlgNotAllowed) {
    return 'algorithm not allowed';
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = error.claim;
    if (claim === 'aud') return 'invalid audience';
    if (claim === 'iss') return 'invalid issuer';
    // Cycle 22 / cycle-21 security-LOW-1: align typ-rejection reason
    // with the embedded AS so operator log-grep sees consistent strings.
    if (claim === 'typ') return 'wrong token type';
    return `claim validation failed: ${claim ?? 'unknown'}`;
  }
  return 'token validation failed';
}

function extractStringClaim(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function extractScopes(payload: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(payload.scopes)) {
    return payload.scopes.filter((s): s is string => typeof s === 'string');
  }
  if (typeof payload.scope === 'string') {
    return payload.scope.split(/\s+/).filter(Boolean);
  }
  return undefined;
}
