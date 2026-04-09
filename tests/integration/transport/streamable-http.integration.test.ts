import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import request from 'supertest';

const describeSocketSmoke = process.env.DOLLHOUSE_RUN_SOCKET_SMOKE === 'true'
  ? describe
  : describe.skip;

function createBufferedFetch(server: import('node:http').Server, mcpPath: string): typeof fetch {
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const requestUrl = input instanceof Request
      ? new URL(input.url)
      : input instanceof URL
        ? input
        : new URL(String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    // The SDK client probes GET /mcp for optional SSE support. Returning 405 tells it
    // to continue in POST-only mode, which is enough for this smoke coverage.
    if (method === 'GET' && requestUrl.pathname === mcpPath) {
      return new Response('', { status: 405, statusText: 'Method Not Allowed' });
    }

    const agent = request(server);
    let testRequest;
    switch (method) {
      case 'GET':
        testRequest = agent.get(`${requestUrl.pathname}${requestUrl.search}`);
        break;
      case 'DELETE':
        testRequest = agent.delete(`${requestUrl.pathname}${requestUrl.search}`);
        break;
      default:
        testRequest = agent.post(`${requestUrl.pathname}${requestUrl.search}`);
        break;
    }

    headers.forEach((value, key) => {
      testRequest.set(key, value);
    });

    if (init?.body && method !== 'GET') {
      if (typeof init.body === 'string') {
        testRequest.send(init.body);
      } else if (init.body instanceof Uint8Array) {
        testRequest.send(Buffer.from(init.body));
      }
    }

    const response = await testRequest.buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) {
        value.forEach((item) => responseHeaders.append(key, String(item)));
      } else if (value !== undefined) {
        responseHeaders.set(key, String(value));
      }
    }

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  };
}

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

    const healthResponse = await request(serverHandle.httpServer).get('/healthz');
    const readyResponse = await request(serverHandle.httpServer).get('/readyz');

    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body.ok).toBe(true);
    expect(healthResponse.body.transport).toBe('streamable-http');

    expect(readyResponse.status).toBe(200);
    expect(readyResponse.body.ready).toBe(true);
    expect(readyResponse.body.transport).toBe('streamable-http');
  });

  it('supports an SDK client listing tools and calling mcp_aql_read', async () => {
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
      fetch: createBufferedFetch(serverHandle.httpServer, serverHandle.mcpPath),
    });
    await client.connect(transport);

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
