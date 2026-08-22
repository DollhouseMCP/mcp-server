import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Router } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createStreamableHttpRuntime, type StreamableHttpRuntimeHandle } from '../../../src/server/StreamableHttpServer.js';

describe('streamable HTTP request body ceiling', () => {
  let runtime: StreamableHttpRuntimeHandle | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it.each([
    ['below', 1, 400],
    ['exactly at', 0, 400],
    ['above', -1, 413],
  ] as const)('%s the configured byte limit returns the expected status', async (_label, delta, expectedStatus) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'not-an-initialize-request',
      params: { padding: 'x'.repeat(128) },
    });
    const bodyBytes = Buffer.byteLength(body);
    runtime = await createStreamableHttpRuntime(
      async () => { throw new Error('non-initialize request must not create a session'); },
      {
        host: '127.0.0.1',
        port: 0,
        bodyLimitBytes: bodyBytes + delta,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
      },
    );

    const response = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(expectedStatus);
    const payload = await response.json() as { error?: { message?: string } };
    expect(payload.error?.message).toBe(expectedStatus === 413
      ? 'MCP request body exceeds the configured limit'
      : 'Initialization request required before session use');
  });

  it('rejects an invalid Host before reading an oversized JSON body', async () => {
    const authMiddleware = jest.fn((_req, _res, next) => next());
    runtime = await createStreamableHttpRuntime(
      async () => { throw new Error('invalid Host must not create a session'); },
      {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['trusted.example'],
        bodyLimitBytes: 64,
        rateLimitMaxRequests: 1,
        rateLimitWindowMs: 60_000,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
        authMiddleware,
      },
    );

    const response = await fetch(runtime.url, {
      method: 'POST',
      headers: { host: 'untrusted.example', 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024) }),
    });

    expect(response.status).toBe(403);
    expect(authMiddleware).not.toHaveBeenCalled();
  });

  it('authenticates before reading an oversized JSON body', async () => {
    const authMiddleware = jest.fn((_req, res) => {
      res.status(401).json({ error: 'missing_token' });
    });
    runtime = await createStreamableHttpRuntime(
      async () => { throw new Error('unauthenticated request must not create a session'); },
      {
        host: '127.0.0.1',
        port: 0,
        bodyLimitBytes: 64,
        rateLimitMaxRequests: 1,
        rateLimitWindowMs: 60_000,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
        authMiddleware,
      },
    );

    const response = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024) }),
    });

    expect(response.status).toBe(401);
    expect(authMiddleware).toHaveBeenCalledTimes(1);
  });

  it('applies the authenticated MCP rate limit before reading another oversized body', async () => {
    runtime = await createStreamableHttpRuntime(
      async () => { throw new Error('non-initialize request must not create a session'); },
      {
        host: '127.0.0.1',
        port: 0,
        bodyLimitBytes: 128,
        rateLimitMaxRequests: 1,
        rateLimitWindowMs: 60_000,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
        authMiddleware: (_req, _res, next) => next(),
      },
    );

    const first = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'invalid' }),
    });
    const second = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024) }),
    });

    expect(first.status).toBe(400);
    expect(second.status).toBe(429);
  });

  it('drains accepted MCP requests, including trailing-slash routes, before process-level shutdown', async () => {
    let releaseAuth!: () => void;
    let markAuthEntered!: () => void;
    const authEntered = new Promise<void>(resolve => { markAuthEntered = resolve; });
    const authGate = new Promise<void>(resolve => { releaseAuth = resolve; });
    const onShutdown = jest.fn().mockResolvedValue(undefined);
    runtime = await createStreamableHttpRuntime(
      async () => { throw new Error('non-initialize request must not create a session'); },
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        shutdownGracePeriodMs: 1_000,
        registerSignalHandlers: false,
        authMiddleware: (_req, _res, next) => {
          markAuthEntered();
          void authGate.then(() => next());
        },
        onShutdown,
      },
    );
    const request = fetch(`${runtime.url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'invalid' }),
    });
    await authEntered;

    let shutdownFinished = false;
    const shutdown = runtime.close().then(() => { shutdownFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(shutdownFinished).toBe(false);
    expect(onShutdown).not.toHaveBeenCalled();

    releaseAuth();
    const response = await request;
    expect(response.status).toBe(400);
    await shutdown;
    expect(onShutdown).toHaveBeenCalledTimes(1);
    runtime = null;
  });

  it('bounds attachment disposal after shutdown grace expires', async () => {
    const onShutdown = jest.fn().mockResolvedValue(undefined);
    runtime = await createStreamableHttpRuntime(
      async (transport) => {
        const server = new Server(
          { name: 'shutdown-timeout-test', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        await server.connect(transport);
        return {
          contextSessionId: 'shutdown-timeout-session',
          dispose: () => new Promise<void>(() => {}),
        };
      },
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        shutdownGracePeriodMs: 20,
        sessionDisposalTimeoutMs: 20,
        registerSignalHandlers: false,
        onShutdown,
      },
    );
    const initialize = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });
    expect(initialize.status).toBe(200);

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(onShutdown).toHaveBeenCalledTimes(1);
    runtime = null;
  });

  it('fails session initialization closed when durable runtime presence cannot be registered', async () => {
    const dispose = jest.fn(async () => {});
    const registerSession = jest.fn(async () => { throw new Error('presence database unavailable'); });
    runtime = await createStreamableHttpRuntime(
      async (transport) => {
        const server = new Server(
          { name: 'presence-registration-test', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        await server.connect(transport);
        return {
          contextSessionId: 'presence-registration-session',
          runtimeSession: {
            userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
            accountCorrelationId: '11df9917-b534-4014-a03f-e2eb1f0c6fef',
          },
          dispose,
        };
      },
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
        runtimeSessionControl: {
          registerSession,
          recordActivity: jest.fn(async () => undefined),
          markSessionDisposed: jest.fn(async () => undefined),
          reconcilePendingCommands: jest.fn(async () => 0),
        },
      },
    );

    const response = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });

    expect(response.status).toBe(500);
    expect(registerSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'presence-registration-session',
    }));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(runtime.activeSessionCount()).toBe(0);
  });

  it('keeps termination retryable until durable runtime presence closes', async () => {
    const sessionId = 'durable-close-retry-session';
    const results: string[] = [];
    let armed = false;
    const markSessionDisposed = jest.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('presence database unavailable'))
      .mockResolvedValue(undefined);
    runtime = await createStreamableHttpRuntime(
      async transport => {
        const server = new Server(
          { name: 'durable-close-retry-test', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        await server.connect(transport);
        return {
          contextSessionId: sessionId,
          runtimeSession: {
            userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
            accountCorrelationId: '11df9917-b534-4014-a03f-e2eb1f0c6fef',
          },
          dispose: async () => server.close(),
        };
      },
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        runtimeCommandPollIntervalMs: 10,
        registerSignalHandlers: false,
        runtimeSessionControl: {
          registerSession: jest.fn(async () => undefined),
          recordActivity: jest.fn(async () => undefined),
          markSessionDisposed,
          reconcilePendingCommands: jest.fn(async terminator => {
            if (!armed || results.includes('already_absent')) return 0;
            results.push(await terminator.terminateLocalSession(sessionId));
            return 1;
          }),
        },
      },
    );
    const initialize = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });
    expect(initialize.status).toBe(200);
    armed = true;

    await waitUntil(() => results.includes('already_absent'));

    expect(results).toEqual(['retry', 'already_absent']);
    expect(markSessionDisposed).toHaveBeenCalledTimes(2);
  });

  it('keeps termination retryable until the local session attachment closes', async () => {
    const sessionId = 'attachment-close-retry-session';
    const results: string[] = [];
    let armed = false;
    const dispose = jest.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('attachment still draining'))
      .mockResolvedValue(undefined);
    runtime = await createStreamableHttpRuntime(
      async transport => {
        const server = new Server(
          { name: 'attachment-close-retry-test', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        await server.connect(transport);
        return {
          contextSessionId: sessionId,
          runtimeSession: {
            userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
            accountCorrelationId: '11df9917-b534-4014-a03f-e2eb1f0c6fef',
          },
          dispose,
        };
      },
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        runtimeCommandPollIntervalMs: 10,
        registerSignalHandlers: false,
        runtimeSessionControl: {
          registerSession: jest.fn(async () => undefined),
          recordActivity: jest.fn(async () => undefined),
          markSessionDisposed: jest.fn(async () => undefined),
          reconcilePendingCommands: jest.fn(async terminator => {
            if (!armed || results.includes('terminated')) return 0;
            results.push(await terminator.terminateLocalSession(sessionId));
            return 1;
          }),
        },
      },
    );
    const initialize = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });
    expect(initialize.status).toBe(200);
    armed = true;

    await waitUntil(() => results.includes('terminated'));

    expect(results).toEqual(['retry', 'terminated']);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('retries a failed idle-session attachment disposal without runtime control polling', async () => {
    const dispose = jest.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('attachment still draining'))
      .mockResolvedValue(undefined);
    runtime = await createStreamableHttpRuntime(
      async transport => {
        const server = new Server(
          { name: 'attachment-idle-retry-test', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        await server.connect(transport);
        return {
          contextSessionId: 'attachment-idle-retry-session',
          dispose,
        };
      },
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 10,
        sessionPoolSize: 0,
        runtimeCommandPollIntervalMs: 10,
        registerSignalHandlers: false,
      },
    );
    const initialize = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });
    expect(initialize.status).toBe(200);

    await waitUntil(() => dispose.mock.calls.length >= 2);

    expect(dispose).toHaveBeenCalledTimes(2);
    expect(runtime.activeSessionCount()).toBe(0);
  });

  it('closes non-MCP streams before process-level shutdown', async () => {
    const router = Router();
    let streamOpened!: () => void;
    const opened = new Promise<void>(resolve => { streamOpened = resolve; });
    router.get('/api/v1/test-stream', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ready\ndata: {}\n\n');
      streamOpened();
    });
    const onShutdown = jest.fn().mockResolvedValue(undefined);
    runtime = await createStreamableHttpRuntime(
      async () => { throw new Error('MCP session creation is not expected'); },
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        shutdownGracePeriodMs: 250,
        registerSignalHandlers: false,
        webConsoleApiV1: { router, markMounted: () => {} },
        onShutdown,
      },
    );

    const streamRequest = fetch(`${runtime.url.replace(/\/mcp$/, '')}/api/v1/test-stream`)
      .then(response => response.text())
      .catch(() => 'closed');
    await opened;

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(onShutdown).toHaveBeenCalledTimes(1);
    await streamRequest;
    runtime = null;
  });

  it('keeps disconnected MCP work in flight until the async handler completes', async () => {
    let handlerEntered!: () => void;
    let releaseHandler!: () => void;
    const entered = new Promise<void>(resolve => { handlerEntered = resolve; });
    const handlerGate = new Promise<void>(resolve => { releaseHandler = resolve; });
    const servers: Server[] = [];
    const onShutdown = jest.fn().mockResolvedValue(undefined);
    const markSessionDisposed = jest.fn(async () => undefined);
    runtime = await createStreamableHttpRuntime(
      async (transport) => {
        const server = new Server(
          { name: 'shutdown-test', version: '1.0.0' },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: 'blocked', description: 'Waits for the test gate', inputSchema: { type: 'object' } }],
        }));
        server.setRequestHandler(CallToolRequestSchema, async () => {
          handlerEntered();
          await handlerGate;
          return { content: [{ type: 'text', text: 'done' }] };
        });
        await server.connect(transport);
        servers.push(server);
        return {
          contextSessionId: 'shutdown-disconnect-session',
          runtimeSession: {
            userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
            accountCorrelationId: '11df9917-b534-4014-a03f-e2eb1f0c6fef',
          },
          waitForRequest: async requestId => {
            if (requestId === 2) await handlerGate;
          },
          dispose: async () => server.close(),
        };
      },
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        shutdownGracePeriodMs: 1_000,
        registerSignalHandlers: false,
        onShutdown,
        runtimeSessionControl: {
          registerSession: jest.fn(async () => undefined),
          recordActivity: jest.fn(async () => undefined),
          markSessionDisposed,
          reconcilePendingCommands: jest.fn(async () => 0),
        },
      },
    );
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const initialize = await fetch(runtime.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'shutdown-test', version: '1.0.0' },
        },
      }),
    });
    const sessionId = initialize.headers.get('mcp-session-id');
    expect(initialize.status).toBe(200);
    expect(sessionId).toBe('shutdown-disconnect-session');

    const controller = new AbortController();
    const call = fetch(runtime.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'blocked', arguments: {} } }),
      signal: controller.signal,
    }).catch(() => null);
    await entered;
    controller.abort();
    await call;

    let shutdownFinished = false;
    const shutdown = runtime.close().then(() => { shutdownFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(shutdownFinished).toBe(false);
    expect(onShutdown).not.toHaveBeenCalled();
    expect(markSessionDisposed).not.toHaveBeenCalled();

    releaseHandler();
    await shutdown;
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(markSessionDisposed).toHaveBeenCalledWith(sessionId);
    expect(servers).toHaveLength(1);
    runtime = null;
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for runtime condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
