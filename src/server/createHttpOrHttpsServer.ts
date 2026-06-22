/**
 * createHttpOrHttpsServer
 *
 * Factory that returns a node:http.Server or node:https.Server depending on
 * whether TlsConfig is enabled. Houses the non-loopback-without-TLS startup
 * guard: refuses to bind to a public interface unless TLS is configured or
 * the operator explicitly opts in via DOLLHOUSE_UNSAFE_NO_TLS=true (CI-only).
 *
 * StreamableHttpServer (and any other HTTP surface) consumes this factory
 * rather than calling app.listen() directly, so the same TLS / bind policy
 * applies uniformly.
 *
 * @module server/createHttpOrHttpsServer
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Express } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { isLoopbackHost as isLoopbackHostInternal } from '../auth/oauth/url.js';
import { TlsConfig } from './TlsConfig.js';

export interface CreateHttpServerOptions {
  /** Bind host. Used by the non-loopback guard. */
  host: string;
  /** Bind port. */
  port: number;
  /**
   * TLS configuration. When enabled, an HTTPS server is returned.
   * When omitted or disabled, an HTTP server is returned (and the
   * non-loopback guard fires for non-loopback hosts).
   */
  tlsConfig?: TlsConfig;
  /**
   * CI-only escape hatch: allow non-loopback bind without TLS. Reads
   * DOLLHOUSE_UNSAFE_NO_TLS by default; tests can override.
   */
  allowUnsafeNonLoopback?: boolean;
}

export interface CreateHttpServerResult {
  server: HttpServer | HttpsServer;
  /** True when an HTTPS server was created. Drives URL scheme decisions. */
  isHttps: boolean;
}

/**
 * Create the appropriate server, enforce the bind policy, and start listening.
 * Resolves once the server is listening; rejects on listen errors.
 */
export async function createHttpOrHttpsServer(
  app: Express,
  options: CreateHttpServerOptions,
): Promise<CreateHttpServerResult> {
  const { host, port, tlsConfig } = options;
  const allowUnsafe = options.allowUnsafeNonLoopback ?? env.DOLLHOUSE_UNSAFE_NO_TLS;

  const tlsOptions = tlsConfig?.toServerOptions() ?? null;
  const isHttps = tlsOptions !== null;

  if (!isHttps && !isLoopbackHostInternal(host)) {
    if (!allowUnsafe) {
      throw new Error(
        `Refusing to bind to non-loopback host '${host}' without TLS. ` +
        `Set DOLLHOUSE_TLS_CERT_PATH and DOLLHOUSE_TLS_KEY_PATH for HTTPS, ` +
        `or DOLLHOUSE_UNSAFE_NO_TLS=true to override (CI/dev only).`,
      );
    }
    logger.warn(
      `[createHttpOrHttpsServer] Non-loopback bind '${host}' without TLS — DOLLHOUSE_UNSAFE_NO_TLS is set. ` +
      `Do not use this in production.`,
    );
  }

  const server = isHttps
    ? createHttpsServer(tlsOptions!, app)
    : createHttpServer(app);

  // Cycle 24: Node has THREE separate HTTP timeouts; MCP Streamable HTTP
  // trips on all of them differently. Defaults caused two distinct
  // "MCP ERROR" pop-ups in Gemini CLI:
  //
  //   1. keepAliveTimeout (default 5s): TCP socket between requests.
  //      Short idle gaps between user actions caused socket close →
  //      next request got ECONNRESET. Bumped to 120s — matches
  //      reverse-proxy industry norms (AWS ALB 60s, Cloudflare 100s).
  //
  //   2. headersTimeout (default 60s): must exceed keepAliveTimeout per
  //      Node.js docs. Bumped to 130s (10s margin).
  //
  //   3. requestTimeout (default 300s/5min in Node 18+): per-request
  //      timeout that ALSO applies to long-lived SSE GETs that MCP
  //      Streamable HTTP holds open for server-to-client events. After
  //      5 min idle, the GET was killed → Gemini CLI showed "MCP ERROR".
  //      Disabled (0) because MCP session lifecycle is governed by
  //      `DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS` (default 15min) at the
  //      application layer; we don't want a lower HTTP-level timeout
  //      preempting that.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 130_000;
  server.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return { server, isHttps };
}

// Re-export the canonical predicate from auth/oauth/url so server code and
// auth code agree on what counts as loopback (must-fix #8 unification).
export { isLoopbackHost } from '../auth/oauth/url.js';
