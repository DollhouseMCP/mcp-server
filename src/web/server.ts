/**
 * DollhouseMCP Web UI Server
 *
 * Lightweight Express server for browsing portfolio elements in a browser.
 * Bound to 127.0.0.1 only (localhost). Read-only for V1.
 *
 * Can be started standalone (`--web` flag) or from within the MCP server
 * process via `openPortfolioBrowser()`.
 *
 * @see https://github.com/DollhouseMCP/mcp-server-v2-refactor/issues/704
 * @see https://github.com/DollhouseMCP/mcp-server-v2-refactor/issues/774
 */

import express from 'express';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { mkdir, readdir, readFile as readFileFs } from 'node:fs/promises';
import { createApiRoutes, createGatewayApiRoutes } from './routes.js';
import { createLogRoutes, type LogRoutesResult } from './routes/logRoutes.js';
import { createMetricsRoutes, type MetricsRoutesResult } from './routes/metricsRoutes.js';
import { createHealthRoutes } from './routes/healthRoutes.js';
import { createSetupRoutes } from './routes/setupRoutes.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import type { MCPAQLHandler } from '../handlers/mcp-aql/MCPAQLHandler.js';
import type { MemoryLogSink } from '../logging/sinks/MemoryLogSink.js';
import type { MemoryMetricsSink } from '../metrics/sinks/MemoryMetricsSink.js';
import type { ConsoleTokenStore } from './console/consoleToken.js';
import { createAuthMiddleware } from './middleware/authMiddleware.js';

/**
 * Public path prefixes that never require authentication (#1780).
 * These endpoints return safe metadata or act as health probes — requiring
 * tokens on them would break monitoring and client detection without adding
 * real security value.
 */
const PUBLIC_PATH_PREFIXES = [
  '/api/health',
  '/api/setup/version',
  '/api/setup/mcpb',
  '/api/setup/detect',
];

/** Placeholder in index.html that is replaced with the current console token. */
const TOKEN_META_PLACEHOLDER = '{{CONSOLE_TOKEN}}';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3939;
const CONSOLE_HOST = 'dollhouse.localhost';
const ALLOWED_PAGE_EXTENSIONS = new Set(['.html', '.htm']);
/** Max JSON body for setup routes (install/open-config). Ingest routes use their own 1mb limit. */
const SETUP_BODY_LIMIT = '1kb';

/** Track whether the web server is already running in-process. */
let serverRunning = false;
let serverPort = DEFAULT_PORT;

/** Check whether the web server has been started in this process. */
export function isWebServerRunning(): boolean {
  return serverRunning;
}

/**
 * Options for starting the web server.
 */
export interface WebServerOptions {
  /** Port to bind to (default: 3939) */
  port?: number;
  /** Path to the portfolio directory (e.g., ~/.dollhouse/portfolio) */
  portfolioDir: string;
  /** Open the browser automatically after starting (default: false) */
  openBrowser?: boolean;
  /**
   * MCPAQLHandler for routing through the MCP-AQL pipeline.
   * When provided, API routes use the gateway (validated, cached, gatekeeper-checked).
   * When absent, falls back to direct filesystem access (legacy behavior).
   * Issue #796: Web MCP-AQL Gateway.
   */
  mcpAqlHandler?: MCPAQLHandler;
  /** MemoryLogSink for log routes (optional — logs tab disabled if not provided) */
  memorySink?: MemoryLogSink;
  /** MemoryMetricsSink for metrics routes (optional — metrics tab disabled if not provided) */
  metricsSink?: MemoryMetricsSink;
  /** Additional routers to mount before the SPA fallback (e.g., ingest routes) */
  additionalRouters?: import('express').Router[];
  /**
   * Console token store (#1780). When provided, the server will:
   *   1. Mount Bearer token auth middleware before protected routers.
   *   2. Inject the primary token into index.html so the browser client
   *      can attach it to fetch calls and EventSource URLs.
   *   3. Append the token file location to the startup banner.
   * Auth enforcement is still gated on DOLLHOUSE_WEB_AUTH_ENABLED — the
   * middleware is a pass-through when the flag is false (the Phase 1 default).
   */
  tokenStore?: ConsoleTokenStore;
}

/**
 * Result of starting the web server, including hooks for DI wiring.
 */
export interface WebServerResult {
  /** Express app instance — for mounting additional routes (e.g., ingest routes) */
  app?: import('express').Express;
  /** Log broadcast function — call with each entry to push to SSE clients */
  logBroadcast?: (entry: import('../logging/types.js').UnifiedLogEntry) => void;
  /** Metrics snapshot function — call with each snapshot to push to SSE clients */
  metricsOnSnapshot?: (snapshot: import('../metrics/types.js').MetricSnapshot) => void;
}

/**
 * Result of attempting to open the browser.
 */
export interface BrowserOpenResult {
  /** The URL the server is running on */
  url: string;
  /** Whether the server was already running (true) or just started (false) */
  alreadyRunning: boolean;
  /** Whether the browser was successfully opened */
  browserOpened: boolean;
  /** Warning message if the browser could not be opened */
  warning?: string;
}

/**
 * Open a URL in the system's default browser.
 *
 * Platform-aware:
 * - macOS: `open`
 * - Linux: `xdg-open`
 * - Windows: `start`
 *
 * @param url - The URL to open
 * @returns Promise that resolves to true if the browser opened, false with error message if not
 */
function openInBrowser(url: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const plat = platform();
    const cmd = plat === 'darwin' ? 'open'
      : plat === 'win32' ? 'start'
      : 'xdg-open';

    // Security: use execFile with URL as argument array, not string interpolation
    const urlStr = String(url);
    // Accept localhost, 127.0.0.1, and *.localhost subdomains (RFC 6761)
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|[\w-]+\.localhost)[:/]/.test(urlStr)) {
      resolve({ success: false, error: 'URL must be a localhost HTTP URL' });
      return;
    }
    execFile(cmd, [urlStr], (err) => {
      if (err) {
        logger.warn(`[WebUI] Could not auto-open browser: ${err.message}`);
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true });
      }
    });
  });
}

/**
 * Start the portfolio web server.
 *
 * Binds to 127.0.0.1 only (localhost). Serves the portfolio browser
 * frontend and API routes for reading elements.
 *
 * Idempotent: if the server is already running, optionally opens the
 * browser without starting a second instance.
 *
 * @param options - Server configuration
 * @returns Hooks for DI wiring (log broadcast, metrics onSnapshot)
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerResult> {
  const port = options.port || DEFAULT_PORT;
  const result: WebServerResult = {};

  if (serverRunning) {
    if (options.openBrowser) {
      openInBrowser(`http://${CONSOLE_HOST}:${serverPort}`);
    }
    return result;
  }

  const app = express();
  result.app = app;
  app.disable('x-powered-by');

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Access-Control-Allow-Origin', `http://${CONSOLE_HOST}:${port}`);
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' cdn.jsdelivr.net cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' cdnjs.cloudflare.com cdn.jsdelivr.net",
      "connect-src 'self' raw.githubusercontent.com",
      "font-src 'self'",
    ].join('; '));
    next();
  });

  // Console token authentication middleware (#1780). Mounted before any /api
  // routes so every protected endpoint goes through it. When the feature flag
  // DOLLHOUSE_WEB_AUTH_ENABLED is false (Phase 1 default) this is a pass-through.
  // Public endpoints in PUBLIC_PATH_PREFIXES always bypass auth regardless of flag.
  if (options.tokenStore) {
    const authMiddleware = createAuthMiddleware({
      store: options.tokenStore,
      enabled: env.DOLLHOUSE_WEB_AUTH_ENABLED,
      publicPathPrefixes: PUBLIC_PATH_PREFIXES,
      label: 'api',
    });
    app.use('/api', authMiddleware);
    logger.info(
      `[WebUI] Console auth middleware mounted ${env.DOLLHOUSE_WEB_AUTH_ENABLED ? 'ENFORCING' : 'pass-through (flag off)'}`,
    );
  }

  // Setup routes: auto-install DollhouseMCP to MCP clients (mount BEFORE API routes)
  // Body limit scoped to setup routes only — ingest routes need 1mb for follower log forwarding
  const setupJsonParser = express.json({ limit: SETUP_BODY_LIMIT, type: 'application/json' });
  const { installHandler, openConfigHandler, versionHandler, mcpbRedirectHandler, detectHandler } = createSetupRoutes();
  app.post('/api/setup/install', setupJsonParser, installHandler);
  app.post('/api/setup/open-config', setupJsonParser, openConfigHandler);
  app.get('/api/setup/version', versionHandler);
  app.get('/api/setup/mcpb', mcpbRedirectHandler);
  app.get('/api/setup/detect', detectHandler);
  logger.info('[WebUI] Setup routes mounted at /api/setup');

  // API routes — use MCP-AQL gateway when handler is available (Issue #796)
  if (options.mcpAqlHandler) {
    app.use('/api', createGatewayApiRoutes(options.mcpAqlHandler, options.portfolioDir));

    // Permission evaluation routes (POST /evaluate_permission, GET /permissions/status)
    const { registerPermissionRoutes } = await import('./routes/permissionRoutes.js');
    const permRouter = (await import('express')).Router();
    registerPermissionRoutes(permRouter, options.mcpAqlHandler);
    app.use('/api', permRouter);

    logger.info('[WebUI] API routes using MCP-AQL Gateway + permission routes');
  } else {
    app.use('/api', createApiRoutes(options.portfolioDir));
    logger.warn('[WebUI] API routes using direct filesystem access (no MCP-AQL handler available)');
  }

  // Console routes: logs, metrics, health
  let logRoutes: LogRoutesResult | undefined;
  let metricsRoutes: MetricsRoutesResult | undefined;

  if (options.memorySink) {
    logRoutes = createLogRoutes(options.memorySink);
    app.use('/api', logRoutes.router);
    result.logBroadcast = logRoutes.broadcast;
    logger.info('[WebUI] Log viewer routes mounted at /api/logs');
  }

  if (options.metricsSink) {
    metricsRoutes = createMetricsRoutes(options.metricsSink);
    app.use('/api', metricsRoutes.router);
    result.metricsOnSnapshot = metricsRoutes.onSnapshot;
    logger.info('[WebUI] Metrics routes mounted at /api/metrics');
  }

  if (options.memorySink) {
    const healthRouter = createHealthRoutes({
      memorySink: options.memorySink,
      metricsSink: options.metricsSink,
      logClientCount: logRoutes ? logRoutes.clientCount : () => 0,
      metricsClientCount: metricsRoutes ? metricsRoutes.clientCount : () => 0,
    });
    app.use('/api', healthRouter);
  }

  // Serve ~/.dollhouse/pages/ at /pages/ — dashboards, generated content, stack views
  const pagesDir = join(dirname(options.portfolioDir), 'pages');
  mkdir(pagesDir, { recursive: true }).catch(err => {
    logger.warn(`[WebUI] Could not create pages directory: ${(err as Error).message}`);
  });
  app.use('/pages', express.static(pagesDir));

  /**
   * GET /api/pages
   * Lists available HTML pages in ~/.dollhouse/pages/.
   * Returns page names and their URLs for the management console.
   */
  app.get('/api/pages', async (_req, res) => {
    try {
      const files = await readdir(pagesDir);
      const pages = files
        .filter(f => !f.startsWith('.') && ALLOWED_PAGE_EXTENSIONS.has(extname(f)))
        .map(f => ({ name: f, url: `/pages/${f}` }));
      res.json({ pages, directory: pagesDir });
    } catch {
      res.json({ pages: [], directory: pagesDir });
    }
  });

  // Additional routers (e.g., unified console ingest routes) — must mount before SPA fallback
  options.additionalRouters?.forEach(router => app.use(router));

  // Static frontend files
  const publicDir = join(__dirname, 'public');
  app.use(express.static(publicDir));

  // SPA fallback with console token injection (#1780).
  // Reads index.html on first request, substitutes the {{CONSOLE_TOKEN}} placeholder
  // with the current token value, and caches the rendered string. Phase 2 will
  // invalidate this cache on token rotation; Phase 1 tokens are stable so the
  // cache lives for the life of the process.
  let cachedIndexHtml: string | null = null;
  const indexHtmlPath = join(publicDir, 'index.html');

  const renderIndexHtml = async (): Promise<string> => {
    if (cachedIndexHtml !== null) return cachedIndexHtml;
    const template = await readFileFs(indexHtmlPath, 'utf8');
    const tokenValue = options.tokenStore?.getPrimaryTokenValue() ?? '';
    cachedIndexHtml = template.replaceAll(TOKEN_META_PLACEHOLDER, tokenValue);
    return cachedIndexHtml;
  };

  app.get('/{*path}', async (req, res) => {
    const normalizedPath = req.path.normalize('NFC');
    if (normalizedPath.startsWith('/api/')) {
      res.status(404).json({ error: `API route not found: ${normalizedPath}` });
      return;
    }
    if (normalizedPath.startsWith('/pages/')) {
      res.status(404).json({ error: `Page not found: ${normalizedPath}` });
      return;
    }
    try {
      const html = await renderIndexHtml();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      logger.error(`[WebUI] Failed to render index.html: ${(err as Error).message}`);
      res.status(500).send('Failed to load console');
    }
  });

  // Global error handler — catch Express errors and route to logger instead of terminal.
  // Without this, Express dumps stack traces to stderr (visible in --web terminal).
  // All errors still appear in the management console's Logs tab via MemoryLogSink.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    const status = (err as any).status || (err as any).statusCode || 500;
    logger.warn(`[WebUI] ${err.name}: ${err.message}`);
    if (!res.headersSent) {
      res.status(status).json({ error: err.message });
    }
  });

  // Bind to localhost only — handle port conflicts gracefully
  // NOTE: Use stderr for terminal output, not stdout. In MCP stdio mode, stdout
  // is reserved for JSON-RPC messages — any non-JSON output corrupts the protocol.
  // stderr is safe for human-readable messages in both MCP and standalone modes.
  await new Promise<void>((resolve) => {
    const httpServer = app.listen(port, '127.0.0.1', () => {
      serverRunning = true;
      serverPort = port;
      const url = `http://${CONSOLE_HOST}:${port}`;
      const fallbackUrl = `http://127.0.0.1:${port}`;
      logger.info(`[WebUI] Management console running at ${url}`);
      console.error(`\n  DollhouseMCP Management Console\n  ${url}\n  ${fallbackUrl} (fallback)\n`);
      if (options.tokenStore) {
        console.error(`  Session token: ${options.tokenStore.getFilePath()}\n`);
      }
      console.error(`  Type "q" or "quit" to exit.\n`);

      if (options.openBrowser) {
        openInBrowser(url);
      }
      resolve();
    });
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const url = `http://${CONSOLE_HOST}:${port}`;
        logger.info(`[WebUI] Port ${port} already in use — opening existing console`);
        console.error(`\n  DollhouseMCP Management Console (existing instance)\n  ${url}\n`);
        if (options.openBrowser) {
          openInBrowser(url);
        }
      } else {
        logger.error(`[WebUI] Failed to bind port ${port}: ${err.message}`);
      }
      resolve(); // Web console is optional — don't block startup
    });
  });

  return result;
}

/**
 * Open the portfolio browser from within the MCP server process.
 *
 * Starts the web server if not already running, then opens the system
 * browser to the portfolio UI. Returns a result object indicating
 * whether the server started and the browser opened successfully.
 *
 * Called by the `open_portfolio_browser` MCP-AQL operation (Issue #774).
 *
 * @param portfolioDir - Path to the portfolio directory (e.g., ~/.dollhouse/portfolio)
 * @param port - Port to bind to (default: 3939)
 * @returns Result with URL, server status, and browser open status
 */
export async function openPortfolioBrowser(portfolioDir: string, port?: number, mcpAqlHandler?: MCPAQLHandler, tab?: string, urlParams?: Record<string, string>): Promise<BrowserOpenResult> {
  const targetPort = port || DEFAULT_PORT;
  const baseUrl = `http://${CONSOLE_HOST}:${targetPort}`;

  // Build URL with optional tab hash and query parameters
  // Format: http://host:port/#tab?key=value&key=value
  let url = baseUrl;
  if (tab) {
    const qs = urlParams ? new URLSearchParams(urlParams).toString() : '';
    url = `${baseUrl}/#${tab}${qs ? '?' + qs : ''}`;
  } else if (urlParams && Object.keys(urlParams).length > 0) {
    const qs = new URLSearchParams(urlParams).toString();
    url = `${baseUrl}/#portfolio?${qs}`;
  }

  const alreadyRunning = serverRunning;

  if (!serverRunning) {
    await startWebServer({
      portfolioDir,
      port: targetPort,
      openBrowser: false, // We'll open manually below to capture the result
      mcpAqlHandler,
    });
  }

  const browserResult = await openInBrowser(url);

  return {
    url,
    alreadyRunning,
    browserOpened: browserResult.success,
    ...(browserResult.error ? { warning: `Browser could not be opened automatically: ${browserResult.error}. Open ${url} manually.` } : {}),
  };
}
