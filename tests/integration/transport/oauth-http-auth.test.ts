import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { createHttpSession } from '../../../src/context/HttpSession.js';
import { setHttpModeActive } from '../../../src/index.js';
import { EmbeddedAuthorizationServer } from '../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { TrivialConsentMethod } from '../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import {
  createStreamableHttpRuntime,
  type StreamableHttpRuntimeHandle,
} from '../../../src/server/StreamableHttpServer.js';

const ELEMENT_TYPES = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function getFreePort(): Promise<number> {
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
 * Cookie jar for the OAuth interaction flow. oidc-provider sets multiple
 * cookies (session, interaction); the jar uses Headers.getSetCookie() so
 * each Set-Cookie header is parsed individually (Node 20+).
 */
class CookieJar {
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

function absoluteUrl(base: string, location: string | null): string {
  if (!location) throw new Error('Expected a Location header on redirect, got none');
  if (/^https?:\/\//i.test(location)) return location;
  return new URL(location, base).toString();
}

describe('Embedded OAuth + Streamable HTTP auth (oidc-provider)', () => {
  let savedEnv: Record<string, string | undefined>;
  let testDir: string;
  let container: DollhouseContainer;
  let runtime: StreamableHttpRuntimeHandle;

  beforeEach(async () => {
    savedEnv = {
      DOLLHOUSE_PORTFOLIO_DIR: process.env.DOLLHOUSE_PORTFOLIO_DIR,
      MCP_INTERFACE_MODE: process.env.MCP_INTERFACE_MODE,
      DOLLHOUSE_WEB_CONSOLE: process.env.DOLLHOUSE_WEB_CONSOLE,
      DOLLHOUSE_PERMISSION_SERVER: process.env.DOLLHOUSE_PERMISSION_SERVER,
    };

    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-oauth-http-'));
    await Promise.all(ELEMENT_TYPES.map(type => fs.mkdir(path.join(testDir, type), { recursive: true })));

    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
    process.env.MCP_INTERFACE_MODE = 'mcpaql';
    process.env.DOLLHOUSE_WEB_CONSOLE = 'false';
    process.env.DOLLHOUSE_PERMISSION_SERVER = 'false';

    const port = await getFreePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    const provider = new EmbeddedAuthorizationServer({
      publicBaseUrl,
      mcpPath: '/mcp',
      keyFilePath: path.join(testDir, 'oauth-key.json'),
      method: new TrivialConsentMethod({ defaultSubject: 'oauth-http-user' }),
      storage: new InMemoryAuthStorageLayer(),
    });

    container = new DollhouseContainer();
    await container.preparePortfolio();
    await container.bootstrapHttpHandlers();
    await container.completeSinkSetup();

    setHttpModeActive(true);
    runtime = await createStreamableHttpRuntime(
      async (transport, authClaims) => {
        const sessionContext = createHttpSession({
          userId: authClaims?.sub,
          displayName: authClaims?.displayName,
          tenantId: authClaims?.tenantId,
          email: authClaims?.email,
        });
        const session = await container.createServerForHttpSession(sessionContext);
        await session.server.connect(transport);
        return { dispose: session.dispose };
      },
      {
        host: '127.0.0.1',
        port,
        mcpPath: '/mcp',
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
        oauthProvider: provider,
        authMiddleware: createUnifiedAuthMiddleware({
          provider,
          protectedResourceMetadataUrl: provider.getProtectedResourceMetadataUrl(),
        }),
      },
    );
  }, 20_000);

  afterEach(async () => {
    await runtime?.close().catch(() => {});
    await container?.dispose().catch(() => {});
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    setHttpModeActive(false);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('discovers OAuth, completes the interaction flow, and lists MCP tools with Bearer auth', async () => {
    // 1. Unauthenticated request returns 401 with discovery hint.
    const unauthorized = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource');

    // 2. Discover the AS metadata.
    const baseUrl = runtime.url.replace('/mcp', '');
    const metadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    const authServer = await metadata.json() as {
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
    };
    expect(authServer.authorization_endpoint).toBeTruthy();
    expect(authServer.token_endpoint).toBeTruthy();

    // 3. Begin the OAuth flow. Browsers send GET to /authorize per RFC 6749;
    //    expect 303 redirect to the interaction URL.
    const verifier = randomBytes(32).toString('base64url');
    const jar = new CookieJar();
    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: 'dollhouse-claude-connector',
      redirect_uri: 'http://127.0.0.1/callback',
      code_challenge: pkceS256(verifier),
      code_challenge_method: 'S256',
      resource: runtime.url,
      scope: 'mcp offline_access',
    });
    const authorize = await fetch(`${authServer.authorization_endpoint}?${authorizeParams}`, {
      method: 'GET',
      redirect: 'manual',
    });
    expect([302, 303]).toContain(authorize.status);
    jar.ingest(authorize.headers);
    const interactionUrl = absoluteUrl(baseUrl, authorize.headers.get('location'));
    expect(interactionUrl).toMatch(/\/interaction\//);

    // 4. GET the interaction page; render-html step yields the consent form + CSRF token.
    const consent = await fetch(interactionUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { Cookie: jar.header() },
    });
    expect(consent.status).toBe(200);
    jar.ingest(consent.headers);
    const consentHtml = await consent.text();
    const csrfMatch = consentHtml.match(/name="csrf_token"\s+value="([^"]+)"/);
    expect(csrfMatch).not.toBeNull();
    const csrfToken = csrfMatch![1];

    // 5. POST the consent form; the InteractionRouter saves a Grant and calls
    //    interactionFinished, which 303s back into oidc-provider's /auth/:uid.
    const consentPost = await fetch(interactionUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: jar.header(),
      },
      body: new URLSearchParams({ csrf_token: csrfToken, action: 'approve' }),
    });
    expect([302, 303]).toContain(consentPost.status);
    jar.ingest(consentPost.headers);

    // 6. Follow oidc-provider's redirect chain to the client redirect_uri.
    //    The exact path of internal hops is oidc-provider-internal — we just
    //    chase the Location header until we land on the registered redirect.
    let nextUrl: string | null = absoluteUrl(baseUrl, consentPost.headers.get('location'));
    let code: string | null = null;
    for (let hop = 0; hop < 10 && !code && nextUrl; hop += 1) {
      const followed = await fetch(nextUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { Cookie: jar.header() },
      });
      jar.ingest(followed.headers);
      const location = followed.headers.get('location');
      if (location && location.startsWith('http://127.0.0.1/callback')) {
        code = new URL(location).searchParams.get('code');
        break;
      }
      if (!location) break;
      nextUrl = absoluteUrl(baseUrl, location);
    }
    expect(code).toBeTruthy();

    // 7. Exchange the code for tokens. RFC 8707: include the same `resource`.
    const tokenResp = await fetch(authServer.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
        code: code!,
        code_verifier: verifier,
        resource: runtime.url,
      }),
    });
    expect(tokenResp.status).toBe(200);
    const tokenBody = await tokenResp.json() as { access_token: string; refresh_token?: string };
    expect(tokenBody.access_token).toBeTruthy();

    // 8. Use the access token over the MCP transport.
    const transport = new StreamableHTTPClientTransport(new URL(runtime.url), {
      requestInit: { headers: { Authorization: `Bearer ${tokenBody.access_token}` } },
    });
    const client = new Client(
      { name: 'oauth-http-test', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toContain('mcp_aql_read');
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
  }, 30_000);
});
