/**
 * Integration tests for DatabaseChallengeStore.
 * Runs against real Docker PostgreSQL.
 */

import { DatabaseChallengeStore } from '../../../src/state/DatabaseChallengeStore.js';
import { ensureSessionRow, loadSessionRow, updateSessionColumns } from '../../../src/state/db-persistence-utils.js';
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
const keys = { resolve: async () => ({ keyId: 'integration-test', key: Buffer.alloc(32, 0x5d) }) };

function makeStore(userId: string): DatabaseChallengeStore {
  return new DatabaseChallengeStore(getTestDb(), userId, TEST_SESSION_ID, keys, 0);
}

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
    const store = makeStore(userId);

    await store.initialize();
    expect(store.size()).toBe(0);
    store.destroy();
  });

  it('should set and get challenges', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = makeStore(userId);
    await store.initialize();

    const challenge = makeChallenge('ABC123');
    store.set('challenge-1', challenge);

    const retrieved = store.get('challenge-1');
    expect(retrieved).toBeDefined();
    expect(retrieved).toEqual({ expiresAt: challenge.expiresAt, reason: challenge.reason });
    expect(store.size()).toBe(1);

    store.destroy();
  });

  it('should verify challenges (timing-safe)', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = makeStore(userId);
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
    const store = makeStore(userId);
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
    const store = makeStore(userId);
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
    const store1 = makeStore(userId);
    await store1.initialize();
    store1.set('persist-1', makeChallenge('PERSIST'));
    await store1.awaitPendingWrites();
    store1.destroy();

    const row = await loadSessionRow(getTestDb(), userId, TEST_SESSION_ID);
    expect(JSON.stringify(row?.challenges)).not.toContain('PERSIST');
    expect(row?.challenges).toEqual([['persist-1', expect.objectContaining({ verifier: expect.stringMatching(/^[a-f0-9]{64}$/) })]]);

    // Restore
    const store2 = makeStore(userId);
    await store2.initialize();

    const challenge = store2.get('persist-1');
    expect(challenge).toBeDefined();
    expect(challenge?.reason).toBe('test challenge');
    expect(store2.verify('persist-1', 'PERSIST')).toBe(true);
    expect(store2.verify('persist-1', 'PERSIST')).toBe(false);
    await store2.awaitPendingWrites();

    store2.destroy();
  });

  it('rewrites legacy codes to keyed verifiers before restoring active challenges', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    await ensureSessionRow(db, userId, TEST_SESSION_ID);
    await updateSessionColumns(db, userId, TEST_SESSION_ID, {
      challenges: [
        ['legacy-active', makeChallenge('OLD-ACTIVE')],
        ['legacy-expired', makeChallenge('OLD-EXPIRED', -1000)],
      ],
    });
    const store = makeStore(userId);
    try {
      await store.initialize();
      const row = await loadSessionRow(db, userId, TEST_SESSION_ID);
      expect(JSON.stringify(row?.challenges)).not.toMatch(/OLD-ACTIVE|OLD-EXPIRED|"code"/u);
      expect(store.get('legacy-expired')).toBeUndefined();
      expect(store.verify('legacy-active', 'OLD-ACTIVE')).toBe(true);
      expect(store.verify('legacy-active', 'OLD-ACTIVE')).toBe(false);
      await store.awaitPendingWrites();
    } finally {
      store.destroy();
    }
  });

  it('should clear all challenges', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = makeStore(userId);
    await store.initialize();

    store.set('c1', makeChallenge('A'));
    store.set('c2', makeChallenge('B'));
    expect(store.size()).toBe(2);

    store.clear();
    expect(store.size()).toBe(0);

    store.destroy();
  });
});
