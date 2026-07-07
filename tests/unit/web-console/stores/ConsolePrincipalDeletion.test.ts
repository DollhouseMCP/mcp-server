import { describe, expect, it } from '@jest/globals';

import { deleteConsolePrincipalWithTx } from '../../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { sessionActivityEvents } from '../../../../src/database/schema/index.js';
import type { DrizzleTx } from '../../../../src/database/db-utils.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const DELETED_AT = new Date('2026-07-07T12:00:00.000Z');

// A transaction whose hard `DELETE FROM users` raises a foreign-key violation (23503),
// as an audit-chain RESTRICT reference would, forcing the anonymize-tombstone branch.
function anonymizingTxMock() {
  const deletedTables: unknown[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ for: () => Promise.resolve([{ id: USER_ID }]) }),
        }),
      }),
    }),
    delete: (table: unknown) => {
      deletedTables.push(table);
      return { where: () => Promise.resolve() };
    },
    transaction: () => Promise.reject({ code: '23503' }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([{ authzVersion: 5 }]) }),
      }),
    }),
  };
  return { tx: tx as unknown as DrizzleTx, deletedTables };
}

describe('deleteConsolePrincipalWithTx (anonymize path)', () => {
  it('purges session_activity_events when the account is anonymize-tombstoned', async () => {
    const { tx, deletedTables } = anonymizingTxMock();

    const outcome = await deleteConsolePrincipalWithTx(tx, { userId: USER_ID, deletedAt: DELETED_AT });

    expect(outcome).toMatchObject({ userId: USER_ID, outcome: 'anonymized' });
    // The users row is retained, so ON DELETE CASCADE never fires — the activity purge must be explicit.
    expect(deletedTables).toContain(sessionActivityEvents);
  });
});
