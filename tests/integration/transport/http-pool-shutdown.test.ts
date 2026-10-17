import { readHttpResponse } from '../../helpers/httpResponseAssertions.js';
import { describe, expect, it, jest } from '@jest/globals';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createStreamableHttpRuntime } from '../../../src/server/StreamableHttpServer.js';
import { logger } from '../../../src/utils/logger.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Warm-pool shutdown condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('concurrent warm-pool shutdown', () => {
  it.each([false, true])('awaits all three prepared attachments before listener close (rejecting attachment: %s)', async rejectOne => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const disposers: Array<ReturnType<typeof jest.fn<() => Promise<void>>>> = [];
    const disposed = new Set<number>();
    const warn = jest.spyOn(logger, 'warn');
    const runtime = await createStreamableHttpRuntime(async transport => {
      const id = disposers.length;
      const server = new Server({ name: `pool-${id}`, version: '1' }, { capabilities: {} });
      await server.connect(transport);
      const dispose = jest.fn(async () => {
        if (id === 0) await held;
        await server.close();
        disposed.add(id);
        if (rejectOne && id === 1) throw new Error('Injected prepared attachment disposal failure');
      });
      disposers.push(dispose);
      return { dispose };
    }, { host: '127.0.0.1', port: 0, sessionPoolSize: 3, registerSignalHandlers: false });
    let closing: Promise<void> | undefined;
    try {
      await until(() => runtime.pooledSessionCount() === 3);
      expect(disposers).toHaveLength(3);
      closing = runtime.close();
      // The held first attachment must not prevent the other two disposals.
      await until(() => disposed.has(1) && disposed.has(2));
      for (const dispose of disposers) expect(dispose).toHaveBeenCalledTimes(1);
      expect(disposed.has(0)).toBe(false);
      expect(runtime.httpServer.listening).toBe(true);
      const health = await fetch(new URL('/healthz', runtime.url));
      await readHttpResponse(health, 200, 'Pool shutdown health probe', true);
      release();
      await expect(closing).resolves.toBeUndefined();
      expect(disposed).toEqual(new Set([0, 1, 2]));
      expect(runtime.pooledSessionCount()).toBe(0);
      expect(runtime.httpServer.listening).toBe(false);
      const failures = warn.mock.calls.filter(([message]) => message === '[StreamableHTTP] Failed to dispose pooled session');
      expect(failures).toHaveLength(rejectOne ? 1 : 0);
      if (rejectOne) expect(failures[0][1]).toEqual(expect.objectContaining({ error: expect.any(String) }));
    } finally { release(); await closing; await runtime.close(); warn.mockRestore(); }
  });
});
