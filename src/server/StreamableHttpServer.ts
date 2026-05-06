import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';
import { env } from '../config/env.js';
import { PACKAGE_VERSION } from '../generated/version.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { logger } from '../utils/logger.js';
import { assertSafePublicBaseUrl } from '../auth/oauth/url.js';
import { createHttpOrHttpsServer } from './createHttpOrHttpsServer.js';
import { TlsConfig } from './TlsConfig.js';

export type RuntimeTransportName = 'stdio' | 'streamable-http';
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
  authMiddleware?: import('express').RequestHandler;
  /** Embedded OAuth provider. Discovery and token routes are mounted before MCP auth middleware. */
  oauthProvider?: {
    setPublicBaseUrl?: (publicBaseUrl: string) => void;
    createRouter: () => import('express').Router;
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

export interface StreamableHttpSessionAttachment {
  dispose(): Promise<void>;
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
  const headerValue = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return normalizeUserInput(sessionId);
}

function getClientKey(req: Request): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return normalizeUserInput(forwardedFor.split(',')[0].trim()) ?? 'unknown';
  }

  return normalizeUserInput(req.ip || req.socket.remoteAddress || 'unknown') ?? 'unknown';
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
    return 'streamable-http';
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
  httpServer.closeAllConnections?.();
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

export async function createStreamableHttpRuntime(
  createSessionAttachment: (transport: StreamableHTTPServerTransport, authClaims?: import('../auth/IAuthProvider.js').AuthClaims) => Promise<StreamableHttpSessionAttachment>,
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
  const publicBaseUrl = env.DOLLHOUSE_PUBLIC_BASE_URL;
  if (publicBaseUrl) {
    assertSafePublicBaseUrl(publicBaseUrl);
  }
  const app = createMcpExpressApp({ host, allowedHosts });
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
  let replenishPoolPromise: Promise<void> | null = null;

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
    session.expirationTimer.unref?.();
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
      while (!closingPromise && pooledSessions.length < sessionPoolSize) {
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

  const prepareSession = async (authClaims?: import('../auth/IAuthProvider.js').AuthClaims): Promise<PreparedSessionRecord> => {
    let attachment: StreamableHttpSessionAttachment | null = null;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
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

    attachment = await createSessionAttachment(transport, authClaims);

    return {
      attachment,
      transport,
      ownerSub: authClaims?.sub,
      dispose: async () => {
        await transport.close().catch(() => {
          /* pooled transport shutdown is best-effort */
        });
        await attachment?.dispose();
      },
    };
  };

  const getOrCreatePreparedSession = async (authClaims?: import('../auth/IAuthProvider.js').AuthClaims): Promise<PreparedSessionRecord> => {
    // Pooled sessions don't carry auth claims — they were pre-created without
    // knowing who would connect. When auth is enabled, always create fresh.
    if (!authClaims) {
      const pooledSession = pooledSessions.pop();
      if (pooledSession) {
        sessionTelemetry.poolHits += 1;
        void maintainSessionPool();
        return pooledSession;
      }
    }

    sessionTelemetry.poolMisses += 1;
    return prepareSession(authClaims);
  };

  app.get('/', (_req, res) => {
    res.json({
      name: 'dollhousemcp',
      version: PACKAGE_VERSION,
      transport: 'streamable-http',
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
      transport: 'streamable-http',
      version: PACKAGE_VERSION,
      sessions: {
        active: sessions.size,
        pooled: pooledSessions.length,
        ...sessionTelemetry,
      },
      memory: getProcessMemorySnapshot(),
    });
  });

  app.get('/readyz', (_req, res) => {
    res.status(200).json({
      ready: true,
      transport: 'streamable-http',
      activeSessions: sessions.size,
      pooledSessions: pooledSessions.length,
      sessionTelemetry,
      memory: getProcessMemorySnapshot(),
    });
  });

  app.get('/version', (_req, res) => {
    res.status(200).json({
      name: 'dollhousemcp',
      version: PACKAGE_VERSION,
    });
  });

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
        return;
      }

      if (!isInitializeRequest(req.body)) {
        respondWithJsonRpcError(res, 400, 'Initialization request required before session use', getRequestId(req));
        return;
      }

      const preparedSession = await getOrCreatePreparedSession(res.locals.authClaims);

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
    if (!assertSessionOwner(req, res, sessionId, session)) return;

    try {
      touchSession(sessionId);
      await session.transport.handleRequest(req, res);
    } catch (error) {
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

  const tlsConfig = options.tlsConfig ?? new TlsConfig();
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
