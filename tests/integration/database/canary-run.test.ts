/**
 * The canary run on PostgreSQL, with the real stores the console and a live
 * session use.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import { and, eq, like } from 'drizzle-orm';

import { CANARY_USER_UUID } from '../../../src/database/internalUsers.js';
import { agentStates, elements, sessions } from '../../../src/database/schema/index.js';
import { runtimeSessionPresence } from '../../../src/database/schema/webConsole.js';
import { StaticAuditHmacKeyResolver } from '../../../src/security/auditHmacKey.js';
import { DatabaseConfirmationStore } from '../../../src/state/DatabaseConfirmationStore.js';
import {
  CANARY_AGENT_PREFIX,
  CANARY_LEFTOVER_AGE_MS,
  CANARY_SESSION_PREFIX,
  runCanary,
  sweepCanaryLeftovers,
  type CanaryRunDependencies,
} from '../../../src/web-console/canary/CanaryRun.js';
import { ensureCanaryUser } from '../../../src/web-console/canary/CanaryUser.js';
import { ConfirmationSessionApprovalStore } from '../../../src/web-console/modules/approvals/ApprovalStore.js';
import { PostgresSessionExecutionReader, PostgresSessionGatekeeperReader } from '../../../src/web-console/modules/executions/ExecutionStore.js';
import { PostgresRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/PostgresRuntimeSessionControlStore.js';
import { closeTestDb, getTestAdminDb } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

required('the canary run on PostgreSQL', () => {
  const db = () => getTestAdminDb();
  const auditHmacResolver = new StaticAuditHmacKeyResolver('77'.repeat(32));
  const confirmationStore = (userId: string, sessionId: string) =>
    new DatabaseConfirmationStore(db(), userId, sessionId, auditHmacResolver);
  const dependencies = (overrides: Partial<CanaryRunDependencies> = {}): CanaryRunDependencies => ({
    db: db(),
    runtimeStore: new PostgresRuntimeSessionControlStore(db()),
    approvalStore: new ConfirmationSessionApprovalStore(({ userId, sessionId }) => confirmationStore(userId, sessionId)),
    executionReader: new PostgresSessionExecutionReader(db()),
    gatekeeperReader: new PostgresSessionGatekeeperReader(db()),
    createConfirmationStore: confirmationStore,
    auditHmacResolver,
    replicaId: 'canary-run-test',
    ...overrides,
  });
  const canaryRows = async () => ({
    presence: await db().select().from(runtimeSessionPresence).where(eq(runtimeSessionPresence.userId, CANARY_USER_UUID)),
    sessions: await db().select().from(sessions).where(eq(sessions.userId, CANARY_USER_UUID)),
    agentStates: await db().select().from(agentStates).where(eq(agentStates.userId, CANARY_USER_UUID)),
    elements: await db().select().from(elements).where(eq(elements.userId, CANARY_USER_UUID)),
  });
  const nothingLeft = { presence: [], sessions: [], agentStates: [], elements: [] };
  /**
   * Dependencies whose clean-up meets `atCleanUp` in place of the database.
   * The detail read is the last thing a run does before it cleans up, and
   * nothing after it uses the run's own database handle except the clean-up.
   */
  const withCleanUp = (atCleanUp: (transaction: () => Promise<unknown>) => Promise<unknown>) => {
    let readBackDone = false;
    const reader = new PostgresSessionExecutionReader(db());
    const find = reader.find.bind(reader);
    reader.find = async (...args) => {
      const found = await find(...args);
      readBackDone = true;
      return found;
    };
    const database = new Proxy(db(), {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        const bound = value.bind(target) as (...args: unknown[]) => Promise<unknown>;
        if (property !== 'transaction') return bound;
        return (...args: unknown[]) => (readBackDone ? atCleanUp(() => bound(...args)) : bound(...args));
      },
    });
    return dependencies({ db: database, executionReader: reader });
  };
  const sweepEverything = () => sweepCanaryLeftovers(db(), new Date(Date.now() + CANARY_LEFTOVER_AGE_MS + 60_000));

  afterAll(async () => {
    await closeTestDb();
  });

  it('creates an approval request and an execution, reads both through the console, and leaves nothing behind', async () => {
    expect(await runCanary(dependencies())).toEqual({
      id: 'approval_execution_projection', state: 'passed', code: 'canary_passed',
      detail: 'A canary approval request and a canary execution were created, read back through the console and removed.',
    });
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('can be run again and again', async () => {
    expect((await runCanary(dependencies())).state).toBe('passed');
    expect((await runCanary(dependencies())).state).toBe('passed');
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('fails, and still cleans up, when the console does not list the approval request', async () => {
    const blind = new ConfirmationSessionApprovalStore(({ userId, sessionId }) => confirmationStore(userId, sessionId));
    blind.list = () => Promise.resolve([]);
    expect(await runCanary(dependencies({ approvalStore: blind }))).toMatchObject({
      state: 'failed', code: 'canary_approval_not_readable',
      detail: 'The canary made an approval request, but the console did not list it. Pending approvals may not be displaying.',
    });
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('fails, and still cleans up, when the console does not list the execution', async () => {
    const blind = new PostgresSessionExecutionReader(db());
    blind.list = () => Promise.resolve([]);
    expect(await runCanary(dependencies({ executionReader: blind }))).toMatchObject({
      state: 'failed', code: 'canary_execution_not_readable',
    });
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('fails when the console shows the execution with a different status than it was recorded with', async () => {
    const wrong = new PostgresSessionExecutionReader(db());
    const list = wrong.list.bind(wrong);
    wrong.list = async (...args) => (await list(...args)).map(execution => ({ ...execution, status: 'failed' as const }));
    expect(await runCanary(dependencies({ executionReader: wrong }))).toMatchObject({
      state: 'failed', code: 'canary_execution_not_readable',
      detail: 'The console\'s execution listing showed the canary\'s execution with a different session, agent or status than it was recorded with.',
    });
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('does not pass, and does not claim its records are gone, when it cannot remove them', async () => {
    const outcome = await runCanary(withCleanUp(
      () => Promise.reject(new Error('connect ECONNREFUSED db.internal.example:5432 user=dollhouse_app')),
    ));
    expect(outcome).toEqual({
      id: 'approval_execution_projection', state: 'failed', code: 'canary_cleanup_failed',
      detail: 'The canary\'s approval request and execution were read back through the console, but the run did not clean up. '
        + 'The canary could not remove the records it made (an unexpected error). '
        + 'They belong to the canary user only, and a later run removes them.',
    });
    const left = await canaryRows();
    expect(left.presence).toHaveLength(1);
    expect(left.sessions).toHaveLength(1);
    // A later run's sweep is what removes them.
    await sweepEverything();
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('keeps to its time limit when it is the clean-up that hangs, and still cleans up once it can', async () => {
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = Date.now();
    const outcome = await runCanary({
      ...withCleanUp(async transaction => { await held; return transaction(); }),
      timeoutMs: 1500,
    });
    expect(outcome).toMatchObject({ state: 'pending', code: 'canary_timed_out' });
    expect(Date.now() - started).toBeLessThan(10_000);
    release();
    for (let attempt = 0; attempt < 50 && (await canaryRows()).presence.length > 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('removes the canary agent too when the agent was made but its state could not be saved', async () => {
    // The approval request is made before the execution, through its own
    // store. From then on the run's database handle is used to add the agent,
    // then to save the agent's state, then to clean up. The second fails.
    let approvalMade = false;
    let transactionsSince = 0;
    const database = new Proxy(db(), {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        const bound = value.bind(target) as (...args: unknown[]) => Promise<unknown>;
        if (property !== 'transaction') return bound;
        return (...args: unknown[]) => {
          if (approvalMade && ++transactionsSince === 2) return Promise.reject(new Error('could not save agent state'));
          return bound(...args);
        };
      },
    });
    const outcome = await runCanary(dependencies({
      db: database,
      createConfirmationStore: (userId, sessionId) => { approvalMade = true; return confirmationStore(userId, sessionId); },
    }));
    expect(outcome).toMatchObject({ state: 'pending', code: 'canary_could_not_run' });
    expect(transactionsSince).toBeGreaterThanOrEqual(3);
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('reports that it could not run, without the driver\'s words, and cleans up, when a store breaks', async () => {
    const broken = new PostgresRuntimeSessionControlStore(db());
    broken.registerPresence = () => Promise.reject(new Error('connect ECONNREFUSED db.internal.example:5432 user=dollhouse_app'));
    const outcome = await runCanary(dependencies({ runtimeStore: broken }));
    expect(outcome).toEqual({
      id: 'approval_execution_projection', state: 'pending', code: 'canary_could_not_run',
      detail: 'The canary could not complete its run (an unexpected error), so nothing is verified.',
    });
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('gives up after its time limit, says nothing is verified, and does not keep the caller waiting', async () => {
    const stuck = new PostgresRuntimeSessionControlStore(db());
    stuck.registerPresence = () => new Promise<never>(() => {});
    const started = Date.now();
    const outcome = await runCanary(dependencies({ runtimeStore: stuck, timeoutMs: 200 }));
    expect(outcome).toEqual({
      id: 'approval_execution_projection', state: 'pending', code: 'canary_timed_out',
      detail: 'The canary did not finish within 0.2 seconds, so nothing is verified.',
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('works although the canary user is disabled, as it always is', async () => {
    const { users } = await import('../../../src/database/schema/users.js');
    await ensureCanaryUser(db());
    const [row] = await db().select().from(users).where(eq(users.id, CANARY_USER_UUID));
    expect(row.disabledAt).toBeInstanceOf(Date);
    expect((await runCanary(dependencies())).state).toBe('passed');
  });

  it('refuses to run, and creates nothing, when the canary user is no longer inert', async () => {
    const { users } = await import('../../../src/database/schema/users.js');
    await ensureCanaryUser(db());
    await db().update(users).set({ disabledAt: null }).where(eq(users.id, CANARY_USER_UUID));
    try {
      expect(await runCanary(dependencies())).toMatchObject({
        state: 'failed', code: 'canary_user_not_inert',
        detail: 'The canary user has been enabled. It must stay disabled. The canary will not run until it is put right.',
      });
      expect(await canaryRows()).toEqual(nothingLeft);
    } finally {
      await db().update(users).set({ disabledAt: new Date() }).where(eq(users.id, CANARY_USER_UUID));
    }
  });

  it('sweeps what an unfinished run left behind, but not a run that could still be going', async () => {
    const canary = await ensureCanaryUser(db());
    const store = new PostgresRuntimeSessionControlStore(db());
    const leave = async (sessionId: string, startedAt: Date) => {
      await store.registerPresence({
        sessionId, userId: canary.userId, accountCorrelationId: canary.accountCorrelationId, replicaId: 'crashed',
        transport: 'streamable-http', startedAt, lastActiveAt: startedAt, leaseUntil: new Date(startedAt.getTime() + 60_000),
      });
      const approvals = confirmationStore(canary.userId, sessionId);
      await approvals.initialize();
      await approvals.persist();
    };
    const now = new Date();
    const old = `${CANARY_SESSION_PREFIX}left-behind`;
    const recent = `${CANARY_SESSION_PREFIX}still-going`;
    await leave(old, new Date(now.getTime() - CANARY_LEFTOVER_AGE_MS - 1000));
    await leave(recent, new Date(now.getTime() - 1000));

    expect(await sweepCanaryLeftovers(db(), now)).toBe(1);
    const left = await canaryRows();
    expect(left.presence.map(row => row.sessionId)).toEqual([recent]);
    expect(left.sessions.map(row => row.sessionId)).toEqual([recent]);

    // Once the other run is old enough to be abandoned too, the next sweep takes it.
    expect(await sweepCanaryLeftovers(db(), new Date(now.getTime() + CANARY_LEFTOVER_AGE_MS))).toBe(1);
    expect(await canaryRows()).toEqual(nothingLeft);
  });

  it('never touches another user\'s rows that merely look like canary rows', async () => {
    const { users } = await import('../../../src/database/schema/users.js');
    const { randomUUID } = await import('node:crypto');
    const otherId = randomUUID();
    const [other] = await db().insert(users).values({ id: otherId, username: `not-the-canary-${otherId.slice(0, 8)}` }).returning();
    const sessionId = `${CANARY_SESSION_PREFIX}someone-elses`;
    const startedAt = new Date(Date.now() - CANARY_LEFTOVER_AGE_MS * 2);
    await new PostgresRuntimeSessionControlStore(db()).registerPresence({
      sessionId, userId: other.id, accountCorrelationId: other.accountCorrelationId, replicaId: 'real',
      transport: 'streamable-http', startedAt, lastActiveAt: startedAt, leaseUntil: new Date(Date.now() + 60_000),
    });
    try {
      await sweepCanaryLeftovers(db(), new Date());
      expect((await runCanary(dependencies())).state).toBe('passed');
      const kept = await db().select().from(runtimeSessionPresence)
        .where(and(eq(runtimeSessionPresence.userId, other.id), like(runtimeSessionPresence.sessionId, `${CANARY_SESSION_PREFIX}%`)));
      expect(kept.map(row => row.sessionId)).toEqual([sessionId]);
    } finally {
      await db().delete(runtimeSessionPresence).where(eq(runtimeSessionPresence.sessionId, sessionId));
      await db().delete(users).where(eq(users.id, other.id));
    }
  });

  it('marks what it makes as canary activity', () => {
    expect(CANARY_SESSION_PREFIX).toBe('canary-');
    expect(CANARY_AGENT_PREFIX).toBe('dollhouse-canary-agent-');
  });
});
