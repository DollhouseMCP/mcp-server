/**
 * Integration tests for DatabaseAgentStateStore.
 * Tests agent state CRUD with optimistic locking against real Docker PostgreSQL.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { createDatabaseConnection } from '../../../src/database/connection.js';
import { DatabaseAgentStateStore } from '../../../src/storage/DatabaseAgentStateStore.js';
import { DatabaseAgentSnapshotReplacementJournal } from '../../../src/storage/DatabaseAgentSnapshotReplacementJournal.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { withUserContext, withUserRead } from '../../../src/database/rls.js';
import { agentReplacementJournals } from '../../../src/database/schema/agents.js';
import {
  findRecordedRuntimePresenceWithTx,
  PostgresRuntimeSessionControlStore,
} from '../../../src/web-console/services/runtime/PostgresRuntimeSessionControlStore.js';
import { buildAgentContent, cleanupAllTestData, cleanupTestAgentStates, closeTestDb, ensureTestUser, fixedUserId, getTestAdminDb, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping DatabaseAgentStateStore tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) {
    const userId = await ensureTestUser();
    await cleanupTestAgentStates(userId);
    await cleanupAllTestData();
  }
});

afterAll(async () => {
  await closeTestDb();
});

async function createTestAgent(userId: string, name = 'state-test-agent'): Promise<string> {
  const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'agents');
  const content = buildAgentContent(name);
  return layer.writeContent('agents', name, content, {
    author: 'test', version: '1.0.0', description: 'Agent for state testing', tags: [],
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}

function serializedAgent(name: string): string {
  return JSON.stringify({ metadata: { name } });
}

describe('DatabaseAgentStateStore', () => {
  it('should return null for agent with no state', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseAgentStateStore(getTestDb(), fixedUserId(userId));
    const agentId = await createTestAgent(userId);

    const state = await store.loadState(agentId);
    expect(state).toBeNull();
  });

  it('should save initial state with expectedVersion 0', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseAgentStateStore(getTestDb(), fixedUserId(userId));
    const agentId = await createTestAgent(userId);

    const newVersion = await store.saveState(agentId, {
      goals: [{ name: 'goal-1', status: 'active' }],
      decisions: [],
      context: { key: 'value' },
      stateVersion: 0,
    }, 0);

    expect(newVersion).toBe(1);

    const loaded = await store.loadState(agentId);
    expect(loaded).not.toBeNull();
    expect(loaded!.stateVersion).toBe(1);
    expect(loaded!.goals).toHaveLength(1);
    expect(loaded!.context).toEqual({ key: 'value' });
  });

  it('should update state with correct expected version', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseAgentStateStore(getTestDb(), fixedUserId(userId));
    const agentId = await createTestAgent(userId);

    await store.saveState(agentId, {
      goals: [{ name: 'g1' }], decisions: [], context: {}, stateVersion: 0,
    }, 0);

    const v2 = await store.saveState(agentId, {
      goals: [{ name: 'g1' }, { name: 'g2' }], decisions: [{ choice: 'A' }],
      context: { updated: true }, stateVersion: 1,
    }, 1);

    expect(v2).toBe(2);

    const loaded = await store.loadState(agentId);
    expect(loaded!.goals).toHaveLength(2);
    expect(loaded!.decisions).toHaveLength(1);
    expect(loaded!.stateVersion).toBe(2);
  });

  it('should reject save with wrong expected version (optimistic lock)', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseAgentStateStore(getTestDb(), fixedUserId(userId));
    const agentId = await createTestAgent(userId);

    await store.saveState(agentId, {
      goals: [], decisions: [], context: {}, stateVersion: 0,
    }, 0);

    // Try to save with stale version (0 instead of 1)
    await expect(
      store.saveState(agentId, {
        goals: [], decisions: [], context: {}, stateVersion: 0,
      }, 0)
    ).rejects.toThrow(/version conflict/i);
  });

  it('should reject initial save with non-zero expected version', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseAgentStateStore(getTestDb(), fixedUserId(userId));
    const agentId = await createTestAgent(userId);

    await expect(
      store.saveState(agentId, {
        goals: [], decisions: [], context: {}, stateVersion: 5,
      }, 5) // No existing row, but expectedVersion != 0
    ).rejects.toThrow(/expected 0 for initial save/i);
  });

  it('rejects a recovery save when durable database state disappeared', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseAgentStateStore(getTestDb(), fixedUserId(userId));
    const agentId = await createTestAgent(userId);

    await expect(store.save({
      name: 'state-test-agent',
      agentElementId: agentId,
      sessionId: 'session-a',
    }, {
      goals: [],
      decisions: [],
      context: {},
      stateVersion: 0,
      sessionCount: 0,
      lastActive: new Date(),
    }, 0, { requireExisting: true })).rejects.toThrow('state disappeared');
  });

  it('should delete agent state', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseAgentStateStore(getTestDb(), fixedUserId(userId));
    const agentId = await createTestAgent(userId);

    await store.saveState(agentId, {
      goals: [{ name: 'will-delete' }], decisions: [], context: {}, stateVersion: 0,
    }, 0);

    await store.deleteState(agentId);

    const loaded = await store.loadState(agentId);
    expect(loaded).toBeNull();
  });

  it('uses the journaled session identity and CAS version for recovery deletion', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let currentSession = 'session-a';
    const store = new DatabaseAgentStateStore(
      getTestDb(),
      fixedUserId(userId),
      () => currentSession,
    );
    const agentId = await createTestAgent(userId);
    const key = {
      name: 'state-test-agent',
      agentElementId: agentId,
      sessionId: 'session-a',
    };
    await store.save(key, {
      goals: [],
      decisions: [],
      context: { owner: 'session-a' },
      lastActive: new Date(),
      sessionCount: 1,
      stateVersion: 0,
    }, 0);

    currentSession = 'session-b';
    await expect(store.load(key, { strict: true })).resolves.toMatchObject({
      context: { owner: 'session-a' },
      stateVersion: 1,
    });
    await expect(store.delete(key, {
      expectedVersion: 0,
      requireExisting: true,
    })).rejects.toThrow(/version conflict/i);
    await expect(store.delete(key, {
      expectedVersion: 1,
      requireExisting: true,
    })).resolves.toBe(true);
  });

  it('persists replacement journals in PostgreSQL with their original session identity', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let currentSession = 'session-a';
    const agentId = await createTestAgent(userId);
    const owner = new DatabaseAgentSnapshotReplacementJournal(
      getTestDb(),
      fixedUserId(userId),
      () => currentSession,
      5,
    );
    const entry = await owner.create({
      agentName: 'state-test-agent',
      filePath: agentId,
      isDatabaseMode: true,
      stateKey: {
        name: 'state-test-agent',
        agentElementId: agentId,
        sessionId: 'session-a',
      },
      stateIncluded: false,
      previousAgentJson: serializedAgent('state-test-agent'),
      intendedAgentJson: serializedAgent('state-test-agent'),
      previousDefinition: 'previous bytes',
      intendedDefinition: 'intended bytes',
      previousState: null,
      intendedState: null,
    });
    await owner.releaseOwnership(entry);

    currentSession = 'session-b';
    const recoveringReplica = new DatabaseAgentSnapshotReplacementJournal(
      getTestDb(),
      fixedUserId(userId),
      () => currentSession,
      5,
    );
    const durable = await recoveringReplica.list();
    expect(durable).toHaveLength(1);
    expect(durable[0].record.stateKey.sessionId).toBe('session-a');
    const claimed = await recoveringReplica.claimForRecovery(durable[0]);
    expect(claimed?.record.leaseToken).not.toBe(entry.record.leaseToken);
    if (!claimed) throw new Error('Expected PostgreSQL lease takeover');
    await expect(owner.remove(entry.journalPath, entry.record.leaseToken))
      .rejects.toThrow('lost its lease fence');
    let staleMutationRan = false;
    await expect(owner.runWhileOwned(entry, async () => {
      staleMutationRan = true;
    })).rejects.toThrow('lease was lost');
    expect(staleMutationRan).toBe(false);
    await expect(recoveringReplica.list()).resolves.toEqual([
      expect.objectContaining({
        record: expect.objectContaining({ leaseToken: claimed.record.leaseToken }),
      }),
    ]);
    await recoveringReplica.remove(claimed.journalPath, claimed.record.leaseToken);
  });

  it('fences PostgreSQL PID-reuse takeover with the lease token', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const agentId = await createTestAgent(userId);
    const recordedIncarnation = {
      source: 'linux-proc' as const,
      bootId: 'boot-a',
      processStartId: '100',
    };
    const owner = new DatabaseAgentSnapshotReplacementJournal(
      getTestDb(),
      fixedUserId(userId),
      () => 'session-a',
      5,
      async () => recordedIncarnation,
    );
    const entry = await owner.create({
      agentName: 'state-test-agent',
      filePath: agentId,
      isDatabaseMode: true,
      stateKey: {
        name: 'state-test-agent',
        agentElementId: agentId,
        sessionId: 'session-a',
      },
      stateIncluded: false,
      previousAgentJson: serializedAgent('state-test-agent'),
      intendedAgentJson: serializedAgent('state-test-agent'),
      previousDefinition: 'previous bytes',
      intendedDefinition: 'intended bytes',
      previousState: null,
      intendedState: null,
    });
    await owner.releaseOwnership(entry);
    await withUserContext(getTestDb(), userId, async (tx) => {
      await tx.update(agentReplacementJournals).set({
        ownerProcessIncarnation: recordedIncarnation,
        leaseExpiresAt: new Date(0),
      }).where(eq(agentReplacementJournals.operationId, entry.record.operationId));
    });
    const successor = new DatabaseAgentSnapshotReplacementJournal(
      getTestDb(),
      fixedUserId(userId),
      () => 'session-b',
      5,
      async () => ({ ...recordedIncarnation, processStartId: '200' }),
    );
    const durable = await successor.list();
    expect(durable).toHaveLength(1);
    const claimed = await successor.claimForRecovery(durable[0]);
    if (!claimed) throw new Error('Expected PID-reuse lease takeover');

    await expect(owner.remove(entry.journalPath, entry.record.leaseToken))
      .rejects.toThrow('lost its lease fence');
    await successor.remove(claimed.journalPath, claimed.record.leaseToken);
  });

  it('rejects concurrent replacement journals for one agent across sessions', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let currentSession = 'session-a';
    const agentId = await createTestAgent(userId);
    const journal = new DatabaseAgentSnapshotReplacementJournal(
      getTestDb(),
      fixedUserId(userId),
      () => currentSession,
      5_000,
    );
    const base = {
      agentName: 'state-test-agent',
      filePath: agentId,
      isDatabaseMode: true as const,
      stateIncluded: false,
      previousAgentJson: serializedAgent('state-test-agent'),
      intendedAgentJson: serializedAgent('state-test-agent'),
      previousDefinition: 'previous bytes',
      intendedDefinition: 'intended bytes',
      previousState: null,
      intendedState: null,
    };
    const first = await journal.create({
      ...base,
      stateKey: { name: 'state-test-agent', agentElementId: agentId, sessionId: 'session-a' },
    });

    currentSession = 'session-b';
    await expect(journal.create({
      ...base,
      stateKey: { name: 'state-test-agent', agentElementId: agentId, sessionId: 'session-b' },
    })).rejects.toThrow('already active');

    currentSession = 'session-a';
    await journal.remove(first.journalPath, first.record.leaseToken);
  });

  it('serializes same-agent mutations across PostgreSQL-backed replicas', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const first = new DatabaseAgentSnapshotReplacementJournal(
      getTestDb(), fixedUserId(userId), () => 'session-a',
    );
    const second = new DatabaseAgentSnapshotReplacementJournal(
      getTestDb(), fixedUserId(userId), () => 'session-b',
    );
    const entered = deferred();
    const release = deferred();
    let secondEntered = false;

    const firstMutation = first.runWithAgentMutationGate('StateTestAgent', async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const secondMutation = second.runWithAgentMutationGate('state-test-agent', async () => {
      secondEntered = true;
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(secondEntered).toBe(false);

    release.resolve();
    await Promise.all([firstMutation, secondMutation]);
    expect(secondEntered).toBe(true);
  });

  it('atomically quarantines malformed journal rows without hiding unrelated valid work', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const malformedAgentId = await createTestAgent(userId, 'malformed-journal-agent');
    const validAgentId = await createTestAgent(userId, 'valid-journal-agent');
    const malformedOperationId = randomUUID();
    const now = new Date();
    await withUserContext(getTestDb(), userId, async (tx) => {
      await tx.insert(agentReplacementJournals).values({
        operationId: malformedOperationId,
        userId,
        sessionId: 'session-a',
        agentId: malformedAgentId,
        agentName: 'malformed-journal-agent',
        ownerHost: 'test-host',
        ownerPid: process.pid,
        ownerInstanceId: randomUUID(),
        leaseToken: randomUUID(),
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        payload: { version: 1, operationId: malformedOperationId },
        createdAt: now,
      });
    });
    const journal = new DatabaseAgentSnapshotReplacementJournal(
      getTestDb(), fixedUserId(userId), () => 'session-b',
    );
    const valid = await journal.create({
      agentName: 'valid-journal-agent',
      filePath: validAgentId,
      isDatabaseMode: true,
      stateKey: {
        name: 'valid-journal-agent',
        agentElementId: validAgentId,
        sessionId: 'session-b',
      },
      stateIncluded: false,
      previousAgentJson: serializedAgent('valid-journal-agent'),
      intendedAgentJson: serializedAgent('valid-journal-agent'),
      previousDefinition: 'previous bytes',
      intendedDefinition: 'intended bytes',
      previousState: null,
      intendedState: null,
    });

    await expect(journal.list()).resolves.toEqual([
      expect.objectContaining({ journalPath: valid.journalPath }),
    ]);
    const malformedRows = await withUserRead(getTestDb(), userId, tx => tx
      .select({
        quarantinedAt: agentReplacementJournals.quarantinedAt,
        quarantineReason: agentReplacementJournals.quarantineReason,
      })
      .from(agentReplacementJournals)
      .where(eq(agentReplacementJournals.operationId, malformedOperationId))
      .limit(1));
    expect(malformedRows[0]?.quarantinedAt).toBeInstanceOf(Date);
    expect(malformedRows[0]?.quarantineReason).toContain('invalid schema');
    await journal.remove(valid.journalPath, valid.record.leaseToken);
  });

  it('should transfer orphaned state to a replacement session', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let sessionId = 'session-a';
    const activeSessions = new Set<string>();
    const store = new DatabaseAgentStateStore(
      getTestDb(),
      fixedUserId(userId),
      () => sessionId,
      async candidateSessionId => activeSessions.has(candidateSessionId) ? 'active' : 'inactive',
      getTestAdminDb(),
    );
    const agentId = await createTestAgent(userId);
    const key = { name: 'state-test-agent', agentElementId: agentId };

    await store.saveState(agentId, {
      goals: [{ id: 'goal-orphan', status: 'in_progress' }],
      decisions: [], context: {}, stateVersion: 0,
    }, 0);

    sessionId = 'session-b';
    expect(await store.loadState(agentId)).toBeNull();

    const reclaimed = await store.reclaimOrphaned(key);

    expect(reclaimed?.goals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'goal-orphan', status: 'in_progress' }),
    ]));
    expect(await store.loadState(agentId)).not.toBeNull();
    sessionId = 'session-a';
    expect(await store.loadState(agentId)).toBeNull();
  });

  it('should merge an orphaned execution into a dormant current-session row', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let sessionId = 'session-a';
    const store = new DatabaseAgentStateStore(
      getTestDb(),
      fixedUserId(userId),
      () => sessionId,
      async candidateSessionId => candidateSessionId === 'session-a' ? 'inactive' : 'active',
      getTestAdminDb(),
    );
    const agentId = await createTestAgent(userId);
    const key = { name: 'state-test-agent', agentElementId: agentId };

    await store.saveState(agentId, {
      goals: [{ id: 'goal-orphan', status: 'in_progress' }],
      decisions: [{ id: 'decision-orphan', goalId: 'goal-orphan' }],
      context: { orphan: true },
      stateVersion: 0,
    }, 0);
    sessionId = 'session-b';
    await store.saveState(agentId, {
      goals: [{ id: 'goal-finished', status: 'completed' }],
      decisions: [{ id: 'decision-finished', goalId: 'goal-finished' }],
      context: { current: true },
      stateVersion: 0,
    }, 0);

    const reclaimed = await store.reclaimOrphaned(key);

    expect(reclaimed).toMatchObject({
      goals: expect.arrayContaining([
        expect.objectContaining({ id: 'goal-finished', status: 'completed' }),
        expect.objectContaining({ id: 'goal-orphan', status: 'in_progress' }),
      ]),
      decisions: expect.arrayContaining([
        expect.objectContaining({ id: 'decision-finished' }),
        expect.objectContaining({ id: 'decision-orphan' }),
      ]),
      context: { current: true, orphan: true },
      stateVersion: 2,
    });
    sessionId = 'session-a';
    await expect(store.loadState(agentId)).resolves.toBeNull();
  });

  it('should not transfer state owned by an active session', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let sessionId = 'session-a';
    const store = new DatabaseAgentStateStore(
      getTestDb(),
      fixedUserId(userId),
      () => sessionId,
      async candidateSessionId => candidateSessionId === 'session-a' ? 'active' : 'inactive',
      getTestAdminDb(),
    );
    const agentId = await createTestAgent(userId);
    const key = { name: 'state-test-agent', agentElementId: agentId };

    await store.saveState(agentId, {
      goals: [{ id: 'goal-live', status: 'in_progress' }],
      decisions: [], context: {}, stateVersion: 0,
    }, 0);
    sessionId = 'session-b';

    expect(await store.reclaimOrphaned(key)).toBeNull();
    sessionId = 'session-a';
    expect(await store.loadState(agentId)).not.toBeNull();
  });

  it('should not transfer state containing a locally tracked goal', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let sessionId = 'session-a';
    const store = new DatabaseAgentStateStore(
      getTestDb(),
      fixedUserId(userId),
      () => sessionId,
      async () => 'inactive',
      getTestAdminDb(),
    );
    const agentId = await createTestAgent(userId);
    const key = { name: 'state-test-agent', agentElementId: agentId };

    await store.saveState(agentId, {
      goals: [{ id: 'goal-live', status: 'in_progress' }],
      decisions: [], context: {}, stateVersion: 0,
    }, 0);
    sessionId = 'session-b';

    expect(await store.reclaimOrphaned(key, {
      excludedGoalIds: ['goal-live'],
    })).toBeNull();
  });

  it('should allow only one replacement session to transfer an orphaned row', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const agentId = await createTestAgent(userId);
    const key = { name: 'state-test-agent', agentElementId: agentId };
    const activeSessions = new Set(['session-b', 'session-c']);
    const resolveSessionActivity = async (candidateSessionId: string) =>
      activeSessions.has(candidateSessionId) ? 'active' as const : 'inactive' as const;
    const sourceStore = new DatabaseAgentStateStore(
      getTestDb(), fixedUserId(userId), () => 'session-a', resolveSessionActivity, getTestAdminDb(),
    );
    const sessionBStore = new DatabaseAgentStateStore(
      getTestDb(), fixedUserId(userId), () => 'session-b', resolveSessionActivity, getTestAdminDb(),
    );
    const sessionCStore = new DatabaseAgentStateStore(
      getTestDb(), fixedUserId(userId), () => 'session-c', resolveSessionActivity, getTestAdminDb(),
    );

    await sourceStore.saveState(agentId, {
      goals: [{ id: 'goal-orphan', status: 'in_progress' }],
      decisions: [], context: {}, stateVersion: 0,
    }, 0);

    const claims = await Promise.all([
      sessionBStore.reclaimOrphaned(key),
      sessionCStore.reclaimOrphaned(key),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const owners = await Promise.all([
      sessionBStore.loadState(agentId),
      sessionCStore.loadState(agentId),
    ]);
    expect(owners.filter(Boolean)).toHaveLength(1);
  });

  it('should fail closed when source-session presence is unknown', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let sessionId = 'session-a';
    const store = new DatabaseAgentStateStore(
      getTestDb(),
      fixedUserId(userId),
      () => sessionId,
      async () => 'unknown',
      getTestAdminDb(),
    );
    const agentId = await createTestAgent(userId);
    const key = { name: 'state-test-agent', agentElementId: agentId };

    await store.saveState(agentId, {
      goals: [{ id: 'goal-unknown-owner', status: 'in_progress' }],
      decisions: [], context: {}, stateVersion: 0,
    }, 0);
    sessionId = 'session-b';

    await expect(store.reclaimOrphaned(key)).resolves.toBeNull();
    sessionId = 'session-a';
    await expect(store.loadState(agentId)).resolves.not.toBeNull();
  });

  it('retains inactive presence through reclaim on a shared single-connection pool', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const agentId = await createTestAgent(userId);
    const connection = createDatabaseConnection({
      connectionUrl: process.env.DOLLHOUSE_TEST_DATABASE_ADMIN_URL
        ?? 'postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp_test',
      poolSize: 1,
      ssl: 'disable',
    });
    const presenceStore = new PostgresRuntimeSessionControlStore(connection.db);
    let sessionId = 'session-a';
    const now = new Date();
    const lastActiveAt = new Date(now.getTime() - 120_000);
    const leaseUntil = new Date(now.getTime() - 60_000);

    try {
      await presenceStore.registerPresence({
        sessionId,
        userId,
        accountCorrelationId: randomUUID(),
        replicaId: 'single-pool-test',
        transport: 'streamable-http',
        startedAt: lastActiveAt,
        lastActiveAt,
        leaseUntil,
      });
      const store = new DatabaseAgentStateStore(
        connection.db,
        fixedUserId(userId),
        () => sessionId,
        async (candidateSessionId, candidateUserId, tx) => {
          const presence = await findRecordedRuntimePresenceWithTx(tx, candidateSessionId);
          if (presence?.userId !== candidateUserId) return 'unknown';
          return presence.status === 'active' && presence.leaseUntil > new Date()
            ? 'active'
            : 'inactive';
        },
        connection.db,
      );
      const key = { name: 'state-test-agent', agentElementId: agentId };

      await store.saveState(agentId, {
        goals: [{ id: 'goal-single-pool', status: 'in_progress' }],
        decisions: [], context: {}, stateVersion: 0,
      }, 0);

      await expect(presenceStore.sweepStalePresence(now)).resolves.toBe(0);
      await expect(presenceStore.findRecordedPresence('session-a')).resolves.not.toBeNull();

      sessionId = 'session-b';
      await expect(store.reclaimOrphaned(key)).resolves.toMatchObject({
        goals: expect.arrayContaining([
          expect.objectContaining({ id: 'goal-single-pool', status: 'in_progress' }),
        ]),
      });

      await expect(presenceStore.sweepStalePresence(now)).resolves.toBe(1);
      await expect(presenceStore.findRecordedPresence('session-a')).resolves.toBeNull();
    } finally {
      await connection.close();
    }
  });

  it('rejects a delayed source heartbeat after orphan state is reclaimed', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const agentId = await createTestAgent(userId);
    const presenceStore = new PostgresRuntimeSessionControlStore(getTestAdminDb());
    let sessionId = 'session-delayed-heartbeat-source';
    const startedAt = new Date(Date.now() - 120_000);
    const expiredAt = new Date(Date.now() - 60_000);
    await presenceStore.registerPresence({
      sessionId,
      userId,
      accountCorrelationId: randomUUID(),
      replicaId: 'delayed-heartbeat-replica',
      transport: 'streamable-http',
      startedAt,
      lastActiveAt: startedAt,
      leaseUntil: expiredAt,
    });
    const store = new DatabaseAgentStateStore(
      getTestDb(),
      fixedUserId(userId),
      () => sessionId,
      async (candidateSessionId, candidateUserId, tx) => {
        const presence = await findRecordedRuntimePresenceWithTx(tx, candidateSessionId);
        if (presence?.userId !== candidateUserId) return 'unknown';
        return presence.status === 'active' && presence.leaseUntil > new Date()
          ? 'active'
          : 'inactive';
      },
      getTestAdminDb(),
    );
    await store.saveState(agentId, {
      goals: [{ id: 'goal-delayed-heartbeat', status: 'in_progress' }],
      decisions: [], context: {}, stateVersion: 0,
    }, 0);

    sessionId = 'session-delayed-heartbeat-target';
    await expect(store.reclaimOrphaned({ name: 'state-test-agent', agentElementId: agentId }))
      .resolves.toMatchObject({
        goals: expect.arrayContaining([
          expect.objectContaining({ id: 'goal-delayed-heartbeat', status: 'in_progress' }),
        ]),
      });
    await expect(presenceStore.heartbeatPresence({
      sessionId: 'session-delayed-heartbeat-source',
      replicaId: 'delayed-heartbeat-replica',
      lastActiveAt: new Date(),
      requestCount: 1,
      errorCount: 0,
      leaseUntil: new Date(Date.now() + 60_000),
    })).resolves.toEqual({ kind: 'lost', reason: 'closing' });
  });

  it('does not retain stale presence for completed-only agent state', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const agentId = await createTestAgent(userId);
    const sessionId = 'session-completed';
    const now = new Date();
    const lastActiveAt = new Date(now.getTime() - 120_000);
    const presenceStore = new PostgresRuntimeSessionControlStore(getTestAdminDb());
    const store = new DatabaseAgentStateStore(
      getTestDb(), fixedUserId(userId), () => sessionId,
    );

    await presenceStore.registerPresence({
      sessionId,
      userId,
      accountCorrelationId: randomUUID(),
      replicaId: 'completed-state-test',
      transport: 'streamable-http',
      startedAt: lastActiveAt,
      lastActiveAt,
      leaseUntil: new Date(now.getTime() - 60_000),
    });
    await store.saveState(agentId, {
      goals: [{ id: 'goal-completed', status: 'completed' }],
      decisions: [], context: {}, stateVersion: 0,
    }, 0);

    await expect(presenceStore.sweepStalePresence(now)).resolves.toBe(1);
    await expect(presenceStore.findRecordedPresence(sessionId)).resolves.toBeNull();
  });
});
