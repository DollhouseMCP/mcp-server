import { describe, expect, it } from '@jest/globals';

import { InMemoryOperatorConfigStore } from '../../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import type { OperatorConfig } from '../../../../src/storage/operatorConfig/IOperatorConfigStore.js';
import {
  InMemoryConsoleTelemetryQuery,
  createOperationsModule,
  executeConsoleRoute,
  projectCanaryRun,
  projectOperatorConfigList,
  projectOperatorConfigSetting,
  projectOperationHealthComponent,
  projectOperationHealthSummary,
  projectOperationalLogs,
  projectOperationalMetrics,
  projectSetupStatus,
  projectSystemMetrics,
  type ConsoleRouteDefinition,
  type ISystemMetricsSource,
  type OperationsCanary,
  type OperationsHealthChecks,
} from '../../../../src/web-console/index.js';
import { OPERATION_HEALTH_COMPONENTS } from '../../../../src/web-console/modules/operations/OperationsHealth.js';

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
const SYSTEM_METRICS_PATH = '/api/v1/admin/operate/metrics/system';
const OPERATE_CONFIG_PATH = '/api/v1/admin/operate/config';
const LICENSE_KEY_PATH = '/api/v1/admin/operate/config/:key';
const CONSOLE_PORT_KEY = 'console.port';
const CANARY_RUN_PATH = '/api/v1/admin/operate/canary/run';
const SETUP_STATUS_PATH = '/api/v1/admin/operate/setup-status';
type ConsoleRouteRequest = Parameters<ConsoleRouteDefinition['handler']>[0];

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
  canary?: OperationsCanary,
) {
  return createOperationsModule({
    healthChecks,
    telemetry,
    operatorConfigStore: new InMemoryOperatorConfigStore(),
    ...(canary ? { canary } : {}),
    now: () => NOW,
  });
}

function canaryThatFinds(state: 'passed' | 'pending' | 'failed', code: string, detail: string) {
  const triggers: string[] = [];
  const canary: OperationsCanary = {
    run: trigger => {
      triggers.push(trigger);
      return Promise.resolve({
        result: { id: 'approval_execution_projection', state, code, detail } as Awaited<ReturnType<OperationsCanary['run']>>['result'],
        trigger,
        startedAt: NOW,
        finishedAt: new Date(NOW.getTime() + 180),
      });
    },
  };
  return { canary, triggers };
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
        elevation: 'admin_30m',
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

    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

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

  it('leaves database migrations out of health when there is no ledger to check', async () => {
    const route = findRoute(createModule().routes, 'GET', '/api/v1/admin/operate/health');
    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);
    const summary = projectOperationHealthSummary(result.body);
    expect(summary.components.map(component => component.component)).toEqual([
      'database', 'auth_server', 'gatekeeper', 'runtime_control', 'security_invalidation', 'api_mount',
    ]);
  });

  it.each([
    ['ok', [], 'ok'],
    ['not_ready', ['migrations_incomplete'], 'degraded'],
    ['degraded', ['migration_ledger_unreadable'], 'degraded'],
  ] as const)('reports database migrations as %s with its stable code', async (status, codes, overall) => {
    const healthy = { ...HEALTH_CHECKS,
      securityInvalidation: () => true,
      apiMount: () => true,
      databaseMigrations: () => ({
        component: 'database_migrations' as const, status, checked_at: NOW.toISOString(), failure_codes: [...codes],
      }),
    };
    const route = findRoute(createModule(healthy).routes, 'GET', '/api/v1/admin/operate/health');
    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

    // A database behind the release is a readiness fault, not an outage of this surface.
    expect(result.status).toBe(200);
    const summary = projectOperationHealthSummary(result.body);
    expect(summary.status).toBe(overall);
    expect(summary.components.map(component => component.component)).toEqual([
      'database', 'auth_server', 'gatekeeper', 'runtime_control', 'security_invalidation', 'database_migrations', 'api_mount',
    ]);
    expect(summary.components.find(component => component.component === 'database_migrations')).toEqual({
      component: 'database_migrations', status, checked_at: NOW.toISOString(), failure_codes: [...codes],
    });
  });

  it.each([
    ['ok', [], 'ok'],
    ['degraded', ['allowlist_entries_not_carried_over'], 'degraded'],
    ['degraded', ['allowlists_unreadable'], 'degraded'],
  ] as const)('reports allowlist parity as %s with its stable code, after database migrations', async (status, codes, overall) => {
    const healthy = { ...HEALTH_CHECKS,
      securityInvalidation: () => true,
      apiMount: () => true,
      databaseMigrations: () => true,
      allowlistParity: () => ({
        component: 'allowlist_parity' as const, status, checked_at: NOW.toISOString(), failure_codes: [...codes],
      }),
    };
    const route = findRoute(createModule(healthy).routes, 'GET', '/api/v1/admin/operate/health');
    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

    // A gap between the allowlists affects some sign-ins; the console itself still answers.
    expect(result.status).toBe(200);
    const summary = projectOperationHealthSummary(result.body);
    expect(summary.status).toBe(overall);
    expect(summary.components.map(component => component.component)).toEqual([
      'database', 'auth_server', 'gatekeeper', 'runtime_control', 'security_invalidation',
      'database_migrations', 'allowlist_parity', 'api_mount',
    ]);
    expect(summary.components.find(component => component.component === 'allowlist_parity')).toEqual({
      component: 'allowlist_parity', status, checked_at: NOW.toISOString(), failure_codes: [...codes],
    });
  });

  it.each([
    ['ok', [], 'ok'],
    ['degraded', ['audit_or_telemetry_unreadable'], 'degraded'],
    ['degraded', ['admin_audit_chain_broken'], 'degraded'],
    ['degraded', ['admin_audit_integrity_unverified'], 'degraded'],
  ] as const)('reports audit and telemetry as %s with its stable code, just before the API mount', async (status, codes, overall) => {
    const healthy = { ...HEALTH_CHECKS,
      securityInvalidation: () => true,
      apiMount: () => true,
      auditTelemetry: () => ({
        component: 'audit_telemetry' as const, status, checked_at: NOW.toISOString(), failure_codes: [...codes],
      }),
    };
    const route = findRoute(createModule(healthy).routes, 'GET', '/api/v1/admin/operate/health');
    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

    // An audit page that cannot display is a console fault; this surface still answers.
    expect(result.status).toBe(200);
    const summary = projectOperationHealthSummary(result.body);
    expect(summary.status).toBe(overall);
    expect(summary.components.map(component => component.component)).toEqual([
      'database', 'auth_server', 'gatekeeper', 'runtime_control', 'security_invalidation', 'audit_telemetry', 'api_mount',
    ]);
    expect(summary.components.find(component => component.component === 'audit_telemetry')).toEqual({
      component: 'audit_telemetry', status, checked_at: NOW.toISOString(), failure_codes: [...codes],
    });
  });

  it.each([
    ['ok', [], 'ok'],
    // Nobody has asked for a run. That is not a fault, so the deployment still reads as healthy.
    ['not_run', [], 'ok'],
    ['degraded', ['canary_approval_not_readable'], 'degraded'],
    ['degraded', ['canary_timed_out'], 'degraded'],
  ] as const)('reports the approvals and executions canary as %s with its stable code, just before the API mount', async (status, codes, overall) => {
    const healthy = { ...HEALTH_CHECKS,
      securityInvalidation: () => true,
      apiMount: () => true,
      auditTelemetry: () => true,
      approvalExecutionProjection: () => ({
        component: 'approval_execution_projection' as const, status, checked_at: NOW.toISOString(), failure_codes: [...codes],
      }),
    };
    const route = findRoute(createModule(healthy).routes, 'GET', '/api/v1/admin/operate/health');
    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

    expect(result.status).toBe(200);
    const summary = projectOperationHealthSummary(result.body);
    expect(summary.status).toBe(overall);
    expect(summary.components.map(component => component.component)).toEqual([
      'database', 'auth_server', 'gatekeeper', 'runtime_control', 'security_invalidation',
      'audit_telemetry', 'approval_execution_projection', 'api_mount',
    ]);
    expect(summary.components.find(component => component.component === 'approval_execution_projection')).toEqual({
      component: 'approval_execution_projection', status, checked_at: NOW.toISOString(), failure_codes: [...codes],
    });
  });

  it('does not offer the canary where there is nothing for it to check', () => {
    const module = createModule();

    expect(module.routes.some(route => route.path === CANARY_RUN_PATH)).toBe(false);
    expect(module.auditOperations).not.toContainEqual({ id: 'operate.canary.run' });
  });

  it('offers the canary run as an audited, elevated operator action that must carry an idempotency key', () => {
    const module = createModule(HEALTH_CHECKS, createTelemetry(), canaryThatFinds('passed', 'canary_passed', 'ok').canary);

    expect(findRoute(module.routes, 'POST', CANARY_RUN_PATH)).toMatchObject({
      audience: 'admin',
      requiredCapability: OPERATE_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: OPERATIONAL_PRIVACY,
      idempotency: 'required',
      auditOperation: 'operate.canary.run',
    });
    expect(module.auditOperations).toContainEqual({ id: 'operate.canary.run' });
  });

  it.each([
    ['passed', 'canary_passed', 'Created, read back through the console and removed.'],
    ['failed', 'canary_approval_not_readable', 'The console did not list the approval request.'],
    ['pending', 'canary_timed_out', 'The canary did not finish, so nothing is verified.'],
  ] as const)('runs the canary for the admin and answers 200 with what it found (%s)', async (state, code, detail) => {
    const { canary, triggers } = canaryThatFinds(state, code, detail);
    const route = findRoute(createModule(HEALTH_CHECKS, createTelemetry(), canary).routes, 'POST', CANARY_RUN_PATH);

    const result = await executeConsoleRoute(route, { query: {}, params: {}, headers: {}, body: {} } as unknown as ConsoleRouteRequest);

    // The request to run it succeeded whatever it found; the finding is in the body.
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      check: 'approval_execution_projection',
      state,
      code,
      detail,
      trigger: 'admin',
      started_at: NOW.toISOString(),
      finished_at: new Date(NOW.getTime() + 180).toISOString(),
    });
    expect(triggers).toEqual(['admin']);
  });

  it('projects a canary run by allowlist rather than source object shape', () => {
    expect(projectCanaryRun({
      state: 'failed',
      code: 'canary_approval_not_readable',
      detail: 'x'.repeat(600),
      trigger: 'schedule',
      started_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
      session_id: MUST_NOT_LEAK,
      result: { connection_string: MUST_NOT_LEAK },
    })).toEqual({
      check: 'approval_execution_projection',
      state: 'failed',
      code: 'canary_approval_not_readable',
      detail: 'x'.repeat(500),
      trigger: 'schedule',
      started_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
    });
    // Anything unrecognised reads as "nothing verified", never as a pass.
    expect(projectCanaryRun({ state: 'ok', code: 'not a code', trigger: 'someone' })).toEqual({
      check: 'approval_execution_projection', state: 'pending', code: '', detail: '', trigger: 'admin', started_at: '', finished_at: '',
    });
  });

  it('keeps the "not run" status through the health projector', () => {
    expect(projectOperationHealthComponent({
      component: 'approval_execution_projection', status: 'not_run', checked_at: NOW.toISOString(), failure_codes: [],
    })).toEqual({
      component: 'approval_execution_projection', status: 'not_run', checked_at: NOW.toISOString(), failure_codes: [],
    });
  });

  it('does not offer the setup status where nothing reports on it', () => {
    const module = createModule();

    expect(module.routes.some(route => route.path === SETUP_STATUS_PATH)).toBe(false);
    expect(module.auditOperations).not.toContainEqual({ id: 'operate.setup_status.show' });
  });

  it('offers the setup status to elevated operators only, as an audited read', async () => {
    const { WEB_CONSOLE_SETUP_CHECKS, listWebConsoleSetupCheckStatuses } = await import('../../../../src/web-console/setup/index.js');
    const observedAt = new Date(NOW.getTime() - 60_000);
    const module = createOperationsModule({
      healthChecks: HEALTH_CHECKS,
      telemetry: createTelemetry(),
      operatorConfigStore: new InMemoryOperatorConfigStore(),
      setupStatus: () => Promise.resolve({
        checkedAt: NOW,
        checks: listWebConsoleSetupCheckStatuses([
          { id: 'production_database_migrations', state: 'failed', detail: 'Migration 0061 is missing.' },
          { id: 'embedded_as_login_step_up', state: 'passed', detail: 'An administrator has elevated.', observedAt },
          { id: 'account_invite_redemption', state: 'not_applicable' },
        ]),
      }),
      now: () => NOW,
    });
    const route = findRoute(module.routes, 'GET', SETUP_STATUS_PATH);

    expect(route).toMatchObject({
      audience: 'admin',
      requiredCapability: OPERATE_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: OPERATIONAL_PRIVACY,
      idempotency: 'not_applicable',
      auditOperation: 'operate.setup_status.show',
    });
    expect(module.auditOperations).toContainEqual({ id: 'operate.setup_status.show' });

    const result = await executeConsoleRoute(route, { query: {}, params: {}, headers: {} } as unknown as ConsoleRouteRequest);
    const body = result.body as ReturnType<typeof projectSetupStatus>;

    expect(result.status).toBe(200);
    expect(body.checked_at).toBe(NOW.toISOString());
    expect(body.checks).toHaveLength(11);
    expect(body.counts).toEqual({ passed: 1, pending: 8, failed: 1, not_applicable: 1 });
    const migrations = WEB_CONSOLE_SETUP_CHECKS.production_database_migrations;
    expect(body.checks[0]).toEqual({
      id: 'production_database_migrations',
      title: migrations.title,
      proves: migrations.proves,
      verification: 'server-probe',
      verified_by: migrations.verifiedBy,
      remediation: migrations.remediation,
      state: 'failed',
      detail: 'Migration 0061 is missing.',
      observed_at: null,
    });
    expect(body.checks.find(check => check.id === 'embedded_as_login_step_up')).toMatchObject({
      state: 'passed', detail: 'An administrator has elevated.', observed_at: observedAt.toISOString(),
    });
    // A check nothing reported on is pending, with no detail.
    expect(body.checks.find(check => check.id === 'oauth_grant_revocation')).toMatchObject({ state: 'pending', detail: null });
  });

  it('projects the setup status by allowlist, taking each check\'s wording from the catalog and not from the value', async () => {
    const { WEB_CONSOLE_SETUP_CHECKS } = await import('../../../../src/web-console/setup/index.js');

    const projected = projectSetupStatus({
      checked_at: NOW.toISOString(),
      connection_string: MUST_NOT_LEAK,
      checks: [
        {
          id: 'github_integration_connect_callback',
          title: MUST_NOT_LEAK,
          remediation: MUST_NOT_LEAK,
          state: 'passed',
          detail: 'd'.repeat(600),
          observed_at: 'not a time',
          user_id: MUST_NOT_LEAK,
        },
        { id: 'not_a_check', state: 'passed', detail: MUST_NOT_LEAK },
        { id: 'oauth_grant_revocation', state: 'verified', detail: 42 },
      ],
    });

    expect(JSON.stringify(projected)).not.toContain(MUST_NOT_LEAK);
    expect(projected.checks.map(check => check.id)).toEqual(['github_integration_connect_callback', 'oauth_grant_revocation']);
    expect(projected.checks[0]).toMatchObject({
      title: WEB_CONSOLE_SETUP_CHECKS.github_integration_connect_callback.title,
      remediation: WEB_CONSOLE_SETUP_CHECKS.github_integration_connect_callback.remediation,
      detail: 'd'.repeat(500),
      observed_at: null,
    });
    // A state the console does not know reads as pending, never as passed.
    expect(projected.checks[1]).toMatchObject({ state: 'pending', detail: null });
    expect(projected.counts).toEqual({ passed: 1, pending: 1, failed: 0, not_applicable: 0 });
  });

  it('reports a migration check that throws as unavailable rather than failing the whole summary', async () => {
    const checks = { ...HEALTH_CHECKS, databaseMigrations: () => { throw new Error('boom'); } };
    const route = findRoute(createModule(checks).routes, 'GET', '/api/v1/admin/operate/health');
    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);
    expect(projectOperationHealthSummary(result.body).components
      .find(component => component.component === 'database_migrations')).toEqual({
      component: 'database_migrations', status: 'unavailable', checked_at: NOW.toISOString(),
      failure_codes: ['database_migrations_check_failed'],
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

    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);
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
    } as unknown as ConsoleRouteRequest);
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
    const before = await getRoute.handler({ query: {}, params: { key: CONSOLE_PORT_KEY } } as unknown as ConsoleRouteRequest);
    const etag = projectOperatorConfigSetting(before.body).etag;

    const result = await putRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
      headers: { 'if-match': etag },
      body: { value: 3100 },
    } as unknown as ConsoleRouteRequest);

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
    } as unknown as ConsoleRouteRequest)).resolves.toMatchObject({ status: 428, body: { code: 'precondition_required' } });

    await expect(putRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
      headers: { 'if-match': 'W/"stale"' },
      body: { value: 3100 },
    } as unknown as ConsoleRouteRequest)).resolves.toMatchObject({ status: 412, body: { code: 'precondition_failed' } });

    const getRoute = findRoute(module.routes, 'GET', LICENSE_KEY_PATH);
    const etag = projectOperatorConfigSetting((await getRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
    } as unknown as ConsoleRouteRequest)).body).etag;
    await expect(putRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
      headers: { 'if-match': etag },
      body: { value: 70000 },
    } as unknown as ConsoleRouteRequest)).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
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
    } as unknown as ConsoleRouteRequest)).body).etag;

    await expect(putRoute.handler({
      query: {},
      params: { key: CONSOLE_PORT_KEY },
      headers: { 'if-match': etag },
      body: { value: 3100 },
    } as unknown as ConsoleRouteRequest)).resolves.toMatchObject({
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

    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

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

    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

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

    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

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
    } as unknown as ConsoleRouteRequest);

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

    // Sub-1 and unparsable limits are invalid input → the endpoint default
    // (shared ConsoleQueryParams semantics), not a clamp to 1.
    await expect(route.handler({ query: { limit: '0' }, params: {} } as unknown as ConsoleRouteRequest))
      .resolves.toMatchObject({ body: { items: expect.arrayContaining([expect.any(Object)]), page: { limit: 100 } } });
    await expect(route.handler({ query: { limit: '-10' }, params: {} } as unknown as ConsoleRouteRequest))
      .resolves.toMatchObject({ body: { page: { limit: 100 } } });
    await expect(route.handler({ query: { limit: '1000' }, params: {} } as unknown as ConsoleRouteRequest))
      .resolves.toMatchObject({ body: { items: expect.any(Array), page: { limit: 100 } } });
    await expect(route.handler({ query: { limit: 'not-a-number' }, params: {} } as unknown as ConsoleRouteRequest))
      .resolves.toMatchObject({ body: { items: expect.any(Array), page: { limit: 100 } } });
    await expect(route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest))
      .resolves.toMatchObject({ body: { items: expect.any(Array), page: { limit: 100 } } });
  });

  it('emits and consumes operational log cursors without trusting malformed cursors', async () => {
    const route = findRoute(createModule(HEALTH_CHECKS, createTelemetry(3)).routes, 'GET', OPERATE_LOGS_PATH);

    const first = await route.handler({ query: { limit: '2' }, params: {} } as unknown as ConsoleRouteRequest);
    const firstPage = projectOperationalLogs(first.body);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.page.next_cursor).toEqual(expect.any(String));

    const second = await route.handler({
      query: { limit: '2', cursor: firstPage.page.next_cursor },
      params: {},
    } as unknown as ConsoleRouteRequest);
    expect(projectOperationalLogs(second.body)).toMatchObject({
      items: [{ session_id: 'session-3' }],
      page: {
        limit: 2,
        cursor: firstPage.page.next_cursor,
        next_cursor: null,
      },
    });

    const malformed = await route.handler({ query: { limit: '2', cursor: 'not-valid-base64url' }, params: {} } as unknown as ConsoleRouteRequest);
    expect(projectOperationalLogs(malformed.body).items.map(item => item.session_id)).toEqual(['session-1', 'session-2']);
  });

  it('applies level and event filters to operational logs', async () => {
    const route = findRoute(createModule(HEALTH_CHECKS, createTelemetry(4)).routes, 'GET', OPERATE_LOGS_PATH);

    const result = await route.handler({
      query: { level: 'info', event: GATEKEEPER_DECISION_EVENT },
      params: {},
    } as unknown as ConsoleRouteRequest);

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
    } as unknown as ConsoleRouteRequest);

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
    } as unknown as ConsoleRouteRequest)).toThrow('Invalid Last-Event-ID');
  });

  it('queries operational metrics through the allowlisted telemetry boundary', async () => {
    const route = findRoute(createModule().routes, 'GET', OPERATE_METRICS_PATH);

    const result = await route.handler({
      query: { subsystem: 'runtime', name: RUNTIME_ERRORS_METRIC },
      params: {},
    } as unknown as ConsoleRouteRequest);

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

  it('exposes in-process System A metrics, allowlisting snapshot fields', async () => {
    const source: ISystemMetricsSource = {
      query: () => ({
        snapshots: [{
          id: 'snap-1',
          timestamp: NOW.toISOString(),
          durationMs: 5,
          errors: ['collector failed'],
          metrics: [
            { name: 'cache.hits', source: 'lru', unit: 'count', type: 'counter', value: 42, labels: { region: 'us' } },
            { name: 'op.latency', source: 'perf', unit: 'ms', type: 'histogram', value: { count: 3, sum: 30, min: 5, p95: 20 } },
          ],
        }],
        total: 1,
        hasMore: false,
        limit: 50,
        offset: 0,
        oldestAvailable: NOW.toISOString(),
        newestAvailable: NOW.toISOString(),
      }),
    };
    const route = findRoute(createOperationsModule({
      healthChecks: HEALTH_CHECKS,
      telemetry: createTelemetry(),
      operatorConfigStore: new InMemoryOperatorConfigStore(),
      systemMetrics: source,
      now: () => NOW,
    }).routes, 'GET', SYSTEM_METRICS_PATH);

    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

    expect(result.status).toBe(200);
    // Cursor-family envelope; ring-buffer anchors stay top-level.
    expect(projectSystemMetrics(result.body)).toEqual({
      items: [{
        id: 'snap-1',
        timestamp: NOW.toISOString(),
        duration_ms: 5,
        errors: ['collector failed'],
        metrics: [
          { name: 'cache.hits', source: 'lru', unit: 'count', type: 'counter', value: 42, labels: { region: 'us' } },
          { name: 'op.latency', source: 'perf', unit: 'ms', type: 'histogram', value: { count: 3, sum: 30, min: 5, p95: 20 } },
        ],
      }],
      page: { limit: 50, cursor: null, next_cursor: null },
      oldest_available: NOW.toISOString(),
      newest_available: NOW.toISOString(),
    });
  });

  it('walks System A pages through opaque cursors, never raw offsets', async () => {
    const source: ISystemMetricsSource = {
      query: (options) => ({
        snapshots: [{
          id: `snap-${(options?.offset ?? 0) + 1}`,
          timestamp: NOW.toISOString(),
          durationMs: 5,
          errors: [],
          metrics: [],
        }],
        total: 2,
        hasMore: (options?.offset ?? 0) === 0,
        limit: 1,
        offset: options?.offset ?? 0,
        oldestAvailable: NOW.toISOString(),
        newestAvailable: NOW.toISOString(),
      }),
    };
    const route = findRoute(createOperationsModule({
      healthChecks: HEALTH_CHECKS,
      telemetry: createTelemetry(),
      operatorConfigStore: new InMemoryOperatorConfigStore(),
      systemMetrics: source,
      now: () => NOW,
    }).routes, 'GET', SYSTEM_METRICS_PATH);

    const first = projectSystemMetrics((await route.handler({ query: { limit: '1' }, params: {} } as unknown as ConsoleRouteRequest)).body);
    expect(first.items[0].id).toBe('snap-1');
    expect(first.page.next_cursor).not.toBeNull();
    // The cursor is opaque — the raw offset never appears as a query param.
    const second = projectSystemMetrics((await route.handler({
      query: { limit: '1', cursor: first.page.next_cursor },
      params: {},
    } as unknown as ConsoleRouteRequest)).body);
    expect(second.items[0].id).toBe('snap-2');
    expect(second.page.cursor).toBe(first.page.next_cursor);
    expect(second.page.next_cursor).toBeNull();
  });

  it('returns an empty System A result when metrics collection is disabled (no sink)', async () => {
    const route = findRoute(createModule().routes, 'GET', SYSTEM_METRICS_PATH);

    const result = await route.handler({ query: {}, params: {} } as unknown as ConsoleRouteRequest);

    expect(result.status).toBe(200);
    expect(projectSystemMetrics(result.body)).toMatchObject({
      items: [],
      page: { cursor: null, next_cursor: null },
    });
  });

  it('streams operational metrics through SSE update events with allowlisted payloads', async () => {
    const route = findRoute(createModule().routes, 'GET', OPERATE_METRICS_STREAM_PATH);

    const result = await executeConsoleRoute(route, {
      query: { subsystem: 'runtime', name: RUNTIME_ERRORS_METRIC },
      params: {},
      headers: {},
    } as unknown as ConsoleRouteRequest);

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
    } as unknown as ConsoleRouteRequest)).toThrow('Invalid Last-Event-ID');
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

  it('drops telemetry codes that are not well-formed stable identifiers (fail-closed)', () => {
    const projected = projectOperationalLogs({
      items: [{
        ts: NOW.toISOString(),
        level: 'error',
        subsystem: 'user report: crash in payment flow',
        event: 'evt@example.com',
        correlation_id: 'correlation-9',
        account_correlation_id: 'account-9',
        session_id: 'session-9',
        replica: 'replica-a',
        duration_ms: 3,
        status_code: 500,
        error_code: `contains spaces ${'x'.repeat(80)}`,
      }],
      page: { limit: 1, cursor: null, next_cursor: null },
    });
    expect(projected.items[0]).toMatchObject({
      subsystem: '',
      event: '',
      replica: 'replica-a',
      error_code: null,
      correlation_id: 'correlation-9',
      session_id: 'session-9',
    });

    const metrics = projectOperationalMetrics({
      checked_at: NOW.toISOString(),
      metrics: [{
        name: RUNTIME_ERRORS_METRIC,
        kind: 'counter',
        value: 1,
        unit: 'count',
        dimensions: {
          subsystem: 'runtime',
          event: 'has space',
          error_code: 'ok_code',
          transport: 'tcp/secure',
          latency_bucket: 'not a bucket!!',
          account_correlation_id: 'account-4',
        },
      }],
    });
    expect(metrics.metrics[0].dimensions).toEqual({
      subsystem: 'runtime',
      error_code: 'ok_code',
      transport: 'tcp/secure',
      account_correlation_id: 'account-4',
    });
  });

  it('accepts every health component the builder can emit (no silent drift to the fallback)', () => {
    for (const component of OPERATION_HEALTH_COMPONENTS) {
      const projected = projectOperationHealthComponent({
        component,
        status: 'ok',
        checked_at: NOW.toISOString(),
        failure_codes: [],
      });
      expect(projected.component).toBe(component);
    }
    // A component the builder never emits is coerced to a valid member (defensive), not passed through.
    const coerced = projectOperationHealthComponent({
      component: 'queue_processor',
      status: 'ok',
      checked_at: NOW.toISOString(),
      failure_codes: [],
    });
    expect(OPERATION_HEALTH_COMPONENTS).toContain(coerced.component);
    expect(coerced.component).not.toBe('queue_processor');
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
