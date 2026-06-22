import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { json, static as expressStatic } from 'express';
import type { Express, Request, RequestHandler, Response, Router } from 'express';
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
  sessionIdleTimeoutMs?: number;
  sessionPoolSize?: number;
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
    terminateLocalSession(sessionId: string): Promise<'terminated' | 'already_absent'>;
  }): Promise<number>;
}

interface ActiveSessionRecord {
  attachment: StreamableHttpSessionAttachment;
  transport: StreamableHTTPServerTransport;
  expirationTimer: NodeJS.Timeout | null;
  lastTouchedAt: number;
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
}

interface PreparedSessionRecord {
  attachment: StreamableHttpSessionAttachment;
  transport: StreamableHTTPServerTransport;
  /** See ActiveSessionRecord.ownerSub. */
  ownerSub: string | undefined;
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

async function closeHttpServer(httpServer: HttpServer | HttpsServer): Promise<void> {
  // Destroy all active sockets so keep-alive connections don't prevent shutdown.
  // httpServer.close() only stops accepting new connections — existing sockets
  // stay alive until their keep-alive timeout expires.
  httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
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
  const sessionPoolSize = Math.max(0, options.sessionPoolSize ?? env.DOLLHOUSE_HTTP_SESSION_POOL_SIZE);
  const runtimeCommandPollIntervalMs = Math.max(
    0,
    options.runtimeCommandPollIntervalMs ?? DEFAULT_RUNTIME_COMMAND_POLL_INTERVAL_MS,
  );
  const publicBaseUrl = env.DOLLHOUSE_PUBLIC_BASE_URL;
  if (publicBaseUrl) {
    assertSafePublicBaseUrl(publicBaseUrl);
  }
  const app = createMcpExpressApp({ host, allowedHosts });
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
  let closingPromise: Promise<void> | null = null;
  const isShuttingDown = (): boolean => Boolean(closingPromise);
  let replenishPoolPromise: Promise<void> | null = null;
  let runtimeCommandPollTimer: NodeJS.Timeout | null = null;
  let runtimeCommandPollRunning = false;

  const clearSessionTimer = (session: ActiveSessionRecord): void => {
    if (session.expirationTimer) {
      clearTimeout(session.expirationTimer);
      session.expirationTimer = null;
    }
  };

  const disposePreparedSession = async (preparedSession: PreparedSessionRecord): Promise<void> => {
    await preparedSession.dispose().catch((error) => {
      logger.warn('[StreamableHTTP] Failed to dispose pooled session', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const disposeSession = async (
    sessionId: string | undefined,
    skipTransportClose = false,
  ): Promise<void> => {
    if (!sessionId) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    sessions.delete(sessionId);
    sessionTelemetry.disposed += 1;
    clearSessionTimer(session);
    options.onSessionDisposed?.(sessionId);
    try {
      await options.runtimeSessionControl?.markSessionDisposed(sessionId);
    } catch (error) {
      logger.warn('[StreamableHTTP] Failed to mark runtime session disposed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!skipTransportClose) {
      await session.transport.close().catch(() => {
        /* transport shutdown is best-effort */
      });
    }

    try {
      await session.attachment.dispose();
    } catch (error) {
      logger.warn('[StreamableHTTP] Failed to dispose session attachment', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

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
      await options.runtimeSessionControl.reconcilePendingCommands({
        terminateLocalSession: async (sessionId) => {
          if (!sessions.has(sessionId)) return 'already_absent';
          await disposeSession(sessionId);
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
          ownerSub: authClaims?.sub,
        });
        sessionTelemetry.created += 1;
        touchSession(sessionId);
        logger.info('[StreamableHTTP] Session initialized', { sessionId });
        options.onSessionCreated?.(sessionId);
        const runtimeSession = attachment.runtimeSession;
        if (runtimeSession && options.runtimeSessionControl) {
          void options.runtimeSessionControl.registerSession({
            sessionId,
            userId: runtimeSession.userId,
            accountCorrelationId: runtimeSession.accountCorrelationId,
            clientInfo: runtimeSession.clientInfo ?? null,
          }).catch((error) => {
            logger.warn('[StreamableHTTP] Failed to register runtime session presence', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
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

    return {
      attachment,
      transport,
      ownerSub: authClaims?.sub,
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
              reason: 'bootstrap_required',
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
    const parseConsoleJson = json();
    app.use((req, res, next) => {
      if (req.path === '/api/v1' || req.path.startsWith('/api/v1/')) {
        parseConsoleJson(req, res, next);
        return;
      }
      next();
    });
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

  app.post(mcpPath, async (req, res) => {
    if (closingPromise) {
      respondWithJsonRpcError(res, 503, 'Server shutting down', getRequestId(req));
      return;
    }

    if (!consumeRateLimit(req, res)) {
      return;
    }

    const sessionId = getMcpSessionId(req);

    try {
      if (sessionId) {
        const existingSession = sessions.get(sessionId);
        if (!existingSession) {
          respondWithJsonRpcError(res, 404, 'Unknown MCP session', getRequestId(req));
          return;
        }

        if (!assertSessionOwner(req, res, sessionId, existingSession)) return;

        touchSession(sessionId);
        await existingSession.transport.handleRequest(req, res, req.body);
        recordRuntimeActivity(sessionId);
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
      }
    } catch (error) {
      if (sessionId) recordRuntimeActivity(sessionId, 'error');
      handleRequestFailure(req, res, 'POST', error, sessionId);
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
    const callerSub = (res.locals.authClaims as { sub?: string } | undefined)?.sub;
    if (callerSub === session.ownerSub) return true;
    logger.warn('[StreamableHTTP] Session ownership mismatch — rejecting dispatch', {
      sessionId,
      method: req.method,
      ownerSub: session.ownerSub,
      callerSub: callerSub ?? '(none)',
    });
    respondWithJsonRpcError(res, 403, 'Session does not belong to the authenticated user', getRequestId(req));
    return false;
  };

  const handleSessionLifecycleRequest = async (
    req: Request,
    res: Response,
    methodName: 'GET' | 'DELETE',
  ): Promise<void> => {
    if (closingPromise) {
      respondWithJsonRpcError(res, 503, 'Server shutting down');
      return;
    }

    if (!consumeRateLimit(req, res)) {
      return;
    }

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
      touchSession(sessionId);
      await session.transport.handleRequest(req, res);
      recordRuntimeActivity(sessionId);
    } catch (error) {
      recordRuntimeActivity(sessionId, 'error');
      handleRequestFailure(req, res, methodName, error, sessionId);
    }
  };

  app.get(mcpPath, async (req, res) => handleSessionLifecycleRequest(req, res, 'GET'));
  app.delete(mcpPath, async (req, res) => handleSessionLifecycleRequest(req, res, 'DELETE'));

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
      // Wait for any in-flight pool replenishment to finish.
      // closingPromise is set before this await, so maintainSessionPool()'s
      // while-loop guard (!closingPromise) will stop the loop from continuing
      // to prepareSession() after the current iteration completes.
      if (replenishPoolPromise) {
        await replenishPoolPromise.catch(() => {});
      }

      const allSessions = Array.from(sessions.keys());
      const warmSessions = pooledSessions.splice(0);
      if (runtimeCommandPollTimer) {
        clearInterval(runtimeCommandPollTimer);
        runtimeCommandPollTimer = null;
      }

      for (const sessionId of allSessions) {
        await disposeSession(sessionId);
      }

      for (const preparedSession of warmSessions) {
        await disposePreparedSession(preparedSession);
      }

      await closeHttpServer(httpServer);
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
