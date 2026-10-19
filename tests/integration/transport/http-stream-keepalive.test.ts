import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readHttpResponse, assertSseResponse } from '../../helpers/httpResponseAssertions.js';
import { preConfirmAllOperations } from '../../helpers/portfolioTestHelper.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import type { AuthClaims } from '../../../src/auth/IAuthProvider.js';
import { OidcAuthProvider } from '../../../src/auth/OidcAuthProvider.js';
import { decodeJwt, SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import { logger } from '../../../src/utils/logger.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { InMemoryRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js';
import { RuntimeMcpSessionControlService } from '../../../src/web-console/services/runtime/RuntimeMcpSessionControlService.js';
import { createHttpTestEnvironment, type HttpTestEnvironment } from '../../helpers/httpTransportHelper.js';

const userId = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const store = new InMemoryRuntimeSessionControlStore();
const control = new RuntimeMcpSessionControlService({ store, replicaId: 'keepalive-test', leaseDurationMs: 30_000 });
let env: HttpTestEnvironment;
let requestId = 0;
let pauseNextGet = false;
let token = 'owner';
let signedProvider: OidcAuthProvider;
let signingKey: CryptoKey;
async function signedCredential(ttlSeconds: number, overrides: Record<string, string> = {}) {
  return new SignJWT({ scope: 'mcp', client_id: 'client', grant_id: 'grant', ...overrides })
    .setProtectedHeader({ alg: 'ES256', kid: 'stream-key', typ: 'at+jwt' })
    .setIssuer('https://stream-test.example').setAudience('mcp').setSubject(userId)
    .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds).sign(signingKey);
}
const credentials = new Map<string, AuthClaims>([['owner', { sub: userId }], ['other', { sub: 'other-user' }]]);
const transports: StreamableHTTPServerTransport[] = [];
const responses = new Map<string, ServerResponse>();
let activity: jest.SpiedFunction<typeof control.recordActivity>;
let renewal: jest.SpiedFunction<typeof control.renewSessionLease>;
beforeEach(() => { activity = jest.spyOn(control, 'recordActivity'); renewal = jest.spyOn(control, 'renewSessionLease'); });
async function settledActivity() { await activity.mock.results.at(-1)?.value; }
async function ended(reader: ReadableStreamDefaultReader<Uint8Array>) {
  // Every caller has already requested a bounded server close; cap the read wait.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Stream did not end')), 3000); });
  const drain = async () => {
    try { for (;;) { if ((await reader.read()).done) return true; } }
    catch { return true; }
  };
  try { return await Promise.race([drain(), timeout]); }
  finally { clearTimeout(deadline); }
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const headers = (sessionId?: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) });
async function rpc(method: string, params: unknown, sessionId?: string, expectedStatus = 200) {
  const response = await fetch(env.runtime.url, { method: 'POST', headers: headers(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) });
  const text = await readHttpResponse(response, expectedStatus, `MCP POST ${method}`, true);
  return { response, text };
}
async function initialize() {
  const { response } = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'keepalive-raw', version: '1' } });
  expect(response.status).toBe(200);
  return response.headers.get('mcp-session-id')!;
}
async function open(sessionId: string) {
  const abort = new AbortController();
  const response = await fetch(env.runtime.url, { headers: { ...headers(sessionId), Accept: 'text/event-stream' }, signal: abort.signal });
  await assertSseResponse(response);
  const reader = response.body!.getReader();
  return { abort, reader, response };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not settle');
    await wait(10);
  }
}

beforeAll(async () => {
  env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 250, streamKeepaliveMs: 20, runtimeCommandPollIntervalMs: 10,
    authMiddleware: createUnifiedAuthMiddleware({ provider: { name: 'keepalive-fixture', validate: async value => {
      const claims = credentials.get(value);
      if (!claims) return signedProvider.validate(value);
      return claims && (claims.exp === undefined || claims.exp * 1000 > Date.now())
        ? { ok: true, claims } : { ok: false, reason: 'expired-or-invalid' };
    } } }),
    onTransport: transport => {
      transports.push(transport);
      const original = transport.handleRequest.bind(transport);
      jest.spyOn(transport, 'handleRequest').mockImplementation((req, res, body) => {
        if (req.method === 'GET' && transport.sessionId) responses.set(transport.sessionId, res);
        if (req.method === 'GET' && pauseNextGet) {
          pauseNextGet = false;
          return new Promise<void>(resolve => { res.once('close', () => resolve()); });
        }
        return original(req, res, body);
      });
    }, runtimeSessionControl: control, runtimeSession: { userId, accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' } });
  const keys = await generateKeyPair('ES256', { extractable: true });
  signingKey = keys.privateKey;
  signedProvider = new OidcAuthProvider({ issuer: 'https://stream-test.example', audience: 'mcp', jwksGetter: createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'stream-key', alg: 'ES256' }] }) });
  preConfirmAllOperations(env.container);
}, 30_000);
afterAll(async () => { await env?.cleanup(); });

describe('real SDK/Hono stream keepalive', () => {
  it('retains session, activation and presence beyond idle timeout without counting ticks or final close', async () => {
    const sid = await initialize();
    const created = await rpc('tools/call', { name: 'mcp_aql_create', arguments: { operation: 'create_element', params: { element_name: 'keepalive-proof', element_type: 'skill', description: 'Transport retention proof', content: 'Retain during quiet streams.' } } }, sid);
    expect(created.text).toContain('success');
    const activated = await rpc('tools/call', { name: 'mcp_aql_read', arguments: { operation: 'activate_element', element_type: 'skill', params: { element_name: 'keepalive-proof' } } }, sid);
    expect(activated.text).toContain('activated');
    await settledActivity();
    const beforeOpen = await store.findPresence(sid);
    const stream = await open(sid);
    try {
      const first = await stream.reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(': keepalive\n\n');
      await settledActivity();
      const before = await store.findPresence(sid);
      expect(before).not.toBeNull();
      expect(before!.requestCount).toBe(beforeOpen!.requestCount + 1);
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      // Prove quiet ticks do not dispose the session or count as activity past idle grace.
      await wait(750);
      const after = await store.findPresence(sid);
      expect(after).toMatchObject({ requestCount: before!.requestCount, errorCount: before!.errorCount, lastActiveAt: before!.lastActiveAt });
      expect(audit).not.toHaveBeenCalled(); audit.mockRestore();
      const active = await rpc('tools/call', { name: 'mcp_aql_read', arguments: { operation: 'get_active_elements', element_type: 'skill' } }, sid);
      expect(active.response.status).toBe(200); expect(active.text).toContain('keepalive-proof');
      await settledActivity();
      const atClose = await store.findPresence(sid);
      const renewals = renewal.mock.calls.length;
      stream.abort.abort();
      await until(() => renewal.mock.calls.length > renewals);
      await renewal.mock.results.at(-1)?.value;
      expect(await store.findPresence(sid)).toMatchObject({ requestCount: atClose!.requestCount, lastActiveAt: atClose!.lastActiveAt });
      await until(async () => !await store.findPresence(sid));
      expect((await rpc('ping', {}, sid, 404)).response.status).toBe(404);
    } finally { stream.abort.abort(); }
  });

  it('replaces an accepted GET with newest-wins and preserves it after a rejected GET', async () => {
    const sid = await initialize(); const first = await open(sid);
    await first.reader.read();
    const second = await open(sid);
    try {
      await second.reader.read();
      expect(await ended(first.reader)).toBe(true);
      const rejected = await fetch(env.runtime.url, { headers: { ...headers(sid), Accept: 'application/json' } });
      await readHttpResponse(rejected, 406, 'Rejected SSE GET');
      // Prove a rejected GET does not cause the retained stream to idle-expire.
      await wait(350);
      expect((await rpc('ping', {}, sid)).response.status).toBe(200);
      expect(await store.findPresence(sid)).not.toBeNull();
    } finally { first.abort.abort(); second.abort.abort(); }
  });

  it('DELETE closes an open stream immediately and init then immediate DELETE leaves no active row', async () => {
    for (const withStream of [true, false]) {
      const sid = await initialize(); const stream = withStream ? await open(sid) : undefined;
      if (stream) await stream.reader.read();
      const deleted = await fetch(env.runtime.url, { method: 'DELETE', headers: headers(sid) });
      await readHttpResponse(deleted, 200, 'Session DELETE');
      await until(async () => !await store.findPresence(sid));
      expect((await rpc('ping', {}, sid, 404)).response.status).toBe(404);
      stream?.abort.abort();
    }
  });

  it('operator termination tears down locally before a delayed durable close', async () => {
    const sid = await initialize(); const stream = await open(sid); await stream.reader.read();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = control.markSessionDisposed.bind(control);
    const close = jest.spyOn(control, 'markSessionDisposed').mockImplementation(async id => { await pending; await original(id); });
    try {
      await store.createTerminationCommand({ sessionId: sid, targetReplicaId: 'keepalive-test', reason: 'operator_terminated', requestedAt: new Date(), requestedBy: { kind: 'operator', userId } });
      await until(() => !env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(sid));
      // The local container and stream are gone although the durable close is blocked.
      expect((await rpc('ping', {}, sid, 404)).response.status).toBe(404);
      expect(close).toHaveBeenCalledWith(sid);
      release(); await until(async () => !await store.findPresence(sid));
    } finally { release(); close.mockRestore(); stream.abort.abort(); }
  });

  it('expires a client without a GET stream', async () => {
    const sid = await initialize();
    await until(async () => !await store.findPresence(sid));
    expect((await rpc('ping', {}, sid, 404)).response.status).toBe(404);
    expect(await store.findPresence(sid)).toBeNull();
  });

  it('warns once for an accepted authenticated exp-less stream without a lifetime cap', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const sid = await initialize(); const stream = await open(sid);
    try {
      await stream.reader.read(); await wait(80);
      const warnings = warn.mock.calls.filter(([message, context]) =>
        String(message).includes('credential has no expiry') && (context as { sessionId?: string })?.sessionId === sid);
      expect(warnings).toHaveLength(1);
    } finally { stream.abort.abort(); warn.mockRestore(); }
  });

  it('does not warn about exp-less streams when authentication is disabled', async () => {
    const previousEnv = env;
    const warn = jest.spyOn(logger, 'warn');
    env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 1500, streamKeepaliveMs: 20 });
    let stream: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const sid = await initialize(); stream = await open(sid); await stream.reader.read(); await wait(60);
      expect(warn.mock.calls.filter(([message]) => String(message).includes('credential has no expiry'))).toHaveLength(0);
    } finally { stream?.abort.abort(); await env.cleanup(); env = previousEnv; warn.mockRestore(); }
  });

  it('SDK client parses notifications interleaved with comment frames', async () => {
    let comments = 0;
    const transport = new StreamableHTTPClientTransport(new URL(env.runtime.url), {
      requestInit: { headers: { Authorization: 'Bearer owner' } },
      fetch: async (input, init) => {
        const result = await fetch(input, init);
        if (init?.method !== 'GET' || !result.body || result.status !== 200) return result;
        const decoder = new TextDecoder();
        const body = result.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
          comments += decoder.decode(chunk, { stream: true }).split(': keepalive').length - 1;
          controller.enqueue(chunk);
        } }));
        return new Response(body, { status: result.status, headers: result.headers });
      },
    });
    const client = new Client({ name: 'comment-parser', version: '1' });
    const notifications: unknown[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, notification => { notifications.push(notification); });
    try {
      await client.connect(transport); await until(() => comments >= 2);
      const child = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(transport.sessionId!)!;
      const server = child.resolve<Server>('Server');
      for (let i = 0; i < 3; i++) {
        await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { marker: i, text: 'λ'.repeat(20_000) } } });
        await until(() => notifications.length === i + 1);
      }
      await until(() => notifications.length === 3);
      await until(() => comments >= 3);
      for (const [i, notification] of notifications.entries()) expect(notification).toMatchObject({ params: { _meta: { marker: i, text: 'λ'.repeat(20_000) } } });
    } finally { await transport.terminateSession(); await client.close(); }
  });
  it('replaces a pending GET before its headers are accepted', async () => {
    const sid = await initialize(); pauseNextGet = true;
    const first = fetch(env.runtime.url, { headers: headers(sid) }).catch(() => undefined);
    await until(() => responses.has(sid));
    const pending = responses.get(sid)!;
    expect(pending.headersSent).toBe(false);
    const replacement = await open(sid);
    try {
      expect(pending.destroyed).toBe(true);
      expect(await first).toBeUndefined();
      expect((await replacement.reader.read()).done).toBe(false);
    } finally { pauseNextGet = false; replacement.abort.abort(); }
  });

  it('graceful SDK stream close starts idle grace and final renewal', async () => {
    const sid = await initialize(); const stream = await open(sid); await stream.reader.read();
    const before = renewal.mock.calls.length;
    transports.find(transport => transport.sessionId === sid)!.closeStandaloneSSEStream();
    expect(await ended(stream.reader)).toBe(true);
    await until(() => renewal.mock.calls.length > before);
    await until(() => !env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(sid));
    expect((await rpc('ping', {}, sid, 404)).response.status).toBe(404);
  });

  it('destroys a stalled GET with the SDK as the sole heartbeat writer', async () => {
    const sid = await initialize(); const stream = await open(sid);
    const first = await stream.reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(': keepalive\n\n');
    const response = responses.get(sid)!;
    const writes = jest.spyOn(response, 'write');
    Object.defineProperty(response, 'writableNeedDrain', { configurable: true, get: () => true });
    try {
      expect(await ended(stream.reader)).toBe(true);
      expect(response.destroyed).toBe(true);
      // Only SDK-encoded comments reach Node; the watcher never calls write().
      expect(writes.mock.calls.length).toBeGreaterThan(0);
      for (const [chunk] of writes.mock.calls) {
        expect(chunk).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(chunk as Uint8Array)).toBe(': keepalive\n\n');
      }
    } finally { writes.mockRestore(); stream.abort.abort(); }
  });

  it('retires a backpressured reader before replacement; late abort cannot remove notification routing', async () => {
    const sid = await initialize(); const first = await open(sid); await first.reader.read();
    const response = responses.get(sid)!;
    response.cork();
    const server = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(sid)!.resolve<Server>('Server');
    for (let i = 0; i < 8; i++) await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { text: 'x'.repeat(128_000) } } });
    await until(() => response.writableNeedDrain);
    const second = await open(sid);
    try {
      expect(response.destroyed).toBe(true);
      expect(await ended(first.reader)).toBe(true);
      first.abort.abort();
      await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { marker: 'replacement-proof' } } });
      let received = '';
      while (!received.includes('replacement-proof')) {
        const chunk = await second.reader.read();
        if (chunk.done) throw new Error('Replacement stream ended before notification');
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received).toContain('replacement-proof');
    } finally { first.abort.abort(); second.abort.abort(); }
  });

  it('preserves session during transient store errors, including POST activity', async () => {
    const sid = await initialize(); const stream = await open(sid); await stream.reader.read();
    const heartbeat = jest.spyOn(store, 'heartbeatPresence').mockRejectedValueOnce(new Error('transient activity failure'));
    expect((await rpc('ping', {}, sid)).response.status).toBe(200);
    await settledActivity().catch(() => {});
    const fail = jest.spyOn(store, 'renewSessionLease').mockRejectedValueOnce(new Error('transient renewal failure'));
    transports.find(transport => transport.sessionId === sid)!.closeStandaloneSSEStream();
    await ended(stream.reader);
    const next = await open(sid); await next.reader.read();
    await until(() => fail.mock.calls.length >= 2);
    await renewal.mock.results.at(-1)?.value;
    expect((await rpc('ping', {}, sid)).response.status).toBe(200);
    heartbeat.mockRestore(); fail.mockRestore(); next.abort.abort();
  });

  it('renews the original expired stream only from a same-binding signed POST and resyncs once', async () => {
    const sid = await initialize();
    const activation = await rpc('tools/call', { name: 'mcp_aql_read', arguments: { operation: 'activate_element', element_type: 'skill', params: { element_name: 'keepalive-proof' } } }, sid);
    expect(activation.text).toContain('activated');
    const shortCredential = await signedCredential(2);
    const freshCredential = await signedCredential(60);
    const expiresAt = decodeJwt(shortCredential).exp! * 1000;
    token = shortCredential;
    const first = await open(sid);
    const firstResponse = responses.get(sid)!;
    const transport = transports.find(item => item.sessionId === sid)!;
    const getCount = () => jest.mocked(transport.handleRequest).mock.calls.filter(([req]) => req.method === 'GET').length;
    const server = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(sid)!.resolve<Server>('Server');
    let received = ''; let expiredHeartbeats = 0;
    const collecting = (async () => {
      try {
        for (;;) {
          const chunk = await first.reader.read();
          if (chunk.done) return;
          const text = new TextDecoder().decode(chunk.value);
          received += text;
          if (Date.now() >= expiresAt && text.includes(': keepalive\n\n')) expiredHeartbeats++;
        }
      } catch (error) { if (!first.abort.signal.aborted && !firstResponse.destroyed) throw error; }
    })();
    try {
      await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { marker: 'before-expiry' } } });
      await until(() => received.includes('before-expiry'));
      await until(() => Date.now() >= expiresAt + 50);
      await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { marker: 'must-be-dropped' } } });
      const heartbeats = expiredHeartbeats;
      await until(() => expiredHeartbeats >= heartbeats + 2);
      expect(received).not.toContain('must-be-dropped');
      expect(firstResponse.destroyed).toBe(false); expect(responses.get(sid)).toBe(firstResponse);
      expect(getCount()).toBe(1);
      expect((await rpc('ping', {}, sid, 401)).response.status).toBe(401);
      for (const different of [{ client_id: 'other-client' }, { grant_id: 'other-grant' }]) {
        token = await signedCredential(60, different);
        expect((await rpc('ping', {}, sid)).response.status).toBe(200);
        await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { marker: 'wrong-binding' } } });
        const before = expiredHeartbeats;
        await until(() => expiredHeartbeats > before);
        expect(received).not.toContain('wrong-binding');
      }
      const notificationsBefore = received.split('notifications/tools/list_changed').length - 1;
      token = freshCredential;
      // Authentication, rather than JSON-RPC success, is the renewal boundary.
      expect((await rpc('missing-method', {}, sid)).text).toContain('Method not found');
      const active = await rpc('tools/call', { name: 'mcp_aql_read', arguments: { operation: 'get_active_elements', element_type: 'skill' } }, sid);
      expect(active.response.status).toBe(200); expect(active.text).toContain('keepalive-proof');
      for (const invalid of [shortCredential, 'other']) {
        token = invalid;
        const rejected = await fetch(env.runtime.url, { headers: headers(sid) });
        await readHttpResponse(rejected, invalid === shortCredential ? 401 : 403, 'Credential rejection');
      }
      expect(firstResponse.destroyed).toBe(false); expect(getCount()).toBe(1);
      await until(() => received.split('notifications/tools/list_changed').length - 1 === notificationsBefore + 1);
      token = freshCredential;
      expect((await rpc('ping', {}, sid)).response.status).toBe(200);
      await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { marker: 'original-stream-renewed' } } });
      await until(() => received.includes('original-stream-renewed'));
      expect(received.split('notifications/tools/list_changed').length - 1).toBe(notificationsBefore + 2);
      expect(received).not.toContain('must-be-dropped');
      expect(firstResponse.destroyed).toBe(false); expect(responses.get(sid)).toBe(firstResponse); expect(getCount()).toBe(1);
    } finally {
      token = 'owner'; first.abort.abort(); await collecting;
    }
  });

  it('keeps an expired SDK stream connected with grace disabled and renews with one resync', async () => {
    let expiry = 0;
    let fresh = false;
    let gets = 0;
    let initializations = 0;
    let observeGated = false;
    const gatedChunks: string[] = [];
    const observed: ServerResponse[] = [];
    const fixture = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 250, streamKeepaliveMs: 20, streamExpiryGraceMs: 0,
      authMiddleware: createUnifiedAuthMiddleware({ provider: { name: 'idle-expiry-fixture', validate: async value => {
        const exp = value === 'fresh' ? Date.now() + 60_000 : expiry;
        return Date.now() < exp ? { ok: true, claims: { sub: userId, exp: exp / 1000,
          credentialBinding: { clientId: 'idle-client', grantId: 'idle-grant' } } } : { ok: false, reason: 'expired' };
      } } }),
      onTransport: transport => {
        initializations++;
        const original = transport.handleRequest.bind(transport);
        jest.spyOn(transport, 'handleRequest').mockImplementation((req, res, body) => {
          if (req.method === 'GET') observed.push(res);
          return original(req, res, body);
        });
      },
    });
    preConfirmAllOperations(fixture.container);
    expiry = Date.now() + 10_000;
    const transport = new StreamableHTTPClientTransport(new URL(fixture.runtime.url), {
      fetch: async (input, init) => {
        const requestHeaders = new Headers(init?.headers);
        requestHeaders.set('Authorization', `Bearer ${fresh ? 'fresh' : 'short'}`);
        const result = await fetch(input, { ...init, headers: requestHeaders });
        if (init?.method !== 'GET' || !result.body) return result;
        gets++;
        const decoder = new TextDecoder();
        const body = result.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
          if (observeGated) gatedChunks.push(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        } }));
        return new Response(body, { status: result.status, headers: result.headers });
      },
    });
    const client = new Client({ name: 'idle-expiry-proof', version: '1' });
    const notifications: unknown[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, n => { notifications.push(n); });
    const realNow = Date.now.bind(Date);
    let clock: jest.SpiedFunction<typeof Date.now> | undefined;
    try {
      await client.connect(transport);
      await until(() => observed.length === 1 && observed[0].headersSent);
      const sid = transport.sessionId!;
      const originalResponse = observed[0];
      const registry = fixture.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
      const originalSession = registry.get(sid)!;
      const element = 'idle-expiry-proof';
      await client.callTool({ name: 'mcp_aql_create', arguments: { operation: 'create_element', params: { element_name: element, element_type: 'skill', description: 'Idle retention proof', content: 'Preserve activations while credentials expire.' } } });
      const activated = await client.callTool({ name: 'mcp_aql_read', arguments: { operation: 'activate_element', element_type: 'skill', params: { element_name: element } } });
      expect(JSON.stringify(activated)).toContain('activated');
      const server = originalSession.resolve<Server>('Server');
      await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { marker: 'before' } } });
      await until(() => notifications.some(n => JSON.stringify(n).includes('before')));
      notifications.length = 0;
      expect(realNow()).toBeLessThan(expiry);
      // Advance only wall-clock time beyond expiry + the former five-minute close.
      // Real sockets, SDK readers and timers keep running; the next write discovers
      // expiry late, which would have armed an immediate destroy in the old code.
      const offset = expiry + 6 * 60_000 - realNow();
      clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
      observeGated = true;
      await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { marker: 'dropped-one' } } });
      await server.notification({ method: 'notifications/tools/list_changed', params: { _meta: { marker: 'dropped-two' } } });
      await wait(750);
      expect(Date.now()).toBeGreaterThan(expiry + 5 * 60_000);
      expect(gatedChunks.join('').split(': keepalive\n\n').length).toBeGreaterThan(3);
      expect(gatedChunks.join('').replaceAll(': keepalive\n\n', '')).toBe('');
      expect(notifications).toHaveLength(0);
      expect(originalResponse.destroyed).toBe(false);
      expect(registry.get(sid)).toBe(originalSession);
      expect(transport.sessionId).toBe(sid);
      expect(gets).toBe(1); expect(initializations).toBe(1);
      observeGated = false;
      fresh = true;
      await client.ping();
      await until(() => notifications.length === 1);
      await client.ping(); await wait(60);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({ method: 'notifications/tools/list_changed' });
      expect(JSON.stringify(notifications)).not.toContain('dropped-');
      const active = await client.callTool({ name: 'mcp_aql_read', arguments: { operation: 'get_active_elements', element_type: 'skill' } });
      expect(JSON.stringify(active)).toContain(element);
      expect(originalResponse.destroyed).toBe(false);
      expect(registry.get(sid)).toBe(originalSession);
      expect(transport.sessionId).toBe(sid);
      expect(gets).toBe(1); expect(initializations).toBe(1);
    } finally { clock?.mockRestore(); await client.close(); await fixture.cleanup(); }
  });

  it.each(['lifetime', 'expiry', 'expiry-drop'] as const)('gracefully closes on %s and reconnects with session and activation intact', async reason => {
    let expiry = 0; let gets = 0; let initializations = 0; let notifications = 0;
    let serverTransport: StreamableHTTPServerTransport;
    const responses: ServerResponse[] = [];
    const destroys: Array<jest.SpiedFunction<ServerResponse['destroy']>> = [];
    const fixture = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 1500, streamKeepaliveMs: 20,
      streamMaxLifetimeMs: reason === 'lifetime' ? 600 : 0, streamExpiryGraceMs: 150,
      authMiddleware: createUnifiedAuthMiddleware({ provider: { name: 'graceful-fixture', validate: async value => ({ ok: true,
        claims: { sub: userId, exp: (value === 'fresh' ? Date.now() + 60_000 : expiry) / 1000,
          credentialBinding: { clientId: 'same-client', grantId: 'same-grant' } } }) } }),
      onTransport: transport => {
        initializations++; serverTransport = transport;
        const original = transport.handleRequest.bind(transport);
        jest.spyOn(transport, 'handleRequest').mockImplementation((req, res, body) => {
          if (req.method === 'GET') { responses.push(res); destroys.push(jest.spyOn(res, 'destroy')); }
          return original(req, res, body);
        });
      },
    });
    preConfirmAllOperations(fixture.container); expiry = Date.now() + 800;
    const transport = new StreamableHTTPClientTransport(new URL(fixture.runtime.url), {
      reconnectionOptions: { initialReconnectionDelay: 20, maxReconnectionDelay: 20, reconnectionDelayGrowFactor: 1, maxRetries: 2 },
      fetch: (input, init) => {
        if (init?.method === 'GET') gets++;
        const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${gets > 1 ? 'fresh' : 'short'}`);
        return fetch(input, { ...init, headers });
      },
    });
    const client = new Client({ name: 'graceful-reconnect', version: '1' });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
    try {
      await client.connect(transport); await until(() => responses.length === 1 && responses[0].headersSent);
      const sid = transport.sessionId!;
      const registry = fixture.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
      const originalSession = registry.get(sid);
      const element = `graceful-${reason}`;
      await client.callTool({ name: 'mcp_aql_create', arguments: { operation: 'create_element', params: { element_name: element, element_type: 'skill', description: 'Graceful close proof', content: 'Retain activation.' } } });
      expect(JSON.stringify(await client.callTool({ name: 'mcp_aql_read', arguments: { operation: 'activate_element', element_type: 'skill', params: { element_name: element } } }))).toContain('activated');
      await wait(30); notifications = 0;
      if (reason === 'expiry-drop') {
        await until(() => Date.now() >= expiry + 10);
        await serverTransport!.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        await wait(30); expect(notifications).toBe(0);
      }
      await until(() => responses.length >= 2 && responses[1].headersSent);
      if (reason === 'expiry-drop') await until(() => notifications === 1);
      await wait(50); expect(notifications).toBe(reason === 'expiry-drop' ? 1 : 0);
      expect(responses[0].writableFinished).toBe(true);
      expect(destroys[0]).not.toHaveBeenCalled();
      expect(transport.sessionId).toBe(sid); expect(registry.get(sid)).toBe(originalSession);
      expect(initializations).toBe(1);
      const active = await client.callTool({ name: 'mcp_aql_read', arguments: { operation: 'get_active_elements', element_type: 'skill' } });
      expect(JSON.stringify(active)).toContain(element);
    } finally { await client.close(); await fixture.cleanup(); }
  });

  it('falls back to destroying a graceful close whose SDK writer never drains', async () => {
    const previousEnv = env;
    let response: ServerResponse | undefined;
    let handlerSettled = false;
    env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 1500, streamKeepaliveMs: 20, streamMaxLifetimeMs: 250,
      // Isolate graceful-close fallback from the independent stall detector.
      sseStallWatcher: { attach: () => () => {} },
      onTransport: transport => {
        const original = transport.handleRequest.bind(transport);
        jest.spyOn(transport, 'handleRequest').mockImplementation((req, res, body) => {
          if (req.method === 'GET') response = res;
          return original(req, res, body).finally(() => { if (req.method === 'GET') handlerSettled = true; });
        });
      },
    });
    let stream: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const sid = await initialize(); stream = await open(sid); await stream.reader.read();
      const destroy = jest.spyOn(response!, 'destroy');
      // Model sustained backpressure: SDK/Hono waits for a drain event that never arrives.
      jest.spyOn(response!, 'write').mockReturnValue(false);
      await wait(400);
      expect(response!.writableFinished).toBe(false); expect(destroy).not.toHaveBeenCalled();
      await until(() => destroy.mock.calls.length > 0);
      expect(response!.writableFinished).toBe(false); expect(response!.destroyed).toBe(true);
      expect(await ended(stream.reader)).toBe(true);
      await until(() => handlerSettled);
    } finally { stream?.abort.abort(); await env.cleanup(); env = previousEnv; }
  });

  it('shutdown disposes all open streams and their session containers', async () => {
    const ids = [await initialize(), await initialize()];
    const streams = await Promise.all(ids.map(id => open(id)));
    await Promise.all(streams.map(stream => stream.reader.read()));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = control.markSessionDisposed.bind(control);
    const durable = jest.spyOn(control, 'markSessionDisposed').mockImplementation(async id => { await held; await original(id); });
    const closing = env.runtime.close();
    await until(() => ids.every(id => !env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(id)));
    expect(durable.mock.calls.filter(([id]) => ids.includes(id))).toHaveLength(ids.length);
    release(); await closing; durable.mockRestore();
    expect(env.runtime.activeSessionCount()).toBe(0);
    expect(control.getLocalSessionCount()).toBe(0);
    for (const id of ids) {
      expect(env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(id)).toBeUndefined();
      expect(await store.findPresence(id)).toBeNull();
    }
    for (const stream of streams) stream.abort.abort();
  });

  it('closes a live stream only after a prolonged outage exhausts its confirmed lease', async () => {
    const previousEnv = env;
    const outageStore = new InMemoryRuntimeSessionControlStore();
    const outageControl = new RuntimeMcpSessionControlService({ store: outageStore, replicaId: 'outage-test', leaseDurationMs: 1800 });
    env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 250, streamKeepaliveMs: 20, runtimeSessionControl: outageControl, runtimeSession: { userId, accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' } });
    let stream: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const sid = await initialize(); stream = await open(sid); await stream.reader.read();
      const confirmed = outageControl.getConfirmedLeaseUntil(sid)!.getTime();
      const failure = jest.spyOn(outageStore, 'renewSessionLease').mockRejectedValue(new Error('database unavailable'));
      await until(() => failure.mock.calls.length > 0);
      expect(env.runtime.activeSessionCount()).toBe(1);
      expect(Date.now()).toBeLessThan(confirmed);
      await until(() => env.runtime.activeSessionCount() === 0);
      expect(Date.now()).toBeGreaterThanOrEqual(confirmed);
      expect(await ended(stream.reader)).toBe(true);
      failure.mockRestore();
    } finally { stream?.abort.abort(); await env.cleanup(); env = previousEnv; }
  });

  it.each([undefined, 0, 150])('preserves one quiet stream unless a lifetime cap is opted into (%s)', async streamMaxLifetimeMs => {
    const previousEnv = env;
    let transportCount = 0;
    let getCount = 0;
    let serverResponse: ServerResponse | undefined;
    env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 250, streamKeepaliveMs: 20, streamMaxLifetimeMs,
      authMiddleware: createUnifiedAuthMiddleware({ provider: { name: 'long-lived-fixture', validate: async () => ({ ok: true, claims: { sub: userId, exp: (Date.now() + 60_000) / 1000 } }) } }),
      onTransport: transport => {
        transportCount++;
        const original = transport.handleRequest.bind(transport);
        jest.spyOn(transport, 'handleRequest').mockImplementation((req, res, body) => {
          if (req.method === 'GET') { getCount++; serverResponse = res; }
          return original(req, res, body);
        });
      },
    });
    let stream: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const sid = await initialize(); stream = await open(sid);
      await stream.reader.read();
      if (streamMaxLifetimeMs) {
        expect(await ended(stream.reader)).toBe(true);
      } else {
        const originalResponse = serverResponse;
        // Prove neither the opt-in 150 ms cap nor 250 ms idle grace closes an uncapped stream.
        await wait(450);
        expect(serverResponse).toBe(originalResponse);
        expect(serverResponse!.destroyed).toBe(false);
        expect((await stream.reader.read()).done).toBe(false);
      }
      expect(transportCount).toBe(1); expect(getCount).toBe(1);
      expect(env.runtime.activeSessionCount()).toBe(1);
      expect((await rpc('ping', {}, sid)).response.status).toBe(200);
    } finally { stream?.abort.abort(); await env.cleanup(); env = previousEnv; }
  });

});
