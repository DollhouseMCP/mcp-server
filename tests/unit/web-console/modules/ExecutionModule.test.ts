import { describe, expect, it, jest } from '@jest/globals';

import {
  ConsoleModuleRegistry,
  GatekeeperSessionStateReader,
  InMemoryRuntimeSessionControlStore,
  InMemorySessionExecutionReader,
  createExecutionModule,
  executeConsoleRoute,
  projectSessionExecution,
  projectSessionExecutionList,
  projectSessionGatekeeper,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
  type SessionExecutionDetailDto,
} from '../../../../src/web-console/index.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { GatekeeperSession } from '../../../../src/handlers/mcp-aql/GatekeeperSession.js';
import { PermissionLevel } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { StaticAuditHmacKeyResolver } from '../../../../src/security/auditHmacKey.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SECOND_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const SESSION_ID = 'mcp-session-1';
const SECOND_SESSION_ID = 'mcp-session-2';
const GOAL_ID = 'goal-018f3d47';
const EXECUTION_LIST_PATH = '/api/v1/me/sessions/:session_id/executions';
const EXECUTION_DETAIL_PATH = '/api/v1/me/sessions/:session_id/executions/:goal_id';
const EXECUTION_STREAM_PATH = '/api/v1/me/sessions/:session_id/executions/:goal_id/stream';
const GATEKEEPER_PATH = '/api/v1/me/sessions/:session_id/gatekeeper';
const EXECUTION_STEP = 'Reviewed auth module';
const NOW = new Date('2026-05-29T14:00:00.000Z');
const FIVE_MINUTES = new Date('2026-05-29T14:05:00.000Z');

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
  const executionReader = new InMemorySessionExecutionReader();
  executionReader.seed(USER_ID, SESSION_ID, executionRecord());
  executionReader.seed(SECOND_USER_ID, SECOND_SESSION_ID, executionRecord({ goal_id: 'goal-other' }));
  const gatekeeper = new Gatekeeper();
  const gatekeeperSession = new GatekeeperSession(
    { name: 'claude-code', version: '1.2.3' },
    100,
    100,
    undefined,
    SESSION_ID,
    new StaticAuditHmacKeyResolver('99'.repeat(32)),
  );
  gatekeeperSession.recordConfirmation('edit_element', PermissionLevel.CONFIRM_SESSION, 'skill');
  await gatekeeperSession.createCliApprovalRequest({
    toolName: 'Bash',
    toolInput: { command: 'npm test -- --runInBand' },
    riskLevel: 'moderate',
    riskScore: 55,
    irreversible: false,
    denyReason: 'Tool requires approval',
    policySource: 'element_policy',
    ttlMs: 300_000,
  });
  gatekeeper.registerSession(SESSION_ID, gatekeeperSession);
  const module = createExecutionModule({
    runtimeStore,
    executionReader,
    gatekeeperReader: new GatekeeperSessionStateReader(gatekeeper),
    now: () => NOW,
  });
  return { module, runtimeStore };
}

function executionRecord(overrides: Partial<SessionExecutionDetailDto> = {}): SessionExecutionDetailDto {
  return {
    goal_id: GOAL_ID,
    session_id: SESSION_ID,
    agent_name: 'code-reviewer',
    status: 'running',
    progress: 0.5,
    started_at: '2026-05-29T13:55:00.000Z',
    updated_at: '2026-05-29T13:59:00.000Z',
    completed_at: null,
    current_step: EXECUTION_STEP,
    stable_error_code: null,
    output: [{
      kind: 'progress',
      message: EXECUTION_STEP,
      occurred_at: '2026-05-29T13:58:00.000Z',
    }],
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

describe('ExecutionModule', () => {
  it('registers descriptor-driven execution and gatekeeper routes with expected policies', async () => {
    const registry = new ConsoleModuleRegistry();
    registry.register((await fixture()).module);

    expect(registry.createRouteManifest().routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleId: 'executions',
        method: 'GET',
        path: EXECUTION_LIST_PATH,
        requiredCapability: 'console:self',
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        moduleId: 'executions',
        method: 'GET',
        path: EXECUTION_DETAIL_PATH,
      }),
      expect.objectContaining({
        moduleId: 'executions',
        method: 'GET',
        path: EXECUTION_STREAM_PATH,
        requiredCapability: 'console:self',
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        responseKind: 'sse',
      }),
      expect.objectContaining({
        moduleId: 'executions',
        method: 'GET',
        path: GATEKEEPER_PATH,
      }),
    ]));
  });

  it('lists and reads owner-private executions only after owned-session validation', async () => {
    const { module } = await fixture();
    const listRoute = findRoute(module.routes, 'GET', EXECUTION_LIST_PATH);
    const detailRoute = findRoute(module.routes, 'GET', EXECUTION_DETAIL_PATH);

    await expect(executeConsoleRoute(listRoute, request({ params: { session_id: SECOND_SESSION_ID } })))
      .resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(listRoute.handler(request({ params: { session_id: SESSION_ID } })))
      .resolves.toMatchObject({
        status: 200,
        body: {
          executions: [expect.objectContaining({
            goal_id: GOAL_ID,
            session_id: SESSION_ID,
            status: 'running',
            current_step: 'Reviewed auth module',
          })],
        },
      });
    await expect(detailRoute.handler(request({
      params: { session_id: SESSION_ID, goal_id: GOAL_ID },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        goal_id: GOAL_ID,
        output: [expect.objectContaining({ message: 'Reviewed auth module' })],
      },
    });
    await expect(executeConsoleRoute(detailRoute, request({
      params: { session_id: SESSION_ID, goal_id: 'bad goal id' },
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    await expect(executeConsoleRoute(detailRoute, request({
      params: { session_id: SESSION_ID, goal_id: 'goal-missing' },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('rejects invalid execution session IDs before service ownership checks', async () => {
    const { module, runtimeStore } = await fixture();
    const listRoute = findRoute(module.routes, 'GET', EXECUTION_LIST_PATH);
    const detailRoute = findRoute(module.routes, 'GET', EXECUTION_DETAIL_PATH);
    const lookup = jest.spyOn(runtimeStore, 'findPresence');

    await expect(Promise.resolve(listRoute.handler(request({ params: { session_id: 'bad session id' } }))))
      .resolves.toMatchObject({
        status: 400,
        body: { code: 'invalid_request', detail: 'session_id path parameter is invalid.' },
      });
    await expect(Promise.resolve(detailRoute.handler(request({
      params: { session_id: '../bad', goal_id: GOAL_ID },
    })))).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid_request', detail: 'session_id path parameter is invalid.' },
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('streams owner-private execution updates with projection and owned-session revalidation', async () => {
    const { module, runtimeStore } = await fixture();
    const route = findRoute(module.routes, 'GET', EXECUTION_STREAM_PATH);

    const result = await executeConsoleRoute(route, request({
      params: { session_id: SESSION_ID, goal_id: GOAL_ID },
      query: {},
      headers: {},
    }));

    expect(result.stream?.init).toEqual({
      stream_id: `me.sessions.${SESSION_ID}.executions.${GOAL_ID}`,
      stream_type: 'session_execution',
      resume_supported: false,
      session_id: SESSION_ID,
      goal_id: GOAL_ID,
    });
    const events = await collectEvents(result.stream?.events);
    expect(events).toEqual([
      {
        event: 'update',
        data: expect.objectContaining({
          goal_id: GOAL_ID,
          session_id: SESSION_ID,
          status: 'running',
          output: [expect.objectContaining({ message: 'Reviewed auth module' })],
        }),
      },
      {
        event: 'end',
        data: { status: 'complete' },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('tool_input');
    expect(result.stream?.projectEvent?.({
      event: 'update',
      data: { ...executionRecord(), secret: 'drop' },
    })).toEqual({
      event: 'update',
      data: expect.not.objectContaining({ secret: 'drop' }),
    });
    expect(result.stream?.projectEvent?.({
      event: 'init',
      data: {
        connected_at: NOW.toISOString(),
        stream_id: `me.sessions.${SESSION_ID}.executions.${GOAL_ID}`,
        stream_type: 'wrong',
        resume_supported: true,
        session_id: SESSION_ID,
        goal_id: GOAL_ID,
        secret: 'drop',
      },
    })).toEqual({
      event: 'init',
      data: {
        connected_at: NOW.toISOString(),
        stream_id: `me.sessions.${SESSION_ID}.executions.${GOAL_ID}`,
        stream_type: 'session_execution',
        resume_supported: true,
        session_id: SESSION_ID,
        goal_id: GOAL_ID,
      },
    });
    expect(result.stream?.projectEvent?.({
      event: 'end',
      data: { status: 'interrupted', secret: 'drop' },
    })).toEqual({
      event: 'end',
      data: { status: 'closed' },
    });

    await runtimeStore.markPresenceClosing(SESSION_ID, NOW);
    await expect(result.stream?.revalidate?.()).resolves.toBe(false);
  });

  it('denies execution streams for non-owned sessions', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', EXECUTION_STREAM_PATH);

    await expect(route.handler(request({
      params: { session_id: SECOND_SESSION_ID, goal_id: GOAL_ID },
      headers: {},
    }))).resolves.toMatchObject({ status: 404 });
  });

  it('validates execution stream goal IDs before opening a stream', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', EXECUTION_STREAM_PATH);

    await expect(route.handler(request({
      params: { session_id: SESSION_ID, goal_id: 'bad goal id' },
      headers: {},
    }))).resolves.toMatchObject({ status: 422 });
  });

  it('rejects invalid execution stream session IDs before opening a stream', async () => {
    const { module, runtimeStore } = await fixture();
    const route = findRoute(module.routes, 'GET', EXECUTION_STREAM_PATH);
    const lookup = jest.spyOn(runtimeStore, 'findPresence');

    await expect(Promise.resolve(route.handler(request({
      params: { session_id: 'bad session id', goal_id: GOAL_ID },
      headers: {},
    })))).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid_request', detail: 'session_id path parameter is invalid.' },
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns not found when the execution stream target does not exist', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', EXECUTION_STREAM_PATH);

    await expect(route.handler(request({
      params: { session_id: SESSION_ID, goal_id: 'goal-missing' },
      headers: {},
    }))).resolves.toMatchObject({ status: 404 });
  });

  it('rejects Last-Event-ID on execution streams until real resume is implemented', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', EXECUTION_STREAM_PATH);

    expect(() => route.handler(request({
      params: { session_id: SESSION_ID, goal_id: GOAL_ID },
      headers: { 'last-event-id': 'execution:1' },
    }))).toThrow('Invalid Last-Event-ID');
  });

  it('projects live Gatekeeper state without exposing raw approval input', async () => {
    const { module } = await fixture();
    const route = findRoute(module.routes, 'GET', GATEKEEPER_PATH);

    await expect(route.handler(request({ params: { session_id: SECOND_SESSION_ID } })))
      .resolves.toMatchObject({ status: 404 });
    const result = await route.handler(request({ params: { session_id: SESSION_ID } }));

    expect(result).toMatchObject({
      status: 200,
      body: {
        session_id: SESSION_ID,
        confirmation_count: 1,
        pending_approval_count: 1,
        retained_approval_count: 1,
        client: { name: 'claude-code', version: '1.2.3' },
        confirmations: [expect.objectContaining({
          operation: 'edit_element',
          element_type: 'skill',
          scope: 'session',
        })],
        pending_approvals: [expect.objectContaining({
          tool_name: 'Bash',
          risk_level: 'moderate',
          reason: 'Tool requires approval',
        })],
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('npm test -- --runInBand');
    expect(JSON.stringify(result.body)).not.toContain('tool_input');
  });

  it('privacy projectors allowlist execution and Gatekeeper DTO fields', () => {
    expect(projectSessionExecutionList({
      executions: [{ ...executionRecord(), secret: 'drop' }],
      secret: 'drop',
    })).toEqual({
      executions: [expect.not.objectContaining({ secret: 'drop' })],
    });
    expect(projectSessionExecution({ ...executionRecord(), output: [{ kind: 'result', message: 'done', occurred_at: NOW.toISOString(), extra: 'drop' }] }))
      .toEqual(expect.not.objectContaining({ extra: 'drop' }));
    expect(projectSessionGatekeeper({
      session_id: SESSION_ID,
      permission_prompt_active: true,
      confirmation_count: 1,
      pending_approval_count: 1,
      retained_approval_count: 1,
      client: { name: 'client', version: '1', token: 'drop' },
      confirmations: [{ operation: 'edit', element_type: 'skill', scope: 'once', confirmed_at: NOW.toISOString(), use_count: 0, raw: 'drop' }],
      pending_approvals: [{ approval_id: 'cli-id', tool_name: 'Bash', risk_level: 'moderate', risk_score: 1, irreversible: false, reason: 'x', policy_source: null, requested_at: NOW.toISOString(), expires_at: NOW.toISOString(), tool_input_detail: { raw: true } }],
    })).toEqual(expect.not.objectContaining({ tool_input_detail: expect.anything() }));
  });
});
