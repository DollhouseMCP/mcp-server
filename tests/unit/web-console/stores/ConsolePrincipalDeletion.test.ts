import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { deleteConsolePrincipalWithTx } from '../../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import {
  portfolioSyncJobs,
  sessionActivityEvents,
  userIntegrations,
  userOauthTokens,
} from '../../../../src/database/schema/index.js';
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
  it('purges the deleted user\'s activity and credential data, scoped to that user, when anonymize-tombstoned', async () => {
    const { tx, deletes } = anonymizingTxMock();

    const outcome = await deleteConsolePrincipalWithTx(tx, { userId: USER_ID, deletedAt: DELETED_AT });

    expect(outcome).toMatchObject({ userId: USER_ID, outcome: 'anonymized' });
    // The users row is retained, so ON DELETE CASCADE never fires — these purges must be explicit,
    // and each must be scoped to exactly this user (not a blanket delete of everyone's rows).
    // user_integrations / user_oauth_tokens hold OAuth token ciphertext; portfolio_sync_jobs must
    // precede user_integrations because it RESTRICT-references it.
    for (const table of [sessionActivityEvents, portfolioSyncJobs, userIntegrations, userOauthTokens]) {
      const purge = deletes.find(entry => entry.table === table);
      expect(purge).toBeDefined();
      expect(purge?.predicate).toEqual(eq(table.userId, USER_ID));
    }

    // Sync jobs must be deleted before the integrations they RESTRICT-reference.
    const order = (table: unknown) => deletes.findIndex(entry => entry.table === table);
    expect(order(portfolioSyncJobs)).toBeLessThan(order(userIntegrations));
  });
});
