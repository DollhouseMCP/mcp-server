import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { withSystemContext } from '../../../src/database/admin.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import {
  closeTestDb,
  getTestAdminDb,
  getTestDb,
  isDatabaseAvailable,
} from './test-db-helpers.js';

let pgAvailable = false;

beforeAll(async () => {
  pgAvailable = await isDatabaseAvailable();
  if (!pgAvailable) {
    console.warn(
      '[system-context-tripwire] Skipping system-context tests — local Docker Postgres unreachable.',
    );
  }
});

afterAll(async () => {
  if (pgAvailable) await closeTestDb();
});

const pgRequired = process.env.DOLLHOUSE_REQUIRE_PG_AUTH_TESTS === '1';
const describePg = pgRequired ? describe : describe.skip;

describePg('withSystemContext privileged-role tripwire', () => {
  beforeAll(() => {
    if (!pgAvailable) {
      throw new Error(
        'system-context tripwire tests required (DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1) ' +
        'but Postgres was not reachable.',
      );
    }
  });

  it('rejects the app role before running system-context work', async () => {
    await expect(
      withSystemContext(getTestDb(), async (tx) => {
        await tx.execute(sql`SELECT 1`);
        return 'should-not-run';
      }),
    ).rejects.toThrow(/SUPERUSER or BYPASSRLS/);
  });

  it('allows the admin role to run system-context work', async () => {
    await expect(
      withSystemContext(getTestAdminDb(), async (tx) => {
        await tx.execute(sql`SELECT 1`);
        return 'ok';
      }),
    ).resolves.toBe('ok');
  });

  it('blocks auth_kv access through PostgresAuthStorageLayer when constructed with the app role', async () => {
    const storage = new PostgresAuthStorageLayer({ db: getTestDb() });

    await expect(storage.genericGet('Session', 'tripwire')).rejects.toThrow(/SUPERUSER or BYPASSRLS/);
  });
});
