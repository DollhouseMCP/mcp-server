import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { deleteConsolePrincipalWithTx } from '../../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { sessionActivityEvents } from '../../../../src/database/schema/index.js';
import type { DrizzleTx } from '../../../../src/database/db-utils.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const DELETED_AT = new Date('2026-07-07T12:00:00.000Z');

// A transaction whose hard `DELETE FROM users` raises a foreign-key violation (23503),
// as an audit-chain RESTRICT reference would, forcing the anonymize-tombstone branch.
// Every `delete(table).where(predicate)` is captured so the purge scope can be asserted.
function anonymizingTxMock() {
  const deletes: { readonly table: unknown; readonly predicate: unknown }[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ for: () => Promise.resolve([{ id: USER_ID }]) }),
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: (predicate: unknown) => {
        deletes.push({ table, predicate });
        return Promise.resolve();
      },
    }),
    transaction: () => Promise.reject({ code: '23503' }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([{ authzVersion: 5 }]) }),
      }),
    }),
  };
  return { tx: tx as unknown as DrizzleTx, deletes };
}

describe('deleteConsolePrincipalWithTx (anonymize path)', () => {
  it('purges only the deleted user\'s session_activity_events when anonymize-tombstoned', async () => {
    const { tx, deletes } = anonymizingTxMock();

    const outcome = await deleteConsolePrincipalWithTx(tx, { userId: USER_ID, deletedAt: DELETED_AT });

    expect(outcome).toMatchObject({ userId: USER_ID, outcome: 'anonymized' });
    // The users row is retained, so ON DELETE CASCADE never fires — the activity purge must be explicit.
    const activityPurge = deletes.find(entry => entry.table === sessionActivityEvents);
    expect(activityPurge).toBeDefined();
    // ...and it must be scoped to exactly this user, not a blanket delete of everyone's activity.
    expect(activityPurge?.predicate).toEqual(eq(sessionActivityEvents.userId, USER_ID));
  });
});
