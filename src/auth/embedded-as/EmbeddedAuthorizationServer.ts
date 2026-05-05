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
import { jwtVerify, importJWK, SignJWT, errors as joseErrors, type JWK } from 'jose';
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
import {
  createInteractionRouter,
} from './InteractionRouter.js';
import { securityHeaders } from './securityHeaders.js';
import {
  defaultKeyFilePath,
  loadOrGenerateSigningJwks,
  type SigningKeyset,
} from './persistKeys.js';
import { loadOrGenerateCookieSigningKeys, rotateCookieSecret } from './cookieSecret.js';
import {
  computeFingerprint,
  OAUTH_STATE_MODELS,
} from './modeFingerprint.js';
import { createOidcAdapterFactory } from './storage/OidcProviderAdapter.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

const ALGORITHM = 'ES256';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_CLIENT_ID = 'dollhouse-claude-connector';

export interface EmbeddedAuthorizationServerOptions {
  publicBaseUrl?: string;
  mcpPath?: string;
  keyFilePath?: string;
  /**
   * Auth methods exposed by this AS. Single-method deployments pass a
   * one-element array; multi-method deployments pass several. Each method
   * owns its own standalone routes via contributeRoutes; findAccount is
   * dispatched by iterating this list (first non-null wins).
   *
   * Accepts a non-empty array — the AS refuses construction with an empty
   * methods list because there'd be nothing to authenticate against.
   */
  methods: readonly IAuthMethod[];
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

  private readonly methods: readonly IAuthMethod[];
  private readonly storage: IAuthStorageLayer;
  private readonly mcpPath: string;
  private readonly keyFilePath: string;

  private publicBaseUrl: string;
  private issuer: string;
  private resource: string;
  private state: InitializedState | null = null;
  private initPromise: Promise<InitializedState> | null = null;
  /**
   * Generation counter incremented on every setPublicBaseUrl. ensureInitialized
   * captures this at start; if it has moved on by the time initialize() returns,
   * the in-flight result is discarded so a stale init never overwrites a fresh
   * setPublicBaseUrl. Without this, a concurrent validate() racing with a
   * publicBaseUrl change could re-assign stale state to this.state, routing
   * subsequent token validations against the wrong issuer.
   */
  private generation = 0;

  constructor(options: EmbeddedAuthorizationServerOptions) {
    if (options.methods.length === 0) {
      throw new Error('EmbeddedAuthorizationServer requires at least one IAuthMethod');
    }
    // Defensive copy — caller may mutate the source array later (e.g. tests
    // that build the method list per-test). The AS holds a stable view.
    this.methods = [...options.methods];
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
    // Bump the generation BEFORE clearing state so any in-flight init() that
    // resolves between this.state = null and the next ensureInitialized()
    // sees the moved-on generation and refuses to assign stale results.
    this.generation += 1;
    this.state = null;
    this.initPromise = null;
  }

  getProtectedResourceMetadataUrl(): string {
    return joinUrl(this.publicBaseUrl, '/.well-known/oauth-protected-resource');
  }

  private isHttpsPublicBaseUrl(): boolean {
    try {
      return new URL(this.publicBaseUrl).protocol === 'https:';
    } catch {
      return false;
    }
  }

  getAuthorizationServerMetadataUrl(): string {
    return joinUrl(this.publicBaseUrl, '/.well-known/oauth-authorization-server');
  }

  /**
   * Verify a bearer token against our published JWKS. This is the path the
   * unified authMiddleware drives. We verify locally (no introspection
   * roundtrip) since we issued the token and have the keys in memory.
   *
   * Hardening (RFC 9068 conformance):
   *   - typ MUST be `at+jwt` — rejects id_tokens or other JWTs signed by the
   *     same key from being replayed as access tokens.
   *   - kid MUST be present — without this an attacker could craft a token
   *     omitting the kid header and bypass the kid match below.
   *   - crit allow-list is empty — refuses any unknown critical extension
   *     header rather than silently ignoring it.
   */
  async validate(token: string): Promise<AuthResult> {
    const { publicSigningKey, keyset } = await this.ensureInitialized();
    try {
      const { payload, protectedHeader } = await jwtVerify(token, publicSigningKey, {
        issuer: this.issuer,
        audience: this.resource,
        algorithms: [ALGORITHM],
        typ: 'at+jwt',
        crit: {},
      });

      if (!protectedHeader.kid) {
        return { ok: false, reason: 'token missing kid header' };
      }
      if (protectedHeader.kid !== keyset.kid) {
        return { ok: false, reason: 'unknown key id' };
      }
      if (!payload.sub) {
        return { ok: false, reason: 'token missing sub claim' };
      }

      return { ok: true, claims: claimsFromPayload(payload) };
    } catch (error) {
      // Use jose's typed errors instead of substring-matching .message —
      // substrings like 'iss' or 'typ' collide with unrelated error text
      // ('issuer', 'unexpected', 'cryptographic', 'type'), producing
      // misleading reasons in operator logs.
      if (error instanceof joseErrors.JWTExpired) {
        return { ok: false, reason: 'token expired' };
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        const claim = (error as { claim?: string }).claim;
        if (claim === 'aud') return { ok: false, reason: 'invalid audience' };
        if (claim === 'iss') return { ok: false, reason: 'invalid issuer' };
        if (claim === 'typ') return { ok: false, reason: 'wrong token type' };
        return { ok: false, reason: `claim validation failed: ${claim ?? 'unknown'}` };
      }
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

    // Each method owns its own standalone routes (callbacks, invite-redemption
    // pages, etc.) and registers them via contributeRoutes. Replaces the
    // earlier instanceof-checks-per-method dispatch — the AS no longer
    // needs to know which concrete method classes are active.
    const contributeDeps = {
      storage: this.storage,
      ensureInitialized: () => this.ensureInitialized().then((s) => ({ provider: s.provider })),
    };
    for (const method of this.methods) {
      method.contributeRoutes?.(router, contributeDeps);
    }

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
    // Capture the generation BEFORE awaiting init. If setPublicBaseUrl bumps
    // the counter while initialize() is in flight, the result we receive is
    // stale and must NOT replace this.state — a fresh ensureInitialized()
    // call will start a new initialize() against the new generation.
    const startedAt = this.generation;
    if (!this.initPromise) {
      // H15: clear initPromise on rejection so a transient init failure
      // (corrupt key file, disk full, DB unreachable) doesn't poison
      // every subsequent request. Without this clear, a single failed
      // init left initPromise holding a rejected promise and every
      // future ensureInitialized awaited the same rejection — the AS
      // was permanently dead until process restart.
      const launched = this.initialize();
      this.initPromise = launched;
      // Attach an error-side-effect handler. `void` swallows this catch
      // chain — the original `launched` promise's rejection still
      // reaches awaiters via this.initPromise above. The check
      // `this.initPromise === launched` avoids clearing a fresh promise
      // installed by a concurrent setPublicBaseUrl reset.
      void launched.catch(() => {
        if (this.initPromise === launched) this.initPromise = null;
      });
    }
    const inFlight = this.initPromise;
    const result = await inFlight;
    if (this.generation !== startedAt) {
      // Generation moved on; this result is stale. Don't assign it; let the
      // next call see this.state === null and trigger a fresh initialize().
      return this.ensureInitialized();
    }
    this.state = result;
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

    // must-fix #14: mode-switch invalidation. Compute a fingerprint of the
    // current operating mode and compare to the persisted one. On mismatch,
    // wipe OAuth-state K/V (sessions, tokens, codes, interactions) so prior
    // tokens cannot be reused, and rotate the cookie signing secret. The
    // first run (no persisted fingerprint) is not a mode switch.
    let cookieKeys = loadOrGenerateCookieSigningKeys();
    const fingerprintInputs = {
      provider: 'embedded',
      methodIds: this.methods.map((m) => m.id),
      issuer: this.issuer,
      primaryKid: keyset.kid,
      primaryCookieKey: cookieKeys[0]!,
    };
    const candidateFingerprint = computeFingerprint(fingerprintInputs);
    const persistedFingerprint = (await this.storage.genericGet(
      'AuthModeFingerprint',
      'current',
    )) as { fingerprint?: string } | null;
    const previous = persistedFingerprint?.fingerprint;

    if (previous && previous !== candidateFingerprint) {
      const cleared = await this.storage.clearGenericByModels(OAUTH_STATE_MODELS);
      rotateCookieSecret();
      cookieKeys = loadOrGenerateCookieSigningKeys();
      const finalFingerprint = computeFingerprint({
        ...fingerprintInputs,
        primaryCookieKey: cookieKeys[0]!,
      });
      await this.storage.genericSet('AuthModeFingerprint', 'current', {
        fingerprint: finalFingerprint,
      });
      await this.storage.recordIdentityEvent({
        type: 'auth.mode_switch_invalidation',
        details: { cleared, previous, current: finalFingerprint },
        timestamp: Date.now(),
      });
      logger.warn('[EmbeddedAuthorizationServer] mode-switch detected; OAuth state cleared, cookie secret rotated', {
        cleared,
      });
    } else if (!previous) {
      await this.storage.genericSet('AuthModeFingerprint', 'current', {
        fingerprint: candidateFingerprint,
      });
    }

    const adapterFactory = createOidcAdapterFactory(this.storage);
    const methods = this.methods;

    const config: Configuration = {
      // adapter: oidc-provider's TypeScript type expects a function-shape
      // constructor, but the runtime accepts a class. Cast bridges the
      // mismatch — see https://github.com/panva/node-oidc-provider docs on
      // adapter shape (the `Adapter` interface is structural at runtime).
      adapter: adapterFactory as unknown as Configuration['adapter'],
      // jwks: the JWKS object shape we produce from `loadOrGenerateSigningJwks`
      // matches the runtime spec ({ keys: [JWK] }) but the @types/oidc-provider
      // declares a narrower internal type. Cast preserves runtime correctness.
      jwks: keyset.jwks as unknown as Configuration['jwks'],
      // Pre-register the default Claude connector client so curl-based dev
      // flows and native MCP clients work without DCR. The bare-host
      // loopback redirect_uris below are deliberate: with
      // `application_type: 'native'`, oidc-provider 9.x applies RFC 8252
      // §7.3 loopback-port relaxation — an arbitrary port matches as
      // long as host + path equal a registered URI. This is what makes
      // Claude Desktop / Claude Code (which bind ephemeral loopback
      // ports for the callback) work against a fresh install with no
      // operator setup. The `B7` integration test pins this behavior so
      // an oidc-provider upstream regression breaks loud.
      //
      // id_token_signed_response_alg must match our keyset (ES256) since
      // oidc-provider defaults to RS256.
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
        // RFC 7591 Dynamic Client Registration. initialAccessToken: true
        // means /reg requires an InitialAccessToken bearer. Without this
        // gate, any unauthenticated client on the network could register
        // with arbitrary redirect_uris, defeating the redirect-URI exact-
        // match guarantee. The pre-registered DEFAULT_CLIENT_ID below
        // works without DCR; only third-party / dynamically-discovered
        // clients need a token.
        //
        // **No working token issuance path today.** The earlier
        // dollhouse-issue-dcr-token CLI minted tokens against a
        // throwaway provider that the running AS could not validate;
        // it was removed (B2). A real admin-channel endpoint that
        // issues IATs against this AS instance is follow-up work.
        // Until that lands, native MCP clients must use the pre-
        // registered DEFAULT_CLIENT_ID (loopback redirect_uris only).
        registration: { enabled: true, initialAccessToken: true },
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
      },
      // must-fix #12: emit auth_time on issued tokens so future step-up
      // enforcement (§8.3 / Web Phase D) can compare against scope-specific
      // max-age windows without re-prompting the user unnecessarily. Sourced
      // from `account.lastAuthAt`, which finishInteractionWithIdentity
      // stamps on every successful login. The earlier `acr: ['auth_time']`
      // config was a misconfiguration — `acr` is the OIDC Authentication
      // Context Class Reference scope, not a vehicle for the auth_time
      // claim — and produced no auth_time on issued tokens.
      extraTokenClaims: async (_ctx, token) => {
        const accountId = (token as { accountId?: string }).accountId;
        if (!accountId) return undefined;
        const account = await this.storage.getAccount(accountId);
        if (!account?.lastAuthAt) return undefined;
        return { auth_time: Math.floor(account.lastAuthAt / 1000) };
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
        // Each method returns null for subs it doesn't own; iterate in the
        // configured order and take the first non-null match. This is how
        // multi-method deployments dispatch token-issue findAccount lookups
        // without an explicit method ID on the sub.
        for (const m of methods) {
          const identity = await m.findAccount(sub);
          if (!identity) continue;
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
        }
        return undefined;
      },
      // Cookie signing + transport defaults. The signing keys come from a
      // dedicated secret file (see cookieSecret.ts) — earlier code reused
      // the JWKS kid here, which made every cookie forgeable by anyone
      // who could read /jwks.
      //
      // `secure` is conditional on the public base URL using https. Forcing
      // secure=true on plain HTTP makes browsers refuse the cookie, breaking
      // loopback dev. With TLS terminated upstream the AS sees http but the
      // public base URL is still https, which is the right signal here.
      cookies: {
        keys: cookieKeys,
        long: {
          signed: true,
          secure: this.isHttpsPublicBaseUrl(),
          sameSite: 'lax',
          httpOnly: true,
          path: '/',
          overwrite: true,
        },
        short: {
          signed: true,
          secure: this.isHttpsPublicBaseUrl(),
          sameSite: 'lax',
          httpOnly: true,
          path: '/',
          overwrite: true,
        },
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
      methods: this.methods.map((m) => m.id),
      kid: keyset.kid,
    });

    // Build the interaction middleware once and cache it on the state. This
    // keeps the createRouter() catch-all from constructing per-request and
    // avoids reaching into private members from a free function.
    const interactionMiddleware = createInteractionRouter({
      provider,
      methods: this.methods,
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

