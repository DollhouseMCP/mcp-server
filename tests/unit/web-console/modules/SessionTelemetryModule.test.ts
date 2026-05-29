import { describe, expect, it } from '@jest/globals';

import {
  ConsoleModuleRegistry,
  InMemoryOwnedActivityQuery,
  InMemoryRuntimeSessionControlStore,
  createSessionTelemetryModule,
  executeConsoleRoute,
  projectUserActivity,
  projectUserActivityPage,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
  type UserActivityDto,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SECOND_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const SESSION_ID = 'mcp-session-1';
const SECOND_SESSION_ID = 'mcp-session-2';
const LOGS_PATH = '/api/v1/me/sessions/:session_id/logs';
const LOGS_STREAM_PATH = '/api/v1/me/sessions/:session_id/logs/stream';
const NOW = new Date('2026-05-29T15:00:00.000Z');
const FIVE_MINUTES = new Date('2026-05-29T15:05:00.000Z');
const MUST_NOT_LEAK = 'must-not-leak';
const RUNTIME_STARTED_EVENT = 'runtime.session.started';
const RUNTIME_HEARTBEAT_EVENT = 'runtime.session.heartbeat';
const GATEKEEPER_APPROVAL_EVENT = 'gatekeeper.approval.requested';

async function fixture() {
  const runtimeStore = new InMemoryRuntimeSessionControlStore();
  await runtimeStore.registerPresence({
    sessionId: SESSION_ID,
    userId: USER_ID,
    accountCorrelationId: '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8',
    replicaId: 'replica-a',
    transport: 'streamable-http',
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: FIVE_MINUTES,
  });
  await runtimeStore.registerPresence({
    sessionId: SECOND_SESSION_ID,
    userId: SECOND_USER_ID,
    accountCorrelationId: '8d0e5e89-52d0-4f88-a7bc-8f2f65a708b9',
    replicaId: 'replica-b',
    transport: 'streamable-http',
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: FIVE_MINUTES,
  });
  const ownedActivityQuery = new InMemoryOwnedActivityQuery();
  ownedActivityQuery.seedOwnedActivity(USER_ID, SESSION_ID, [
    withExtraFields(activityRecord(0, { level: 'info', subsystem: 'runtime', event: RUNTIME_STARTED_EVENT })),
    activityRecord(1, { level: 'warn', subsystem: 'gatekeeper', event: GATEKEEPER_APPROVAL_EVENT }),
    activityRecord(2, { level: 'info', subsystem: 'runtime', event: RUNTIME_HEARTBEAT_EVENT }),
  ]);
  ownedActivityQuery.seedOwnedActivity(SECOND_USER_ID, SECOND_SESSION_ID, [
    activityRecord(0, {
      session_id: SECOND_SESSION_ID,
      message: MUST_NOT_LEAK,
    }),
  ]);
  const module = createSessionTelemetryModule({
    runtimeStore,
    ownedActivityQuery,
    now: () => NOW,
  });
  return { module, runtimeStore };
}

function withExtraFields(record: UserActivityDto): UserActivityDto {
  return {
    ...record,
    tool_input: MUST_NOT_LEAK,
    account_correlation_id: MUST_NOT_LEAK,
  } as UserActivityDto;
}

function activityRecord(index: number, overrides: Partial<UserActivityDto> = {}): UserActivityDto {
  return {
    ts: new Date(NOW.getTime() + index).toISOString(),
    session_id: SESSION_ID,
    level: 'info',
    subsystem: 'runtime',
    event: `runtime.event.${index}`,
    message: `Session event ${index}`,
    correlation_id: `correlation-${index}`,
    stable_error_code: null,
    ...overrides,
  };
}

function findRoute(
  routes: readonly ConsoleRouteDefinition[],
  method: ConsoleRouteDefinition['method'],
  path: string,
): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function request(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    ip: '127.0.0.1',
    get: (name: string) => name.toLowerCase() === 'user-agent' ? 'jest' : undefined,
    consoleContext: {
      correlationId: '94017d3c-7b7a-4e28-a3c2-701e0ea5471d',
      receivedAt: NOW,
    },
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32, 7),
      userId: USER_ID,
      authSub: 'sub-user',
      authzVersion: 1,
      grantedCapabilities: ['console:self'],
      elevation: null,
    },
    ...overrides,
  } as ConsoleRequest;
}

async function collectEvents<T>(events: AsyncIterable<T> | undefined): Promise<T[]> {
  if (!events) throw new Error('missing stream events');
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('SessionTelemetryModule', () => {
  it('registers descriptor-driven user log query and stream routes with expected policies', async () => {
    const registry = new ConsoleModuleRegistry();
    registry.register((await fixture()).module);

    expect(registry.createRouteManifest().routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleId: 'session-telemetry',
        method: 'GET',
        path: LOGS_PATH,
        requiredCapability: 'console:self',
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        moduleId: 'session-telemetry',
        method: 'GET',
        path: LOGS_STREAM_PATH,
        requiredCapability: 'console:self',
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        responseKind: 'sse',
      }),
    ]));
  });

  it('queries only owner-visible session logs with bounded filters and pagination', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', LOGS_PATH);

    await expect(route.handler(request({ params: { session_id: SECOND_SESSION_ID } })))
      .resolves.toMatchObject({ status: 404 });

    const result = await executeConsoleRoute(route, request({
      params: { session_id: SESSION_ID },
      query: { level: 'info', subsystem: 'runtime', limit: '1' },
    }));

    expect(result.body).toEqual({
      items: [expect.objectContaining({
        session_id: SESSION_ID,
        level: 'info',
        subsystem: 'runtime',
      })],
      page: {
        limit: 1,
        cursor: null,
        next_cursor: expect.any(String),
      },
    });
    expect(JSON.stringify(result.body)).not.toContain(MUST_NOT_LEAK);
  });

  it('round-trips pagination cursors and clamps oversized limits', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', LOGS_PATH);

    const firstPage = await executeConsoleRoute(route, request({
      params: { session_id: SESSION_ID },
      query: { limit: '1' },
    }));
    const nextCursor = projectUserActivityPage(firstPage.body).page.next_cursor;
    expect(nextCursor).toEqual(expect.any(String));

    const secondPage = await executeConsoleRoute(route, request({
      params: { session_id: SESSION_ID },
      query: { limit: '500', cursor: nextCursor ?? '' },
    }));

    expect(projectUserActivityPage(secondPage.body)).toMatchObject({
      items: [
        { event: GATEKEEPER_APPROVAL_EVENT },
        { event: RUNTIME_HEARTBEAT_EVENT },
      ],
      page: {
        limit: 100,
        cursor: nextCursor,
        next_cursor: null,
      },
    });
  });

  it('excludes user log records that do not match filters', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', LOGS_PATH);

    const result = await executeConsoleRoute(route, request({
      params: { session_id: SESSION_ID },
      query: { level: 'warn', subsystem: 'runtime' },
    }));

    expect(projectUserActivityPage(result.body)).toEqual({
      items: [],
      page: {
        limit: 100,
        cursor: null,
        next_cursor: null,
      },
    });
  });

  it('streams owner-visible session logs with projection and owned-session revalidation', async () => {
    const { module, runtimeStore } = await fixture();
    const route = findRoute(module.routes, 'GET', LOGS_STREAM_PATH);

    const result = await executeConsoleRoute(route, request({
      params: { session_id: SESSION_ID },
      query: { event: RUNTIME_STARTED_EVENT },
      headers: {},
    }));

    expect(result.stream?.init).toEqual({
      stream_id: `me.sessions.${SESSION_ID}.logs`,
      stream_type: 'session_logs',
      resume_supported: false,
      session_id: SESSION_ID,
      filters: {
        level: null,
        subsystem: null,
        event: RUNTIME_STARTED_EVENT,
      },
    });
    const events = await collectEvents(result.stream?.events);
    expect(events).toEqual([
      {
        event: 'update',
        data: expect.objectContaining({
          session_id: SESSION_ID,
          event: RUNTIME_STARTED_EVENT,
        }),
      },
      {
        event: 'end',
        data: { status: 'complete' },
      },
    ]);
    expect(result.stream?.projectEvent?.({
      event: 'update',
      data: { ...activityRecord(4), prompt: MUST_NOT_LEAK },
    })).toEqual({
      event: 'update',
      data: expect.not.objectContaining({ prompt: MUST_NOT_LEAK }),
    });
    expect(result.stream?.projectEvent?.({
      event: 'init',
      data: {
        connected_at: NOW.toISOString(),
        stream_id: `me.sessions.${SESSION_ID}.logs`,
        stream_type: 'wrong',
        resume_supported: true,
        session_id: SESSION_ID,
        filters: { level: 'info', subsystem: 'runtime', event: 'x', secret: MUST_NOT_LEAK },
      },
    })).toEqual({
      event: 'init',
      data: {
        connected_at: NOW.toISOString(),
        stream_id: `me.sessions.${SESSION_ID}.logs`,
        stream_type: 'session_logs',
        resume_supported: true,
        session_id: SESSION_ID,
        filters: { level: 'info', subsystem: 'runtime', event: 'x' },
      },
    });
    expect(result.stream?.projectEvent?.({
      event: 'end',
      data: { status: 'interrupted', secret: MUST_NOT_LEAK },
    })).toEqual({
      event: 'end',
      data: { status: 'closed' },
    });

    await runtimeStore.markPresenceClosing(SESSION_ID, NOW);
    await expect(result.stream?.revalidate?.()).resolves.toBe(false);
  });

  it('streams multiple matching session log records', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', LOGS_STREAM_PATH);

    const result = await executeConsoleRoute(route, request({
      params: { session_id: SESSION_ID },
      query: { subsystem: 'runtime' },
      headers: {},
    }));

    expect((await collectEvents(result.stream?.events)).map(event => event.event === 'update'
      ? (event.data as UserActivityDto).event
      : event.event)).toEqual([
      RUNTIME_STARTED_EVENT,
      RUNTIME_HEARTBEAT_EVENT,
      'end',
    ]);
  });

  it('denies session log streams for non-owned sessions', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', LOGS_STREAM_PATH);

    await expect(route.handler(request({
      params: { session_id: SECOND_SESSION_ID },
      headers: {},
    }))).resolves.toMatchObject({ status: 404 });
  });

  it('rejects Last-Event-ID on session log streams until real resume is implemented', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', LOGS_STREAM_PATH);

    expect(() => route.handler(request({
      params: { session_id: SESSION_ID },
      headers: { 'last-event-id': 'session-log:1' },
    }))).toThrow('Invalid Last-Event-ID');
  });

  it('privacy projectors allowlist user activity DTO fields', () => {
    expect(projectUserActivity({
      ...activityRecord(0),
      tool_input: MUST_NOT_LEAK,
      account_correlation_id: MUST_NOT_LEAK,
    })).toEqual(expect.not.objectContaining({
      tool_input: MUST_NOT_LEAK,
      account_correlation_id: MUST_NOT_LEAK,
    }));
  });
});
