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
import { EmbeddedOAuthProvider } from '../../../src/auth/EmbeddedOAuthProvider.js';
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

describe('Embedded OAuth + Streamable HTTP auth', () => {
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
    const provider = new EmbeddedOAuthProvider({
      publicBaseUrl,
      mcpPath: '/mcp',
      keyFilePath: path.join(testDir, 'oauth-key.json'),
      stateFilePath: path.join(testDir, 'oauth-state.json'),
      defaultSubject: 'oauth-http-user',
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

  it('discovers OAuth, obtains a token, and lists MCP tools with Bearer auth', async () => {
    const unauthorized = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource');

    const metadata = await fetch(`${runtime.url.replace('/mcp', '')}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    const authServer = await metadata.json() as { authorization_endpoint: string; token_endpoint: string };

    const verifier = randomBytes(32).toString('base64url');
    const authorize = await fetch(authServer.authorization_endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
        code_challenge: pkceS256(verifier),
        code_challenge_method: 'S256',
        resource: runtime.url,
        scope: 'mcp offline_access',
      }),
    });
    expect(authorize.status).toBe(302);
    const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await fetch(authServer.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
        code: code ?? '',
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = await token.json() as { access_token: string; refresh_token: string };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.refresh_token).toBeTruthy();

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
  }, 20_000);
});
