import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import request from 'supertest';

const describeSocketSmoke = process.env.DOLLHOUSE_RUN_SOCKET_SMOKE === 'true'
  ? describe
  : describe.skip;
const describeRuntimeControls = process.env.CI === 'true' || process.env.DOLLHOUSE_RUN_SOCKET_SMOKE === 'true'
  ? describe
  : describe.skip;

function resolveRequestUrl(input: URL | RequestInfo): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }

  if (input instanceof URL) {
    return input;
  }

  return new URL(String(input));
}

function resolveRequestMethod(input: URL | RequestInfo, init?: RequestInit): 'GET' | 'POST' | 'DELETE' {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  if (method === 'DELETE') {
    return 'DELETE';
  }

  if (method === 'GET') {
    return 'GET';
  }

  return 'POST';
}

function createRequestHeaders(input: URL | RequestInfo, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);

  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  return headers;
}

function headerValueToStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string | number | boolean =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      .map(item => String(item));
  }

  return [];
}

function createResponseHeaders(rawHeaders: Record<string, unknown>): Headers {
  const responseHeaders = new Headers();

  for (const [key, value] of Object.entries(rawHeaders)) {
    for (const headerValue of headerValueToStrings(value)) {
      responseHeaders.append(key, headerValue);
    }
  }

  return responseHeaders;
}

function applyRequestBody(
  testRequest: request.Test,
  method: 'GET' | 'POST' | 'DELETE',
  body: RequestInit['body'],
): void {
  if (!body || method === 'GET') {
    return;
  }

  if (typeof body === 'string') {
    testRequest.send(body);
    return;
  }

  if (body instanceof Uint8Array) {
    testRequest.send(Buffer.from(body));
  }
}

function createTestRequest(
  agent: request.SuperTest<request.Test>,
  method: 'GET' | 'POST' | 'DELETE',
  requestPath: string,
): request.Test {
  switch (method) {
    case 'GET':
      return agent.get(requestPath);
    case 'DELETE':
      return agent.delete(requestPath);
    default:
      return agent.post(requestPath);
  }
}

function waitForCondition(assertion: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (assertion()) {
        resolve();
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for condition after ${timeoutMs}ms`));
        return;
      }

      setTimeout(tick, 10);
    };

    tick();
  });
}

function createBufferedFetch(
  server: Parameters<typeof request>[0],
  mcpPath: string,
): typeof fetch {
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const requestUrl = resolveRequestUrl(input);
    const method = resolveRequestMethod(input, init);
    const headers = createRequestHeaders(input, init);

    // The SDK client probes GET /mcp for optional SSE support. Returning 405 tells it
    // to continue in POST-only mode, which is enough for this smoke coverage.
    if (method === 'GET' && requestUrl.pathname === mcpPath) {
      return new Response('', { status: 405, statusText: 'Method Not Allowed' });
    }

    const agent = request(server);
    const requestPath = `${requestUrl.pathname}${requestUrl.search}`;
    const testRequest = createTestRequest(agent, method, requestPath);

    headers.forEach((value, key) => {
      testRequest.set(key, value);
    });

    applyRequestBody(testRequest, method, init?.body);

    const response = await testRequest.buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });

    return new Response(response.body, {
      status: response.status,
      headers: createResponseHeaders(response.headers as Record<string, unknown>),
    });
  };
}

async function createHostedClient(
  serverHandle: import('../../../src/index.js').StreamableHttpRuntimeHandle,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client(
    {
      name: 'streamable-http-integration-test',
      version: '1.0.0',
    },
    {
      capabilities: {},
    },
  );

  const transport = new StreamableHTTPClientTransport(new URL(serverHandle.url), {
    fetch: createBufferedFetch(serverHandle.app, serverHandle.mcpPath),
  });

  await client.connect(transport);
  return { client, transport };
}

describeRuntimeControls('Streamable HTTP runtime controls', () => {
  let originalWebConsoleEnv: string | undefined;
  let originalPermissionServerEnv: string | undefined;

  beforeAll(() => {
    originalWebConsoleEnv = process.env.DOLLHOUSE_WEB_CONSOLE;
    originalPermissionServerEnv = process.env.DOLLHOUSE_PERMISSION_SERVER;
    process.env.DOLLHOUSE_WEB_CONSOLE = 'false';
    process.env.DOLLHOUSE_PERMISSION_SERVER = 'false';
  });

  afterAll(() => {
    if (originalWebConsoleEnv === undefined) {
      delete process.env.DOLLHOUSE_WEB_CONSOLE;
    } else {
      process.env.DOLLHOUSE_WEB_CONSOLE = originalWebConsoleEnv;
    }

    if (originalPermissionServerEnv === undefined) {
      delete process.env.DOLLHOUSE_PERMISSION_SERVER;
    } else {
      process.env.DOLLHOUSE_PERMISSION_SERVER = originalPermissionServerEnv;
    }
  });

  it('returns consistent JSON-RPC errors for invalid lifecycle requests', async () => {
    const { startStreamableHttpServer } = await import('../../../src/index.js');
    const serverHandle = await startStreamableHttpServer({
      host: '127.0.0.1',
      port: 0,
      registerSignalHandlers: false,
    });

    try {
      const missingSessionResponse = await request(serverHandle.app).get(serverHandle.mcpPath);
      expect(missingSessionResponse.status).toBe(400);
      expect(missingSessionResponse.body).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'A valid mcp-session-id header is required.' },
        id: null,
      });

      const unknownSessionResponse = await request(serverHandle.app)
        .delete(serverHandle.mcpPath)
        .set('mcp-session-id', 'missing-session');
      expect(unknownSessionResponse.status).toBe(404);
      expect(unknownSessionResponse.body).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unknown MCP session' },
        id: null,
      });
    } finally {
      await serverHandle.close();
    }
  });

  it('applies HTTP rate limiting after the configured burst', async () => {
    const { startStreamableHttpServer } = await import('../../../src/index.js');
    const serverHandle = await startStreamableHttpServer({
      host: '127.0.0.1',
      port: 0,
      registerSignalHandlers: false,
      rateLimitMaxRequests: 1,
      rateLimitWindowMs: 60_000,
    });

    try {
      const firstResponse = await request(serverHandle.app).get(serverHandle.mcpPath);
      expect(firstResponse.status).toBe(400);

      const secondResponse = await request(serverHandle.app).get(serverHandle.mcpPath);
      expect(secondResponse.status).toBe(429);
      expect(secondResponse.headers['retry-after']).toBeDefined();
      expect(secondResponse.body).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Rate limit exceeded' },
        id: null,
      });
    } finally {
      await serverHandle.close();
    }
  });

  it('expires idle sessions, reports memory snapshots, and keeps a warm pool', async () => {
    const { startStreamableHttpServer } = await import('../../../src/index.js');
    const serverHandle = await startStreamableHttpServer({
      host: '127.0.0.1',
      port: 0,
      registerSignalHandlers: false,
      sessionIdleTimeoutMs: 75,
      sessionPoolSize: 1,
    });

    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;

    try {
      expect(serverHandle.pooledSessionCount()).toBe(1);

      const hostedClient = await createHostedClient(serverHandle);
      client = hostedClient.client;
      transport = hostedClient.transport;

      expect(transport.sessionId).toBeTruthy();
      expect(serverHandle.activeSessionCount()).toBe(1);

      await waitForCondition(() => serverHandle.pooledSessionCount() === 1, 1000);

      const healthResponse = await request(serverHandle.app).get('/healthz');
      const readyResponse = await request(serverHandle.app).get('/readyz');

      expect(healthResponse.body.memory.heapUsed).toEqual(expect.any(Number));
      expect(readyResponse.body.memory.rss).toEqual(expect.any(Number));
      expect(readyResponse.body.activeSessions).toBe(1);
      expect(readyResponse.body.pooledSessions).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 125));

      const expiredSessionResponse = await request(serverHandle.app)
        .get(serverHandle.mcpPath)
        .set('mcp-session-id', transport.sessionId!);

      expect(expiredSessionResponse.status).toBe(404);
      expect(serverHandle.activeSessionCount()).toBe(0);
      expect(serverHandle.pooledSessionCount()).toBe(1);
    } finally {
      await client?.close();
      await serverHandle.close();
    }
  }, 30000);
});

describeSocketSmoke('Streamable HTTP transport', () => {
  let serverHandle: import('../../../src/index.js').StreamableHttpRuntimeHandle;
  let originalWebConsoleEnv: string | undefined;
  let originalPermissionServerEnv: string | undefined;

  beforeAll(async () => {
    originalWebConsoleEnv = process.env.DOLLHOUSE_WEB_CONSOLE;
    originalPermissionServerEnv = process.env.DOLLHOUSE_PERMISSION_SERVER;
    process.env.DOLLHOUSE_WEB_CONSOLE = 'false';
    process.env.DOLLHOUSE_PERMISSION_SERVER = 'false';

    const { startStreamableHttpServer } = await import('../../../src/index.js');
    serverHandle = await startStreamableHttpServer({
      host: '127.0.0.1',
      port: 0,
      registerSignalHandlers: false,
    });
  }, 60000);

  afterAll(async () => {
    await serverHandle?.close();

    if (originalWebConsoleEnv === undefined) {
      delete process.env.DOLLHOUSE_WEB_CONSOLE;
    } else {
      process.env.DOLLHOUSE_WEB_CONSOLE = originalWebConsoleEnv;
    }

    if (originalPermissionServerEnv === undefined) {
      delete process.env.DOLLHOUSE_PERMISSION_SERVER;
    } else {
      process.env.DOLLHOUSE_PERMISSION_SERVER = originalPermissionServerEnv;
    }
  }, 60000);

  it('exposes container-friendly health and readiness endpoints', async () => {
    expect(serverHandle.httpServer.address()).not.toBeNull();

    const healthResponse = await request(serverHandle.app).get('/healthz');
    const readyResponse = await request(serverHandle.app).get('/readyz');

    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body.ok).toBe(true);
    expect(healthResponse.body.transport).toBe('streamable-http');

    expect(readyResponse.status).toBe(200);
    expect(readyResponse.body.ready).toBe(true);
    expect(readyResponse.body.transport).toBe('streamable-http');
  });

  it('supports an SDK client listing tools and calling mcp_aql_read', async () => {
    const { client } = await createHostedClient(serverHandle);

    const toolsResult = await client.request(
      {
        method: 'tools/list',
        params: {},
      },
      ListToolsResultSchema,
    );

    expect(toolsResult.tools.some(tool => tool.name === 'mcp_aql_read')).toBe(true);

    const buildInfoResult = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'mcp_aql_read',
          arguments: {
            operation: 'get_build_info',
          },
        },
      },
      CallToolResultSchema,
    );

    const textContent = buildInfoResult.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n');

    expect(textContent).toContain('Build Information');
    expect(textContent).toContain('@dollhousemcp/mcp-server');

    await client.close();
  });
});
