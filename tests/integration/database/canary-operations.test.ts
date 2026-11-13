/**
 * The canary as Operations runs it, on PostgreSQL: the monitor the server
 * builds over a database, behind the admin route.
 */

import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { CANARY_USER_UUID } from '../../../src/database/internalUsers.js';
import { agentStates, elements, sessions } from '../../../src/database/schema/index.js';
import { runtimeSessionPresence } from '../../../src/database/schema/webConsole.js';
import { StaticAuditHmacKeyResolver } from '../../../src/security/auditHmacKey.js';
import { DatabaseConfirmationStore } from '../../../src/state/DatabaseConfirmationStore.js';
import { InMemoryOperatorConfigStore } from '../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import { CANARY_LEFTOVER_AGE_MS, CANARY_SESSION_PREFIX } from '../../../src/web-console/canary/CanaryRun.js';
import { ensureCanaryUser } from '../../../src/web-console/canary/CanaryUser.js';
import { createDatabaseCanaryMonitor } from '../../../src/web-console/canary/DatabaseCanaryMonitor.js';
import {
  InMemoryConsoleTelemetryQuery,
  createOperationsModule,
  executeConsoleRoute,
  type ConsoleRouteDefinition,
} from '../../../src/web-console/index.js';
import { ConfirmationSessionApprovalStore } from '../../../src/web-console/modules/approvals/ApprovalStore.js';
import { PostgresSessionExecutionReader, PostgresSessionGatekeeperReader } from '../../../src/web-console/modules/executions/ExecutionStore.js';
import { PostgresRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/PostgresRuntimeSessionControlStore.js';
import { closeTestDb, getTestAdminDb } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

required('the canary behind the Operations route, on PostgreSQL', () => {
  const db = () => getTestAdminDb();
  const auditHmacResolver = new StaticAuditHmacKeyResolver('66'.repeat(32));
  const log = { info: jest.fn<(message: string) => void>(), warn: jest.fn<(message: string) => void>() };
  // The stores the server selects for a PostgreSQL console.
  const monitor = () => createDatabaseCanaryMonitor({
    database: db(),
    auditHmacResolver,
    runtimeStore: new PostgresRuntimeSessionControlStore(db()),
    approvalStore: new ConfirmationSessionApprovalStore(
      ({ userId, sessionId }) => new DatabaseConfirmationStore(db(), userId, sessionId, auditHmacResolver),
    ),
    executionReader: new PostgresSessionExecutionReader(db()),
    gatekeeperReader: new PostgresSessionGatekeeperReader(db()),
    replicaId: 'canary-operations-test',
    log,
  });
  const runRoute = (canary: ReturnType<typeof monitor>): ConsoleRouteDefinition => {
    const module = createOperationsModule({
      healthChecks: {
        database: () => true, authServer: () => true, gatekeeper: () => true, runtimeControl: () => true,
        securityInvalidation: () => true, apiMount: () => true,
      },
      telemetry: new InMemoryConsoleTelemetryQuery(),
      operatorConfigStore: new InMemoryOperatorConfigStore(),
      canary,
    });
    const route = module.routes.find(candidate => candidate.path === '/api/v1/admin/operate/canary/run');
    if (!route) throw new Error('the canary run route is not registered');
    return route;
  };
  const canaryRows = async () => ({
    presence: await db().select().from(runtimeSessionPresence).where(eq(runtimeSessionPresence.userId, CANARY_USER_UUID)),
    sessions: await db().select().from(sessions).where(eq(sessions.userId, CANARY_USER_UUID)),
    agentStates: await db().select().from(agentStates).where(eq(agentStates.userId, CANARY_USER_UUID)),
    elements: await db().select().from(elements).where(eq(elements.userId, CANARY_USER_UUID)),
  });
  const nothingLeft = { presence: [], sessions: [], agentStates: [], elements: [] };

  afterAll(async () => {
    await closeTestDb();
  });

  it('runs for an admin, answers with what it found, remembers it, and leaves nothing behind', async () => {
    const canary = monitor();
    expect(canary.status()).toMatchObject({ state: 'pending', code: 'canary_not_run' });

    const result = await executeConsoleRoute(
      runRoute(canary),
      { query: {}, params: {}, headers: {}, body: {} } as unknown as Parameters<ConsoleRouteDefinition['handler']>[0],
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      check: 'approval_execution_projection',
      state: 'passed',
      code: 'canary_passed',
      detail: 'A canary approval request and a canary execution were created, read back through the console and removed.',
      trigger: 'admin',
    });
    expect(canary.status()).toMatchObject({ state: 'passed', code: 'canary_passed' });
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('gives two requests at once the same run', async () => {
    const canary = monitor();

    const [first, second] = await Promise.all([canary.run('admin'), canary.run('admin')]);

    expect(second).toBe(first);
    expect(first.result.state).toBe('passed');
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('sweeps at start-up what a server that stopped mid-run left behind', async () => {
    const user = await ensureCanaryUser(db());
    const startedAt = new Date(Date.now() - CANARY_LEFTOVER_AGE_MS - 60_000);
    await new PostgresRuntimeSessionControlStore(db()).registerPresence({
      sessionId: `${CANARY_SESSION_PREFIX}left-by-a-stopped-server`,
      userId: user.userId, accountCorrelationId: user.accountCorrelationId, replicaId: 'stopped',
      transport: 'streamable-http', startedAt, lastActiveAt: startedAt, leaseUntil: new Date(startedAt.getTime() + 60_000),
    });
    expect((await canaryRows()).presence).toHaveLength(1);
    log.info.mockClear();

    await monitor().sweepLeftovers();

    expect(await canaryRows()).toEqual(nothingLeft);
    expect(log.info).toHaveBeenCalledWith('[WebConsoleCanary] Removed 1 canary session(s) left by an unfinished run');
  });
});
