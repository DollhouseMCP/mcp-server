import { describe, expect, it } from '@jest/globals';

import { InMemoryOperatorConfigStore } from '../../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import type { OperatorConfig } from '../../../../src/storage/operatorConfig/IOperatorConfigStore.js';
import {
  InMemoryConsoleTelemetryQuery,
  createOperationsModule,
  executeConsoleRoute,
  projectOperatorConfigList,
  projectOperatorConfigSetting,
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
const OPERATE_LOGS_STREAM_PATH = '/api/v1/admin/operate/logs/stream';
const OPERATE_METRICS_PATH = '/api/v1/admin/operate/metrics';
const OPERATE_METRICS_STREAM_PATH = '/api/v1/admin/operate/metrics/stream';
const OPERATE_CONFIG_PATH = '/api/v1/admin/operate/config';
const LICENSE_KEY_PATH = '/api/v1/admin/operate/config/:key';
const CONSOLE_PORT_KEY = 'console.port';

class RacingOperatorConfigStore extends InMemoryOperatorConfigStore {
  private raceInjected = false;

  override async save(
    config: Omit<OperatorConfig, 'updatedAt'> & { updatedAt?: number },
    options: { readonly expectedUpdatedAt?: number } = {},
  ): Promise<void> {
    if (options.expectedUpdatedAt !== undefined && !this.raceInjected) {
      this.raceInjected = true;
      await super.save({
        enhancedIndexConfig: { enabled: false },
        consoleConfig: { port: 3200 },
        licenseConfig: {},
        defaultsConfig: {},
        configVersion: 1,
      });
    }
    return super.save(config, options);
  }
}

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
    operatorConfigStore: new InMemoryOperatorConfigStore(),
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

async function collectEvents<T>(events: AsyncIterable<T> | undefined): Promise<T[]> {
  if (!events) throw new Error('missing stream events');
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
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
        path: OPERATE_CONFIG_PATH,
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        idempotency: 'not_applicable',
        auditOperation: 'operate.config.list',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/operate/config/:key',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        idempotency: 'not_applicable',
        auditOperation: 'operate.config.show',
      }),
      expect.objectContaining({
        method: 'PUT',
        path: '/api/v1/admin/operate/config/:key',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: OPERATIONAL_PRIVACY,
        idempotency: 'required',
        auditOperation: 'operate.config.update',
      }),
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
        path: OPERATE_LOGS_STREAM_PATH,
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        auditOperation: 'operate.logs.stream',
        responseKind: 'sse',
        streamPolicy: expect.objectContaining({
          lastEventId: 'unsupported',
          heartbeatMs: 15_000,
          revalidateMs: 15_000,
        }),
      }),
      expect.objectContaining({
        method: 'GET',
        path: OPERATE_METRICS_PATH,
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        auditOperation: 'operate.metrics.show',
      }),
      expect.objectContaining({
        method: 'GET',
        path: OPERATE_METRICS_STREAM_PATH,
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: OPERATIONAL_PRIVACY,
        auditOperation: 'operate.metrics.stream',
        responseKind: 'sse',
        streamPolicy: expect.objectContaining({
          lastEventId: 'unsupported',
          heartbeatMs: 15_000,
          revalidateMs: 15_000,
        }),
      }),
    ]));
    expect(module.auditOperations).toEqual(expect.arrayContaining([
      { id: 'operate.config.list' },
      { id: 'operate.config.show' },
      { id: 'operate.config.update' },
      { id: 'operate.health.show' },
      { id: 'operate.health.database' },
      { id: 'operate.health.auth_server' },
      { id: 'operate.health.gatekeeper' },
      { id: 'operate.logs.list' },
      { id: 'operate.logs.stream' },
      { id: 'operate.metrics.show' },
      { id: 'operate.metrics.stream' },
    ]));
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

  it('lists schema-registered operator config without disclosing write-only secrets', async () => {
    const store = new InMemoryOperatorConfigStore();
    await store.save({
      enhancedIndexConfig: { enabled: true },
      consoleConfig: { port: 3100 },
      licenseConfig: { key: 'license-secret' },
      defaultsConfig: {},
      configVersion: 1,
    });
    const route = findRoute(createOperationsModule({
      healthChecks: HEALTH_CHECKS,
      telemetry: createTelemetry(),
      operatorConfigStore: store,
      now: () => NOW,
    }).routes, 'GET', OPERATE_CONFIG_PATH);

    const result = await route.handler({ query: {}, params: {} } as never);
    const projected = projectOperatorConfigList(result.body);

    expect(projected.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'enhanced_index.enabled',
        sensitivity: 'public_admin',
        value: true,
      }),
      expect.objectContaining({
        key: 'license.key',
        sensitivity: 'secret_write_only',
        configured: true,
      }),
    ]));
    expect(JSON.stringify(projected)).not.toContain('license-secret');
  });

  it('returns one operator config setting with an ETag header', async () => {
    const route = findRoute(createModule().routes, 'GET', LICENSE_KEY_PATH);

    const result = await route.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
    } as never);
    const projected = projectOperatorConfigSetting(result.body);

    expect(result.headers).toEqual({ ETag: projected.etag });
    expect(projected).toMatchObject({
      key: CONSOLE_PORT_KEY,
      value: 3000,
      sensitivity: 'public_admin',
      mutability: 'restart_required',
      value_schema: { type: 'integer', minimum: 1, maximum: 65535 },
    });
  });

  it('updates operator config with If-Match, validation, idempotency policy, and restart metadata', async () => {
    const store = new InMemoryOperatorConfigStore();
    const module = createOperationsModule({
      healthChecks: HEALTH_CHECKS,
      telemetry: createTelemetry(),
      operatorConfigStore: store,
      now: () => NOW,
    });
    const getRoute = findRoute(module.routes, 'GET', LICENSE_KEY_PATH);
    const putRoute = findRoute(module.routes, 'PUT', LICENSE_KEY_PATH);
    const before = await getRoute.handler({ query: {}, params: { key: CONSOLE_PORT_KEY } } as never);
    const etag = projectOperatorConfigSetting(before.body).etag;

    const result = await putRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
      headers: { 'if-match': etag },
      body: { value: 3100 },
    } as never);

    const projected = projectOperatorConfigSetting(result.body);
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ ETag: projected.etag });
    expect(projected).toMatchObject({
      key: CONSOLE_PORT_KEY,
      value: 3100,
      pending_restart: true,
      effective_at: null,
    });
    expect(await store.load()).toMatchObject({
      consoleConfig: { port: 3100 },
    });
  });

  it('rejects operator config updates without current ETag or valid schema', async () => {
    const module = createModule();
    const putRoute = findRoute(module.routes, 'PUT', LICENSE_KEY_PATH);

    await expect(putRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
      headers: {},
      body: { value: 3100 },
    } as never)).resolves.toMatchObject({ status: 428, body: { code: 'precondition_required' } });

    await expect(putRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
      headers: { 'if-match': 'W/"stale"' },
      body: { value: 3100 },
    } as never)).resolves.toMatchObject({ status: 412, body: { code: 'precondition_failed' } });

    const getRoute = findRoute(module.routes, 'GET', LICENSE_KEY_PATH);
    const etag = projectOperatorConfigSetting((await getRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
    } as never)).body).etag;
    await expect(putRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
      headers: { 'if-match': etag },
      body: { value: 70000 },
    } as never)).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
  });

  it('maps store-level operator config compare-and-swap races to precondition failures', async () => {
    const store = new RacingOperatorConfigStore();
    const module = createOperationsModule({
      healthChecks: HEALTH_CHECKS,
      telemetry: createTelemetry(),
      operatorConfigStore: store,
      now: () => NOW,
    });
    const getRoute = findRoute(module.routes, 'GET', LICENSE_KEY_PATH);
    const putRoute = findRoute(module.routes, 'PUT', LICENSE_KEY_PATH);
    const etag = projectOperatorConfigSetting((await getRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
    } as never)).body).etag;

    await expect(putRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
      headers: { 'if-match': etag },
      body: { value: 3100 },
    } as never)).resolves.toMatchObject({
      status: 412,
      body: { code: 'precondition_failed' },
    });
    await expect(store.load()).resolves.toMatchObject({ consoleConfig: { port: 3200 } });
  });

  it('rejects operator config definitions that use reserved internal path segments', () => {
    expect(() => createOperationsModule({
      healthChecks: HEALTH_CHECKS,
      telemetry: createTelemetry(),
      operatorConfigStore: new InMemoryOperatorConfigStore(),
      operatorConfigDefinitions: [{
        key: 'defaults.reserved',
        section: 'defaultsConfig',
        path: ['__operator_config_status'],
        schema: { type: 'object' },
        schemaVersion: 1,
        sensitivity: 'public_admin',
        mutability: 'dynamic',
        requiredCapability: OPERATE_CAPABILITY,
      }],
      now: () => NOW,
    })).toThrow(/reserved path segment/);
  });

  it('projects operator config by allowlist rather than source object shape', () => {
    const projected = projectOperatorConfigSetting({
      key: 'license.key',
      schema_version: 1,
      sensitivity: 'secret_write_only',
      mutability: 'restart_required',
      value_schema: { type: 'string', min_length: 1, max_length: 4096, secret_hint: MUST_NOT_LEAK },
      effective_at: null,
      pending_restart: true,
      etag: 'W/"operator-config:license.key:fixture"',
      configured: true,
      value: MUST_NOT_LEAK,
      raw_secret: MUST_NOT_LEAK,
    });

    expect(projected).toEqual({
      key: 'license.key',
      schema_version: 1,
      sensitivity: 'secret_write_only',
      mutability: 'restart_required',
      value_schema: { type: 'string', min_length: 1, max_length: 4096 },
      effective_at: null,
      pending_restart: true,
      etag: 'W/"operator-config:license.key:fixture"',
      configured: true,
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

  it('streams operational logs through SSE update events with allowlisted payloads', async () => {
    const route = findRoute(createModule(HEALTH_CHECKS, createTelemetry(3)).routes, 'GET', OPERATE_LOGS_STREAM_PATH);

    const result = await executeConsoleRoute(route, {
      query: { subsystem: 'runtime', limit: '10' },
      params: {},
      headers: {},
    } as never);

    expect(result.stream?.init).toMatchObject({
      stream_id: 'admin.operate.logs',
      stream_type: 'operational_logs',
      resume_supported: false,
      filters: {
        level: null,
        subsystem: 'runtime',
        event: null,
      },
    });
    const events = await collectEvents(result.stream?.events);
    expect(events).toEqual([
      {
        event: 'update',
        data: {
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
      },
      {
        event: 'end',
        data: { status: 'complete' },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(MUST_NOT_LEAK);
  });

  it('rejects Last-Event-ID on operational log streams until real resume is implemented', () => {
    const route = findRoute(createModule().routes, 'GET', OPERATE_LOGS_STREAM_PATH);

    expect(() => route.handler({
      query: {},
      params: {},
      headers: { 'last-event-id': 'operational-log:0' },
    } as never)).toThrow('Invalid Last-Event-ID');
  });

  it('queries operational metrics through the allowlisted telemetry boundary', async () => {
    const route = findRoute(createModule().routes, 'GET', OPERATE_METRICS_PATH);

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

  it('streams operational metrics through SSE update events with allowlisted payloads', async () => {
    const route = findRoute(createModule().routes, 'GET', OPERATE_METRICS_STREAM_PATH);

    const result = await executeConsoleRoute(route, {
      query: { subsystem: 'runtime', name: RUNTIME_ERRORS_METRIC },
      params: {},
      headers: {},
    } as never);

    expect(result.stream?.init).toMatchObject({
      stream_id: 'admin.operate.metrics',
      stream_type: 'operational_metrics',
      resume_supported: false,
      filters: {
        subsystem: 'runtime',
        name: RUNTIME_ERRORS_METRIC,
      },
    });
    const events = await collectEvents(result.stream?.events);
    expect(events).toEqual([
      {
        event: 'update',
        data: {
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
      },
      {
        event: 'end',
        data: { status: 'complete' },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(MUST_NOT_LEAK);
  });

  it('rejects Last-Event-ID on operational metric streams until real resume is implemented', () => {
    const route = findRoute(createModule().routes, 'GET', OPERATE_METRICS_STREAM_PATH);

    expect(() => route.handler({
      query: {},
      params: {},
      headers: { 'last-event-id': 'operational-metric:0' },
    } as never)).toThrow('Invalid Last-Event-ID');
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
