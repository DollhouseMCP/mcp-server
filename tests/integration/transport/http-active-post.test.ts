import { readHttpResponse } from '../../helpers/httpResponseAssertions.js';
import { describe, expect, it, jest } from '@jest/globals';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import { InMemoryRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js';
import { RuntimeMcpSessionControlService } from '../../../src/web-console/services/runtime/RuntimeMcpSessionControlService.js';
import { createHttpTestEnvironment } from '../../helpers/httpTransportHelper.js';

describe('active POST idle retention', () => {
  it('returns the tool result after an event-loop stall beyond idle expiry', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    const control = new RuntimeMcpSessionControlService({ store, replicaId: 'active-post', leaseDurationMs: 30_000 });
    const env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 250, runtimeSessionControl: control,
      runtimeSession: { userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1', accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' } });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    try {
      const init = await fetch(env.runtime.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'active-post', version: '1' } } }) });
      const initBody = await readHttpResponse(init, 200, 'Active POST initialize', true);
      expect({ status: init.status, body: initBody }).toMatchObject({ status: 200 });
      const sid = init.headers.get('mcp-session-id')!;
      const server = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(sid)!.resolve<Server>('Server');
      server.setRequestHandler(CallToolRequestSchema, async () => { entered(); await held; return { content: [{ type: 'text', text: 'slow-tool-complete' }] }; });
      const pending = fetch(env.runtime.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } }) });
      await started;
      const confirmed = control.getConfirmedLeaseUntil(sid)!.getTime();
      expect(confirmed).toBeGreaterThan(Date.now());
      const until = performance.now() + 400;
      while (performance.now() < until) { /* Deterministic event-loop stall beyond the 250ms idle window. */ }
      await new Promise(resolve => setTimeout(resolve, 30));
      const metrics = env.runtime.getOperationalMetrics().sessions;
      release();
      const response = await pending;
      const body = await response.text();
      console.info('active-post reproduction', { status: response.status, body, confirmedLeaseStillValid: (confirmed ?? 0) > Date.now(), metrics });
      expect({ status: response.status, body }).toMatchObject({ status: 200, body: expect.stringContaining('slow-tool-complete') });
      expect(metrics.expired).toBe(0);
    } finally { release(); await env.cleanup(); }
  });

  it('keeps concurrent POSTs alive until the last one finishes, then resumes idle expiry', async () => {
    const env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 250 });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const releases: Array<() => void> = [];
    const held = [0, 1].map(() => new Promise<void>(resolve => { releases.push(resolve); }));
    let entered = 0;
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!check()) {
        if (Date.now() >= deadline) throw new Error('Concurrent POST condition did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    try {
      const init = await fetch(env.runtime.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'concurrent-post', version: '1' } } }) });
      await readHttpResponse(init, 200, 'Concurrent POST initialize', true);
      const sid = init.headers.get('mcp-session-id')!;
      const server = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(sid)!.resolve<Server>('Server');
      server.setRequestHandler(CallToolRequestSchema, async () => {
        const index = entered++;
        await held[index];
        return { content: [{ type: 'text', text: `completed-${index}` }] };
      });
      const send = (id: number) => fetch(env.runtime.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'held' } }) });
      const first = send(2); await until(() => entered === 1);
      const second = send(3); await until(() => entered === 2);
      releases[0]();
      expect(await readHttpResponse(await first, 200, 'First concurrent POST', true)).toContain('completed-0');
      // Observe beyond idle grace while the second request remains admitted.
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(env.runtime.activeSessionCount()).toBe(1);
      releases[1]();
      expect(await readHttpResponse(await second, 200, 'Second concurrent POST', true)).toContain('completed-1');
      await until(() => env.runtime.activeSessionCount() === 0);
      expect(env.runtime.getOperationalMetrics().sessions.expired).toBe(1);
    } finally { for (const release of releases) release(); await env.cleanup(); }
  });

  it('renews presence throughout a held POST beyond its original lease', async () => {
    const userId = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
    const store = new InMemoryRuntimeSessionControlStore();
    const control = new RuntimeMcpSessionControlService({ store, replicaId: 'busy-post', leaseDurationMs: 900 });
    const env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 250, runtimeSessionControl: control,
      runtimeSession: { userId, accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' } });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    try {
      const send = (id: number, method: string, params: unknown, sid?: string) => fetch(env.runtime.url, {
        method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      const init = await send(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'busy-post', version: '1' } });
      await readHttpResponse(init, 200, 'Busy POST initialize', true);
      const sid = init.headers.get('mcp-session-id')!;
      const server = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(sid)!.resolve<Server>('Server');
      server.setRequestHandler(CallToolRequestSchema, async () => { entered(); await held; return { content: [{ type: 'text', text: 'held-result' }] }; });
      const pending = send(2, 'tools/call', { name: 'held' }, sid);
      await started;
      const originalDeadline = control.getConfirmedLeaseUntil(sid)!.getTime();
      // Observe visibility repeatedly, without issuing activity writes that could renew the lease.
      while (Date.now() <= originalDeadline + 100) {
        const listed = await store.listPresenceByUser(userId, { now: new Date() });
        expect(listed.some(row => row.sessionId === sid && row.leaseUntil.getTime() > Date.now())).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await readHttpResponse(await send(3, 'ping', {}, sid), 200, 'Concurrent ping during held POST', true);
      release();
      expect(await readHttpResponse(await pending, 200, 'Held POST result', true)).toContain('held-result');
    } finally { release(); await env.cleanup(); }
  });

  it.each([false, true])('adds no lease writes for short POST bursts, stream=%s', async streaming => {
    const store = new InMemoryRuntimeSessionControlStore();
    const renew = jest.spyOn(store, 'renewSessionLease');
    const heartbeat = jest.spyOn(store, 'heartbeatPresence');
    const register = jest.spyOn(store, 'registerPresence');
    const control = new RuntimeMcpSessionControlService({ store, replicaId: 'post-cost', leaseDurationMs: 30_000 });
    const env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: 1000, streamKeepaliveMs: 10, runtimeSessionControl: control,
      runtimeSession: { userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1', accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' } });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const abort = new AbortController();
    try {
      const init = await fetch(env.runtime.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'post-cost', version: '1' } } }) });
      await readHttpResponse(init, 200, 'Write count initialize', true);
      const sid = init.headers.get('mcp-session-id')!;
      // All writes use the service queue; a queued read barrier is unnecessary with this synchronous in-memory store.
      await new Promise(resolve => setImmediate(resolve));
      const initialization = { registrations: register.mock.calls.length, renewals: renew.mock.calls.length };
      if (streaming) {
        const stream = await fetch(env.runtime.url, { headers: { ...headers, 'mcp-session-id': sid }, signal: abort.signal });
        expect(stream.status).toBe(200);
        await stream.body!.getReader().read(); // First keepalive proves GET admission and its writes have started.
        await new Promise(resolve => setImmediate(resolve));
      }
      renew.mockClear(); heartbeat.mockClear();
      for (let id = 2; id < 5; id++) {
        const response = await fetch(env.runtime.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) });
        await readHttpResponse(response, 200, 'Short POST', true);
        await new Promise(resolve => setImmediate(resolve));
      }
      console.info('POST write counts', { streaming, initialization, heartbeats: heartbeat.mock.calls.length, renewals: renew.mock.calls.length });
      expect(initialization).toEqual({ registrations: 1, renewals: 0 });
      expect(heartbeat).toHaveBeenCalledTimes(3);
      expect(renew).not.toHaveBeenCalled();
    } finally { abort.abort(); await env.cleanup(); jest.restoreAllMocks(); }
  });

});
