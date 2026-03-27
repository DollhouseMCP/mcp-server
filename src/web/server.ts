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
import { mkdir, readdir } from 'node:fs/promises';
import { createApiRoutes, createGatewayApiRoutes } from './routes.js';
import { logger } from '../utils/logger.js';
import type { MCPAQLHandler } from '../handlers/mcp-aql/MCPAQLHandler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3939;
const CONSOLE_HOST = 'dollhouse.localhost';
const ALLOWED_PAGE_EXTENSIONS = new Set(['.html', '.htm']);

/** Track whether the web server is already running in-process. */
let serverRunning = false;
let serverPort = DEFAULT_PORT;

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
    if (!/^https?:\/\/localhost[:/]/.test(urlStr)) {
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
 */
export async function startWebServer(options: WebServerOptions): Promise<void> {
  const port = options.port || DEFAULT_PORT;

  if (serverRunning) {
    if (options.openBrowser) {
      openInBrowser(`http://${CONSOLE_HOST}:${serverPort}`);
    }
    return;
  }

  const app = express();
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
      "style-src 'self' 'unsafe-inline' cdnjs.cloudflare.com",
      "connect-src 'self' raw.githubusercontent.com",
      "font-src 'self'",
    ].join('; '));
    next();
  });

  // Portfolio browsing: always use direct filesystem routes (reads frontmatter,
  // returns real filenames, dates, authors — everything app.js needs).
  // The gateway list_elements is too thin for the web UI (no filenames, no dates).
  // Permission endpoints: use MCP-AQL gateway when handler is available.
  app.use('/api', createApiRoutes(options.portfolioDir));
  if (options.mcpAqlHandler) {
    app.use('/api', createGatewayApiRoutes(options.mcpAqlHandler, options.portfolioDir));
    logger.info('[WebUI] Portfolio: direct filesystem | Permissions: MCP-AQL gateway');
  } else {
    logger.info('[WebUI] Portfolio: direct filesystem | Permissions: not available');
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

  // Static frontend files
  const publicDir = join(__dirname, 'public');
  app.use(express.static(publicDir));

  // SPA fallback
  app.get('/{*path}', (req, res) => {
    const normalizedPath = req.path.normalize('NFC');
    if (normalizedPath.startsWith('/api/')) {
      res.status(404).json({ error: `API route not found: ${normalizedPath}` });
      return;
    }
    if (normalizedPath.startsWith('/pages/')) {
      res.status(404).json({ error: `Page not found: ${normalizedPath}` });
      return;
    }
    res.sendFile(join(publicDir, 'index.html'));
  });

  // Bind to localhost only
  app.listen(port, '127.0.0.1', () => {
    serverRunning = true;
    serverPort = port;
    const url = `http://${CONSOLE_HOST}:${port}`;
    const fallbackUrl = `http://127.0.0.1:${port}`;
    logger.info(`[WebUI] Management console running at ${url}`);
    console.log(`\n  DollhouseMCP Management Console\n  ${url}\n  ${fallbackUrl} (fallback)\n`);

    if (options.openBrowser) {
      openInBrowser(url);
    }
  });
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
export async function openPortfolioBrowser(portfolioDir: string, port?: number, mcpAqlHandler?: MCPAQLHandler): Promise<BrowserOpenResult> {
  const targetPort = port || DEFAULT_PORT;
  const url = `http://${CONSOLE_HOST}:${targetPort}`;
  const alreadyRunning = serverRunning;

  if (!serverRunning) {
    await startWebServer({
      portfolioDir,
      port: targetPort,
      openBrowser: false, // We'll open manually below to capture the result
      mcpAqlHandler,
    });
    // Wait briefly for the server to bind
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const browserResult = await openInBrowser(url);

  return {
    url,
    alreadyRunning,
    browserOpened: browserResult.success,
    ...(browserResult.error ? { warning: `Browser could not be opened automatically: ${browserResult.error}. Open ${url} manually.` } : {}),
  };
}
