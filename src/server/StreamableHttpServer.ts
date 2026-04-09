import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';
import { env } from '../config/env.js';
import { PACKAGE_VERSION } from '../generated/version.js';
import { logger } from '../utils/logger.js';

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
}

export interface StreamableHttpRuntimeHandle {
  app: Express;
  host: string;
  port: number;
  mcpPath: string;
  url: string;
  httpServer: HttpServer;
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
}

interface PreparedSessionRecord {
  attachment: StreamableHttpSessionAttachment;
  transport: StreamableHTTPServerTransport;
  dispose(): Promise<void>;
}

interface RateLimitRecord {
  requestCount: number;
  windowEndsAt: number;
}

function getCliFlagValue(flagName: string): string | undefined {
  const prefix = `--${flagName}=`;
  const arg = process.argv.find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function parseCommaSeparatedValues(rawValue: string | undefined): string[] | undefined {
  if (!rawValue) {
    return undefined;
  }

  const values = rawValue
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

function normalizeMcpPath(rawPath: string | undefined): string {
  if (!rawPath || rawPath === '/') {
    return '/mcp';
  }

  return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
}

function getRequestId(req: Request): unknown {
  const body = req.body as { id?: unknown } | undefined;
  return body?.id ?? null;
}

function getMcpSessionId(req: Request): string | undefined {
  const headerValue = req.headers['mcp-session-id'];
  return Array.isArray(headerValue) ? headerValue[0] : headerValue;
}

function getClientKey(req: Request): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.ip || req.socket.remoteAddress || 'unknown';
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

async function closeHttpServer(httpServer: HttpServer): Promise<void> {
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
  createSessionAttachment: (transport: StreamableHTTPServerTransport) => Promise<StreamableHttpSessionAttachment>,
  options: StreamableHttpRuntimeOptions = {},
): Promise<StreamableHttpRuntimeHandle> {
  const host = options.host ?? env.DOLLHOUSE_HTTP_HOST;
  const port = options.port ?? env.DOLLHOUSE_HTTP_PORT;
  const mcpPath = normalizeMcpPath(options.mcpPath ?? env.DOLLHOUSE_HTTP_MCP_PATH);
  const allowedHosts = options.allowedHosts ?? env.DOLLHOUSE_HTTP_ALLOWED_HOSTS;
  const rateLimitWindowMs = Math.max(0, options.rateLimitWindowMs ?? env.DOLLHOUSE_HTTP_RATE_LIMIT_WINDOW_MS);
  const rateLimitMaxRequests = Math.max(0, options.rateLimitMaxRequests ?? env.DOLLHOUSE_HTTP_RATE_LIMIT_MAX_REQUESTS);
  const sessionIdleTimeoutMs = Math.max(0, options.sessionIdleTimeoutMs ?? env.DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS);
  const sessionPoolSize = Math.max(0, options.sessionPoolSize ?? env.DOLLHOUSE_HTTP_SESSION_POOL_SIZE);
  const app = createMcpExpressApp({ host, allowedHosts });
  const sessions = new Map<string, ActiveSessionRecord>();
  const rateLimits = new Map<string, RateLimitRecord>();
  const pooledSessions: PreparedSessionRecord[] = [];
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
    clearSessionTimer(session);

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
      void disposeSession(sessionId);
    }, sessionIdleTimeoutMs);
    session.expirationTimer.unref?.();
  };

  const consumeRateLimit = (req: Request, res: Response): boolean => {
    if (rateLimitMaxRequests <= 0 || rateLimitWindowMs <= 0) {
      return true;
    }

    const now = Date.now();
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

  const prepareSession = async (): Promise<PreparedSessionRecord> => {
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
        });
        touchSession(sessionId);
        logger.info('[StreamableHTTP] Session initialized', { sessionId });
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

    attachment = await createSessionAttachment(transport);

    return {
      attachment,
      transport,
      dispose: async () => {
        await transport.close().catch(() => {
          /* pooled transport shutdown is best-effort */
        });
        await attachment?.dispose();
      },
    };
  };

  const getOrCreatePreparedSession = async (): Promise<PreparedSessionRecord> => {
    const pooledSession = pooledSessions.pop();
    if (pooledSession) {
      void maintainSessionPool();
      return pooledSession;
    }

    return prepareSession();
  };

  app.get('/', (_req, res) => {
    res.json({
      name: 'dollhousemcp',
      version: PACKAGE_VERSION,
      transport: 'streamable-http',
      mcpPath,
      health: '/healthz',
      readiness: '/readyz',
      sessionPoolSize,
    });
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      ok: true,
      transport: 'streamable-http',
      version: PACKAGE_VERSION,
      memory: getProcessMemorySnapshot(),
    });
  });

  app.get('/readyz', (_req, res) => {
    res.status(200).json({
      ready: true,
      transport: 'streamable-http',
      activeSessions: sessions.size,
      pooledSessions: pooledSessions.length,
      memory: getProcessMemorySnapshot(),
    });
  });

  app.get('/version', (_req, res) => {
    res.status(200).json({
      name: 'dollhousemcp',
      version: PACKAGE_VERSION,
    });
  });

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

        touchSession(sessionId);
        await existingSession.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        respondWithJsonRpcError(res, 400, 'Initialization request required before session use', getRequestId(req));
        return;
      }

      const preparedSession = await getOrCreatePreparedSession();

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
      respondWithJsonRpcError(res, 400, 'A valid mcp-session-id header is required.');
      return;
    }

    if (!session) {
      respondWithJsonRpcError(res, 404, 'Unknown MCP session');
      return;
    }

    try {
      touchSession(sessionId);
      await session.transport.handleRequest(req, res);
    } catch (error) {
      handleRequestFailure(req, res, methodName, error, sessionId);
    }
  };

  app.get(mcpPath, async (req, res) => handleSessionLifecycleRequest(req, res, 'GET'));
  app.delete(mcpPath, async (req, res) => handleSessionLifecycleRequest(req, res, 'DELETE'));

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });

  const address = httpServer.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${resolvedPort}${mcpPath}`;

  logger.info('[StreamableHTTP] Hosted MCP server listening', {
    host,
    port: resolvedPort,
    mcpPath,
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
    activeSessionCount: () => sessions.size,
    pooledSessionCount: () => pooledSessions.length,
    close: async () => {
      removeSignalHandlers();
      await shutdown();
    },
  };
}
