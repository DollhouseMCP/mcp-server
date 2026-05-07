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
  rotateSigningKey,
  type SigningKeyset,
} from './persistKeys.js';
import { loadOrGenerateCookieSigningKeys, rotateCookieSecret } from './cookieSecret.js';
import {
  checkAndPersistModeFingerprint,
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

      // Defense in depth (H6): require the `mcp` scope on the token.
      // Tokens we issue always carry it (resource server scope wired in
      // the resourceIndicators config), but a key-rotation bug or a
      // future code path that accidentally minted a token without scope
      // would otherwise pass everything else here. Reject unconditionally.
      const scopeClaim = typeof payload.scope === 'string' ? payload.scope : '';
      const scopes = new Set(scopeClaim.split(/\s+/).filter(Boolean));
      if (!scopes.has('mcp')) {
        return { ok: false, reason: 'token missing mcp scope' };
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
        const claim = error.claim;
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

    // Bootstrap gate (must-fix #22 / spec L923). When configured methods
    // include a multi-user identity provider, refuse all auth-flow
    // traffic until the operator has run the admin-bootstrap CLI.
    // Public discovery routes (/.well-known/* above, /jwks below in the
    // oidc-provider catch-all) bypass the gate so clients can still find
    // the AS even when it's closed. Mounted AFTER metadata + BEFORE
    // method routes / interaction / oidc-provider catch-all so it
    // intercepts /authorize, /token, /interaction/*, /auth/*.
    router.use(this.createBootstrapGate());

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

  /**
   * Multi-user methods (must-fix #22). When ANY of these is configured,
   * the bootstrap gate is active until the admin-bootstrap CLI runs.
   * Single-user / external-IdP modes (trivial-consent, oidc-bridge) do
   * not need a bootstrap step and skip the gate entirely.
   */
  private static readonly MULTI_USER_METHODS: ReadonlySet<string> = new Set([
    'local-password',
    'magic-link',
    'github',
  ]);

  /**
   * Paths that bypass the bootstrap gate. Discovery + key-distribution
   * endpoints MUST stay reachable even when the AS is closed so that
   * clients can find the AS and verify any tokens already in their
   * possession. The list is path-prefix matched against `req.path`
   * (route-level path, NOT originalUrl) — when this middleware runs
   * inside the AS router, `req.path` is already mount-relative.
   */
  private static readonly GATE_BYPASS_PREFIXES: readonly string[] = ['/.well-known/', '/jwks'];

  private isMultiUserMode(): boolean {
    return this.methods.some((m) => EmbeddedAuthorizationServer.MULTI_USER_METHODS.has(m.id));
  }

  /**
   * Render a method-specific actionable hint for the 503 body. The
   * operator should be able to copy-paste the suggested command and
   * have it Just Work.
   */
  private bootstrapHint(): string {
    const ids = this.methods.map((m) => m.id);
    const lines: string[] = [];
    if (ids.includes('local-password')) {
      lines.push(
        "Run 'dollhousemcp create-user --username <name> --email <addr>' " +
        "to issue the first invite (this also marks bootstrap complete).",
      );
    }
    if (ids.includes('magic-link')) {
      lines.push(
        "Run 'dollhousemcp admin bootstrap --method magic-link --email <admin@example.com>' " +
        "to claim the admin identity.",
      );
    }
    if (ids.includes('github')) {
      lines.push(
        "Run 'dollhousemcp admin bootstrap --method github --github-username <gh-username>' " +
        "to claim the admin identity.",
      );
    }
    return lines.join(' OR ');
  }

  /**
   * Build the bootstrap-gate Express middleware. Cached as a closure
   * because (a) `createRouter()` may be called more than once in tests,
   * (b) the cache flag below is per-middleware-instance.
   */
  private createBootstrapGate(): RequestHandler {
    if (!this.isMultiUserMode()) {
      // Trivial-consent / oidc-bridge: gate is unconditionally open.
      return (_req, _res, next) => next();
    }
    const bypassPrefixes = EmbeddedAuthorizationServer.GATE_BYPASS_PREFIXES;
    // Once bootstrap has been observed as complete, latch open. The
    // markBootstrapComplete contract rejects admin transfer, so going
    // back from completed→incomplete is impossible — caching is safe.
    let cachedComplete = false;
    return async (req, res, next) => {
      if (cachedComplete) {
        next();
        return;
      }
      // Mount-relative path: `req.path` is path within this router's
      // scope, regardless of where the router is mounted in the host app.
      for (const prefix of bypassPrefixes) {
        if (req.path === prefix || req.path.startsWith(prefix)) {
          next();
          return;
        }
      }
      try {
        const state = await this.storage.getBootstrapState();
        if (state.completed) {
          cachedComplete = true;
          next();
          return;
        }
        res.status(503).json({
          error: 'bootstrap_required',
          error_description:
            'This authorization server has not been bootstrapped. ' +
            'An operator must claim the first admin identity before any ' +
            'authentication flow is accepted.',
          next_step: this.bootstrapHint(),
        });
      } catch (err) {
        logger.error('[EmbeddedAuthorizationServer] bootstrap-gate storage read failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Fail closed: if the gate can't read the state, refuse traffic
        // rather than open the AS to potential pre-bootstrap auth flow.
        res.status(503).json({
          error: 'bootstrap_check_unavailable',
          error_description: 'Unable to verify bootstrap state. Try again shortly.',
        });
      }
    };
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
    // Single-key JWKS keyset. The AS publishes one ES256 key under one
    // kid loaded from the persistKeys file. A multi-key rotation
    // procedure (so existing tokens stay valid through a key swap) is a
    // follow-up runbook — `persistKeys.ts` would need to grow multi-key
    // support, and an admin endpoint would need to drive the promotion.
    // The current shape is "rotate by restart with token invalidation,"
    // which is honest but not zero-downtime.
    let keyset = await loadOrGenerateSigningJwks(this.keyFilePath);

    // must-fix #14: mode-switch invalidation. Delegate the read-compare-
    // persist dance to checkAndPersistModeFingerprint so this AS and any
    // out-of-band tooling (the dashboard, ops scripts) compute "did the
    // mode change?" the same way. On mismatch we rotate three things —
    // K/V state, cookie secret, AND the JWKS signing key — then re-
    // persist the fingerprint reflecting the post-rotation state.
    let cookieKeys = loadOrGenerateCookieSigningKeys();
    const fingerprintInputs = {
      provider: 'embedded',
      methodIds: this.methods.map((m) => m.id),
      issuer: this.issuer,
      primaryKid: keyset.kid,
      primaryCookieKey: cookieKeys[0]!,
    };
    const fingerprintResult = await checkAndPersistModeFingerprint(this.storage, fingerprintInputs);

    if (fingerprintResult.changed) {
      const cleared = await this.storage.clearGenericByModels(OAUTH_STATE_MODELS);
      rotateCookieSecret();
      cookieKeys = loadOrGenerateCookieSigningKeys();
      // Phase 9 H2/Q2: rotate the JWKS signing key too. Without this,
      // stateless JWT access tokens issued before the mode change keep
      // verifying until natural exp (1h), even though K/V was cleared
      // and the cookie secret rotated. Deleting the keyfile + reloading
      // mints a fresh kid; old tokens fail kid-match in validate().
      await rotateSigningKey(this.keyFilePath);
      keyset = await loadOrGenerateSigningJwks(this.keyFilePath);
      // Re-persist with the post-rotation cookie key + new kid so the
      // next boot sees a stable fingerprint that already reflects the
      // rotation. Without this, every boot after a mode-switch would
      // detect "another change" because cookieKeys[0] and primaryKid
      // both moved on rotation.
      await checkAndPersistModeFingerprint(this.storage, {
        ...fingerprintInputs,
        primaryKid: keyset.kid,
        primaryCookieKey: cookieKeys[0]!,
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
        if (!account) return undefined;
        // Defense in depth: refuse to emit role/auth_time claims if the
        // row's sub doesn't match the token's accountId. A bug elsewhere
        // that lets a token carry a foreign accountId would otherwise
        // propagate someone else's claims onto it. Today this is
        // unreachable (oidc-provider sets accountId from the Grant we
        // minted) but making it a no-op rather than trusting the lookup
        // keeps the claim honest if the surrounding code ever changes shape.
        if (account.sub !== accountId) return undefined;
        const extras: Record<string, unknown> = {};
        if (account.lastAuthAt) {
          extras.auth_time = Math.floor(account.lastAuthAt / 1000);
        }
        if (account.roles && account.roles.length > 0) {
          // Roles are sourced from the durable account record set by the
          // admin-bootstrap CLI (must-fix #22). Emitted on every token
          // issued for this sub, so the role survives refresh-rotation.
          extras.roles = account.roles;
        }
        return Object.keys(extras).length > 0 ? extras : undefined;
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

    // privateJwk carries `d`/`p`/`q`/etc; strip those for the public key
    // import so signature verification can't accidentally use the private
    // half. The earlier shape called this `publicJwk`, which was
    // misleading — anyone reading the private-import line couldn't tell
    // it was the full private JWK. The names now match what each value is.
    const privateJwk = keyset.jwks.keys[0];
    const publicSigningKey = (await importJWK(stripPrivate(privateJwk), ALGORITHM)) as CryptoKey;
    const privateSigningKey = (await importJWK(privateJwk, ALGORITHM)) as CryptoKey;

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

    return { provider, keyset, publicSigningKey, privateSigningKey, cookieKeys, interactionMiddleware };
  }
}


function claimsFromPayload(payload: Record<string, unknown>): AuthClaims {
  return {
    sub: String(payload.sub),
    displayName: typeof payload.name === 'string' ? payload.name : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : null,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : undefined,
    roles: Array.isArray(payload.roles)
      ? payload.roles.filter((r): r is string => typeof r === 'string')
      : undefined,
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

