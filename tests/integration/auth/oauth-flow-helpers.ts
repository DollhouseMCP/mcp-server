/**
 * Shared utilities for OAuth flow E2E tests against EmbeddedAuthorizationServer.
 *
 * The existing tests/integration/transport/oauth-http-auth.test.ts boots
 * the full StreamableHttpRuntime to verify the auth-to-tool-call path.
 * The per-method E2E tests in this directory focus on the AS itself —
 * the OAuth/PKCE flow, token issuance, method-specific rules — without
 * the DollhouseContainer / MCP transport stack on top. The helpers here
 * extract the bits that don't depend on that stack.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import express, { type Express } from 'express';
import { EmbeddedAuthorizationServer, type EmbeddedAuthorizationServerOptions } from '../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function newPkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate test port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Cookie jar that consumes Set-Cookie headers and emits a Cookie header.
 * Uses Headers.getSetCookie() (Node 20+) so multi-cookie responses are
 * parsed individually.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  ingest(headers: Headers): void {
    const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = getter ? getter.call(headers) : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx < 0) continue;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      if (value === '' || value.toLowerCase() === 'deleted') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export function absoluteUrl(base: string, location: string | null): string {
  if (!location) throw new Error('Expected a Location header on redirect, got none');
  if (/^https?:\/\//i.test(location)) return location;
  return new URL(location, base).toString();
}

export interface ASHarness {
  as: EmbeddedAuthorizationServer;
  baseUrl: string;
  publicBaseUrl: string;
  app: Express;
  close: () => Promise<void>;
  tmpDir: string;
}

export type ASHarnessOptions = Omit<EmbeddedAuthorizationServerOptions, 'publicBaseUrl' | 'keyFilePath'> & {
  /** Override publicBaseUrl. Default: `http://127.0.0.1:<port>`. */
  publicBaseUrl?: string;
  /**
   * Listen on this pre-allocated port. Use when callers need to know the
   * URL (and thus port) before constructing the AS — e.g. MagicLinkMethod
   * needs `verifyUrl` to point back at the AS at construction time.
   */
  port?: number;
  /**
   * Use this directory for the harness key file + tmp working area. When
   * provided the harness will NOT delete it on close() — caller owns
   * lifecycle. Use this for restart tests that need the signing key (and
   * any caller-managed storage rooted in the same dir) to survive a
   * harness teardown.
   */
  tmpDir?: string;
  /**
   * Skip the auto-bootstrap step. Default: false (the harness marks
   * bootstrap complete with a placeholder admin sub before returning,
   * so existing E2E tests that drive flows in multi-user mode work
   * without each test having to know about must-fix #22).
   *
   * Set to `true` for tests that explicitly verify gate behavior — they
   * want the gate CLOSED so they can assert 503 responses on
   * pre-bootstrap traffic.
   */
  skipAutoBootstrap?: boolean;
};

/**
 * Boot an EmbeddedAuthorizationServer mounted on a fresh Express app.
 * Returns the URL the AS is reachable at + a `close()` to tear down.
 */
export async function startASHarness(opts: ASHarnessOptions): Promise<ASHarness> {
  const ownsTmpDir = !opts.tmpDir;
  const tmpDir = opts.tmpDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'as-e2e-'));
  const port = opts.port ?? (await getFreePort());
  const publicBaseUrl = opts.publicBaseUrl ?? `http://127.0.0.1:${port}`;

  // Required by the trivial-consent guard if any method is trivial-consent.
  // Set DOLLHOUSE_HTTP_HOST so the loopback check passes when bound here.
  process.env.DOLLHOUSE_HTTP_HOST = '127.0.0.1';

  const as = new EmbeddedAuthorizationServer({
    ...opts,
    publicBaseUrl,
    mcpPath: '/mcp',
    keyFilePath: path.join(tmpDir, 'key.json'),
    rateLimitStore: opts.rateLimitStore ?? new InMemoryRateLimitStore(),
  });

  // Auto-bootstrap so existing E2E tests in multi-user mode aren't blocked
  // by the must-fix #22 gate. Tests that specifically verify gate behavior
  // pass `skipAutoBootstrap: true` and the gate stays closed.
  if (!opts.skipAutoBootstrap) {
    await opts.storage.markBootstrapComplete('test-admin', 'github').catch(() => {
      // Already bootstrapped — fine.
    });
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(as.createRouter());
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));

  return {
    as,
    baseUrl: `http://127.0.0.1:${port}`,
    publicBaseUrl,
    app,
    tmpDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownsTmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Drive the OAuth GET /authorize step. Returns the 303-Location to the
 * AS interaction URL plus the cookie jar primed for subsequent calls.
 */
export interface AuthorizeResult {
  interactionUrl: string;
  jar: CookieJar;
  verifier: string;
}

export async function startAuthorizeFlow(opts: {
  baseUrl: string;
  authServerMetadata: { authorization_endpoint: string };
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  /** Optional `prompt` param. Use `'consent'` to force the consent prompt
   * needed for offline_access to actually be granted under standard OIDC. */
  prompt?: string;
}): Promise<AuthorizeResult> {
  const verifier = newPkceVerifier();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    resource: opts.resource,
    scope: opts.scope,
  });
  if (opts.prompt) params.set('prompt', opts.prompt);
  const jar = new CookieJar();
  const authorize = await fetch(`${opts.authServerMetadata.authorization_endpoint}?${params}`, {
    method: 'GET',
    redirect: 'manual',
  });
  if (![302, 303].includes(authorize.status)) {
    throw new Error(`Expected 302/303 from /authorize, got ${authorize.status}`);
  }
  jar.ingest(authorize.headers);
  const interactionUrl = absoluteUrl(opts.baseUrl, authorize.headers.get('location'));
  if (!interactionUrl.includes('/interaction/')) {
    throw new Error(`Expected /interaction/<uid> redirect, got ${interactionUrl}`);
  }
  return { interactionUrl, jar, verifier };
}

/**
 * Walk oidc-provider's redirect chain after a successful interaction
 * POST until we land on the client redirect_uri with `?code=...`.
 */
export async function followToCodeRedirect(opts: {
  baseUrl: string;
  start: string | null;
  jar: CookieJar;
  redirectUriPrefix: string;
}): Promise<string> {
  let nextUrl: string | null = opts.start ? absoluteUrl(opts.baseUrl, opts.start) : null;
  for (let hop = 0; hop < 10 && nextUrl; hop += 1) {
    const followed = await fetch(nextUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { Cookie: opts.jar.header() },
    });
    opts.jar.ingest(followed.headers);
    const location = followed.headers.get('location');
    if (location?.startsWith(opts.redirectUriPrefix)) {
      const code = new URL(location).searchParams.get('code');
      if (code) return code;
    }
    if (!location) break;
    nextUrl = absoluteUrl(opts.baseUrl, location);
  }
  throw new Error('Did not land on client redirect_uri with code');
}

export async function approveClientConsentPage(opts: {
  baseUrl: string;
  response: Response;
  jar: CookieJar;
}): Promise<Response> {
  opts.jar.ingest(opts.response.headers);
  const html = await opts.response.text();
  const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
  if (!csrfMatch) throw new Error('CSRF token not found in client consent page');
  const formAction = /<form[^>]*action="([^"]+)"/i.exec(html)?.[1];
  if (!formAction) throw new Error('Client consent form action not found');

  return fetch(absoluteUrl(opts.baseUrl, formAction), {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: opts.jar.header(),
    },
    body: new URLSearchParams({
      csrf_token: csrfMatch[1],
      action: 'authorize_oauth_client',
    }),
  });
}
