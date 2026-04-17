/**
 * Integration tests for DatabaseChallengeStore.
 * Runs against real Docker PostgreSQL.
 */

import { DatabaseChallengeStore } from '../../../src/state/DatabaseChallengeStore.js';
import type { StoredChallenge } from '@dollhousemcp/safety';
import {
  getTestDb,
  ensureTestUser,
  cleanupTestSessions,
  closeTestDb,
  isDatabaseAvailable,
} from './test-db-helpers.js';

const TEST_SESSION_ID = 'testChallenge';
let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping DatabaseChallengeStore tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) await cleanupTestSessions();
});

afterAll(async () => {
  await closeTestDb();
});

function makeChallenge(code: string, ttlMs: number = 60000): StoredChallenge {
  return {
    code,
    expiresAt: Date.now() + ttlMs,
    reason: 'test challenge',
  };
}

describe('DatabaseChallengeStore', () => {
  it('should initialize and create session row', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseChallengeStore(getTestDb(), userId, TEST_SESSION_ID, 0);

    await store.initialize();
    expect(store.size()).toBe(0);
    store.destroy();
  });

  it('should set and get challenges', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseChallengeStore(getTestDb(), userId, TEST_SESSION_ID, 0);
    await store.initialize();

    const challenge = makeChallenge('ABC123');
    store.set('challenge-1', challenge);

    const retrieved = store.get('challenge-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.code).toBe('ABC123');
    expect(store.size()).toBe(1);

    store.destroy();
  });

  it('should verify challenges (timing-safe)', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseChallengeStore(getTestDb(), userId, TEST_SESSION_ID, 0);
    await store.initialize();

    store.set('verify-1', makeChallenge('SECRET'));

    // Correct code
    expect(store.verify('verify-1', 'SECRET')).toBe(true);

    // Challenge is consumed (one-time use)
    expect(store.get('verify-1')).toBeUndefined();
    expect(store.size()).toBe(0);

    store.destroy();
  });

  it('should reject incorrect verification code', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseChallengeStore(getTestDb(), userId, TEST_SESSION_ID, 0);
    await store.initialize();

    store.set('verify-2', makeChallenge('CORRECT'));

    expect(store.verify('verify-2', 'WRONG')).toBe(false);
    // Challenge is consumed even on failure (one-time use)
    expect(store.get('verify-2')).toBeUndefined();

    store.destroy();
  });

  it('should expire challenges', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseChallengeStore(getTestDb(), userId, TEST_SESSION_ID, 0);
    await store.initialize();

    // Create an already-expired challenge
    store.set('expired-1', { code: 'GONE', expiresAt: Date.now() - 1000, reason: 'test' });

    expect(store.get('expired-1')).toBeUndefined();
    expect(store.size()).toBe(0);

    store.destroy();
  });

  it('should persist and restore across instances', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();

    // Write
    const store1 = new DatabaseChallengeStore(getTestDb(), userId, TEST_SESSION_ID, 0);
    await store1.initialize();
    store1.set('persist-1', makeChallenge('PERSIST'));
    store1.destroy();

    // Wait for fire-and-forget persist (PersistQueue + RLS transaction overhead)
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Restore
    const store2 = new DatabaseChallengeStore(getTestDb(), userId, TEST_SESSION_ID, 0);
    await store2.initialize();

    const challenge = store2.get('persist-1');
    expect(challenge).toBeDefined();
    expect(challenge!.code).toBe('PERSIST');

    store2.destroy();
  });

  it('should clear all challenges', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseChallengeStore(getTestDb(), userId, TEST_SESSION_ID, 0);
    await store.initialize();

    store.set('c1', makeChallenge('A'));
    store.set('c2', makeChallenge('B'));
    expect(store.size()).toBe(2);

    store.clear();
    expect(store.size()).toBe(0);

    store.destroy();
  });
});
