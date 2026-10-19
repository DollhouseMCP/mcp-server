import { readHttpResponse } from '../../helpers/httpResponseAssertions.js';
import { describe, expect, it, jest } from '@jest/globals';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../../src/utils/logger.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import { createHttpTestEnvironment, type HttpTestEnvironment } from '../../helpers/httpTransportHelper.js';
import { preConfirmAllOperations } from '../../helpers/portfolioTestHelper.js';
import { InMemoryRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js';
import { RuntimeMcpSessionControlService } from '../../../src/web-console/services/runtime/RuntimeMcpSessionControlService.js';

const user = { userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1', accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' };
const replicaId = 'presence-admission';
const headers = (sid?: string) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) });
async function rpc(env: HttpTestEnvironment, method: string, params: unknown, sid?: string, expectedStatus = 200) {
  const response = await fetch(env.runtime.url, { method: 'POST', headers: headers(sid), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { response, text: await readHttpResponse(response, expectedStatus, `MCP POST ${method}`, true) };
}
async function initialize(env: HttpTestEnvironment) {
  const { response } = await rpc(env, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'presence-admission', version: '1' } });
  expect(response.status).toBe(200); return response.headers.get('mcp-session-id')!;
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Presence did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(idleMs: number, leaseMs: number) {
  const store = new InMemoryRuntimeSessionControlStore();
  const control = new RuntimeMcpSessionControlService({ store, replicaId, leaseDurationMs: leaseMs });
  const transports: StreamableHTTPServerTransport[] = [];
  const env = await createHttpTestEnvironment({ sessionIdleTimeoutMs: idleMs, runtimeSessionControl: control, runtimeSession: user,
    onTransport: transport => { transports.push(transport); jest.spyOn(transport, 'handleRequest'); } });
  const sid = await initialize(env);
  await until(() => Boolean(control.getConfirmedLeaseUntil(sid)));
  const transport = transports.find(item => item.sessionId === sid)!;
  const server = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(sid)!.resolve<Server>('Server');
  return { env, store, control, sid, transport, server };
}

describe('presence admission before SDK dispatch', () => {
  it.each(['active', 'missing', 'closing', 'replica_mismatch'] as const)('rejects a lapsed local lease before a tool handler can run (row state: %s)', async state => {
    const { env, store, control, sid, transport, server } = await fixture(10_000, 60_000);
    const handler = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'side effect' }] }));
    server.setRequestHandler(CallToolRequestSchema, handler);
    try {
      // Positive control: this exact tool reaches the actual SDK handler while valid.
      expect((await rpc(env, 'tools/call', { name: 'admission-proof' }, sid)).response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      await until(async () => (await store.findPresence(sid))?.requestCount === 1);
      const deadline = control.getConfirmedLeaseUntil(sid)!.getTime();
      if (state === 'missing') await store.sweepStalePresence(new Date(deadline + 1));
      if (state === 'closing') await store.markPresenceClosing(sid, new Date(), replicaId);
      if (state === 'replica_mismatch') await store.registerPresence({ ...(await store.findPresence(sid))!, replicaId: 'other-replica' });
      const dispatches = jest.mocked(transport.handleRequest).mock.calls.length;
      const activity = jest.spyOn(control, 'recordActivity');
      const warn = jest.spyOn(logger, 'warn');
      // Jump wall time without running expiry callbacks: admission must fence lagged timers.
      const clock = jest.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      try {
        const result = await rpc(env, 'tools/call', { name: 'admission-proof' }, sid, 404);
        expect(result.response.status).toBe(404); expect(result.text).toContain('Unknown MCP session');
        expect(handler).toHaveBeenCalledTimes(1);
        expect(transport.handleRequest).toHaveBeenCalledTimes(dispatches);
        expect(activity).not.toHaveBeenCalled();
        const admissionWarnings = warn.mock.calls.filter(([, metadata]) =>
          (metadata as { reason?: string } | undefined)?.reason === 'lease_expired_at_admission');
        expect(admissionWarnings).toEqual([['[StreamableHTTP] Runtime presence lost; closing local session',
          { sessionId: sid, reason: 'lease_expired_at_admission' }]]);
      } finally { clock.mockRestore(); activity.mockRestore(); warn.mockRestore(); }
      expect(env.runtime.activeSessionCount()).toBe(0);
    } finally { await env.cleanup(); }
  });

  it.each(['active', 'missing', 'closing', 'replica_mismatch'] as const)('rejects a resumed GET with a lapsed local lease before SDK admission (row state: %s)', async state => {
    const { env, store, control, sid, transport } = await fixture(0, 60_000);
    try {
      const deadline = control.getConfirmedLeaseUntil(sid)!.getTime();
      if (state === 'missing') await store.sweepStalePresence(new Date(deadline + 1));
      if (state === 'closing') await store.markPresenceClosing(sid, new Date(), replicaId);
      if (state === 'replica_mismatch') await store.registerPresence({ ...(await store.findPresence(sid))!, replicaId: 'other-replica' });
      const dispatches = jest.mocked(transport.handleRequest).mock.calls.length;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      try {
        const response = await fetch(env.runtime.url, { headers: { ...headers(sid), Accept: 'text/event-stream' } });
        await readHttpResponse(response, 404, 'Lapsed-lease GET');
        expect(transport.handleRequest).toHaveBeenCalledTimes(dispatches);
      } finally { clock.mockRestore(); }
      expect(env.runtime.activeSessionCount()).toBe(0);
    } finally { await env.cleanup(); }
  });

  it('keeps an idle-disabled activation through two full quiet intervals and real cleanup sweeps', async () => {
    const { env, store, control, sid } = await fixture(0, 900);
    preConfirmAllOperations(env.container);
    try {
      const created = await rpc(env, 'tools/call', { name: 'mcp_aql_create', arguments: { operation: 'create_element', params: { element_name: 'quiet-proof', element_type: 'skill', description: 'Quiet presence proof', content: 'Retain through cleanup.' } } }, sid);
      expect(created.text).toContain('success');
      const activated = await rpc(env, 'tools/call', { name: 'mcp_aql_read', arguments: { operation: 'activate_element', element_type: 'skill', params: { element_name: 'quiet-proof' } } }, sid);
      expect(activated.text).toContain('activated');
      await until(async () => (await store.findPresence(sid))?.requestCount === 2);
      for (let interval = 0; interval < 2; interval++) {
        const before = (await store.findPresence(sid))!;
        const quietUntil = Date.now() + 1_100;
        await until(() => Date.now() >= quietUntil);
        expect(await store.sweepStalePresence(new Date())).toBe(0);
        expect(await store.findPresence(sid)).toMatchObject({ requestCount: before.requestCount, lastActiveAt: before.lastActiveAt });
        expect((await store.listPresenceByUser(user.userId)).map(row => row.sessionId)).toContain(sid);
        const active = await rpc(env, 'tools/call', { name: 'mcp_aql_read', arguments: { operation: 'get_active_elements', element_type: 'skill' } }, sid);
        expect(active.response.status).toBe(200); expect(active.text).toContain('quiet-proof');
        await until(async () => (await store.findPresence(sid))?.requestCount === before.requestCount + 1);
      }
      expect(control.getLocalSessionCount()).toBe(1); expect(env.runtime.activeSessionCount()).toBe(1);
    } finally { await env.cleanup(); }
  });

  it('keeps idle-enabled request admission valid between the idle window and lease expiry', async () => {
    const { env, control, sid, server } = await fixture(10_000, 60_000);
    const handler = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'allowed' }] }));
    server.setRequestHandler(CallToolRequestSchema, handler);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(control.getConfirmedLeaseUntil(sid)!.getTime() - 30_000);
    try {
      expect((await rpc(env, 'tools/call', { name: 'admission-proof' }, sid)).response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1); expect(env.runtime.activeSessionCount()).toBe(1);
    } finally { clock.mockRestore(); await env.cleanup(); }
  });
});
