/**
 * DatabaseTokenStore integration tests.
 *
 * Postgres tests are gated the same way as the other storage parity suites:
 * local runs skip when Docker Postgres is unavailable, CI can require them via
 * DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';

import { DatabaseTokenStore } from '../../../src/security/tokenStores/DatabaseTokenStore.js';
import type { MasterKeyProvider } from '../../../src/security/keys/MasterKeyProvider.js';
import { userOauthTokens } from '../../../src/database/schema/index.js';
import { withUserContext } from '../../../src/database/rls.js';
import {
  closeTestDb,
  ensureTestUser,
  ensureTestUserB,
  getTestDb,
  isDatabaseAvailable,
} from '../database/test-db-helpers.js';

class StubMasterKeyProvider implements MasterKeyProvider {
  constructor(private readonly key = Buffer.alloc(32, 9), private readonly version = 1) {}

  async getCurrentKey() {
    return { key: Buffer.from(this.key), version: this.version };
  }

  async getKey(version: number) {
    if (version !== this.version) throw new Error(`missing key ${version}`);
    return this.getCurrentKey();
  }
}

const pgRequired = process.env.DOLLHOUSE_REQUIRE_PG_AUTH_TESTS === '1';
const describePg = pgRequired ? describe : describe.skip;

describePg('DatabaseTokenStore', () => {
  let available = false;

  beforeAll(async () => {
    available = await isDatabaseAvailable();
    if (!available && pgRequired) {
      throw new Error('DatabaseTokenStore tests required but Postgres was not reachable');
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    if (!available) return;
    const db = getTestDb();
    for (const userId of [await ensureTestUser(), await ensureTestUserB()]) {
      await withUserContext(db, userId, async (tx) => {
        await tx.delete(userOauthTokens).where(eq(userOauthTokens.userId, userId));
      });
    }
  });

  it('round-trips tokens through the database with envelope encryption', async () => {
    const db = getTestDb();
    const userId = await ensureTestUser();
    const store = new DatabaseTokenStore(db, new StubMasterKeyProvider());
    const token = 'ghp_DBMODETOKEN00000000000000000000000000001';

    await store.storeToken(userId, token);

    const rawRows = await withUserContext(db, userId, (tx) =>
      tx.select().from(userOauthTokens).where(eq(userOauthTokens.userId, userId)).limit(1),
    );
    expect(rawRows).toHaveLength(1);
    expect(Buffer.from(rawRows[0].tokenCiphertext).toString('utf8')).not.toContain(token);
    expect(rawRows[0].keyVersion).toBe(1);

    await expect(store.retrieveToken(userId)).resolves.toBe(token);
  });

  it('enforces user isolation at the RLS layer', async () => {
    const db = getTestDb();
    const userA = await ensureTestUser();
    const userB = await ensureTestUserB();
    const store = new DatabaseTokenStore(db, new StubMasterKeyProvider());

    await store.storeToken(userA, 'ghp_ALICEDBTOKEN000000000000000000000000001');

    await expect(store.retrieveToken(userB)).resolves.toBeNull();
    const visibleToBob = await withUserContext(db, userB, (tx) =>
      tx.select({ userId: userOauthTokens.userId })
        .from(userOauthTokens)
        .where(eq(userOauthTokens.userId, userA)),
    );
    expect(visibleToBob).toHaveLength(0);

    const unscopedCount = await db.execute(sql`SELECT COUNT(*)::int AS count FROM user_oauth_tokens`);
    expect(Number((unscopedCount as unknown as Array<{ count: number }>)[0]?.count ?? 0)).toBe(0);
  });

  it('deletes only the current user token', async () => {
    const db = getTestDb();
    const userA = await ensureTestUser();
    const userB = await ensureTestUserB();
    const store = new DatabaseTokenStore(db, new StubMasterKeyProvider());

    await store.storeToken(userA, 'ghp_ALICEDELETE000000000000000000000000001');
    await store.storeToken(userB, 'ghp_BOBDELETE00000000000000000000000000002');
    await store.deleteToken(userA);

    await expect(store.retrieveToken(userA)).resolves.toBeNull();
    await expect(store.retrieveToken(userB)).resolves.toBe('ghp_BOBDELETE00000000000000000000000000002');
  });
});

