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

import express, { type Router, type Request, type RequestHandler, type Response } from 'express';
import OidcProvider from 'oidc-provider';
import type { Configuration } from 'oidc-provider';
import { env } from '../../config/env.js';
import { PackageResourceLocator } from '../../paths/PackageResourceLocator.js';
import { logger } from '../../utils/logger.js';
import type {
  AuthResult,
  IAuthProvider,
  IssueOptions,
} from '../IAuthProvider.js';
import { assertSafePublicBaseUrl, joinUrl, resolvePublicBaseUrl } from '../oauth/url.js';
import { normalizeIp } from './rateLimit.js';
import type { IAuthMethod } from './IAuthMethod.js';
import {
  createInteractionRouter,
} from './InteractionRouter.js';
import {
  createOpenDcrRegistrationHandlers,
} from './dcrPolicyMiddleware.js';
import { securityHeaders } from './securityHeaders.js';
import {
  defaultKeyFilePath,
  loadOrGenerateSigningJwks,
  loadOrGenerateSigningJwksViaStore,
  rotateSigningKey,
  rotateSigningKeyViaStore,
  type SigningKeyset,
} from './persistKeys.js';
import {
  loadOrGenerateCookieSigningKeys,
  loadOrGenerateCookieSigningKeysViaStore,
  rotateCookieSecret,
  rotateCookieSecretViaStore,
} from './cookieSecret.js';
import type { ISigningKeyStore } from '../../storage/signingKeys/ISigningKeyStore.js';
import {
  checkModeFingerprint,
  persistModeFingerprint,
  OAUTH_STATE_MODELS,
} from './modeFingerprint.js';
import {
  createOidcAdapterFactory,
  hashRotationAttribute,
  withRotationRequestContext,
  type RotationRequestContext,
} from './storage/OidcProviderAdapter.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';
import type { IRateLimitStore } from './storage/IRateLimitStore.js';
import { EmbeddedASBootstrap } from './EmbeddedASBootstrap.js';
import { EmbeddedASAdmin } from './EmbeddedASAdmin.js';
import { EmbeddedASOidcAccount } from './EmbeddedASOidcAccount.js';
import {
  ALGORITHM,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  DEFAULT_AUTH_CODE_TTL_SECONDS,
  DEFAULT_INTERACTION_TTL_SECONDS,
  DEFAULT_SESSION_TTL_SECONDS,
  DEFAULT_CLIENT_ID,
  EmbeddedASTokens,
  importSigningKeys,
} from './EmbeddedASTokens.js';

/**
 * Cycle-8 fix (B1): predicate that decides whether oidc-provider's
 * `proxy` setting should be true (trust X-Forwarded-Proto/Host) or
 * false (treat the request as terminal).
 *
 * Returns true when `DOLLHOUSE_TRUSTED_PROXIES` names at least one
 * upstream proxy that is NOT just the loopback default. The two
 * supported tester deployment shapes:
 *   - Native HTTPS (env unset or only 'loopback'): predicate returns
 *     false; oidc-provider uses Node's view of the request directly.
 *   - Behind a TLS-terminating proxy (env names a real CIDR): predicate
 *     returns true; oidc-provider walks X-Forwarded-Proto/Host through
 *     the trust-proxy chain Express resolves.
 *
 * Exported so unit tests can pin the matrix without spinning up the AS.
 */
export function shouldTrustUpstreamProxy(
  trustedProxies: readonly string[] | undefined,
): boolean {
  if (!Array.isArray(trustedProxies) || trustedProxies.length === 0) return false;
  // 'loopback' alone means no upstream proxy — Express's loopback
  // shorthand is the default and is what we set when nothing is
  // configured. Treat it as the unset case.
  if (trustedProxies.length === 1 && trustedProxies[0] === 'loopback') return false;
  return true;
}

/**
 * Cycle-13 fix (UA array coercion): Express's `req.headers[name]` is
 * typed `string | string[] | undefined`. A multi-value header (rare
 * but valid per HTTP/1.1) used to coerce to a comma-joined string
 * when passed through `createHmac.update(arr)` — producing a different
 * hash from the same value sent as a single header. This helper picks
 * the first array element so the hash stays stable.
 *
 * Returns the input unchanged for `string` and `undefined`; returns
 * `arr[0]` (which may itself be `undefined` for an empty/sparse array)
 * for `string[]`. Exported for unit testing.
 */
export function pickHeaderValue(
  header: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(header)) return header[0];
  return header;
}

const authAssetLocator = new PackageResourceLocator();
const AUTH_FONT_FILE_RE = /^[A-Za-z0-9._-]+\.woff2$/;

function servePackagedAuthAsset(relativePath: string, contentType: string): RequestHandler {
  return async (_req, res, next) => {
    try {
      const assetPath = await authAssetLocator.locate(relativePath);
      if (!assetPath) {
        res.sendStatus(404);
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.type(contentType);
      res.sendFile(assetPath, (err) => {
        if (err) next(err);
      });
    } catch (err) {
      next(err);
    }
  };
}

function servePackagedAuthFont(): RequestHandler {
  return async (req, res, next) => {
    const file = req.params.file;
    if (typeof file !== 'string' || !AUTH_FONT_FILE_RE.test(file)) {
      res.sendStatus(404);
      return;
    }
    return servePackagedAuthAsset(`web/public/fonts/${file}`, 'font/woff2')(req, res, next);
  };
}

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
  /**
   * Refresh-token rotation grace window in milliseconds (R3, spec L926).
   * After a refresh token is consumed, its `consumed` marker is hidden
   * from oidc-provider's `find()` for this duration so legitimate
   * concurrent rotations don't trip reuse-detection. After the window
   * elapses, the marker becomes visible and reuse-detection fires
   * normally for actual replays. Default: 30,000 ms (industry standard).
   * Set to 0 to disable (strict consume-then-detect behavior).
   */
  refreshRotationGraceMs?: number;

  /**
   * Round 5 / H1: opt-in IP/UA gating for the rotation grace window.
   * When `true`, the grace window applies only when the rotating
   * request's IP+UA hashes match what was captured at initial token
   * issue. Mismatch = no grace = reuse-detection fires. Default:
   * `false` (industry norm — NAT/CGNAT/proxy realities make per-IP
   * gating unreliable for legitimate users; DPoP in §8.2 is the
   * structural sender-binding answer).
   */
  refreshRotationCheckIpUa?: boolean;
  /**
   * Cycle 22 test injection point. When set, overrides
   * `env.DOLLHOUSE_COOKIE_SIGNING_SECRET` for the multi-replica
   * warn-when-unset check in `initialize()`. Production callers omit
   * this; tests use it to drive the warn branch without mutating
   * `process.env` at runtime (which no longer reaches the Zod-captured
   * env value). Mirrors `cookieSecret.ts`'s `options.envSecret` shape.
   */
  cookieSecretEnvOverride?: string;

  /**
   * Cycle 24 test injection + operator escape hatch. When set, overrides
   * `env.DOLLHOUSE_AUTH_OPEN_DCR` to control whether `/reg` (Dynamic
   * Client Registration) requires an Initial Access Token. Default
   * (undefined) falls back to the env-var; production deployments leave
   * the env unset (gated) and the option undefined.
   *
   * `true` = open DCR (no IAT required, default for localhost dev when
   * `DOLLHOUSE_AUTH_OPEN_DCR=true` is set). Unsafe on non-loopback binds.
   *
   * `false` = IAT-gated DCR (production target shape). Tests pass `true`
   * to exercise the open-DCR code path without mutating env.
   */
  openDCR?: boolean;
  /** Shared rate-limit state store. Required when openDCR=true. */
  rateLimitStore?: IRateLimitStore;

  /**
   * Phase 4.5: optional injected ISigningKeyStore. When present,
   * `initialize()` loads JWKS + cookie keys from the store (postgres- or
   * filesystem-backed per `DOLLHOUSE_AUTH_STORAGE_BACKEND`) and the
   * mode-fingerprint mismatch path rotates them via the store. When
   * absent, falls back to the legacy file-based persistKeys / cookieSecret
   * paths — same dual-mode pattern §8.1's auth K/V uses.
   *
   * Wired in by AuthServiceRegistrar from the DI-resolved 'SigningKeyStore'.
   */
  signingKeyStore?: ISigningKeyStore;
}

interface InitializedState {
  provider: InstanceType<typeof OidcProvider>;
  keyset: SigningKeyset;
  publicSigningKey: CryptoKey;
  privateSigningKey: CryptoKey;
  /** Cookie signing keys oidc-provider received; methods need them for H12 binding verify. */
  cookieKeys: readonly string[];
  /** Pre-built interaction middleware bound to the initialized provider. */
  interactionMiddleware: Router;
}

export class EmbeddedAuthorizationServer implements IAuthProvider {
  readonly name = 'embedded-oauth';

  private readonly methods: readonly IAuthMethod[];
  private readonly storage: IAuthStorageLayer;
  private readonly mcpPath: string;
  private readonly keyFilePath: string;
  private readonly refreshRotationGraceMs: number | undefined;
  private readonly refreshRotationCheckIpUa: boolean;
  private readonly cookieSecretEnvOverride: string | undefined;
  private readonly openDCR: boolean;
  private readonly rateLimitStore: IRateLimitStore | null;
  private readonly signingKeyStore: ISigningKeyStore | null;
  private readonly bootstrap: EmbeddedASBootstrap;
  private readonly admin: EmbeddedASAdmin;
  private readonly tokens: EmbeddedASTokens;
  private readonly oidcAccount: EmbeddedASOidcAccount;

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
    this.refreshRotationGraceMs = options.refreshRotationGraceMs;
    this.refreshRotationCheckIpUa = options.refreshRotationCheckIpUa ?? false;
    this.cookieSecretEnvOverride = options.cookieSecretEnvOverride;
    this.openDCR = options.openDCR ?? env.DOLLHOUSE_AUTH_OPEN_DCR;
    this.rateLimitStore = options.rateLimitStore ?? null;
    this.signingKeyStore = options.signingKeyStore ?? null;
    this.bootstrap = new EmbeddedASBootstrap(
      this.methods,
      this.storage,
      () => this.bootstrapReadyLatch,
      (ready) => { this.bootstrapReadyLatch = ready; },
    );
    this.admin = new EmbeddedASAdmin(
      this,
      this.storage,
      () => this.getProtectedResourceMetadataUrl(),
    );
    this.tokens = new EmbeddedASTokens(
      () => this.ensureInitialized(),
      () => this.issuer,
      () => this.resource,
    );
    this.oidcAccount = new EmbeddedASOidcAccount(this.methods, this.storage);
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
    return this.bootstrap.isHttpsPublicBaseUrl(this.publicBaseUrl);
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
    return await this.tokens.validate(token);
  }

  /**
   * Mint a signed access token directly without driving the OAuth flow.
   * Used by integration tests that need to assert HTTP transport
   * behaviors (session-ownership, rate limits, header parsing) without
   * the cost of running through /authorize and /token. Tokens minted
   * here carry the same signing key + issuer + audience as tokens
   * issued via the standard flow, so validate() accepts them — but
   * they have NO Grant, NO accountId, and are NOT reachable from
   * revokeByGrantId. This is intentional for the test use case;
   * production code paths must use the OAuth flow.
   */
  async issue(sub: string, options?: IssueOptions): Promise<string> {
    return await this.tokens.issue(sub, options);
  }

  /**
   * Build the AS's Express router. All embedded-AS routes (oidc-provider
   * mount, /interaction, /.well-known, JWKS) live under here.
   */
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
    //
    // H8: ensureInitialized() can reject (corrupt keyfile, DB unreachable,
    // disk full). A bare `void this.handle...` swallowed the rejection and
    // the request hung forever with no Express error path. Mirror the
    // try/catch/next pattern the /interaction handler uses below so init
    // failures surface as a 500 via the Express error handler.
    router.get('/.well-known/oauth-authorization-server', (req, res, next) => {
      void (async () => {
        try {
          await this.handleAuthorizationServerMetadata(req, res);
        } catch (err) {
          next(err);
        }
      })();
    });

    // Hosted auth pages reuse the console's first-party visual assets, but the
    // embedded AS is often mounted without the web console's static middleware.
    // Serve only the exact logo/font assets needed by those pages.
    router.get('/dollhouse-logo.png', servePackagedAuthAsset('web/public/dollhouse-logo.png', 'image/png'));
    router.get('/fonts.css', servePackagedAuthAsset('web/public/fonts.css', 'text/css; charset=utf-8'));
    router.get('/fonts/:file', servePackagedAuthFont());

    // Bootstrap gate (must-fix #22 / spec L923). When configured methods
    // include a multi-user identity provider, refuse all auth-flow
    // traffic until the operator has run the admin-bootstrap CLI.
    // Public discovery routes (/.well-known/* above, /jwks below in the
    // oidc-provider catch-all) bypass the gate so clients can still find
    // the AS even when it's closed. Mounted AFTER metadata + BEFORE
    // method routes / interaction / oidc-provider catch-all so it
    // intercepts /authorize, /token, /interaction/*, /auth/*.
    router.use(this.createBootstrapGate());

    // Round 5 / H7: GET /auth/admin/me — admin-role enforcement
    // endpoint. Closes the must-fix #22 loop end-to-end: CLI sets
    // bootstrap-state → setAccountRoles writes ['admin'] →
    // extraTokenClaims emits roles → assertHasRole('admin') gates
    // this route. Without a route that actually reads the role, the
    // dashboard's "admin claim flows" claim was unverifiable.
    //
    // Mounted AFTER the bootstrap gate so pre-bootstrap requests get
    // the same 503 as every other auth-flow path. Post-bootstrap, the
    // route validates the bearer token via this.validate(), then
    // delegates to assertHasRole('admin'); a non-admin valid token
    // gets 403, no token / invalid token gets 401.
    router.get('/auth/admin/me', this.createAdminMeHandler());

    // Each method owns its own standalone routes (callbacks, invite-redemption
    // pages, etc.) and registers them via contributeRoutes. Replaces the
    // earlier instanceof-checks-per-method dispatch — the AS no longer
    // needs to know which concrete method classes are active.
    const contributeDeps = {
      storage: this.storage,
      ensureInitialized: () => this.ensureInitialized().then((s) => ({
        provider: s.provider,
        cookieKeys: s.cookieKeys,
      })),
      // Cycle 24 fix: pass the AS's resource URL so social/magic-link
      // callbacks can bind resource scopes to it via finishInteractionWithIdentity.
      defaultResource: this.resource,
    };
    for (const method of this.methods) {
      method.contributeRoutes?.(router, contributeDeps);
    }

    // Issue #2220: when open DCR is enabled for hosted MCP clients, keep
    // registration dynamic but constrain unsafe callback/metadata shapes.
    // Default/IAT-gated DCR remains handled by oidc-provider below.
    if (this.openDCR) {
      if (!this.rateLimitStore) {
        throw new Error('EmbeddedAuthorizationServer openDCR=true requires a shared rateLimitStore');
      }
      router.post('/reg', ...createOpenDcrRegistrationHandlers({
        ensureProvider: async () => {
          const state = await this.ensureInitialized();
          return state.provider;
        },
        rateLimitStore: this.rateLimitStore,
        storage: this.storage,
      }));
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
          // Round 5 / H1: when IP/UA-bound rotation grace is opted in,
          // wrap the oidc-provider callback in an AsyncLocalStorage
          // context carrying the request's IP+UA hashes. The
          // OidcProviderAdapter reads the context at upsert (to stamp
          // hashes onto a freshly-issued RefreshToken) and at find (to
          // gate the grace window on hash match). Without the wrap,
          // the adapter falls back to time-only grace.
          if (this.refreshRotationCheckIpUa) {
            // Round 5 review fixup (MED-2): salt the ip/ua hashes
            // with the AS cookie signing key. Plain SHA-256 of an
            // IPv4 + a known user-agent is rainbow-tableable from an
            // audit dump; HMAC with a per-deployment key forces an
            // attacker to also exfiltrate the salt. Cookie key is
            // already deployment-scoped, persisted, and rotated on
            // mode-switch — exactly the lifecycle we want.
            const salt = state.cookieKeys[0];
            // Cycle-12 fix (H12-1): normalize the IP before hashing so
            // the same dual-stack client (`::ffff:1.2.3.4` vs `1.2.3.4`)
            // produces the same `ipHash`. Without this, the IP/UA-bound
            // rotation grace silently fails closed for v6-mapped clients
            // that rotate via v4 (or vice-versa). Same bug class as
            // cycle-10 H10-2 (MagicLink), cycle-11 H11-2 (getClientKey)
            // — fourth and final site of the pattern.
            //
            // Cycle-13 fix: Express's `req.headers['user-agent']` is
            // typed `string | string[] | undefined`. Multi-value UA
            // headers (rare but valid per HTTP/1.1) used to coerce to
            // a comma-joined string via `createHmac.update(arr)` —
            // producing a different hash from the same UA sent as a
            // single header. Pick the first value when an array is
            // present so the hash stays stable.
            const context: RotationRequestContext = {
              ipHash: hashRotationAttribute(normalizeIp(req.ip ?? ''), salt),
              uaHash: hashRotationAttribute(pickHeaderValue(req.headers['user-agent']), salt),
            };
            // Await the oidc-provider callback so async rejections (e.g.
            // adapter/DB hiccups during token issuance) reach the outer
            // try/catch and flow to Express's error middleware via next().
            // Without the await, the returned Promise is discarded and
            // any async rejection becomes an unhandledRejection.
            await withRotationRequestContext(context, () => state.provider.callback()(req, res));
          } else {
            await state.provider.callback()(req, res);
          }
        } catch (err) {
          next(err);
        }
      })();
    });

    return router;
  }

  /**
   * Latch flipped once bootstrap is observed as complete. Mirrors the
   * pattern in `createBootstrapGate`: bootstrap is monotonic (the
   * atomic `markBootstrapComplete` UPSERT rejects admin transfer), so
   * once we see `completed: true` we never need to re-read storage.
   * Without this, /readyz at a 10s probe interval × N replicas
   * generates sustained read traffic against `auth_kv` indefinitely
   * even though the answer can never change again.
   *
   * Concurrency: under concurrent /readyz probes (Kubernetes liveness
   * + readiness racing), two callers can both observe the latch as
   * `false`, both read storage, and both write `true`. That's benign:
   * both writes converge to the same value and the worst case is one
   * extra storage read per cold-start probe. The latch is monotonic
   * `false → true` and never reverts, so this is not a race in any
   * meaningful sense — it's a converging idempotent write.
   */
  private bootstrapReadyLatch = false;

  /**
   * Round 5 / H3: public predicate so /readyz can refuse traffic
   * pre-bootstrap. Returns true when:
   *   - the AS is not in multi-user mode (no bootstrap concept), OR
   *   - the AS is in multi-user mode AND bootstrap has been completed.
   * Returns false when multi-user mode is active and bootstrap is
   * incomplete, so the readiness probe stays red until the operator
   * runs the bootstrap CLI. Errors fail closed (returns false) so a
   * storage outage doesn't pretend the AS is ready.
   *
   * Round 5 review fixup (MED-4): once bootstrap completes, latch and
   * stop hitting storage on subsequent probes. Bootstrap is monotonic
   * — the atomic UPSERT rejects admin transfer, so a `completed: true`
   * observation can never revert. Pre-bootstrap probes still hit
   * storage (we want to see the moment it flips).
   */
  async isReadyForTraffic(): Promise<boolean> {
    return await this.bootstrap.isReadyForTraffic();
  }

  /**
   * Build the bootstrap-gate Express middleware. Cached as a closure
   * because (a) `createRouter()` may be called more than once in tests,
   * (b) the cache flag below is per-middleware-instance.
   */
  private createBootstrapGate(): RequestHandler {
    return this.bootstrap.createBootstrapGate();
  }

  /**
   * Build the GET /auth/admin/me handler chain.
   *
   * Validates the bearer token via this.validate() (the same path the
   * unified auth middleware uses), populates res.locals.authClaims so
   * assertHasRole reads the same shape the rest of the codebase does,
   * then assertHasRole('admin') gates the actual handler. Body is
   * minimal — a stable shape for operator tooling that wants to verify
   * "yes, I'm authenticated as the admin".
   */
  private createAdminMeHandler(): RequestHandler[] {
    return this.admin.createAdminMeHandler();
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
      token_endpoint_auth_methods_supported: this.supportedTokenEndpointAuthMethods(),
      // Cycle 24: include standard OIDC scopes (profile, email) so MCP
      // clients that auto-register with these in their DCR payload
      // (Gemini CLI, claude.ai, others) pass scope validation. These are
      // no-op for resource access — the mcp scope check on /mcp is the
      // gate (must-fix #15). profile/email map to id_token claims if the
      // client requests them; without configured claims they're silent.
      scopes_supported: ['openid', 'offline_access', 'mcp', 'profile', 'email'],
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
    // Single-key JWKS keyset. The AS publishes one ES256 key under one
    // kid loaded from the persistKeys file. A multi-key rotation
    // procedure (so existing tokens stay valid through a key swap) is a
    // follow-up runbook — `persistKeys.ts` would need to grow multi-key
    // support, and an admin endpoint would need to drive the promotion.
    // The current shape is "rotate by restart with token invalidation,"
    // which is honest but not zero-downtime.
    // Phase 4.5: load via store when injected, else legacy file path.
    let keyset = this.signingKeyStore
      ? await loadOrGenerateSigningJwksViaStore(this.signingKeyStore)
      : await loadOrGenerateSigningJwks(this.keyFilePath);

    // Mode-switch invalidation. The split API (checkModeFingerprint +
    // persistModeFingerprint) lets the AS and out-of-band tooling (dashboard,
    // ops scripts) compute "did the mode change?" the same way. On mismatch
    // we rotate three things — K/V state, cookie secret, AND the JWKS signing
    // key — then persist the fingerprint reflecting the post-rotation state.
    let cookieKeys = this.signingKeyStore
      ? await loadOrGenerateCookieSigningKeysViaStore(this.signingKeyStore, { envSecret: this.cookieSecretEnvOverride })
      : loadOrGenerateCookieSigningKeys(undefined, { envSecret: this.cookieSecretEnvOverride });

    // Round 6 review fixup: when the operator opts into IP/UA-bound
    // rotation grace, the cookie key doubles as the HMAC salt for the
    // ip/ua hashes stamped onto refresh tokens. In a multi-replica
    // HA deployment, replicas that load DIFFERENT cookie keys from
    // their local files would HMAC the same IP+UA differently — a
    // refresh token issued by replica A would silently fail the IP/UA
    // match on replica B and the legitimate session would be revoked.
    //
    // The supported HA path is `DOLLHOUSE_COOKIE_SIGNING_SECRET` env
    // var (every replica reads the same key from env, file is
    // ignored). If we observe `refreshRotationCheckIpUa=true` AND the
    // env var is unset, log a warning naming the multi-replica risk.
    // Single-replica deployments are unaffected — the file-loaded
    // key stays stable across the AS lifetime.
    // Cycle 22: cookieSecretEnvOverride is the test injection point.
    // Production callers omit it; the env.X value is the default.
    const cookieSecretConfigured = this.cookieSecretEnvOverride ?? env.DOLLHOUSE_COOKIE_SIGNING_SECRET;
    if (this.refreshRotationCheckIpUa && !cookieSecretConfigured) {
      logger.warn(
        '[EmbeddedAuthorizationServer] refreshRotationCheckIpUa is enabled but ' +
        'DOLLHOUSE_COOKIE_SIGNING_SECRET is unset. The cookie signing key — used as ' +
        'the HMAC salt for IP/UA hashes on refresh tokens — will be loaded from a ' +
        'local file. In a multi-replica HA deployment, replicas with different ' +
        'local key files will HMAC IP/UA differently and legitimate refresh ' +
        'rotations will be revoked. Set DOLLHOUSE_COOKIE_SIGNING_SECRET (hex, ≥32 ' +
        'bytes, identical across replicas) before enabling IP/UA-bound grace in HA.',
      );
    }

    const fingerprintInputs = {
      provider: 'embedded',
      methodIds: this.methods.map((m) => m.id),
      issuer: this.issuer,
      primaryKid: keyset.kid,
      primaryCookieKey: cookieKeys[0],
    };
    const fingerprintResult = await checkModeFingerprint(this.storage, fingerprintInputs);

    if (fingerprintResult.firstRun) {
      // First run: nothing to invalidate, just record the fingerprint.
      await persistModeFingerprint(this.storage, fingerprintInputs);
    } else if (fingerprintResult.changed) {
      // Invalidate FIRST, then persist the new fingerprint. Persisting
      // before clearing would leave stale tokens valid against the new
      // mode if a crash hit between the two. Clear-then-persist is
      // crash-safe: a crash mid-sequence means the next boot recomputes
      // `changed: true` and re-runs the idempotent clear.
      // Cycle 24 / cycle-23 code LOW: forward cookieSecretEnvOverride
      // to the mode-switch rotation calls so tests that exercise this
      // path with the override observe the same env-driven semantics
      // as the initial load. Production callers don't set the override,
      // so this is a no-op outside tests.
      const cleared = await this.storage.clearGenericByModels(OAUTH_STATE_MODELS);
      // Phase 4.5: rotate via store when injected, else legacy file path.
      // The store's rotate() is atomic (mark-old-inactive + insert-new in one
      // transaction); the file path is unlink + regenerate-on-next-load.
      if (this.signingKeyStore) {
        await rotateCookieSecretViaStore(this.signingKeyStore, { envSecret: this.cookieSecretEnvOverride });
        cookieKeys = await loadOrGenerateCookieSigningKeysViaStore(this.signingKeyStore, { envSecret: this.cookieSecretEnvOverride });
        await rotateSigningKeyViaStore(this.signingKeyStore);
        keyset = await loadOrGenerateSigningJwksViaStore(this.signingKeyStore);
      } else {
        rotateCookieSecret(undefined, { envSecret: this.cookieSecretEnvOverride });
        cookieKeys = loadOrGenerateCookieSigningKeys(undefined, { envSecret: this.cookieSecretEnvOverride });
        // Phase 9 H2/Q2: rotate the JWKS signing key too. Without this,
        // stateless JWT access tokens issued before the mode change keep
        // verifying until natural exp (1h), even though K/V was cleared
        // and the cookie secret rotated. Deleting the keyfile + reloading
        // mints a fresh kid; old tokens fail kid-match in validate().
        await rotateSigningKey(this.keyFilePath);
        keyset = await loadOrGenerateSigningJwks(this.keyFilePath);
      }
      // Persist with the post-rotation cookie key + new kid so the
      // next boot sees a stable fingerprint that already reflects the
      // rotation. Done LAST so a crash before this point re-triggers
      // the invalidation on next boot rather than skipping it.
      await persistModeFingerprint(this.storage, {
        ...fingerprintInputs,
        primaryKid: keyset.kid,
        primaryCookieKey: cookieKeys[0],
      });
      await this.storage.recordIdentityEvent({
        type: 'auth.mode_switch_invalidation',
        details: {
          cleared,
          previous: fingerprintResult.previous,
          current: fingerprintResult.current,
        },
        timestamp: Date.now(),
      });
      logger.warn('[EmbeddedAuthorizationServer] mode-switch detected; OAuth state cleared, cookie secret rotated', {
        cleared,
      });
    }

    const adapterFactory = createOidcAdapterFactory(this.storage, {
      refreshRotationGraceMs: this.refreshRotationGraceMs,
      refreshRotationCheckIpUa: this.refreshRotationCheckIpUa,
    });

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
      clientAuthMethods: this.supportedTokenEndpointAuthMethods(),
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
        //
        // Cycle 24 escape hatch: when `DOLLHOUSE_AUTH_OPEN_DCR=true`
        // (or the constructor option openDCR=true for tests), /reg
        // accepts unauthenticated registrations. This unblocks MCP
        // clients that do automatic DCR without an IAT (Gemini CLI,
        // claude.ai web). Acceptable on loopback dev where the AS is
        // unreachable from the network; on remote binds it widens the
        // attack surface. Operators must understand the trade-off.
        registration: { enabled: true, initialAccessToken: !this.openDCR },
        // Disable oidc-provider's developer-only built-in interaction page;
        // we own /interaction/:uid via InteractionRouter.
        devInteractions: { enabled: false },
        // RFC 8707 resource indicators — clients pass `resource=...` to bind
        // tokens to a specific MCP server URI; we issue JWT access tokens
        // with that aud claim (must-fix #15 audience binding).
        resourceIndicators: {
          enabled: true,
          defaultResource: () => this.resource,
          // Force resource binding for grants that didn't explicitly pass
          // an RFC 8707 `resource=...` parameter, so generic OAuth clients
          // (e.g. oauth2-proxy fronting the web console behind a forward-
          // auth gate) still receive JWT-format access tokens bound to
          // this.resource. Without this, oidc-provider defaults to opaque
          // tokens for any grant where the client didn't pass resource= —
          // which means anything but a resource-aware MCP client lands on
          // a token shape unifiedAuthMiddleware can't validate.
          //
          // Companion config required on the consuming side: oauth2-proxy
          // MUST NOT call the AS's /me (userinfo) endpoint with these
          // resource-bound tokens — set OAUTH2_PROXY_SKIP_CLAIMS_FROM_PROFILE_URL=true
          // — because oidc-provider correctly rejects "for-resource-X"
          // tokens at the OP's own userinfo endpoint (RFC 8707).
          useGrantedResource: () => true,
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
      extraTokenClaims: (_ctx, token) => this.oidcAccount.extraTokenClaims(_ctx, token),
      // oidc-provider validates DCR-time AND authorize-time `scope` values
      // against THIS list (not against the published `scopes_supported` in
      // the well-known metadata — those are independent). Cycle 24: the
      // earlier shape kept `mcp` out under the rationale that
      // resourceIndicators.getResourceServerInfo would declare it; but MCP
      // clients (Gemini CLI confirmed) send `scope=mcp` in their DCR
      // payload alongside the OIDC standard scopes, and oidc-provider
      // rejects the registration. The original consent-prompt concern is
      // moot because devInteractions.enabled=false hands consent rendering
      // to our InteractionRouter. profile+email added in cycle 24 too.
      scopes: ['openid', 'offline_access', 'profile', 'email', 'mcp'],
      // PKCE is required for all clients; oidc-provider 9.x defaults to S256-only
      // when 'plain' is not in code_challenge_methods_supported (which it isn't).
      pkce: { required: () => true },
      ttl: {
        AccessToken: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
        RefreshToken: DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
        AuthorizationCode: DEFAULT_AUTH_CODE_TTL_SECONDS,
        Interaction: DEFAULT_INTERACTION_TTL_SECONDS,
        Session: DEFAULT_SESSION_TTL_SECONDS,
      },
      // must-fix #11: enable refresh-token rotation + replay detection.
      // oidc-provider tags consumed records with `consumed: <ts>` (via
      // the Adapter's consume(); see OidcProviderAdapter + storage's
      // genericConsume) and triggers `revokeByGrantId` on the next find
      // that returns a consumed payload — this is the §6.1 family-
      // revocation path.
      //
      // Atomicity nuance: oidc-provider's Adapter contract is
      // find-then-consume, not transactional find-and-consume. Two
      // truly-concurrent token exchanges can both `find` an unconsumed
      // record before either calls `consume`. The CAS in
      // `genericConsume` (single-statement UPDATE WHERE NOT consumed
      // on Postgres; lock-protected RMW on filesystem; single-process
      // serialization on memory) guarantees only ONE caller marks the
      // record consumed — the other's consume returns false. That's
      // sufficient to detect a third use (which sees consumed: true and
      // triggers revoke), but does NOT prevent a single double-redeem
      // window. A truly-atomic solution would require an upstream
      // contract change in oidc-provider; out of §8.1 scope.
      rotateRefreshToken: true,
      issueRefreshToken: async (_ctx, client, code) => {
        // Only issue a refresh token when offline_access was granted.
        return client.grantTypeAllowed('refresh_token') && code.scopes.has('offline_access');
      },
      interactions: {
        url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      },
      findAccount: (_ctx, sub) => this.oidcAccount.findAccount(_ctx, sub),
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
    this.attachAuditEventHandlers(provider);

    // Cycle-8 fix (B1): align oidc-provider's proxy setting with the
    // operator's trust-proxy configuration. `proxy` controls whether
    // X-Forwarded-Proto/Host headers are trusted when oidc-provider
    // computes the request scheme/host for redirect URI validation
    // and similar checks.
    //
    //   - Native HTTPS at the server (DOLLHOUSE_TRUSTED_PROXIES unset
    //     or only 'loopback'): server scheme is what Node sees; no
    //     upstream proxy to trust. proxy=false is correct.
    //   - Behind a TLS-terminating upstream proxy
    //     (DOLLHOUSE_TRUSTED_PROXIES set to that proxy's CIDR):
    //     server is HTTP, proxy supplies X-Forwarded-Proto=https
    //     and X-Forwarded-Host=public.example.com. proxy=true is
    //     required or oidc-provider rejects https:// redirect URIs
    //     as "not matching" the http:// scheme it computes from req.
    //
    // The earlier hardcoded `false` broke every TLS-terminating
    // reverse-proxy deployment. shouldTrustUpstreamProxy() is
    // exported for unit testing and reads the same env source of
    // truth that drives `app.set('trust proxy')` in
    // StreamableHttpServer.
    provider.proxy = shouldTrustUpstreamProxy(env.DOLLHOUSE_TRUSTED_PROXIES);

    // privateJwk carries `d`/`p`/`q`/etc; strip those for the public key
    // import so signature verification can't accidentally use the private
    // half. The earlier shape called this `publicJwk`, which was
    // misleading — anyone reading the private-import line couldn't tell
    // it was the full private JWK. The names now match what each value is.
    const { publicSigningKey, privateSigningKey } = await importSigningKeys(keyset);

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
      // Cycle 24 fix: defaultResource so finishInteractionWithIdentity
      // can bind resource scopes (like `mcp`) to a real resource server
      // when the client didn't pass `resource=` on the authorize request.
      // Without this, the grant ends up scope-empty for the resource
      // dimension, oidc-provider re-prompts, and the consent flow loops.
      defaultResource: this.resource,
    });

    return { provider, keyset, publicSigningKey, privateSigningKey, cookieKeys, interactionMiddleware };
  }

  private attachAuditEventHandlers(provider: InstanceType<typeof OidcProvider>): void {
    const recordTokenIssued = (eventName: string) => (token: unknown) => {
      const accountId = stringProperty(token, 'accountId');
      void this.storage.recordIdentityEvent({
        type: 'auth.oauth.token_issued',
        sub: accountId,
        details: {
          providerEvent: eventName,
          tokenKind: stringProperty(token, 'kind'),
          clientId: stringProperty(token, 'clientId'),
          grantId: stringProperty(token, 'grantId'),
          scope: stringProperty(token, 'scope'),
          audience: stringOrStringArrayProperty(token, 'aud'),
        },
        timestamp: Date.now(),
      }).catch((err) => {
        logger.warn('[EmbeddedAuthorizationServer] failed to record token-issued audit event', {
          providerEvent: eventName,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    provider.on('access_token.issued', recordTokenIssued('access_token.issued'));
    provider.on('access_token.saved', recordTokenIssued('access_token.saved'));
    provider.on('refresh_token.saved', recordTokenIssued('refresh_token.saved'));
  }

  private supportedTokenEndpointAuthMethods(): ['none'] | ['none', 'client_secret_basic', 'client_secret_post'] {
    return this.openDCR
      ? ['none']
      : ['none', 'client_secret_basic', 'client_secret_post'];
  }
}


function normalizePath(rawPath: string): string {
  if (!rawPath || rawPath === '/') return '/mcp';
  return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function stringOrStringArrayProperty(value: unknown, key: string): string | string[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (Array.isArray(raw)) {
    const strings = raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return strings.length > 0 ? strings : undefined;
  }
  return undefined;
}
