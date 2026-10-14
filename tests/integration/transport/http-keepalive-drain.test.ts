import { readHttpResponse, assertSseResponse } from '../../helpers/httpResponseAssertions.js';
import { describe, expect, it, jest } from '@jest/globals';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import { STREAM_RETIREMENT_TIMEOUT_MS } from '../../../src/server/http/StreamLifecycle.js';
import { logger } from '../../../src/utils/logger.js';
import { MemoryUpgradeLifecycle } from '../../../src/lifecycle/MemoryUpgradeLifecycle.js';
import { InMemoryRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js';
import { RuntimeMcpSessionControlService } from '../../../src/web-console/services/runtime/RuntimeMcpSessionControlService.js';
import { createHttpTestEnvironment } from '../../helpers/httpTransportHelper.js';

const user = { userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1', accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' };
const headers = (sid?: string) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) });
async function until(check: () => boolean | Promise<boolean>, message = 'Drain test condition did not settle', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(idleMs = 0, pollMs?: number) {
  const lifecycle = new MemoryUpgradeLifecycle();
  const store = new InMemoryRuntimeSessionControlStore();
  const control = new RuntimeMcpSessionControlService({ store, replicaId: 'drain-test', leaseDurationMs: 900 });
  const transports: StreamableHTTPServerTransport[] = [];
  const env = await createHttpTestEnvironment({ onTransport: transport => { transports.push(transport); }, memoryUpgradeLifecycle: lifecycle, sessionIdleTimeoutMs: idleMs,
    runtimeCommandPollIntervalMs: pollMs, streamKeepaliveMs: 20, runtimeSessionControl: control, runtimeSession: user });
  const response = await fetch(env.runtime.url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'drain', version: '1' } } }) });
  await readHttpResponse(response, 200, 'Drain initialize', true);
  const sid = response.headers.get('mcp-session-id')!;
  await until(() => Boolean(control.getConfirmedLeaseUntil(sid)));
  const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
  return { env, lifecycle, store, control, sid, registry, transport: transports.find(item => item.sessionId === sid)! };
}
async function openStream(url: string, sid: string) {
  const abort = new AbortController();
  const response = await fetch(url, { headers: { ...headers(sid), Accept: 'text/event-stream' }, signal: abort.signal });
  await assertSseResponse(response);
  let text = '';
  let ended = false;
  const read = (async () => {
    try {
      const reader = response.body!.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
    } catch { /* Server close or explicit client abort ends the stream. */ }
    finally { ended = true; }
  })();
  return { abort, read, text: () => text, ended: () => ended };
}
async function expectClosedAdmission(url: string, sid: string) {
  for (const method of ['POST', 'GET', 'DELETE']) {
    const response = await fetch(url, { method, headers: headers(sid),
      ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) } : {}) });
    await readHttpResponse(response, 503, 'Request during drain');
  }
}

describe('keepalive across memory drain', () => {
  it('disposes the session when the previous SDK reader exceeds the retirement bound', async () => {
    const { env, sid, transport, registry } = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = transport.handleRequest.bind(transport);
    const dispatch = jest.spyOn(transport, 'handleRequest').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0].method === 'GET') await held;
      return result;
    });
    const stream = await openStream(env.runtime.url, sid);
    const warn = jest.spyOn(logger, 'warn');
    const originalTimeout = globalThis.setTimeout;
    let replacementIssued = false;
    const replacementAbort = new AbortController();
    let replacement: ReturnType<typeof fetch> | undefined;
    let expireRetirement: (() => void) | undefined;
    // Trigger just the retirement deadline; leave HTTP I/O and lease timers real.
    const timer = jest.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (replacementIssued && expireRetirement === undefined && delay === STREAM_RETIREMENT_TIMEOUT_MS) {
        expireRetirement = () => callback(...args);
      }
      return originalTimeout(callback, delay, ...args);
    });
    try {
      await until(() => stream.text().includes(':'));
      replacementIssued = true;
      replacement = fetch(env.runtime.url, { headers: { ...headers(sid), Accept: 'text/event-stream' }, signal: replacementAbort.signal });
      await until(() => expireRetirement !== undefined, 'Replacement GET did not arm the stream retirement timer', 1000);
      expect(env.runtime.activeSessionCount()).toBe(1);
      expireRetirement!();
      const response = await replacement;
      expect(await readHttpResponse(response, 404, 'Hung-reader replacement GET')).toContain('Unknown MCP session');
      expect(dispatch).toHaveBeenCalledTimes(1);
      await until(() => registry.get(sid) === undefined);
      expect(env.runtime.activeSessionCount()).toBe(0);
      expect(warn.mock.calls.filter(([message]) => message === '[StreamableHTTP] Stream retirement timed out; closing local session'))
        .toEqual([['[StreamableHTTP] Stream retirement timed out; closing local session',
          { sessionId: sid, reason: 'stream_retirement_timeout', timeoutMs: STREAM_RETIREMENT_TIMEOUT_MS }]]);
      const next = await fetch(env.runtime.url, { method: 'POST', headers: headers(sid),
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
      expect(await readHttpResponse(next, 404, 'Disposed-session POST')).toContain('Unknown MCP session');
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      timer.mockRestore(); warn.mockRestore(); replacementAbort.abort(); release();
      await replacement?.catch(() => undefined);
      stream.abort.abort(); await stream.read; dispatch.mockRestore(); await env.cleanup();
    }
  });

  it.each(['quiescing', 'refused'] as const)('fails an in-flight termination ACK and logs retention once while %s', async state => {
    const { env, lifecycle, store, sid, registry } = await fixture(0, 20);
    let retained = true;
    lifecycle.registerOwner({ hasRetainedMemoryWork: () => retained, flushPendingSaves: async () => {} });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let polling = false;
    const original = store.listPendingCommandsForReplica.bind(store);
    const poll = jest.spyOn(store, 'listPendingCommandsForReplica').mockImplementation(async (...args) => {
      const commands = await original(...args);
      if (commands.length) { polling = true; await held; }
      return commands;
    });
    const info = jest.spyOn(logger, 'info');
    try {
      // Two commands in one already-started poll exercise repeated disposal callers.
      const commands = await Promise.all([0, 1].map(() => store.createTerminationCommand({
        sessionId: sid, targetReplicaId: 'drain-test', reason: 'admin_terminated',
        requestedAt: new Date(), requestedBy: { kind: 'admin', userId: user.userId },
      })));
      await until(() => polling);
      if (state === 'refused') await expect(env.runtime.close()).rejects.toMatchObject({ code: 'EMEMORYDRAIN' });
      else lifecycle.closeAdmission();
      expect(lifecycle.getSummary().state).toBe(state);
      release();
      for (const command of commands) {
        await until(async () => Boolean(await store.getCommandAck(command.commandId)));
        expect(await store.getCommandAck(command.commandId)).toMatchObject({
          result: 'failed', errorCode: 'local_termination_failed',
        });
      }
      expect(env.runtime.activeSessionCount()).toBe(1); expect(registry.get(sid)).toBeDefined();
      expect(info.mock.calls.filter(([message]) => message === '[StreamableHTTP] Session retained for memory drain'))
        .toEqual([['[StreamableHTTP] Session retained for memory drain', { sessionId: sid, memoryState: state }]]);
    } finally { release(); retained = false; poll.mockRestore(); info.mockRestore(); await env.cleanup(); }
  });

  it('rejects a replacement GET if drain begins while the old SDK reader retires', async () => {
    const { env, lifecycle, sid, transport, registry } = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let retiring = false;
    const original = transport.handleRequest.bind(transport);
    const dispatch = jest.spyOn(transport, 'handleRequest').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0].method === 'GET') { retiring = true; await held; }
      return result;
    });
    const stream = await openStream(env.runtime.url, sid);
    try {
      await until(() => stream.text().includes(':'));
      const replacement = fetch(env.runtime.url, { headers: { ...headers(sid), Accept: 'text/event-stream' } });
      await until(() => retiring);
      lifecycle.closeAdmission();
      release();
      const response = await replacement;
      await readHttpResponse(response, 503, 'Request during drain');
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(registry.get(sid)).toBeDefined();
    } finally { release(); stream.abort.abort(); await stream.read; dispatch.mockRestore(); await env.cleanup(); }
  });

  it('retains healthy streams and renewals after refusal, then retries shutdown successfully', async () => {
    const { env, lifecycle, store, control, sid, registry } = await fixture();
    let retained = true;
    lifecycle.registerOwner({ hasRetainedMemoryWork: () => retained, flushPendingSaves: async () => {} });
    const stream = await openStream(env.runtime.url, sid);
    try {
      await until(() => stream.text().includes(':'));
      await expect(env.runtime.close()).rejects.toMatchObject({ code: 'EMEMORYDRAIN' });
      expect(lifecycle.getSummary().state).toBe('refused');
      const deadline = control.getConfirmedLeaseUntil(sid)!.getTime();
      const size = stream.text().length;
      await until(() => control.getConfirmedLeaseUntil(sid)!.getTime() > deadline);
      await until(() => stream.text().length > size);
      expect(stream.ended()).toBe(false); expect(registry.get(sid)).toBeDefined();
      expect(env.runtime.activeSessionCount()).toBe(1);
      await expectClosedAdmission(env.runtime.url, sid);
      retained = false;
      await env.runtime.close();
      await until(stream.ended);
      expect(registry.get(sid)).toBeUndefined();
      expect(env.runtime.activeSessionCount()).toBe(0);
      expect(await store.findPresence(sid)).toBeNull();
    } finally { retained = false; stream.abort.abort(); await stream.read; await env.cleanup(); }
  });

  it('retains a quiet session when its idle timer fires during a blocked drain', async () => {
    const { env, lifecycle, store, sid, registry } = await fixture(250);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let flushing = false;
    lifecycle.registerOwner({ hasRetainedMemoryWork: () => false, flushPendingSaves: async () => { flushing = true; await held; } });
    const closing = env.runtime.close();
    try {
      await until(() => flushing);
      // Observe beyond idle expiry while the original drain is deliberately held.
      const pastIdle = Date.now() + 350;
      await until(() => Date.now() >= pastIdle);
      expect(registry.get(sid)).toBeDefined(); expect(env.runtime.activeSessionCount()).toBe(1);
      expect(env.runtime.getOperationalMetrics().sessions.expired).toBe(0);
      await expectClosedAdmission(env.runtime.url, sid);
      release(); await closing;
      expect(registry.get(sid)).toBeUndefined(); expect(await store.findPresence(sid)).toBeNull();
    } finally { release(); await closing; await env.cleanup(); }
  });

  it('retains the owner but suppresses payloads when a refused drain outlives its lease', async () => {
    const { env, lifecycle, control, sid, registry } = await fixture();
    let retained = true;
    lifecycle.registerOwner({ hasRetainedMemoryWork: () => retained, flushPendingSaves: async () => {} });
    const stream = await openStream(env.runtime.url, sid);
    const server = registry.get(sid)!.resolve<Server>('Server');
    const renewal = jest.spyOn(control, 'renewSessionLease').mockRejectedValue(new Error('store offline'));
    try {
      await until(() => stream.text().includes(':'));
      await expect(env.runtime.close()).rejects.toMatchObject({ code: 'EMEMORYDRAIN' });
      const deadline = control.getConfirmedLeaseUntil(sid)!.getTime();
      await until(() => Date.now() > deadline + 50);
      expect(registry.get(sid)).toBeDefined(); expect(env.runtime.activeSessionCount()).toBe(1);
      const size = stream.text().length;
      await server.notification({ method: 'notifications/tools/list_changed', params: { proof: 'must-not-pass' } });
      await until(() => stream.text().length > size);
      expect(stream.text()).not.toContain('must-not-pass'); expect(stream.ended()).toBe(false);
      await expectClosedAdmission(env.runtime.url, sid);
    } finally { renewal.mockRestore(); retained = false; stream.abort.abort(); await stream.read; await env.cleanup(); }
  });
});
