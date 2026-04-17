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
});
