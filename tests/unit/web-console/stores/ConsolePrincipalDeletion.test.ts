import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { deleteConsolePrincipalWithTx } from '../../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import {
  accountAllowlistEntries,
  authKv,
  elements,
  portfolioSyncJobs,
  userIntegrations,
  users,
} from '../../../../src/database/schema/index.js';
import type { DrizzleTx } from '../../../../src/database/db-utils.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const ADMIN_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb2';
const DELETED_AT = new Date('2026-07-07T12:00:00.000Z');
const ACCOUNTS = [
  { sub: 'sub-1', provider: 'github', externalSub: '42', email: 'a@b.com', rawProfile: { login: 'octo' } },
];

interface SelectNode {
  where(): SelectNode;
  limit(): SelectNode;
  for(): Promise<unknown>;
  then(resolve: (value: unknown) => void, reject: (error: unknown) => void): Promise<unknown>;
}

// A tx where the hard `DELETE FROM users` raises a 23503 FK violation unless hardDelete is set,
// forcing the anonymize-tombstone branch. Both selects (users, auth_accounts) are served.
function txMock({ hardDelete = false, transactionError }: { hardDelete?: boolean; transactionError?: unknown } = {}) {
  const deletes: { readonly table: unknown; readonly predicate: unknown }[] = [];
  const inserts: { readonly table: unknown; readonly values: unknown }[] = [];
  const from = (table: unknown): SelectNode => {
    const rows = table === users
      ? [{ id: USER_ID, email: 'a@b.com' }]
      : table === accountAllowlistEntries ? [] : ACCOUNTS;
    const node: SelectNode = {
      where: () => node,
      limit: () => node,
      for: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return node;
  };
  const tx = {
    execute: () => Promise.resolve([]),
    select: () => ({ from }),
    delete: (table: unknown) => ({
      where: (predicate: unknown) => {
        deletes.push({ table, predicate });
        return Promise.resolve();
      },
    }),
    transaction: () => {
      if (hardDelete) return Promise.resolve();
      return Promise.reject(transactionError ?? { code: '23503' });
    },
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ authzVersion: 5 }]) }) }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserts.push({ table, values });
        return {
          onConflictDoUpdate: () => Promise.resolve(),
          then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
            Promise.resolve().then(resolve, reject),
        };
      },
    }),
  };
  return { tx: tx as unknown as DrizzleTx, deletes, inserts };
}

describe('deleteConsolePrincipalWithTx', () => {
  it('anonymize-tombstones and erases the account content + non-FK identity, scoped to the user', async () => {
    const { tx, deletes, inserts } = txMock();
    const deletionTransactionStartedAt = Date.now();

    const outcome = await deleteConsolePrincipalWithTx(tx, {
      userId: USER_ID,
      deletedByUserId: ADMIN_ID,
      deletedAt: DELETED_AT,
    });

    expect(outcome).toMatchObject({ userId: USER_ID, outcome: 'anonymized' });
    const tables = deletes.map(d => d.table);
    // Cascade-closure content is purged (via purgeUserScopedData), scoped to this user...
    expect(tables).toContain(elements);
    expect(deletes.find(d => d.table === elements)?.predicate).toEqual(eq(elements.userId, USER_ID));
    expect(tables.indexOf(portfolioSyncJobs)).toBeLessThan(tables.indexOf(userIntegrations));
    // ...and the non-FK identity/credential tables are purged too (via purgeNonCascadeUserIdentity).
    expect(tables).toContain(authKv);
    const allowlistInsert = inserts.find(insert => insert.table === accountAllowlistEntries);
    expect(allowlistInsert).toBeDefined();
    const tombstones = allowlistInsert?.values as Array<{ revokedAt: Date }>;
    expect(tombstones[0]?.revokedAt.getTime()).toBeGreaterThanOrEqual(deletionTransactionStartedAt);
    expect(tombstones[0]?.revokedAt).not.toEqual(DELETED_AT);
  });

  it('hard-deletes (users row removed) when nothing RESTRICT-references the user', async () => {
    const { tx } = txMock({ hardDelete: true });

    const outcome = await deleteConsolePrincipalWithTx(tx, {
      userId: USER_ID,
      deletedByUserId: ADMIN_ID,
      deletedAt: DELETED_AT,
    });

    expect(outcome).toMatchObject({ userId: USER_ID, outcome: 'deleted' });
  });

  it('propagates a non-FK error from the hard-delete attempt (the whole tx then rolls back)', async () => {
    const { tx } = txMock({ transactionError: { code: '40001' } }); // serialization failure, not 23503

    await expect(deleteConsolePrincipalWithTx(tx, {
      userId: USER_ID,
      deletedByUserId: ADMIN_ID,
      deletedAt: DELETED_AT,
    }))
      .rejects.toMatchObject({ code: '40001' });
  });
});
