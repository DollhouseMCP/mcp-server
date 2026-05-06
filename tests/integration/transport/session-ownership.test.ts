/**
 * StreamableHTTP session-to-subject binding (H7).
 *
 * Pins: a session initialized by user A's bearer token cannot be
 * dispatched against by user B's bearer token, even if B has a valid
 * token and somehow knows the session id. Without this binding, anyone
 * with a valid bearer + a leaked or guessed `mcp-session-id` reaches
 * A's user-scoped DI container.
 *
 * The check lives in `StreamableHttpServer.ts` at the dispatch site
 * (compares `existingSession.ownerSub` to the bearer's `sub`); the
 * binding is set at session creation by reading `authClaims?.sub`.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { EmbeddedAuthorizationServer } from '../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { TrivialConsentMethod } from '../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import { createStreamableHttpRuntime } from '../../../src/server/StreamableHttpServer.js';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

interface InitializeResult {
  status: number;
  sessionId: string | null;
}

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'session-binding-test', version: '0.0.1' },
  },
};

const TOOL_LIST_BODY = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
};

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('StreamableHTTP session-to-subject binding (H7)', () => {
  let testDir: string;
  let runtime: import('../../../src/server/StreamableHttpServer.js').StreamableHttpRuntimeHandle;
  let mcpUrl: string;
  let tokenForUserA: string;
  let tokenForUserB: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-binding-'));
    const port = await getFreePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    mcpUrl = `${publicBaseUrl}/mcp`;

    const provider = new EmbeddedAuthorizationServer({
      publicBaseUrl,
      mcpPath: '/mcp',
      keyFilePath: path.join(testDir, 'oauth-key.json'),
      // Two methods are not necessary — we mint tokens directly via
      // provider.issue() for two different subjects, sidestepping the
      // OAuth flow.
      methods: [new TrivialConsentMethod({ defaultSubject: 'unused' })],
      storage: new InMemoryAuthStorageLayer(),
    });

    runtime = await createStreamableHttpRuntime(
      async (transport, authClaims) => {
        // Minimal session attachment: connect, expose a single tool list
        // so dispatch has something to do, and dispose on close.
        await transport.start();
        return {
          dispose: async () => { /* nothing extra to tear down */ },
          authClaims,
        } as never; // Loose any: the test only asserts HTTP status codes.
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

    // Phase 9 M3/Q6: tokens must carry the `mcp` scope to pass
    // validate(); otherwise both users get rejected before the
    // session-ownership check runs.
    tokenForUserA = await provider.issue('local_user-a', { scopes: ['mcp'] });
    tokenForUserB = await provider.issue('local_user-b', { scopes: ['mcp'] });
  }, 20_000);

  afterEach(async () => {
    await runtime?.close().catch(() => {});
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Drives a JSON-RPC initialize and returns the assigned session id.
   * The MCP SDK transport returns it via the `mcp-session-id` response
   * header.
   */
  async function initializeWithToken(token: string): Promise<InitializeResult> {
    const resp = await postJson(mcpUrl, INITIALIZE_BODY, {
      Authorization: `Bearer ${token}`,
    });
    return {
      status: resp.status,
      sessionId: resp.headers.get('mcp-session-id'),
    };
  }

  it('user A initializes a session; user B cannot dispatch against it', async () => {
    const aSession = await initializeWithToken(tokenForUserA);
    expect(aSession.status).toBe(200);
    expect(aSession.sessionId).toBeTruthy();
    const sessionId = aSession.sessionId!;

    // User B tries to dispatch a tools/list against A's session id.
    // Without H7 this would reach A's session and run with B's effective
    // bearer (but A's underlying user context). With H7 the server
    // detects the ownerSub mismatch and returns 403.
    const dispatchResp = await postJson(mcpUrl, TOOL_LIST_BODY, {
      Authorization: `Bearer ${tokenForUserB}`,
      'mcp-session-id': sessionId,
    });
    expect(dispatchResp.status).toBe(403);
    const body = await dispatchResp.json() as { error?: { message?: string } };
    expect(body.error?.message ?? '').toMatch(/Session does not belong to the authenticated user/);
  }, 20_000);

  it('user B cannot SSE-attach (GET) to user A\'s session', async () => {
    // H1 (Phase 9 review): the GET handler shares a lifecycle helper with
    // DELETE; the earlier shape skipped the ownership check there, so a
    // valid bearer + leaked session id could attach to someone else's
    // SSE stream and observe their server→client notifications.
    const aSession = await initializeWithToken(tokenForUserA);
    const sessionId = aSession.sessionId!;
    const attachResp = await fetch(mcpUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${tokenForUserB}`,
        'mcp-session-id': sessionId,
      },
    });
    expect(attachResp.status).toBe(403);
  }, 20_000);

  it('user B cannot terminate (DELETE) user A\'s session', async () => {
    // H1: same shared lifecycle helper; DELETE without the ownership
    // check let an attacker drop someone else's session.
    const aSession = await initializeWithToken(tokenForUserA);
    const sessionId = aSession.sessionId!;
    const deleteResp = await fetch(mcpUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${tokenForUserB}`,
        'mcp-session-id': sessionId,
      },
    });
    expect(deleteResp.status).toBe(403);

    // Confirm A's session survived B's failed attempt: A can still
    // dispatch a tools/list against the same session id.
    const stillAlive = await postJson(mcpUrl, TOOL_LIST_BODY, {
      Authorization: `Bearer ${tokenForUserA}`,
      'mcp-session-id': sessionId,
    });
    expect(stillAlive.status).not.toBe(404);
  }, 20_000);

  it('user A can dispatch their own session normally', async () => {
    const aSession = await initializeWithToken(tokenForUserA);
    expect(aSession.status).toBe(200);
    const sessionId = aSession.sessionId!;
    // Same bearer that initialized — should pass the ownership check.
    // The dispatch may still fail at the JSON-RPC layer (no real tool
    // wired in this minimal harness), but it MUST NOT fail at 403.
    const dispatchResp = await postJson(mcpUrl, TOOL_LIST_BODY, {
      Authorization: `Bearer ${tokenForUserA}`,
      'mcp-session-id': sessionId,
    });
    expect(dispatchResp.status).not.toBe(403);
  }, 20_000);

  it('dispatch without any bearer token against an authenticated session is rejected', async () => {
    const aSession = await initializeWithToken(tokenForUserA);
    const sessionId = aSession.sessionId!;
    // No Authorization header — auth middleware rejects with 401 before
    // reaching the session-binding check, but the important thing is
    // the unauthenticated request never reaches A's session.
    const dispatchResp = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify(TOOL_LIST_BODY),
    });
    expect([401, 403]).toContain(dispatchResp.status);
  }, 20_000);
});
