/**
 * Integration tests for DatabaseActivationStateStore.
 * Runs against real Docker PostgreSQL.
 */

import { DatabaseActivationStateStore } from '../../../src/state/DatabaseActivationStateStore.js';
import {
  getTestDb,
  ensureTestUser,
  cleanupTestSessions,
  closeTestDb,
  isDatabaseAvailable,
} from './test-db-helpers.js';

const TEST_SESSION_ID = 'testActivation';
let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping DatabaseActivationStateStore tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) await cleanupTestSessions();
});

afterAll(async () => {
  await closeTestDb();
});

describe('DatabaseActivationStateStore', () => {
  it('should initialize and create session row', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseActivationStateStore(getTestDb(), userId, TEST_SESSION_ID);

    await store.initialize();
    expect(store.isEnabled()).toBe(true);
    expect(store.getSessionId()).toBe(TEST_SESSION_ID);
  });

  it('should record and retrieve activations', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseActivationStateStore(getTestDb(), userId, TEST_SESSION_ID);
    await store.initialize();

    store.recordActivation('skill', 'test-skill');
    store.recordActivation('persona', 'test-persona', 'test-persona.md');

    const skills = store.getActivations('skill');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('test-skill');

    const personas = store.getActivations('persona');
    expect(personas).toHaveLength(1);
    expect(personas[0].name).toBe('test-persona');
    expect(personas[0].filename).toBe('test-persona.md');
  });

  it('should deduplicate activations', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseActivationStateStore(getTestDb(), userId, TEST_SESSION_ID);
    await store.initialize();

    store.recordActivation('skill', 'same-skill');
    store.recordActivation('skill', 'same-skill');

    expect(store.getActivations('skill')).toHaveLength(1);
  });

  it('should record deactivation', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseActivationStateStore(getTestDb(), userId, TEST_SESSION_ID);
    await store.initialize();

    store.recordActivation('skill', 'to-remove');
    expect(store.getActivations('skill')).toHaveLength(1);

    store.recordDeactivation('skill', 'to-remove');
    expect(store.getActivations('skill')).toHaveLength(0);
  });

  it('should persist and restore across instances', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();

    // Write
    const store1 = new DatabaseActivationStateStore(getTestDb(), userId, TEST_SESSION_ID);
    await store1.initialize();
    store1.recordActivation('skill', 'persisted-skill');

    await store1.awaitPendingWrites();

    // Read back with a new instance
    const store2 = new DatabaseActivationStateStore(getTestDb(), userId, TEST_SESSION_ID);
    await store2.initialize();

    const skills = store2.getActivations('skill');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('persisted-skill');
  });

  it('should be idempotent on double initialize', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseActivationStateStore(getTestDb(), userId, TEST_SESSION_ID);

    await store.initialize();
    store.recordActivation('skill', 'once');

    await store.initialize(); // second call should be no-op
    expect(store.getActivations('skill')).toHaveLength(1);
  });

  it('should clearAll', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseActivationStateStore(getTestDb(), userId, TEST_SESSION_ID);
    await store.initialize();

    store.recordActivation('skill', 'will-clear');
    store.clearAll();

    expect(store.getActivations('skill')).toHaveLength(0);
  });
});
