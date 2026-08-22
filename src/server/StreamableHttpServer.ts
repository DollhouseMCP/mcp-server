import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { json, static as expressStatic } from 'express';
import type { ErrorRequestHandler, Express, Request, RequestHandler, Response, Router } from 'express';
import type { AuthClaims } from '../auth/IAuthProvider.js';
import type { PerformanceMonitor } from '../utils/PerformanceMonitor.js';
import { env } from '../config/env.js';
import { PACKAGE_VERSION } from '../generated/version.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { normalizeIp } from '../auth/embedded-as/rateLimit.js';
import { pickHeaderValue } from '../auth/embedded-as/EmbeddedAuthorizationServer.js';
import { logger } from '../utils/logger.js';
import { assertSafePublicBaseUrl, isLoopbackHost } from '../auth/oauth/url.js';
import { createHttpOrHttpsServer } from './createHttpOrHttpsServer.js';
import { TlsConfig } from './TlsConfig.js';

export type RuntimeTransportName = 'stdio' | 'streamable-http';
export const DEFAULT_RUNTIME_COMMAND_POLL_INTERVAL_MS = 5_000;

/** Constant form of the streamable-http transport name. Used in /healthz,
 *  /readyz, and runtime selection — extracted so changes (or typos) can't
 *  drift across the multiple emission sites. */
const STREAMABLE_HTTP: RuntimeTransportName = 'streamable-http';
export type DeferredSetupMode = 'full' | 'sink-only' | 'none';

export interface AttachTransportOptions {
  transportName: RuntimeTransportName;
  deferredSetupMode: DeferredSetupMode;
  emitReadySentinel?: boolean;
  suppressConsoleLoggingAfterConnect?: boolean;
}

export interface StreamableHttpRuntimeOptions {
  host?: string;
  port?: number;
  mcpPath?: string;
  allowedHosts?: string[];
  registerSignalHandlers?: boolean;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
  bodyLimitBytes?: number;
  sessionIdleTimeoutMs?: number;
  sessionPoolSize?: number;
  /** Maximum time to let accepted MCP requests finish during shutdown. */
  shutdownGracePeriodMs?: number;
  /** Maximum time to wait for one session attachment to dispose. */
  sessionDisposalTimeoutMs?: number;
  /** Drain process-level services after HTTP requests and sessions are closed. */
  onShutdown?: () => Promise<void>;
  /** Express middleware for authentication. Mounted before MCP handlers when provided. */
  authMiddleware?: RequestHandler;
  /** Embedded OAuth provider. Discovery and token routes are mounted before MCP auth middleware. */
  oauthProvider?: {
    setPublicBaseUrl?: (publicBaseUrl: string) => void;
    createRouter: () => Router;
    /**
     * Round 5 / H3: optional readiness predicate. /readyz returns 503
     * when this resolves to false (multi-user mode + bootstrap
     * incomplete) so Kubernetes / load balancers stop routing traffic
     * to a pod that can't yet serve auth flows.
     */
    isReadyForTraffic?: () => Promise<boolean>;
    getReadinessFailureReason?: () => string;
  };
  /**
   * TLS configuration for the HTTP transport. When enabled, the server binds HTTPS.
   * Defaults to a TlsConfig constructed from env (DOLLHOUSE_TLS_CERT_PATH/_KEY_PATH).
   * Tests can pass a stub TlsConfig with overrides.
   */
  tlsConfig?: TlsConfig;
  /** Called when a new HTTP session is initialized (after MCP handshake). */
  onSessionCreated?: (sessionId: string) => void;
  /** Called when an HTTP session is disposed (disconnect, expiry, or shutdown). */
  onSessionDisposed?: (sessionId: string) => void;
  /** Optional web-console runtime control-plane bridge. Dormant when omitted. */
  runtimeSessionControl?: StreamableHttpRuntimeSessionControl;
  /**
   * Optional descriptor-driven web-console API router. The production registrar
   * only creates this after its activation checks pass; the HTTP runtime owns
   * the actual Express mount and marks readiness once mounted.
   */
  webConsoleApiV1?: {
    router: Router;
    markMounted: () => void;
  };
  /** Poll interval for durable runtime termination commands when runtimeSessionControl is configured. */
  runtimeCommandPollIntervalMs?: number;
  /**
   * Optional PerformanceMonitor. When provided, /healthz includes
   * per-op auth timing aggregates (latency p50/p95/p99, success rate)
   * under the `auth` key so operators can spot slow OAuth round-trips,
   * JWKS misses, etc.
   */
  performanceMonitor?: PerformanceMonitor;
}

export interface StreamableHttpRuntimeHandle {
  app: Express;
  host: string;
  port: number;
  mcpPath: string;
  url: string;
  httpServer: HttpServer | HttpsServer;
  /** True when the server is bound HTTPS (TLS enabled). */
  isHttps: boolean;
  close(): Promise<void>;
  activeSessionCount(): number;
  pooledSessionCount(): number;
}

/** Client name/version advertised in the MCP `initialize` handshake (`clientInfo`). */
export interface McpClientInfo {
  readonly name?: string;
  readonly version?: string;
}

export interface StreamableHttpSessionAttachment {
  /**
   * The dollhouse SessionContext id for this session. The transport adopts it
   * as its own `mcp-session-id` (see `sessionIdGenerator` in `prepareSession`)
   * so the id shown in `/me/sessions`, the runtime presence id, and the id
   * that tags this session's logs are ALL ONE value — which is what keeps the
   * Sessions↔Logs "View logs" cross-link working for MCP clients.
   */
  readonly contextSessionId: string;
  /** Resolves after the application handler for one JSON-RPC request completes. */
  waitForRequest?: (requestId: string | number) => Promise<void>;
  /** Resolves only after every application request handler has completed. */
  waitForIdle?: () => Promise<void>;
  dispose(): Promise<void>;
  runtimeSession?: {
    readonly userId: string;
    readonly accountCorrelationId: string;
    readonly clientInfo?: {
      readonly name?: string;
      readonly version?: string;
    } | null;
  };
}

export interface StreamableHttpRuntimeSessionControl {
  registerSession(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly accountCorrelationId: string;
    readonly clientInfo?: {
      readonly name?: string;
      readonly version?: string;
    } | null;
  }): Promise<void>;
  recordActivity(sessionId: string, outcome?: 'ok' | 'error'): Promise<unknown>;
  markSessionDisposed(sessionId: string): Promise<void>;
  reconcilePendingCommands(terminator: {
    terminateLocalSession(sessionId: string): Promise<'terminated' | 'already_absent' | 'retry'>;
  }): Promise<number>;
}

interface ActiveSessionRecord {
  attachment: StreamableHttpSessionAttachment;
  transport: StreamableHTTPServerTransport;
  expirationTimer: NodeJS.Timeout | null;
  lastTouchedAt: number;
  inFlightRequests: number;
  /**
   * Authenticated subject of the user that initialized this session.
   * Set when auth is enabled and a bearer token authenticated the
   * `initialize` request; undefined otherwise (auth disabled, or
   * pooled session that was never claimed).
   *
   * Subsequent requests on the same `mcp-session-id` MUST come from
   * the same `sub` — without this binding, anyone with a valid bearer
   * token plus a leaked session id can dispatch tools against this
   * session's user-scoped DI container (H7).
   */
  ownerSub: string | undefined;
  /** Canonical DB user resolved for ownerSub when live account authority is enabled. */
  ownerUserId: string | undefined;
  /** Principal generation at session initialization; changes invalidate reuse. */
  ownerAuthzVersion: number | undefined;
}

interface PreparedSessionRecord {
  attachment: StreamableHttpSessionAttachment;
  transport: StreamableHTTPServerTransport;
  /** See ActiveSessionRecord.ownerSub. */
  ownerSub: string | undefined;
  ownerUserId: string | undefined;
  ownerAuthzVersion: number | undefined;
  /** Presence row registered before initialization, if any. */
  runtimePresenceSessionId: string | undefined;
  dispose(): Promise<void>;
}

interface RateLimitRecord {
  requestCount: number;
  windowEndsAt: number;
}

interface SessionTelemetry {
  created: number;
  disposed: number;
  expired: number;
  poolHits: number;
  poolMisses: number;
  rateLimitedRequests: number;
}

function normalizeUserInput(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  return UnicodeValidator.normalize(rawValue).normalizedContent;
}

function getCliFlagValue(flagName: string): string | undefined {
  const prefix = `--${flagName}=`;
  const arg = process.argv.find(value => value.startsWith(prefix));
  return arg ? normalizeUserInput(arg.slice(prefix.length)) : undefined;
}

function parseCommaSeparatedValues(rawValue: string | undefined): string[] | undefined {
  if (!rawValue) {
    return undefined;
  }

  const values = rawValue
    .split(',')
    .map(value => normalizeUserInput(value.trim())?.trim())
    .filter((value): value is string => Boolean(value));

  return values.length > 0 ? values : undefined;
}

function normalizeMcpPath(rawPath: string | undefined): string {
  const normalizedPath = normalizeUserInput(rawPath);
  if (!normalizedPath || normalizedPath === '/') {
    return '/mcp';
  }

  return normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
}

function getRequestId(req: Request): unknown {
  const body = req.body as { id?: unknown } | undefined;
  return body?.id ?? null;
}

function getMcpSessionId(req: Request): string | undefined {
  // Cycle-15 fix (HIGH-1): use the shared pickHeaderValue helper
  // that cycle-13 extracted for the user-agent path. Inline
  // `Array.isArray ? [0] : value` is the exact pattern the helper
  // generalizes — duplicating it here was the sibling-fix-miss the
  // architect-reviewer flagged in cycle 15.
  return normalizeUserInput(pickHeaderValue(req.headers['mcp-session-id']));
}

/**
 * Pull the client's self-reported name/version out of an `initialize` request
 * body (`params.clientInfo`) so it can label the runtime session in the console
 * Sessions/Logs views instead of a bare UUID. Values are trimmed and clamped to
 * 100 chars (the runtime-presence store rejects longer); empties are dropped.
 * Display sites escape the values, so untrusted content is rendered safely.
 */
function extractClientInfo(body: unknown): McpClientInfo | undefined {
  const params = (body as { params?: unknown } | undefined)?.params;
  const clientInfo = (params as { clientInfo?: unknown } | undefined)?.clientInfo;
  if (!clientInfo || typeof clientInfo !== 'object') return undefined;
  const clamp = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const normalized = normalizeUserInput(value)?.trim();
    return normalized ? normalized.slice(0, 100) : undefined;
  };
  const name = clamp((clientInfo as { name?: unknown }).name);
  const version = clamp((clientInfo as { version?: unknown }).version);
  return name || version ? { ...(name ? { name } : {}), ...(version ? { version } : {}) } : undefined;
}

export function getClientKey(req: Request): string {
  // Cycle-8 fix (H1): use Express's `req.ip` which resolves through
  // the configured `app.set('trust proxy', ...)` chain. The earlier
  // shape read `x-forwarded-for` directly and always trusted the
  // first hop — bypassing trust-proxy entirely. An attacker
  // connecting directly to a non-loopback bind could spoof their
  // identity by setting the header to defeat per-IP rate limiting.
  //
  // Behavior across deployment shapes:
  //   - Native HTTPS (no upstream proxy, DOLLHOUSE_TRUSTED_PROXIES
  //     unset or 'loopback'): `req.ip` is the TCP peer; the header
  //     is ignored. Correct.
  //   - Behind a TLS-terminating proxy with DOLLHOUSE_TRUSTED_PROXIES
  //     set to that proxy's CIDR: `req.ip` is resolved by walking
  //     the X-Forwarded-For chain trusting only configured hops.
  //     Correct.
  //   - Behind a proxy with trusted proxies UNSET on a non-loopback
  //     bind: blocked at startup by `assertHostedDeploymentSafety`.
  //
  // Cycle-11 fix (H11-2): normalize IPv4-mapped IPv6 (`::ffff:1.2.3.4`)
  // to the v4 form so dual-stack Node deployments don't double-bucket
  // the same client. Sibling of the cycle-10 H10-2 fix in MagicLink
  // — same exported helper, same bypass class. Without normalization,
  // an attacker on a dual-stack bind alternated `::ffff:1.2.3.4` and
  // `1.2.3.4` for 2× the per-IP rate-limit budget on the MCP transport.
  const raw = req.ip || req.socket.remoteAddress || 'unknown';
  const normalized = normalizeIp(raw);
  return normalizeUserInput(normalized) ?? 'unknown';
}

function getProcessMemorySnapshot(): Record<string, number> {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

export function getRequestedTransportName(): RuntimeTransportName {
  if (process.argv.includes('--streamable-http') || process.argv.includes('--http')) {
    return STREAMABLE_HTTP;
  }

  return env.DOLLHOUSE_TRANSPORT;
}

export function respondWithJsonRpcError(
  res: Response,
  statusCode: number,
  message: string,
  requestId: unknown = null,
): void {
  res.status(statusCode).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
    },
    id: requestId,
  });
}

export function getStreamableHttpRuntimeOptions(): StreamableHttpRuntimeOptions {
  const portFlag = getCliFlagValue('port');
  const parsedPort = portFlag ? Number.parseInt(portFlag, 10) : undefined;

  return {
    host: getCliFlagValue('host') ?? env.DOLLHOUSE_HTTP_HOST,
    port: Number.isFinite(parsedPort) ? parsedPort : env.DOLLHOUSE_HTTP_PORT,
    mcpPath: normalizeMcpPath(getCliFlagValue('mcp-path') ?? env.DOLLHOUSE_HTTP_MCP_PATH),
    allowedHosts: parseCommaSeparatedValues(getCliFlagValue('allowed-hosts')) ?? env.DOLLHOUSE_HTTP_ALLOWED_HOSTS,
    rateLimitWindowMs: env.DOLLHOUSE_HTTP_RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: env.DOLLHOUSE_HTTP_RATE_LIMIT_MAX_REQUESTS,
    sessionIdleTimeoutMs: env.DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS,
    sessionPoolSize: env.DOLLHOUSE_HTTP_SESSION_POOL_SIZE,
  };
}

function beginHttpServerClose(httpServer: HttpServer | HttpsServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Round 5 / H2 + H4: hosted multi-tenant safety guards.
 *
 *   H2: refuse to start when bind is non-loopback AND auth is
 *       disabled AND multi-user methods are configured. The previous
 *       shape silently shipped an unauthenticated MCP endpoint when
 *       the operator set up the embedded AS but forgot to flip
 *       DOLLHOUSE_AUTH_ENABLED=true.
 *
 *   H4: refuse to start when bind is non-loopback AND multi-user
 *       methods are configured AND DOLLHOUSE_TRUSTED_PROXIES is unset.
 *       Behind any reverse proxy (Cloudflare Tunnel, nginx, Cloud
 *       Run), `req.ip` collapses to the proxy's IP and per-IP rate
 *       limits become global — brute-force protection that doesn't
 *       protect.
 *
 * Both checks fire ONLY when multi-user methods are configured;
 * solo-localhost trivial-consent deployments are unaffected.
 *
 * Exported so tests can exercise the guard logic without standing up
 * an Express server.
 */
export function assertHostedDeploymentSafety(config: HostedDeploymentSafetyConfig): Promise<void> {
  try {
    runHostedDeploymentSafetyChecks(config);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

interface HostedDeploymentSafetyConfig {
  host: string;
  methods: readonly string[] | undefined;
  authEnabled: boolean;
  trustedProxies: readonly string[] | undefined;
  /**
   * Cycle-12 fix: whether the AS is serving TLS itself (cert/key
   * configured at the server) vs. relying on an upstream TLS-
   * terminating proxy. When `false` and the operator sets
   * `trustedProxies=['loopback']` only on a non-loopback bind, the
   * deployment shape is "behind a real proxy" but the trust-proxy
   * config doesn't trust the proxy — `req.ip` collapses to the
   * proxy's egress IP and per-IP rate limits become per-cluster.
   * Refusing this combination prevents the silent misconfig.
   */
  nativeTls?: boolean;
}

function runHostedDeploymentSafetyChecks(config: HostedDeploymentSafetyConfig): void {
  const multiUserMethods = new Set(['github', 'local-password', 'magic-link']);
  const configuredMethods = Array.isArray(config.methods) ? config.methods : [];
  const hasMultiUserMethod = configuredMethods.some((m) => multiUserMethods.has(m));
  if (!hasMultiUserMethod) return;
  if (isLoopbackHost(config.host)) return;

  if (!config.authEnabled) {
    throw new Error(
      `[StreamableHttpServer] Refusing to start: DOLLHOUSE_AUTH_METHODS configures ` +
      `a multi-user identity method (${configuredMethods.join(',')}) on a non-loopback ` +
      `bind '${config.host}', but DOLLHOUSE_AUTH_ENABLED is false. The MCP endpoint ` +
      `would accept unauthenticated traffic. Set DOLLHOUSE_AUTH_ENABLED=true (and ` +
      `ensure the bootstrap-admin CLI has been run) before exposing this deployment.`,
    );
  }
  if (!config.trustedProxies || config.trustedProxies.length === 0) {
    throw new Error(
      `[StreamableHttpServer] Refusing to start: DOLLHOUSE_AUTH_METHODS configures ` +
      `a multi-user identity method on a non-loopback bind '${config.host}', but ` +
      `DOLLHOUSE_TRUSTED_PROXIES is unset. Per-IP rate limits would collapse to ` +
      `the proxy's IP and brute-force protection would be ineffective.\n\n` +
      `For native HTTPS deployments (TLS certificate at this server, no upstream ` +
      `proxy): set DOLLHOUSE_TRUSTED_PROXIES=loopback. The 'loopback' keyword ` +
      `tells Express to trust only loopback addresses (which never appear in ` +
      `real client traffic), so X-Forwarded-* headers from external clients are ` +
      `correctly ignored and req.ip is the TCP peer.\n\n` +
      `For deployments behind a TLS-terminating reverse proxy (Cloudflare Tunnel, ` +
      `nginx, ALB, Cloud Run, etc.): set DOLLHOUSE_TRUSTED_PROXIES to the proxy's ` +
      `CIDR range, e.g. '10.0.0.0/8' or '127.0.0.1/32,fd00::/8'.`,
    );
  }

  // Cycle-12 fix: refuse the silent misconfiguration where an
  // operator behind an upstream proxy sets `loopback` only. With
  // native TLS at this server, `loopback` is correct (we serve TLS,
  // no proxy in front). Without native TLS on a non-loopback bind,
  // the only way TLS reaches the user is via an upstream proxy —
  // but then `loopback` means we don't trust that proxy, `req.ip`
  // collapses to its egress, and per-IP rate limits become per-
  // cluster. The cycle-12 reviewer flagged this as a deployment
  // footgun that bypasses the previous guards.
  const onlyLoopback =
    config.trustedProxies.length === 1 && config.trustedProxies[0] === 'loopback';
  if (onlyLoopback && config.nativeTls === false) {
    throw new Error(
      `[StreamableHttpServer] Refusing to start: DOLLHOUSE_TRUSTED_PROXIES='loopback' ` +
      `on a non-loopback bind '${config.host}' WITHOUT native TLS at this server ` +
      `(no DOLLHOUSE_TLS_CERT_PATH / DOLLHOUSE_TLS_KEY_PATH). This combination is ` +
      `inconsistent: either\n\n` +
      `  (a) you serve TLS at this server — set DOLLHOUSE_TLS_CERT_PATH and _KEY_PATH ` +
      `      so this configuration becomes correct (loopback-only is right for ` +
      `      native HTTPS), OR\n\n` +
      `  (b) you're behind a TLS-terminating reverse proxy — set DOLLHOUSE_TRUSTED_PROXIES ` +
      `      to the proxy's CIDR (e.g. 'fd00::/8' or '10.0.0.0/8') so req.ip resolves ` +
      `      to the real client and per-IP rate limits work.\n\n` +
      `Mixing 'loopback'-only with no-native-TLS leaves you with collapsed rate limits ` +
      `and an oidc-provider that thinks the request scheme is http://, breaking ` +
      `https:// redirect URI validation.`,
    );
  }

  // Checked last: once the network-exposure guards above pass, the deployment is
  // reachable correctly, so the only remaining concern is at-rest secret
  // protection. Encrypted GitHub tokens (github_token.enc in file mode) and the
  // OAuth device-flow handoff fall back to a machine-derived passphrase when
  // DOLLHOUSE_TOKEN_SECRET is unset. That passphrase has no per-install entropy
  // (derived from homedir + USER, with the PBKDF2 salt stored beside the
  // ciphertext), so anyone who reads the on-disk ciphertext could derive the key
  // and decrypt every user's tokens offline. Fail closed; an operator who has
  // accepted this at-rest risk can opt back in with
  // DOLLHOUSE_ALLOW_INSECURE_TOKEN_STORE=true.
  if (!process.env.DOLLHOUSE_TOKEN_SECRET?.trim()) {
    const insecureTokenStoreDetail =
      'DOLLHOUSE_TOKEN_SECRET is not set for this exposed multi-user deployment. ' +
      'Encrypted GitHub tokens and OAuth handoff files would use a machine-derived ' +
      'passphrase with no per-install entropy, so anyone who reads the on-disk ' +
      'ciphertext could decrypt every user\'s at-rest secrets offline. Set ' +
      'DOLLHOUSE_TOKEN_SECRET to a strong random value.';
    if (process.env.DOLLHOUSE_ALLOW_INSECURE_TOKEN_STORE?.trim().toLowerCase() === 'true') {
      logger.warn(
        `[StreamableHttpServer] ${insecureTokenStoreDetail} Continuing anyway because ` +
        'DOLLHOUSE_ALLOW_INSECURE_TOKEN_STORE=true.',
      );
    } else {
      throw new Error(
        `[StreamableHttpServer] Refusing to start: ${insecureTokenStoreDetail} To start ` +
        'anyway (not recommended), set DOLLHOUSE_ALLOW_INSECURE_TOKEN_STORE=true.',
      );
    }
  }
}

export async function createStreamableHttpRuntime(
  createSessionAttachment: (transport: StreamableHTTPServerTransport, authClaims?: AuthClaims, clientInfo?: McpClientInfo) => Promise<StreamableHttpSessionAttachment>,
  options: StreamableHttpRuntimeOptions = {},
): Promise<StreamableHttpRuntimeHandle> {
  const host = normalizeUserInput(options.host ?? env.DOLLHOUSE_HTTP_HOST) ?? env.DOLLHOUSE_HTTP_HOST;
  const port = options.port ?? env.DOLLHOUSE_HTTP_PORT;
  const mcpPath = normalizeMcpPath(options.mcpPath ?? env.DOLLHOUSE_HTTP_MCP_PATH);
  const allowedHosts = options.allowedHosts
    ?.map(value => normalizeUserInput(value))
    .filter((value): value is string => Boolean(value))
    ?? env.DOLLHOUSE_HTTP_ALLOWED_HOSTS;
  const rateLimitWindowMs = Math.max(0, options.rateLimitWindowMs ?? env.DOLLHOUSE_HTTP_RATE_LIMIT_WINDOW_MS);
  const rateLimitMaxRequests = Math.max(0, options.rateLimitMaxRequests ?? env.DOLLHOUSE_HTTP_RATE_LIMIT_MAX_REQUESTS);
  const sessionIdleTimeoutMs = Math.max(0, options.sessionIdleTimeoutMs ?? env.DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS);
  const bodyLimitBytes = options.bodyLimitBytes ?? env.DOLLHOUSE_HTTP_BODY_LIMIT_BYTES;
  const sessionPoolSize = Math.max(0, options.sessionPoolSize ?? env.DOLLHOUSE_HTTP_SESSION_POOL_SIZE);
  const shutdownGracePeriodMs = Math.max(0, options.shutdownGracePeriodMs ?? 30_000);
  const sessionDisposalTimeoutMs = Math.max(0, options.sessionDisposalTimeoutMs ?? 5_000);
  const runtimeCommandPollIntervalMs = Math.max(
    0,
    options.runtimeCommandPollIntervalMs ?? DEFAULT_RUNTIME_COMMAND_POLL_INTERVAL_MS,
  );
  const publicBaseUrl = env.DOLLHOUSE_PUBLIC_BASE_URL;
  if (publicBaseUrl) {
    assertSafePublicBaseUrl(publicBaseUrl);
  }
  let closingPromise: Promise<void> | null = null;
  let inFlightMcpRequests = 0;
  const requestDrainWaiters = new Set<() => void>();
  interface McpRequestTracking {
    handlerOwnsCompletion: boolean;
    release(): void;
  }
  const mcpRequestTracking = new WeakMap<Response, McpRequestTracking>();
  const trackMcpRequest: RequestHandler = (req, res, next) => {
    // Express is non-strict by default, so a route registered at `/mcp` also
    // accepts `/mcp/`. Match the same shape here or the trailing-slash form can
    // bypass shutdown rejection and request-drain accounting.
    if (normalizeExpressRoutePath(req.path) !== normalizeExpressRoutePath(mcpPath)) {
      next();
      return;
    }
    if (closingPromise) {
      respondWithJsonRpcError(res, 503, 'Server shutting down', getRequestId(req));
      return;
    }
    inFlightMcpRequests += 1;
    let released = false;
    const tracking: McpRequestTracking = {
      handlerOwnsCompletion: false,
      release: () => {
        if (released) return;
        released = true;
        inFlightMcpRequests = Math.max(0, inFlightMcpRequests - 1);
        if (inFlightMcpRequests === 0) {
          for (const waiter of [...requestDrainWaiters]) waiter();
        }
      },
    };
    mcpRequestTracking.set(res, tracking);
    const releaseBeforeHandler = () => {
      if (!tracking.handlerOwnsCompletion) tracking.release();
    };
    res.once('finish', releaseBeforeHandler);
    res.once('close', releaseBeforeHandler);
    next();
  };
  const claimMcpHandlerCompletion = (res: Response): (() => void) => {
    const tracking = mcpRequestTracking.get(res);
    if (!tracking) return () => {};
    tracking.handlerOwnsCompletion = true;
    return tracking.release;
  };
  const waitForApplicationRequest = async (
    attachment: StreamableHttpSessionAttachment,
    req: Request,
  ): Promise<void> => {
    const requestId = getRequestId(req);
    if (typeof requestId === 'string' || typeof requestId === 'number') {
      await attachment.waitForRequest?.(requestId);
    }
  };
  const app = createProtectedMcpExpressApp({
    host,
    allowedHosts,
    afterHostValidation: trackMcpRequest,
  });
  // Defense-in-depth: suppress Express's default `X-Powered-By` header on
  // every response. Doesn't change auth posture but avoids version-disclosing
  // fingerprinting via response headers.
  app.disable('x-powered-by');

  // Round 5 / H2 + H4: hosted multi-tenant safety guards.
  // See assertHostedDeploymentSafety for the full rationale; the
  // function is exported so unit tests can exercise the guard
  // without standing up an Express server.
  // Cycle-13 fix: instantiate TlsConfig FIRST so its `isEnabled()`
  // is the single source of truth for nativeTls. The earlier shape
  // re-read env vars at the safety-guard call site, which diverged
  // from a constructor-injected `options.tlsConfig` (e.g. a test
  // stub). Now both the safety guard and the later HTTPS bind read
  // from the same TlsConfig instance.
  const tlsConfig = options.tlsConfig ?? new TlsConfig();
  await assertHostedDeploymentSafety({
    host,
    methods: env.DOLLHOUSE_AUTH_METHODS,
    authEnabled: env.DOLLHOUSE_AUTH_ENABLED,
    trustedProxies: env.DOLLHOUSE_TRUSTED_PROXIES,
    nativeTls: tlsConfig.isEnabled(),
  });

  // Wire trust proxy from env. Default 'loopback' (Express built-in)
  // so plain solo deployments behind no proxy still see the right
  // req.ip. Hosted deployments override via DOLLHOUSE_TRUSTED_PROXIES.
  app.set('trust proxy', env.DOLLHOUSE_TRUSTED_PROXIES ?? ['loopback']);
  const sessions = new Map<string, ActiveSessionRecord>();
  const closingSessions = new Map<string, ActiveSessionRecord>();
  const pendingSessionDisposals = new Map<string, Promise<boolean>>();
  const sessionDisposalRetryTimers = new Map<string, NodeJS.Timeout>();
  const pendingDurableSessionClosures = new Set<string>();
  const rateLimits = new Map<string, RateLimitRecord>();
  const pooledSessions: PreparedSessionRecord[] = [];
  const sessionTelemetry: SessionTelemetry = {
    created: 0,
    disposed: 0,
    expired: 0,
    poolHits: 0,
    poolMisses: 0,
    rateLimitedRequests: 0,
  };
  const isShuttingDown = (): boolean => Boolean(closingPromise);
  let replenishPoolPromise: Promise<void> | null = null;
  let runtimeCommandPollTimer: NodeJS.Timeout | null = null;
  let runtimeCommandPollRunning = false;
  const sessionDisposalRetryDelayMs = Math.max(
    10,
    Math.min(runtimeCommandPollIntervalMs || DEFAULT_RUNTIME_COMMAND_POLL_INTERVAL_MS, 5_000),
  );

  const clearSessionTimer = (session: ActiveSessionRecord): void => {
    if (session.expirationTimer) {
      clearTimeout(session.expirationTimer);
      session.expirationTimer = null;
    }
  };

  const markDurableSessionDisposed = async (sessionId: string): Promise<boolean> => {
    if (!options.runtimeSessionControl) return true;
    try {
      await options.runtimeSessionControl.markSessionDisposed(sessionId);
      pendingDurableSessionClosures.delete(sessionId);
      closingSessions.delete(sessionId);
      return true;
    } catch (error) {
      pendingDurableSessionClosures.add(sessionId);
      logger.warn('[StreamableHTTP] Failed to mark runtime session disposed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const disposePreparedSession = async (preparedSession: PreparedSessionRecord): Promise<void> => {
    if (preparedSession.runtimePresenceSessionId) {
      await options.runtimeSessionControl?.markSessionDisposed(preparedSession.runtimePresenceSessionId).catch((error) => {
        logger.warn('[StreamableHTTP] Failed to mark prepared runtime session disposed', {
          sessionId: preparedSession.runtimePresenceSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const disposal = preparedSession.dispose().then(() => true).catch((error) => {
      logger.warn('[StreamableHTTP] Failed to dispose pooled session', {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    });
    if (!await settlesWithin(disposal, sessionDisposalTimeoutMs)) {
      logger.warn('[StreamableHTTP] Timed out disposing pooled session', { sessionDisposalTimeoutMs });
    }
  };

  const disposeSession = async (
    sessionId: string | undefined,
    skipTransportClose = false,
  ): Promise<boolean> => {
    if (!sessionId) {
      return true;
    }

    const pendingDisposal = pendingSessionDisposals.get(sessionId);
    if (pendingDisposal) {
      return (await booleanResultWithin(pendingDisposal, sessionDisposalTimeoutMs)) ?? false;
    }

    const session = sessions.get(sessionId) ?? closingSessions.get(sessionId);
    if (!session) {
      return pendingDurableSessionClosures.has(sessionId)
        ? markDurableSessionDisposed(sessionId)
        : true;
    }

    // Publish the in-progress promise before closing the transport. The SDK may
    // synchronously invoke onsessionclosed from transport.close(); that callback
    // must join this disposal instead of recursively starting another one.
    const disposal = Promise.resolve().then(async () => {
      if (sessions.delete(sessionId)) {
        closingSessions.set(sessionId, session);
        sessionTelemetry.disposed += 1;
        clearSessionTimer(session);
        options.onSessionDisposed?.(sessionId);
      }
      if (!skipTransportClose) {
        await session.transport.close().catch(() => {
          /* transport shutdown is best-effort */
        });
      }
      let disposed = false;
      try {
        await session.attachment.dispose();
        disposed = true;
      } catch (error) {
        logger.warn('[StreamableHTTP] Failed to dispose session attachment', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // A closing runtime presence is immediately reclaimable. Publish that
      // state only after the attachment has drained all in-flight requests.
      if (!disposed) return false;
      const durableClosed = await markDurableSessionDisposed(sessionId);
      if (durableClosed) {
        closingSessions.delete(sessionId);
        const retryTimer = sessionDisposalRetryTimers.get(sessionId);
        if (retryTimer) clearTimeout(retryTimer);
        sessionDisposalRetryTimers.delete(sessionId);
      }
      return durableClosed;
    });
    pendingSessionDisposals.set(sessionId, disposal);
    void disposal.then(disposed => {
      if (!disposed) scheduleSessionDisposalRetry(sessionId);
    });
    void disposal.finally(() => {
      if (pendingSessionDisposals.get(sessionId) === disposal) {
        pendingSessionDisposals.delete(sessionId);
      }
    });
    const disposed = await booleanResultWithin(disposal, sessionDisposalTimeoutMs);
    if (disposed === null) {
      logger.warn('[StreamableHTTP] Timed out disposing session attachment', {
        sessionId,
        sessionDisposalTimeoutMs,
      });
    }
    return disposed ?? false;
  };

  function scheduleSessionDisposalRetry(sessionId: string): void {
    if (closingPromise || sessionDisposalRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      sessionDisposalRetryTimers.delete(sessionId);
      if (!closingSessions.has(sessionId)) return;
      void disposeSession(sessionId).then(disposed => {
        if (!disposed) scheduleSessionDisposalRetry(sessionId);
      });
    }, sessionDisposalRetryDelayMs);
    timer.unref();
    sessionDisposalRetryTimers.set(sessionId, timer);
  }

  const recordRuntimeActivity = (sessionId: string, outcome: 'ok' | 'error' = 'ok'): void => {
    void options.runtimeSessionControl?.recordActivity(sessionId, outcome).catch((error) => {
      logger.warn('[StreamableHTTP] Failed to heartbeat runtime session', {
        sessionId,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const pollRuntimeCommands = async (): Promise<void> => {
    if (!options.runtimeSessionControl || runtimeCommandPollRunning || closingPromise) return;
    runtimeCommandPollRunning = true;
    try {
      for (const sessionId of [...pendingDurableSessionClosures]) {
        await markDurableSessionDisposed(sessionId);
      }
      await options.runtimeSessionControl.reconcilePendingCommands({
        terminateLocalSession: async (sessionId) => {
          if (!sessions.has(sessionId)
              && !closingSessions.has(sessionId)
              && !pendingSessionDisposals.has(sessionId)
              && !pendingDurableSessionClosures.has(sessionId)) {
            return 'already_absent';
          }
          if (!await disposeSession(sessionId)) return 'retry';
          return 'terminated';
        },
      });
    } catch (error) {
      logger.warn('[StreamableHTTP] Runtime command reconciliation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      runtimeCommandPollRunning = false;
    }
  };

  const startRuntimeCommandPolling = (): void => {
    if (!options.runtimeSessionControl || runtimeCommandPollIntervalMs <= 0 || runtimeCommandPollTimer) return;
    runtimeCommandPollTimer = setInterval(() => {
      void pollRuntimeCommands();
    }, runtimeCommandPollIntervalMs);
    runtimeCommandPollTimer.unref();
    void pollRuntimeCommands();
  };

  const touchSession = (sessionId: string): void => {
    if (sessionIdleTimeoutMs <= 0) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    clearSessionTimer(session);
    session.lastTouchedAt = Date.now();
    if (session.inFlightRequests > 0) return;
    session.expirationTimer = setTimeout(() => {
      logger.info('[StreamableHTTP] Expiring idle session', {
        sessionId,
        idleTimeoutMs: sessionIdleTimeoutMs,
      });
      sessionTelemetry.expired += 1;
      void disposeSession(sessionId);
    }, sessionIdleTimeoutMs);
    session.expirationTimer.unref();
  };

  const beginSessionRequest = (sessionId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    clearSessionTimer(session);
    session.lastTouchedAt = Date.now();
    session.inFlightRequests += 1;
    return true;
  };

  const endSessionRequest = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.inFlightRequests = Math.max(0, session.inFlightRequests - 1);
    if (session.inFlightRequests === 0) touchSession(sessionId);
  };

  const consumeRateLimit = (req: Request, res: Response): boolean => {
    if (rateLimitMaxRequests <= 0 || rateLimitWindowMs <= 0) {
      return true;
    }

    const now = Date.now();

    // Evict expired rate limit entries to bound Map growth from unique client IPs.
    // Only runs when the Map exceeds 1000 entries to avoid per-request overhead.
    if (rateLimits.size > 1000) {
      for (const [key, record] of rateLimits) {
        if (record.windowEndsAt <= now) rateLimits.delete(key);
      }
    }

    const clientKey = getClientKey(req);
    const current = rateLimits.get(clientKey);

    if (!current || current.windowEndsAt <= now) {
      rateLimits.set(clientKey, {
        requestCount: 1,
        windowEndsAt: now + rateLimitWindowMs,
      });
      return true;
    }

    if (current.requestCount >= rateLimitMaxRequests) {
      sessionTelemetry.rateLimitedRequests += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((current.windowEndsAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      respondWithJsonRpcError(res, 429, 'Rate limit exceeded', getRequestId(req));
      return false;
    }

    current.requestCount += 1;
    return true;
  };

  const handleRequestFailure = (
    req: Request,
    res: Response,
    methodName: 'POST' | 'GET' | 'DELETE',
    error: unknown,
    sessionId?: string,
  ): void => {
    logger.error(`[StreamableHTTP] Failed to handle MCP ${methodName} request`, {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    if (!res.headersSent) {
      respondWithJsonRpcError(res, 500, 'Internal server error', getRequestId(req));
    }
  };

  const maintainSessionPool = async (): Promise<void> => {
    if (sessionPoolSize <= 0 || closingPromise || replenishPoolPromise) {
      return;
    }

    replenishPoolPromise = (async () => {
      while (!isShuttingDown() && pooledSessions.length < sessionPoolSize) {
        try {
          pooledSessions.push(await prepareSession());
        } catch (error) {
          logger.warn('[StreamableHTTP] Failed to replenish session pool', {
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
    })().finally(() => {
      replenishPoolPromise = null;
    });

    await replenishPoolPromise;
  };

  const prepareSession = async (authClaims?: AuthClaims, clientInfo?: McpClientInfo): Promise<PreparedSessionRecord> => {
    let attachment: StreamableHttpSessionAttachment | null = null;

    const transport = new StreamableHTTPServerTransport({
      // Adopt the dollhouse context id as the transport session id so the
      // mcp-session-id (the presence id + the header clients echo back on
      // every request) is the SAME value that tags this session's logs.
      // `attachment` is assigned before any request reaches handleRequest
      // (where the SDK invokes this generator), so contextSessionId is always
      // present here; the randomUUID() fallback only covers loosely-typed test
      // attachments that omit it.
      sessionIdGenerator: () => attachment?.contextSessionId ?? randomUUID(),
      onsessioninitialized: (sessionId) => {
        if (!attachment) {
          throw new Error('Session attachment was not ready when the transport initialized');
        }

        sessions.set(sessionId, {
          attachment,
          transport,
          expirationTimer: null,
          lastTouchedAt: Date.now(),
          // The initialize request that caused this callback is still active.
          inFlightRequests: 1,
          ownerSub: authClaims?.sub,
          ownerUserId: authClaims?.userId,
          ownerAuthzVersion: authClaims?.authzVersion,
        });
        sessionTelemetry.created += 1;
        touchSession(sessionId);
        logger.info('[StreamableHTTP] Session initialized', { sessionId });
        options.onSessionCreated?.(sessionId);
        // Fire-and-forget: replenishPoolPromise guard inside maintainSessionPool()
        // prevents concurrent replenishment — safe to call without awaiting.
        void maintainSessionPool();
      },
    });

    transport.onerror = (error) => {
      logger.warn('[StreamableHTTP] Transport error', {
        sessionId: transport.sessionId,
        error: error.message,
      });
    };

    transport.onclose = () => {
      if (transport.sessionId) {
        void disposeSession(transport.sessionId, true);
      }
    };

    attachment = await createSessionAttachment(transport, authClaims, clientInfo);
    const runtimeSession = attachment.runtimeSession;
    if (runtimeSession && options.runtimeSessionControl) {
      try {
        await options.runtimeSessionControl.registerSession({
          sessionId: attachment.contextSessionId,
          userId: runtimeSession.userId,
          accountCorrelationId: runtimeSession.accountCorrelationId,
          clientInfo: runtimeSession.clientInfo ?? null,
        });
      } catch (error) {
        await transport.close().catch(() => {
          /* failed setup cleanup is best-effort */
        });
        await attachment.dispose().catch(() => {
          /* failed setup cleanup is best-effort */
        });
        throw error;
      }
    }

    return {
      attachment,
      transport,
      ownerSub: authClaims?.sub,
      ownerUserId: authClaims?.userId,
      ownerAuthzVersion: authClaims?.authzVersion,
      runtimePresenceSessionId: runtimeSession && options.runtimeSessionControl
        ? attachment.contextSessionId
        : undefined,
      dispose: async () => {
        await transport.close().catch(() => {
          /* pooled transport shutdown is best-effort */
        });
        await attachment.dispose();
      },
    };
  };

  const getOrCreatePreparedSession = async (authClaims?: AuthClaims, clientInfo?: McpClientInfo): Promise<PreparedSessionRecord> => {
    // Pooled sessions don't carry auth claims — they were pre-created without
    // knowing who would connect. When auth is enabled, always create fresh.
    // (Pooled sessions are only used on the no-auth path, which never registers
    // runtime presence, so dropping clientInfo there is harmless.)
    if (!authClaims) {
      const pooledSession = pooledSessions.pop();
      if (pooledSession) {
        sessionTelemetry.poolHits += 1;
        void maintainSessionPool();
        return pooledSession;
      }
    }

    sessionTelemetry.poolMisses += 1;
    return prepareSession(authClaims, clientInfo);
  };

  const waitForMcpRequestDrain = async (): Promise<boolean> => {
    if (inFlightMcpRequests === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        requestDrainWaiters.delete(onDrained);
        resolve(drained);
      };
      const onDrained = () => finish(true);
      timer = setTimeout(() => finish(false), shutdownGracePeriodMs);
      requestDrainWaiters.add(onDrained);
    });
  };

  app.get('/', (_req, res) => {
    res.json({
      name: 'dollhousemcp',
      version: PACKAGE_VERSION,
      transport: STREAMABLE_HTTP,
      mcpPath,
      connectorUrl: publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}${mcpPath}` : mcpPath,
      health: '/healthz',
      readiness: '/readyz',
      sessionPoolSize,
      sessionTelemetry,
    });
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      ok: true,
      transport: STREAMABLE_HTTP,
      version: PACKAGE_VERSION,
      sessions: {
        active: sessions.size,
        pooled: pooledSessions.length,
        ...sessionTelemetry,
      },
      auth: options.performanceMonitor?.getAuthOpStats() ?? {},
      memory: getProcessMemorySnapshot(),
    });
  });

  app.get('/readyz', (_req, res, next) => {
    void (async () => {
      try {
        // Round 5 / H3: when the embedded AS is in multi-user mode and
        // bootstrap is incomplete, /authorize returns 503 from the
        // bootstrap gate. Without consulting bootstrap state in
        // /readyz, Kubernetes routes traffic to the pod and operators
        // see a flood of 503s with no probe signal that something
        // requires action. Fail-closed shape: bootstrap-incomplete →
        // 503 with reason='bootstrap_required'.
        if (options.oauthProvider?.isReadyForTraffic) {
          const ready = await options.oauthProvider.isReadyForTraffic();
          if (!ready) {
            res.status(503).json({
              ready: false,
              reason: options.oauthProvider.getReadinessFailureReason?.() ?? 'bootstrap_required',
              transport: STREAMABLE_HTTP,
            });
            return;
          }
        }
        res.status(200).json({
          ready: true,
          transport: STREAMABLE_HTTP,
          activeSessions: sessions.size,
          pooledSessions: pooledSessions.length,
          sessionTelemetry,
          memory: getProcessMemorySnapshot(),
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  app.get('/version', (_req, res) => {
    res.status(200).json({
      name: 'dollhousemcp',
      version: PACKAGE_VERSION,
    });
  });

  if (options.webConsoleApiV1) {
    // Serve the console UI (static) at /ui. Public; the page self-gates on
    // GET /api/v1/auth/me. Assets are copied to dist/web-console/ui by postbuild.
    const consoleUiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../web-console/ui');
    app.use('/ui', expressStatic(consoleUiDir, { index: 'index.html' }));
    logger.info('[StreamableHTTP] Console UI mounted', { basePath: '/ui' });
    app.use(options.webConsoleApiV1.router);
    options.webConsoleApiV1.markMounted();
    logger.info('[StreamableHTTP] Descriptor web-console API mounted', { basePath: '/api/v1' });
  }

  // Mount auth middleware on MCP path so /mcp requests are validated
  // (and 401 on missing/invalid token) before they reach the MCP handler.
  // The embedded OAuth provider's router is mounted LATER, after the /mcp
  // handlers, because oidc-provider's catch-all responds 404 to anything it
  // doesn't recognize — placing it last lets specific routes match first.
  if (options.authMiddleware) {
    app.use(mcpPath, options.authMiddleware);
    logger.info('[StreamableHTTP] Auth middleware mounted on MCP path', { mcpPath });
  }
  app.use(mcpPath, (req, res, next) => {
    if (consumeRateLimit(req, res)) next();
  });
  app.use(mcpPath, json({ limit: bodyLimitBytes }));
  app.use(createJsonBodyErrorHandler());

  app.post(mcpPath, async (req, res) => {
    const completeRequest = claimMcpHandlerCompletion(res);
    try {
      const sessionId = getMcpSessionId(req);

      try {
        if (sessionId) {
          const existingSession = sessions.get(sessionId);
          if (!existingSession) {
            respondWithJsonRpcError(res, 404, 'Unknown MCP session', getRequestId(req));
            return;
          }

          if (!assertSessionOwner(req, res, sessionId, existingSession)) return;

          beginSessionRequest(sessionId);
          try {
            await existingSession.transport.handleRequest(req, res, req.body);
            recordRuntimeActivity(sessionId);
          } finally {
            await waitForApplicationRequest(existingSession.attachment, req);
            endSessionRequest(sessionId);
          }
          return;
        }

        if (!isInitializeRequest(req.body)) {
          respondWithJsonRpcError(res, 400, 'Initialization request required before session use', getRequestId(req));
          return;
        }

        const preparedSession = await getOrCreatePreparedSession(res.locals.authClaims, extractClientInfo(req.body));

        try {
          await preparedSession.transport.handleRequest(req, res, req.body);
        } catch (error) {
          const initializedSessionId = preparedSession.transport.sessionId;

          if (initializedSessionId) {
            await disposeSession(initializedSessionId);
          } else {
            await disposePreparedSession(preparedSession);
          }

          throw error;
        } finally {
          await waitForApplicationRequest(preparedSession.attachment, req);
          const initializedSessionId = preparedSession.transport.sessionId;
          if (initializedSessionId) endSessionRequest(initializedSessionId);
        }
      } catch (error) {
        if (sessionId) recordRuntimeActivity(sessionId, 'error');
        handleRequestFailure(req, res, 'POST', error, sessionId);
      }
    } finally {
      completeRequest();
    }
  });

  /**
   * H7 ownership gate. Used by both the POST dispatch path and the
   * GET/DELETE lifecycle path so the same check applies to all three
   * verbs. An earlier shape only guarded POST — a valid bearer + a
   * leaked session id could still SSE-attach (GET) or terminate
   * (DELETE) someone else's session through the lifecycle helper.
   *
   * Returns true when the request is allowed to proceed; on false it
   * has already written the 403 response. `ownerSub: undefined`
   * (auth-disabled or pooled-unclaimed sessions) bypasses the check
   * to preserve existing no-auth behavior.
   */
  const assertSessionOwner = (
    req: Request,
    res: Response,
    sessionId: string,
    session: ActiveSessionRecord,
  ): boolean => {
    if (session.ownerSub === undefined) return true;
    const caller = res.locals.authClaims;
    const sameSubject = caller?.sub === session.ownerSub;
    const sameCanonicalUser = session.ownerUserId === undefined || caller?.userId === session.ownerUserId;
    const sameAuthorizationGeneration = session.ownerAuthzVersion === undefined
      || caller?.authzVersion === session.ownerAuthzVersion;
    if (sameSubject && sameCanonicalUser && sameAuthorizationGeneration) return true;
    logger.warn('[StreamableHTTP] Session ownership mismatch — rejecting dispatch', {
      sessionId,
      method: req.method,
      ownerSub: session.ownerSub,
      callerSub: caller?.sub ?? '(none)',
      ownerUserId: session.ownerUserId,
      callerUserId: caller?.userId,
      ownerAuthzVersion: session.ownerAuthzVersion,
      callerAuthzVersion: caller?.authzVersion,
    });
    respondWithJsonRpcError(res, 403, 'Session does not belong to the authenticated user', getRequestId(req));
    return false;
  };

  const handleSessionLifecycleRequest = async (
    req: Request,
    res: Response,
    methodName: 'GET' | 'DELETE',
  ): Promise<void> => {
    const sessionId = getMcpSessionId(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (!sessionId) {
      // GET without session ID is the SDK's SSE stream probe.
      // Return 405 so the client silently falls back to POST-only mode.
      // Other status codes (including 400) trigger onerror in the SDK client.
      if (methodName === 'GET') {
        res.status(405).end();
      } else {
        respondWithJsonRpcError(res, 400, 'A valid mcp-session-id header is required.');
      }
      return;
    }

    if (!session) {
      respondWithJsonRpcError(res, 404, 'Unknown MCP session');
      return;
    }

    // H7: lifecycle (GET/DELETE) must enforce the same ownership gate
    // as POST. A valid bearer + leaked session id could otherwise SSE-
    // attach to someone else's session (GET) or terminate it (DELETE).
    if (!assertSessionOwner(req, res, sessionId, session)) {
      return;
    }

    try {
      beginSessionRequest(sessionId);
      try {
        await session.transport.handleRequest(req, res);
        recordRuntimeActivity(sessionId);
      } finally {
        await waitForApplicationRequest(session.attachment, req);
        endSessionRequest(sessionId);
      }
    } catch (error) {
      recordRuntimeActivity(sessionId, 'error');
      handleRequestFailure(req, res, methodName, error, sessionId);
    }
  };

  const executeTrackedLifecycleRequest = async (
    req: Request,
    res: Response,
    methodName: 'GET' | 'DELETE',
  ): Promise<void> => {
    const completeRequest = claimMcpHandlerCompletion(res);
    try {
      await handleSessionLifecycleRequest(req, res, methodName);
    } finally {
      completeRequest();
    }
  };
  app.get(mcpPath, async (req, res) => executeTrackedLifecycleRequest(req, res, 'GET'));
  app.delete(mcpPath, async (req, res) => executeTrackedLifecycleRequest(req, res, 'DELETE'));

  // OAuth provider router is mounted LAST so its catch-all (oidc-provider's
  // request handler) only sees URLs that none of the specific routes above
  // matched. The well-known + interaction routes inside the provider's router
  // are still matched first within its own scope.
  if (options.oauthProvider) {
    if (publicBaseUrl) {
      options.oauthProvider.setPublicBaseUrl?.(publicBaseUrl);
    }
    app.use(options.oauthProvider.createRouter());
    logger.info('[StreamableHTTP] Embedded OAuth routes mounted', {
      publicBaseUrl: publicBaseUrl ?? `http://${host}:${port}`,
    });
  }

  // tlsConfig already instantiated above (cycle-13: single source of
  // truth for both safety guard and HTTPS bind).
  const { server: httpServer, isHttps } = await createHttpOrHttpsServer(app, {
    host,
    port,
    tlsConfig,
  });

  const address = httpServer.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  const scheme = isHttps ? 'https' : 'http';
  const url = `${scheme}://${host}:${resolvedPort}${mcpPath}`;

  logger.info('[StreamableHTTP] Hosted MCP server listening', {
    host,
    port: resolvedPort,
    mcpPath,
    scheme,
    allowedHosts,
    sessionIdleTimeoutMs,
    sessionPoolSize,
    rateLimitWindowMs,
    rateLimitMaxRequests,
  });

  await maintainSessionPool();
  startRuntimeCommandPolling();

  const shutdown = async (): Promise<void> => {
    if (closingPromise) {
      return closingPromise;
    }

    closingPromise = (async () => {
      const serverClosePromise = beginHttpServerClose(httpServer);
      httpServer.closeIdleConnections();
      if (runtimeCommandPollTimer) {
        clearInterval(runtimeCommandPollTimer);
        runtimeCommandPollTimer = null;
      }
      for (const timer of sessionDisposalRetryTimers.values()) clearTimeout(timer);
      sessionDisposalRetryTimers.clear();

      // Wait for any in-flight pool replenishment to finish.
      // closingPromise is set before this await, so maintainSessionPool()'s
      // while-loop guard (!closingPromise) will stop the loop from continuing
      // to prepareSession() after the current iteration completes.
      if (replenishPoolPromise) {
        await replenishPoolPromise.catch(() => {});
      }

      const drained = await waitForMcpRequestDrain();
      if (!drained) {
        logger.warn('[StreamableHTTP] Shutdown grace period expired; closing active connections', {
          inFlightMcpRequests,
          shutdownGracePeriodMs,
        });
      }

      // `server.close()` waits for active non-MCP responses too. Console SSE
      // streams may otherwise retain the process for their full lifetime. At
      // this point accepted MCP handlers completed or exhausted their explicit
      // grace period, so terminate every remaining socket before disposal.
      httpServer.closeAllConnections();

      const warmSessions = pooledSessions.splice(0);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const allSessions = [...new Set([...sessions.keys(), ...closingSessions.keys()])];
        if (allSessions.length === 0) break;
        await Promise.all(allSessions.map(sessionId => disposeSession(sessionId)));
      }
      if (closingSessions.size > 0) {
        logger.warn('[StreamableHTTP] Session attachments remained after shutdown retries', {
          sessionIds: [...closingSessions.keys()],
        });
      }
      await Promise.all(warmSessions.map(preparedSession => disposePreparedSession(preparedSession)));

      httpServer.closeIdleConnections();
      await serverClosePromise;
      await options.onShutdown?.();
    })();

    return closingPromise;
  };

  let removeSignalHandlers = () => {};
  if (options.registerSignalHandlers) {
    const handleSignal = (signal: NodeJS.Signals) => {
      logger.info(`[StreamableHTTP] Received ${signal}, shutting down...`);
      void shutdown()
        .then(() => process.exit(0))
        .catch((error) => {
          console.error('[DollhouseMCP] Streamable HTTP shutdown failed:', error);
          process.exit(1);
        });
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
    process.on('SIGHUP', handleSignal);

    removeSignalHandlers = () => {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
      process.off('SIGHUP', handleSignal);
    };
  }

  return {
    app,
    host,
    port: resolvedPort,
    mcpPath,
    url,
    httpServer,
    isHttps,
    activeSessionCount: () => sessions.size,
    pooledSessionCount: () => pooledSessions.length,
    close: async () => {
      removeSignalHandlers();
      await shutdown();
    },
  };
}

function normalizeExpressRoutePath(routePath: string): string {
  if (routePath === '/') return routePath;
  return routePath.replace(/\/+$/u, '');
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function booleanResultWithin(promise: Promise<boolean>, timeoutMs: number): Promise<boolean | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createProtectedMcpExpressApp(input: {
  readonly host: string;
  readonly allowedHosts: readonly string[] | undefined;
  readonly afterHostValidation?: RequestHandler;
}): Express {
  const app = express();
  if (input.allowedHosts) {
    app.use(hostHeaderValidation([...input.allowedHosts]));
  } else if (isLoopbackHost(input.host)) {
    app.use(localhostHostValidation());
  } else if (input.host === '0.0.0.0' || input.host === '::') {
    logger.warn('[StreamableHTTP] Binding to all interfaces without an explicit Host allowlist');
  }
  if (input.afterHostValidation) app.use(input.afterHostValidation);
  return app;
}

function createJsonBodyErrorHandler(): ErrorRequestHandler {
  return (error: unknown, req, res, next): void => {
    if (isEntityTooLargeError(error)) {
      respondWithJsonRpcError(res, 413, 'MCP request body exceeds the configured limit', getRequestId(req));
      return;
    }
    next(error);
  };
}

function isEntityTooLargeError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large');
}
