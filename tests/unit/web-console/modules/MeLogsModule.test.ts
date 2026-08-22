import { describe, expect, it } from '@jest/globals';

import {
  createMemoryConsoleLogSource,
  createMeLogsModule,
  type ConsoleLogEntry,
  type ConsoleLogQueryOptions,
  type IConsoleLogSource,
} from '../../../../src/web-console/modules/me-logs/index.js';
import { MemoryLogSink } from '../../../../src/logging/sinks/MemoryLogSink.js';
import type { ConsoleRequest } from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';

function entry(id: number): ConsoleLogEntry {
  return {
    id: `log-${id}`,
    ts: '2026-07-06T12:00:00.000Z',
    level: 'info',
    category: 'app',
    source: 'test',
    message: `message ${id}`,
    correlation_id: null,
    session_id: null,
  };
}

/** A source over a fixed set of entries honoring the console keyset boundary. */
function sourceOver(total: number): { source: IConsoleLogSource; seen: ConsoleLogQueryOptions[] } {
  const seen: ConsoleLogQueryOptions[] = [];
  return {
    seen,
    source: {
      queryUserLogs(options) {
        seen.push(options);
        const all = Array.from({ length: total }, (_, i) => entry(i + 1));
        const boundaryIndex = options.beforeId
          ? all.findIndex(candidate => candidate.id === options.beforeId)
          : -1;
        const start = boundaryIndex + 1;
        const slice = all.slice(start, start + options.limit);
        return { entries: slice, has_more: start + slice.length < total };
      },
    },
  };
}

function request(query: Record<string, string> = {}): ConsoleRequest {
  return {
    params: {},
    query,
    body: {},
    headers: {},
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32, 7),
      userId: USER_ID,
      authSub: 'github_user-7',
      authzVersion: 1,
      grantedCapabilities: ['console:self'],
      elevation: null,
    },
  } as unknown as ConsoleRequest;
}

function route(source: IConsoleLogSource) {
  const module = createMeLogsModule({ logSource: source });
  const match = module.routes.find(candidate => candidate.path === '/api/v1/me/logs');
  if (!match) throw new Error('me/logs route not found');
  return match;
}

describe('MeLogsModule', () => {
  it('serves the cursor-family envelope with a null cursor on the first page', async () => {
    const { source } = sourceOver(2);
    const result = await route(source).handler(request({ limit: '10' }));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      items: [entry(1), entry(2)],
      page: { limit: 10, cursor: null, next_cursor: null },
    });
  });

  it('walks pages through opaque cursors, never exposing an offset parameter', async () => {
    const { source, seen } = sourceOver(3);
    const handler = route(source).handler;

    const first = await handler(request({ limit: '2' }));
    const firstBody = first.body as { items: unknown[]; page: { next_cursor: string | null } };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.page.next_cursor).not.toBeNull();
    expect(firstBody.page.next_cursor).not.toBe('2'); // opaque, not a raw offset

    const second = await handler(request({ limit: '2', cursor: firstBody.page.next_cursor ?? '' }));
    const secondBody = second.body as {
      items: readonly ConsoleLogEntry[];
      page: { cursor: string | null; next_cursor: string | null };
    };
    expect(secondBody.items).toEqual([entry(3)]);
    expect(secondBody.page.cursor).toBe(firstBody.page.next_cursor);
    expect(secondBody.page.next_cursor).toBeNull();
    expect(seen.map(options => options.beforeId)).toEqual([null, 'log-2']);
  });

  it('treats a garbage cursor as the first page', async () => {
    const { source, seen } = sourceOver(1);
    await route(source).handler(request({ cursor: 'not-a-cursor' }));
    expect(seen[0]).toMatchObject({ cursor: null, beforeTimestamp: null, beforeId: null });
  });

  it('passes filters through to the source alongside the cursor', async () => {
    const { source, seen } = sourceOver(1);
    await route(source).handler(request({ level: 'error', session_id: 'sess-1' }));
    expect(seen[0]).toMatchObject({
      userId: USER_ID,
      level: 'error',
      sessionId: 'sess-1',
      cursor: null,
      beforeTimestamp: null,
      beforeId: null,
    });
  });

  it('does not skip or repeat entries inserted ahead of a continuation cursor', async () => {
    const sink = new MemoryLogSink({
      appCapacity: 20,
      securityCapacity: 20,
      perfCapacity: 20,
      telemetryCapacity: 20,
    });
    for (let id = 1; id <= 5; id += 1) {
      sink.write({
        id: `log-${id}`,
        timestamp: `2026-07-06T12:00:0${id}.000Z`,
        category: 'application',
        level: 'info',
        source: 'test',
        message: `message ${id}`,
        userId: USER_ID,
      });
    }
    const handler = route(createMemoryConsoleLogSource(sink)).handler;
    const first = await handler(request({ limit: '2' }));
    const firstBody = first.body as { items: ConsoleLogEntry[]; page: { next_cursor: string } };

    sink.write({
      id: 'log-6',
      timestamp: '2026-07-06T12:00:06.000Z',
      category: 'application',
      level: 'info',
      source: 'test',
      message: 'message 6',
      userId: USER_ID,
    });
    const second = await handler(request({ limit: '2', cursor: firstBody.page.next_cursor }));
    const secondBody = second.body as { items: ConsoleLogEntry[] };

    expect(firstBody.items.map(item => item.id)).toEqual(['log-5', 'log-4']);
    expect(secondBody.items.map(item => item.id)).toEqual(['log-3', 'log-2']);
  });
});
