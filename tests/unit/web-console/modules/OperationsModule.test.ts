import { describe, expect, it } from '@jest/globals';

import {
  InMemoryConsoleTelemetryQuery,
  createOperationsModule,
  projectOperationHealthComponent,
  projectOperationHealthSummary,
  projectOperationalLogs,
  projectOperationalMetrics,
  type ConsoleRouteDefinition,
  type OperationsHealthChecks,
} from '../../../../src/web-console/index.js';

const NOW = new Date('2026-05-29T10:30:00.000Z');
const MUST_NOT_LEAK = 'must-not-leak';
const OPERATE_CAPABILITY = 'console:admin:operate';
const OPERATIONAL_PRIVACY = 'operational_allowlist';
const RUNTIME_HEARTBEAT_EVENT = 'runtime.session.heartbeat';
const GATEKEEPER_DECISION_EVENT = 'gatekeeper.decision';
const RUNTIME_ERRORS_METRIC = 'runtime.session.errors';
const OPERATE_LOGS_PATH = '/api/v1/admin/operate/logs';

const HEALTH_CHECKS: OperationsHealthChecks = {
  database: () => true,
  authServer: () => true,
  gatekeeper: () => true,
  runtimeControl: () => true,
  securityInvalidation: () => ({
    component: 'security_invalidation',
    status: 'not_ready',
    checked_at: NOW.toISOString(),
    failure_codes: ['security_invalidation_processor_not_ready'],
  }),
  apiMount: () => ({
    component: 'api_mount',
    status: 'not_ready',
    checked_at: NOW.toISOString(),
    failure_codes: ['api_v1_not_mounted'],
  }),
};

function createModule(
  healthChecks: OperationsHealthChecks = HEALTH_CHECKS,
  telemetry = createTelemetry(),
) {
  return createOperationsModule({
    healthChecks,
    telemetry,
    now: () => NOW,
  });
}

function createTelemetry(logCount = 1): InMemoryConsoleTelemetryQuery {
  return new InMemoryConsoleTelemetryQuery({
    now: () => NOW,
    logs: Array.from({ length: logCount }, (_, index) => ({
      ts: new Date(NOW.getTime() + index).toISOString(),
      level: index % 2 === 0 ? 'warn' : 'info',
      subsystem: index % 3 === 0 ? 'runtime' : 'gatekeeper',
      event: index % 2 === 0 ? RUNTIME_HEARTBEAT_EVENT : GATEKEEPER_DECISION_EVENT,
      correlation_id: `correlation-${index + 1}`,
      account_correlation_id: `account-correlation-${index + 1}`,
      session_id: `session-${index + 1}`,
      replica: 'replica-a',
      duration_ms: 12 + index,
      status_code: 200,
      error_code: null,
    })),
    metrics: {
      checked_at: NOW.toISOString(),
      metrics: [
        {
          name: RUNTIME_ERRORS_METRIC,
          kind: 'counter',
          value: 2,
          unit: 'count',
          dimensions: {
            subsystem: 'runtime',
            error_code: 'transport_closed',
            replica: 'replica-a',
          },
        },
        {
          name: 'gatekeeper.decisions',
          kind: 'counter',
          value: 4,
          unit: 'count',
          dimensions: {
            subsystem: 'gatekeeper',
            event: GATEKEEPER_DECISION_EVENT,
          },
        },
      ],
    },
  });
}

function findRoute(routes: readonly ConsoleRouteDefinition[], method: string, path: string): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

describe('OperationsModule', () => {
  it('declares authenticated operator read descriptors', () => {
    const module = createModule();

    expect(module).toMatchObject({
      id: 'operations',
      apiVersion: 'v1',
      capabilities: ['console:admin:operate'],
    });
    expect(module.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/operate/health',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        idempotency: 'not_applicable',
        auditOperation: 'operate.health.show',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/operate/health/database',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        auditOperation: 'operate.health.database',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/operate/health/auth-server',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        auditOperation: 'operate.health.auth_server',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/operate/health/gatekeeper',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        auditOperation: 'operate.health.gatekeeper',
      }),
      expect.objectContaining({
        method: 'GET',
        path: OPERATE_LOGS_PATH,
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        auditOperation: 'operate.logs.list',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/operate/metrics',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        auditOperation: 'operate.metrics.show',
      }),
    ]));
    expect(module.auditOperations).toEqual(expect.arrayContaining([
      { id: 'operate.health.show' },
      { id: 'operate.health.database' },
      { id: 'operate.health.auth_server' },
      { id: 'operate.health.gatekeeper' },
      { id: 'operate.logs.list' },
      { id: 'operate.metrics.show' },
    ]));
    expect(module.routes.map(route => route.path)).not.toContain('/api/v1/admin/operate/logs/stream');
    expect(module.routes.map(route => route.path)).not.toContain('/api/v1/admin/operate/metrics/stream');
  });

  it('returns detailed operator health with stable failure codes', async () => {
    const route = findRoute(createModule().routes, 'GET', '/api/v1/admin/operate/health');

    const result = await route.handler({ query: {}, params: {} } as never);

    expect(result.status).toBe(200);
    expect(projectOperationHealthSummary(result.body)).toEqual({
      status: 'degraded',
      checked_at: NOW.toISOString(),
      components: expect.arrayContaining([
        {
          component: 'database',
          status: 'ok',
          checked_at: NOW.toISOString(),
          failure_codes: [],
        },
        {
          component: 'security_invalidation',
          status: 'not_ready',
          checked_at: NOW.toISOString(),
          failure_codes: ['security_invalidation_processor_not_ready'],
        },
      ]),
    });
  });

  it('returns unavailable component health as 503 without sensitive config', async () => {
    const route = findRoute(createModule({
      ...HEALTH_CHECKS,
      database: () => false,
    }).routes, 'GET', '/api/v1/admin/operate/health/database');

    const result = await route.handler({ query: {}, params: {} } as never);

    expect(result).toEqual({
      status: 503,
      body: {
        component: 'database',
        status: 'unavailable',
        checked_at: NOW.toISOString(),
        failure_codes: ['database_unavailable'],
      },
    });
  });

  it('returns 503 for summary health when any component is unavailable', async () => {
    const route = findRoute(createModule({
      ...HEALTH_CHECKS,
      database: () => false,
    }).routes, 'GET', '/api/v1/admin/operate/health');

    const result = await route.handler({ query: {}, params: {} } as never);

    expect(result.status).toBe(503);
    expect(projectOperationHealthSummary(result.body)).toMatchObject({
      status: 'unavailable',
      components: expect.arrayContaining([
        {
          component: 'database',
          status: 'unavailable',
          checked_at: NOW.toISOString(),
          failure_codes: ['database_unavailable'],
        },
      ]),
    });
  });

  it('maps throwing health checks to stable component failure codes', async () => {
    const route = findRoute(createModule({
      ...HEALTH_CHECKS,
      authServer: () => {
        throw new Error('connection string must not leak');
      },
    }).routes, 'GET', '/api/v1/admin/operate/health/auth-server');

    const result = await route.handler({ query: {}, params: {} } as never);

    expect(result.status).toBe(503);
    expect(projectOperationHealthComponent(result.body)).toEqual({
      component: 'auth_server',
      status: 'unavailable',
      checked_at: NOW.toISOString(),
      failure_codes: ['auth_server_check_failed'],
    });
  });

  it('queries operational logs through the allowlisted telemetry boundary', async () => {
    const route = findRoute(createModule().routes, 'GET', OPERATE_LOGS_PATH);

    const result = await route.handler({
      query: { subsystem: 'runtime', limit: '10' },
      params: {},
    } as never);

    expect(projectOperationalLogs(result.body)).toEqual({
      items: [
        {
          ts: NOW.toISOString(),
          level: 'warn',
          subsystem: 'runtime',
          event: RUNTIME_HEARTBEAT_EVENT,
          correlation_id: 'correlation-1',
          account_correlation_id: 'account-correlation-1',
          session_id: 'session-1',
          replica: 'replica-a',
          duration_ms: 12,
          status_code: 200,
          error_code: null,
        },
      ],
      page: {
        limit: 10,
        cursor: null,
        next_cursor: null,
      },
    });
  });

  it('bounds operational log limits for invalid and extreme requests', async () => {
    const route = findRoute(createModule(HEALTH_CHECKS, createTelemetry(150)).routes, 'GET', OPERATE_LOGS_PATH);

    await expect(route.handler({ query: { limit: '0' }, params: {} } as never))
      .resolves.toMatchObject({ body: { items: expect.arrayContaining([expect.any(Object)]), page: { limit: 1 } } });
    await expect(route.handler({ query: { limit: '-10' }, params: {} } as never))
      .resolves.toMatchObject({ body: { page: { limit: 1 } } });
    await expect(route.handler({ query: { limit: '1000' }, params: {} } as never))
      .resolves.toMatchObject({ body: { items: expect.any(Array), page: { limit: 100 } } });
    await expect(route.handler({ query: { limit: 'not-a-number' }, params: {} } as never))
      .resolves.toMatchObject({ body: { items: expect.any(Array), page: { limit: 100 } } });
    await expect(route.handler({ query: {}, params: {} } as never))
      .resolves.toMatchObject({ body: { items: expect.any(Array), page: { limit: 100 } } });
  });

  it('emits and consumes operational log cursors without trusting malformed cursors', async () => {
    const route = findRoute(createModule(HEALTH_CHECKS, createTelemetry(3)).routes, 'GET', OPERATE_LOGS_PATH);

    const first = await route.handler({ query: { limit: '2' }, params: {} } as never);
    const firstPage = projectOperationalLogs(first.body);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.page.next_cursor).toEqual(expect.any(String));

    const second = await route.handler({
      query: { limit: '2', cursor: firstPage.page.next_cursor },
      params: {},
    } as never);
    expect(projectOperationalLogs(second.body)).toMatchObject({
      items: [{ session_id: 'session-3' }],
      page: {
        limit: 2,
        cursor: firstPage.page.next_cursor,
        next_cursor: null,
      },
    });

    const malformed = await route.handler({ query: { limit: '2', cursor: 'not-valid-base64url' }, params: {} } as never);
    expect(projectOperationalLogs(malformed.body).items.map(item => item.session_id)).toEqual(['session-1', 'session-2']);
  });

  it('applies level and event filters to operational logs', async () => {
    const route = findRoute(createModule(HEALTH_CHECKS, createTelemetry(4)).routes, 'GET', OPERATE_LOGS_PATH);

    const result = await route.handler({
      query: { level: 'info', event: GATEKEEPER_DECISION_EVENT },
      params: {},
    } as never);

    expect(projectOperationalLogs(result.body).items).toEqual([
      expect.objectContaining({ level: 'info', event: GATEKEEPER_DECISION_EVENT, session_id: 'session-2' }),
      expect.objectContaining({ level: 'info', event: GATEKEEPER_DECISION_EVENT, session_id: 'session-4' }),
    ]);
  });

  it('queries operational metrics through the allowlisted telemetry boundary', async () => {
    const route = findRoute(createModule().routes, 'GET', '/api/v1/admin/operate/metrics');

    const result = await route.handler({
      query: { subsystem: 'runtime', name: RUNTIME_ERRORS_METRIC },
      params: {},
    } as never);

    expect(projectOperationalMetrics(result.body)).toEqual({
      checked_at: NOW.toISOString(),
      metrics: [{
        name: RUNTIME_ERRORS_METRIC,
        kind: 'counter',
        value: 2,
        unit: 'count',
        dimensions: {
          subsystem: 'runtime',
          error_code: 'transport_closed',
          replica: 'replica-a',
        },
      }],
    });
  });

  it('projects logs and metrics by allowlist rather than source object shape', () => {
    expect(projectOperationalLogs({
      items: [{
        ts: NOW.toISOString(),
        level: 'error',
        subsystem: 'gatekeeper',
        event: 'gatekeeper.denied',
        correlation_id: 'correlation-2',
        account_correlation_id: 'account-correlation-2',
        session_id: 'session-2',
        replica: 'replica-b',
        duration_ms: 8,
        status_code: 403,
        error_code: 'gatekeeper_denied',
        user_id: MUST_NOT_LEAK,
        prompt: MUST_NOT_LEAK,
        tool_input: { secret: true },
      }],
      page: {
        limit: 1,
        cursor: null,
        next_cursor: null,
        raw_ip: MUST_NOT_LEAK,
      },
    })).toEqual({
      items: [{
        ts: NOW.toISOString(),
        level: 'error',
        subsystem: 'gatekeeper',
        event: 'gatekeeper.denied',
        correlation_id: 'correlation-2',
        account_correlation_id: 'account-correlation-2',
        session_id: 'session-2',
        replica: 'replica-b',
        duration_ms: 8,
        status_code: 403,
        error_code: 'gatekeeper_denied',
      }],
      page: {
        limit: 1,
        cursor: null,
        next_cursor: null,
      },
    });

    expect(projectOperationalMetrics({
      checked_at: NOW.toISOString(),
      metrics: [{
        name: RUNTIME_ERRORS_METRIC,
        kind: 'counter',
        value: 2,
        unit: 'count',
        dimensions: {
          subsystem: 'runtime',
          user_id: MUST_NOT_LEAK,
          prompt: MUST_NOT_LEAK,
          account_correlation_id: 'account-correlation-3',
        },
        raw_samples: [MUST_NOT_LEAK],
      }],
    })).toEqual({
      checked_at: NOW.toISOString(),
      metrics: [{
        name: RUNTIME_ERRORS_METRIC,
        kind: 'counter',
        value: 2,
        unit: 'count',
        dimensions: {
          subsystem: 'runtime',
          account_correlation_id: 'account-correlation-3',
        },
      }],
    });
  });

  it('projects health by allowlist rather than source object shape', () => {
    expect(projectOperationHealthSummary({
      status: 'ok',
      checked_at: NOW.toISOString(),
      db_connection_string: MUST_NOT_LEAK,
      components: [{
        component: 'database',
        status: 'ok',
        checked_at: NOW.toISOString(),
        failure_codes: [],
        host: MUST_NOT_LEAK,
        connection_string: MUST_NOT_LEAK,
        credentials: { password: MUST_NOT_LEAK },
      }],
    })).toEqual({
      status: 'ok',
      checked_at: NOW.toISOString(),
      components: [{
        component: 'database',
        status: 'ok',
        checked_at: NOW.toISOString(),
        failure_codes: [],
      }],
    });
  });
});
