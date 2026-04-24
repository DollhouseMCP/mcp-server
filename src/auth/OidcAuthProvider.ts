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

import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { logger } from '../utils/logger.js';
import type { IAuthProvider, AuthResult, AuthClaims } from './IAuthProvider.js';

export interface OidcAuthProviderOptions {
  /** OIDC issuer URL (e.g. "https://tenant.auth0.com/"). */
  issuer: string;
  /** Expected audience claim. */
  audience: string;
  /** JWKS endpoint URL. Defaults to {issuer}/.well-known/jwks.json */
  jwksUri?: string;
}

export class OidcAuthProvider implements IAuthProvider {
  readonly name: string;

  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwks: JWTVerifyGetKey;

  constructor(options: OidcAuthProviderOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.name = `oidc:${new URL(options.issuer).hostname}`;

    const jwksUri = options.jwksUri
      ?? new URL('.well-known/jwks.json', options.issuer).toString();

    this.jwks = createRemoteJWKSet(new URL(jwksUri));

    logger.info(`[OidcAuthProvider] Configured for issuer ${this.issuer}`, {
      audience: this.audience,
      jwksUri,
    });
  }

  async validate(token: string): Promise<AuthResult> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });

      if (!payload.sub) {
        return { ok: false, reason: 'token missing sub claim' };
      }

      const claims: AuthClaims = {
        sub: payload.sub,
        displayName: extractStringClaim(payload, 'name', 'display_name', 'preferred_username'),
        email: extractStringClaim(payload, 'email'),
        tenantId: extractStringClaim(payload, 'tenant_id', 'org_id') ?? null,
        scopes: extractScopes(payload),
        exp: payload.exp,
      };

      return { ok: true, claims };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('exp')) {
        return { ok: false, reason: 'token expired' };
      }
      if (message.includes('signature')) {
        return { ok: false, reason: 'invalid signature' };
      }
      if (message.includes('issuer')) {
        return { ok: false, reason: 'issuer mismatch' };
      }
      if (message.includes('audience')) {
        return { ok: false, reason: 'audience mismatch' };
      }
      return { ok: false, reason: message };
    }
  }
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
