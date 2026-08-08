/**
 * Integration tests for DatabaseAgentStateStore.
 * Tests agent state CRUD with optimistic locking against real Docker PostgreSQL.
 */

import { DatabaseAgentStateStore } from '../../../src/storage/DatabaseAgentStateStore.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { buildAgentContent, cleanupAllTestData, cleanupTestAgentStates, closeTestDb, ensureTestUser, fixedUserId, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

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

async function createTestAgent(userId: string): Promise<string> {
  const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'agents');
  const content = buildAgentContent('state-test-agent');
  return layer.writeContent('agents', 'state-test-agent', content, {
    author: 'test', version: '1.0.0', description: 'Agent for state testing', tags: [],
  });
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

  it('should transfer orphaned state to a replacement session', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let sessionId = 'session-a';
    const activeSessions = new Set<string>();
    const store = new DatabaseAgentStateStore(
      getTestDb(),
      fixedUserId(userId),
      () => sessionId,
      async candidateSessionId => activeSessions.has(candidateSessionId),
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

  it('should not transfer state owned by an active session', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    let sessionId = 'session-a';
    const store = new DatabaseAgentStateStore(
      getTestDb(),
      fixedUserId(userId),
      () => sessionId,
      async candidateSessionId => candidateSessionId === 'session-a',
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
      async () => false,
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
    const isSessionActive = async (candidateSessionId: string) =>
      activeSessions.has(candidateSessionId);
    const sourceStore = new DatabaseAgentStateStore(
      getTestDb(), fixedUserId(userId), () => 'session-a', isSessionActive,
    );
    const sessionBStore = new DatabaseAgentStateStore(
      getTestDb(), fixedUserId(userId), () => 'session-b', isSessionActive,
    );
    const sessionCStore = new DatabaseAgentStateStore(
      getTestDb(), fixedUserId(userId), () => 'session-c', isSessionActive,
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
});
