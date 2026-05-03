/**
 * EmbeddedAuthorizationServer
 *
 * Wraps panva/oidc-provider as the embedded OAuth 2.1 / OIDC authorization
 * server. Implements IAuthProvider for the unified bearer middleware so
 * existing plumbing (StreamableHttpServer, authMiddleware) treats it the
 * same as LocalDevAuthProvider / OidcAuthProvider.
 *
 * Construction takes:
 *   - the active IAuthMethod (interactions and findAccount delegate here)
 *   - an IAuthStorageLayer (oidc-provider's Adapter delegates here)
 *   - public-base-URL config
 *   - signing key file path
 *
 * Exposes the surface StreamableHttpServer expects:
 *   - createRouter(): Router  — well-known docs + interaction routes + provider.callback
 *   - validate(token): AuthResult — verifies our own JWTs against the JWKS
 *   - getProtectedResourceMetadataUrl(): string
 *   - setPublicBaseUrl(url): void
 *
 * @module auth/embedded-as/EmbeddedAuthorizationServer
 */

import express, { type Router, type Request, type Response } from 'express';
import { jwtVerify, importJWK, SignJWT, type JWK } from 'jose';
import OidcProvider from 'oidc-provider';
import type { Configuration } from 'oidc-provider';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type {
  AuthClaims,
  AuthResult,
  IAuthProvider,
  IssueOptions,
} from '../IAuthProvider.js';
import { assertSafePublicBaseUrl, joinUrl, resolvePublicBaseUrl } from '../oauth/url.js';
import type { IAuthMethod } from './IAuthMethod.js';
import { createInteractionRouter } from './InteractionRouter.js';
import { securityHeaders } from './securityHeaders.js';
import {
  defaultKeyFilePath,
  loadOrGenerateSigningJwks,
  type SigningKeyset,
} from './persistKeys.js';
import { createOidcAdapterFactory } from './storage/OidcProviderAdapter.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

const ALGORITHM = 'ES256';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_CLIENT_ID = 'dollhouse-claude-connector';

export interface EmbeddedAuthorizationServerOptions {
  publicBaseUrl?: string;
  mcpPath?: string;
  keyFilePath?: string;
  /** The single active auth method at C4 (multi-method chooser is a future commit). */
  method: IAuthMethod;
  /** Backing storage for oidc-provider's Adapter and our semantic operations. */
  storage: IAuthStorageLayer;
}

interface InitializedState {
  provider: InstanceType<typeof OidcProvider>;
  keyset: SigningKeyset;
  publicSigningKey: CryptoKey;
  privateSigningKey: CryptoKey;
  /** Pre-built interaction middleware bound to the initialized provider. */
  interactionMiddleware: Router;
}

export class EmbeddedAuthorizationServer implements IAuthProvider {
  readonly name = 'embedded-oauth';

  private readonly method: IAuthMethod;
  private readonly storage: IAuthStorageLayer;
  private readonly mcpPath: string;
  private readonly keyFilePath: string;

  private publicBaseUrl: string;
  private issuer: string;
  private resource: string;
  private state: InitializedState | null = null;
  private initPromise: Promise<InitializedState> | null = null;

  constructor(options: EmbeddedAuthorizationServerOptions) {
    this.method = options.method;
    this.storage = options.storage;
    this.mcpPath = normalizePath(options.mcpPath ?? env.DOLLHOUSE_HTTP_MCP_PATH);
    this.publicBaseUrl = resolvePublicBaseUrl({ publicBaseUrl: options.publicBaseUrl });
    this.issuer = this.publicBaseUrl;
    this.resource = joinUrl(this.publicBaseUrl, this.mcpPath);
    this.keyFilePath = options.keyFilePath ?? defaultKeyFilePath();
  }

  setPublicBaseUrl(publicBaseUrl: string): void {
    this.publicBaseUrl = assertSafePublicBaseUrl(publicBaseUrl);
    this.issuer = this.publicBaseUrl;
    this.resource = joinUrl(this.publicBaseUrl, this.mcpPath);
    // Force re-init so the new issuer flows into oidc-provider config.
    this.state = null;
    this.initPromise = null;
  }

  getProtectedResourceMetadataUrl(): string {
    return joinUrl(this.publicBaseUrl, '/.well-known/oauth-protected-resource');
  }

  getAuthorizationServerMetadataUrl(): string {
    return joinUrl(this.publicBaseUrl, '/.well-known/oauth-authorization-server');
  }

  /**
   * Verify a bearer token against our published JWKS. This is the path the
   * unified authMiddleware drives. We verify locally (no introspection
   * roundtrip) since we issued the token and have the keys in memory.
   */
  async validate(token: string): Promise<AuthResult> {
    const { publicSigningKey, keyset } = await this.ensureInitialized();
    try {
      const { payload, protectedHeader } = await jwtVerify(token, publicSigningKey, {
        issuer: this.issuer,
        audience: this.resource,
        algorithms: [ALGORITHM],
      });

      if (protectedHeader.kid && protectedHeader.kid !== keyset.kid) {
        return { ok: false, reason: 'unknown key id' };
      }
      if (!payload.sub) {
        return { ok: false, reason: 'token missing sub claim' };
      }

      return { ok: true, claims: claimsFromPayload(payload) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('exp')) return { ok: false, reason: 'token expired' };
      if (message.includes('aud')) return { ok: false, reason: 'invalid audience' };
      if (message.includes('iss')) return { ok: false, reason: 'invalid issuer' };
      return { ok: false, reason: 'token validation failed' };
    }
  }

  /**
   * Issue an access token directly without going through the OAuth flow.
   * Used by the LocalDev startup-token convenience path; bypasses
   * oidc-provider's accounting. Signed with the same JWKS the AS publishes
   * so the standard validate() path verifies it.
   */
  async issue(sub: string, options?: IssueOptions): Promise<string> {
    const { keyset, privateSigningKey } = await this.ensureInitialized();
    const ttl = options?.ttlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    const scope = options?.scopes?.join(' ') || 'mcp';

    return new SignJWT({
      azp: DEFAULT_CLIENT_ID,
      scope,
      name: options?.displayName ?? sub,
    })
      .setProtectedHeader({ alg: ALGORITHM, kid: keyset.kid, typ: 'at+jwt' })
      .setIssuer(this.issuer)
      .setAudience(this.resource)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(privateSigningKey);
  }

  createRouter(): Router {
    const router = express.Router();

    // Frame-busting headers (must-fix #7) on every embedded AS response so the
    // consent / login pages can never be iframed for clickjacking.
    router.use(securityHeaders());

    // RFC 9728 protected-resource metadata. oidc-provider doesn't emit this;
    // we add it so MCP clients can discover the AS.
    router.get('/.well-known/oauth-protected-resource', (_req, res) => {
      res.json({
        resource: this.resource,
        authorization_servers: [this.issuer],
        bearer_methods_supported: ['header'],
        resource_documentation: joinUrl(this.publicBaseUrl, '/'),
      });
    });

    // RFC 8414 alias for OAuth-only clients. oidc-provider only emits
    // /.well-known/openid-configuration by default.
    router.get('/.well-known/oauth-authorization-server', (req, res) => {
      void this.handleAuthorizationServerMetadata(req, res);
    });

    // Mount oidc-provider's full OAuth/OIDC surface (/auth, /token, /jwks,
    // /reg for DCR, /me, etc.) and our interaction handlers under the same
    // router so they share host/path. oidc-provider's callback() is the
    // catch-all; well-known + interaction routes are matched first.
    //
    // Both /interaction and the catch-all need the initialized state. We
    // route through ensureInitialized() per request and dispatch into the
    // already-built interaction middleware (constructed once during init).
    router.use('/interaction', (req, res, next) => {
      void (async () => {
        try {
          const state = await this.ensureInitialized();
          state.interactionMiddleware(req, res, next);
        } catch (err) {
          next(err);
        }
      })();
    });
    router.use((req, res, next) => {
      void (async () => {
        try {
          const state = await this.ensureInitialized();
          state.provider.callback()(req, res);
        } catch (err) {
          next(err);
        }
      })();
    });

    return router;
  }

  private async handleAuthorizationServerMetadata(_req: Request, res: Response): Promise<void> {
    // Synthesize the RFC 8414 metadata. This is a strict subset of the
    // OIDC discovery doc oidc-provider serves at /.well-known/openid-configuration;
    // we publish it under the OAuth name for OAuth-only clients.
    await this.ensureInitialized();
    res.json({
      issuer: this.issuer,
      authorization_endpoint: joinUrl(this.publicBaseUrl, '/auth'),
      token_endpoint: joinUrl(this.publicBaseUrl, '/token'),
      jwks_uri: joinUrl(this.publicBaseUrl, '/jwks'),
      registration_endpoint: joinUrl(this.publicBaseUrl, '/reg'),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes_supported: ['openid', 'offline_access', 'mcp'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [ALGORITHM],
    });
  }

  private async ensureInitialized(): Promise<InitializedState> {
    if (this.state) return this.state;
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    this.state = await this.initPromise;
    return this.state;
  }

  private async initialize(): Promise<InitializedState> {
    // jwks rotation procedure (must-fix #15 forward-compat):
    //   Today the AS publishes a single ES256 key under one kid loaded from
    //   the persistKeys file. To rotate without invalidating in-flight tokens:
    //     1. Generate a new ES256 keypair, append it to the JWKS keyset.
    //     2. Restart the AS — JWKS endpoint now publishes both keys.
    //     3. Update persistKeys to mark the new kid as the SIGNING kid; the
    //        old kid stays in the keyset for verification only.
    //     4. After the access-token TTL window passes (1h default), drop the
    //        old kid from the JWKS keyset and the file.
    //   The SqliteAuthStorageLayer (out-of-scope for §8.1) will replace this
    //   procedure with the multi-instance encrypted-JWK-in-database approach
    //   spec'd in PRODUCTION-AUTH-ARCHITECTURE.md §5.2a.
    const keyset = await loadOrGenerateSigningJwks(this.keyFilePath);

    const adapterFactory = createOidcAdapterFactory(this.storage);
    const method = this.method;

    const config: Configuration = {
      // adapter is typed via constructor; cast around oidc-provider's runtime expectations.
      adapter: adapterFactory as unknown as Configuration['adapter'],
      jwks: keyset.jwks as unknown as Configuration['jwks'],
      // Pre-register the default Claude connector client so curl-based dev flows
      // and the integration test work without DCR. id_token_signed_response_alg
      // must match our keyset (ES256) since oidc-provider defaults to RS256.
      clients: [
        {
          client_id: DEFAULT_CLIENT_ID,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
          application_type: 'native',
          id_token_signed_response_alg: 'ES256',
        },
      ],
      clientDefaults: {
        id_token_signed_response_alg: 'ES256',
        // Same default for DCR-registered clients.
      },
      enabledJWA: {
        idTokenSigningAlgValues: ['ES256'],
        userinfoSigningAlgValues: ['ES256'],
        authorizationSigningAlgValues: ['ES256'],
        introspectionSigningAlgValues: ['ES256'],
        requestObjectSigningAlgValues: ['ES256'],
      },
      features: {
        registration: { enabled: true },
        // Disable oidc-provider's developer-only built-in interaction page;
        // we own /interaction/:uid via InteractionRouter.
        devInteractions: { enabled: false },
        // RFC 8707 resource indicators — clients pass `resource=...` to bind
        // tokens to a specific MCP server URI; we issue JWT access tokens
        // with that aud claim (must-fix #15 audience binding).
        resourceIndicators: {
          enabled: true,
          defaultResource: () => this.resource,
          getResourceServerInfo: () => ({
            scope: 'mcp openid offline_access',
            accessTokenFormat: 'jwt',
            audience: this.resource,
          }),
        },
        // DPoP, PAR, etc. left at defaults for now.
      },
      claims: {
        openid: ['sub'],
        profile: ['name'],
        email: ['email', 'email_verified'],
        // must-fix #12: emit auth_time on issued tokens so future step-up
        // enforcement (§8.3 / Web Phase D) can compare against scope-specific
        // max-age windows without re-prompting the user unnecessarily.
        acr: ['auth_time'],
      },
      // Only OIDC standard scopes here. The `mcp` resource scope is declared
      // via resourceIndicators.getResourceServerInfo below — keeping it out of
      // this list prevents oidc-provider from treating it as a missing OIDC
      // scope during the consent prompt.
      scopes: ['openid', 'offline_access'],
      // PKCE is required for all clients; oidc-provider 9.x defaults to S256-only
      // when 'plain' is not in code_challenge_methods_supported (which it isn't).
      pkce: { required: () => true },
      ttl: {
        AccessToken: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
        RefreshToken: 30 * 24 * 3600,
        AuthorizationCode: 5 * 60,
        Interaction: 10 * 60,
        Session: 14 * 24 * 3600,
      },
      // must-fix #11: rotate the refresh token on every refresh and reject any
      // attempt to reuse a previously-rotated token. oidc-provider revokes the
      // entire refresh family on reuse-detection.
      rotateRefreshToken: true,
      issueRefreshToken: async (_ctx, client, code) => {
        // Only issue a refresh token when offline_access was granted.
        return client.grantTypeAllowed('refresh_token') && code.scopes.has('offline_access');
      },
      interactions: {
        url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      },
      async findAccount(_ctx, sub) {
        const identity = await method.findAccount(sub);
        if (!identity) return undefined;
        return {
          accountId: identity.sub,
          async claims() {
            return {
              sub: identity.sub,
              name: identity.displayName,
              email: identity.email,
              email_verified: identity.emailVerified,
            };
          },
        };
      },
      // Required by oidc-provider when using cookies (interaction state).
      cookies: {
        keys: [keyset.kid, `${keyset.kid}-secondary`],
      },
    };

    const provider = new OidcProvider(this.issuer, config);

    // Match the existing-test expectation that errors throw rather than render
    // a redirect-with-error in dev; this also surfaces config issues early.
    provider.proxy = false;

    const publicJwk = keyset.jwks.keys[0];
    const publicSigningKey = (await importJWK(stripPrivate(publicJwk), ALGORITHM)) as CryptoKey;
    const privateSigningKey = (await importJWK(publicJwk, ALGORITHM)) as CryptoKey;

    logger.info('[EmbeddedAuthorizationServer] initialized', {
      issuer: this.issuer,
      resource: this.resource,
      method: this.method.id,
      kid: keyset.kid,
    });

    // Build the interaction middleware once and cache it on the state. This
    // keeps the createRouter() catch-all from constructing per-request and
    // avoids reaching into private members from a free function.
    const interactionMiddleware = createInteractionRouter({
      provider,
      resolveMethod: () => this.method,
      storage: this.storage,
    });

    return { provider, keyset, publicSigningKey, privateSigningKey, interactionMiddleware };
  }
}


function claimsFromPayload(payload: Record<string, unknown>): AuthClaims {
  return {
    sub: String(payload.sub),
    displayName: typeof payload.name === 'string' ? payload.name : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : null,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
}

function stripPrivate(jwk: JWK): JWK {
  const { d, p, q, dp, dq, qi, k, ...publicPart } = jwk as JWK & Record<string, unknown>;
  void d; void p; void q; void dp; void dq; void qi; void k;
  return publicPart as JWK;
}

function normalizePath(rawPath: string): string {
  if (!rawPath || rawPath === '/') return '/mcp';
  return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
}
