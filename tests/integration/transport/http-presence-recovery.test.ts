import { readHttpResponse, assertSseResponse } from '../../helpers/httpResponseAssertions.js';
import { describe, expect, it, jest } from '@jest/globals';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHttpTestEnvironment, type HttpTestEnvironment } from '../../helpers/httpTransportHelper.js';
import { InMemoryRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js';
import { RuntimeMcpSessionControlService } from '../../../src/web-console/services/runtime/RuntimeMcpSessionControlService.js';

const user = { userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1', accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Recovery did not settle'); await delay(10); }
}
async function rpc(env: HttpTestEnvironment, sid?: string, expectedStatus: number | readonly number[] = 200): Promise<Response> {
  const method = sid ? 'ping' : 'initialize';
  const response = await fetch(env.runtime.url, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: sid ? {} : { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'presence-recovery', version: '1' } } }) });
  await readHttpResponse(response, expectedStatus, `MCP POST ${method}`, true); return response;
}
async function open(env: HttpTestEnvironment, sid: string) {
  const abort = new AbortController();
  const response = await fetch(env.runtime.url, { headers: { Accept: 'text/event-stream', 'mcp-session-id': sid }, signal: abort.signal });
  await assertSseResponse(response);
  await response.body!.getReader().read(); return abort;
}
async function fixture(store: InMemoryRuntimeSessionControlStore, onTransport?: (t: StreamableHTTPServerTransport) => void) {
  const control = new RuntimeMcpSessionControlService({ store, replicaId: 'presence-recovery', leaseDurationMs: 1500 });
  const env = await createHttpTestEnvironment({ runtimeSessionControl: control, runtimeSession: user, sessionIdleTimeoutMs: 0, streamKeepaliveMs: 20, onTransport });
  return { env, control };
}

describe('presence recovery regardless of stream cadence', () => {
  it.each([false, true])('retries failed initial registration with streaming=%s', async streaming => {
    const store = new InMemoryRuntimeSessionControlStore();
    const register = jest.spyOn(store, 'registerPresence').mockRejectedValueOnce(new Error('brief outage'));
    const { env, control } = await fixture(store);
    let stream: AbortController | undefined;
    try {
      const sid = (await rpc(env)).headers.get('mcp-session-id')!;
      if (streaming) stream = await open(env, sid);
      await until(async () => Boolean(await store.findPresence(sid)));
      expect(register).toHaveBeenCalledTimes(2);
      expect((await rpc(env, sid)).status).toBe(200);
      expect(control.getConfirmedLeaseUntil(sid)).toBeDefined();
    } finally { stream?.abort(); await env.cleanup(); register.mockRestore(); }
  });

  it.each([false, true])('bounds missing-row POSTs after successful stream close=%s', async hadStream => {
    const store = new InMemoryRuntimeSessionControlStore();
    const { env, control } = await fixture(store);
    const renew = jest.spyOn(control, 'renewSessionLease');
    const register = jest.spyOn(store, 'registerPresence');
    try {
      const sid = (await rpc(env)).headers.get('mcp-session-id')!;
      await until(() => Boolean(control.getConfirmedLeaseUntil(sid)));
      if (hadStream) {
        const stream = await open(env, sid);
        await until(() => renew.mock.calls.length > 0); await renew.mock.results.at(-1)?.value;
        const calls = renew.mock.calls.length; stream.abort();
        await until(() => renew.mock.calls.length > calls); await renew.mock.results.at(-1)?.value;
      }
      const confirmed = control.getConfirmedLeaseUntil(sid)!.getTime();
      await store.sweepStalePresence(new Date(confirmed + 1));
      const untilTime = Date.now() + 4000;
      let status = 200; let accepted = 0;
      while (status === 200 && Date.now() < untilTime) {
        status = (await rpc(env, sid, [200, 404])).status; if (status === 200) accepted++;
        await delay(25);
      }
      expect(accepted).toBeGreaterThan(1); expect(status).toBe(404);
      expect(Date.now()).toBeGreaterThanOrEqual(confirmed);
      expect(env.runtime.activeSessionCount()).toBe(0);
      expect(register).toHaveBeenCalledTimes(1);
    } finally { await env.cleanup(); renew.mockRestore(); register.mockRestore(); }
  });

  it('bounds persistent registration failure for a POST-only active session', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    const register = jest.spyOn(store, 'registerPresence').mockRejectedValue(new Error('offline'));
    const { env } = await fixture(store);
    try {
      const sid = (await rpc(env)).headers.get('mcp-session-id')!;
      await until(async () => (await rpc(env, sid, [200, 404])).status === 404);
      expect(register.mock.calls.length).toBeGreaterThan(1);
      expect(env.runtime.activeSessionCount()).toBe(0);
    } finally { await env.cleanup(); register.mockRestore(); }
  });

  it('returns 404 and releases admission when the old handler never settles', async () => {
    let first = true;
    let entered = false;
    const { env } = await fixture(new InMemoryRuntimeSessionControlStore(), transport => {
      const original = transport.handleRequest.bind(transport);
      jest.spyOn(transport, 'handleRequest').mockImplementation((req, res, body) => {
        if (req.method === 'GET' && first) { first = false; entered = true; return new Promise(() => {}); }
        return original(req, res, body);
      });
    });
    try {
      const sid = (await rpc(env)).headers.get('mcp-session-id')!;
      const headers = { Accept: 'text/event-stream', 'mcp-session-id': sid };
      const original = fetch(env.runtime.url, { headers }).catch(() => undefined);
      await until(() => entered);
      const replacement = await fetch(env.runtime.url, { headers });
      await readHttpResponse(replacement, 404, 'Hung-reader replacement GET'); await original;
      await readHttpResponse(await fetch(env.runtime.url, { headers }), 404, 'Disposed-session GET');
    } finally { await env.cleanup(); }
  }, 15_000);
});
