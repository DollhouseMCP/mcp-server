import { afterAll, beforeAll, expect, it } from '@jest/globals';
import { runtimeLeaseContract } from '../../helpers/runtimeLeaseContract.js';
import { PostgresRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/PostgresRuntimeSessionControlStore.js';
import { closeTestDb, ensureTestUser, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

let available = false;
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
});
afterAll(async () => { await closeTestDb(); });
runtimeLeaseContract(async () => ({ store: new PostgresRuntimeSessionControlStore(getTestAdminDb()), userId: await ensureTestUser() }), () => available);

it('rejects invalid lease deadlines before issuing SQL', async () => {
  if (!available) return;
  const store = new PostgresRuntimeSessionControlStore(getTestAdminDb());
  await expect(store.renewSessionLease({ sessionId: 'invalid-lease', replicaId: 'replica-a', leaseUntil: new Date(Number.NaN) })).rejects.toThrow('leaseUntil');
});
