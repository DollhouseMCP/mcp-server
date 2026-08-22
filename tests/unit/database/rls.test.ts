import { describe, expect, it, jest } from '@jest/globals';

import { InactiveUserContextError, withUserContext, withUserRead } from '../../../src/database/rls.js';
import type { DatabaseInstance } from '../../../src/database/connection.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';

function databaseWithPrincipal(rows: readonly { id: string }[]) {
  const limit = jest.fn(() => Promise.resolve(rows));
  const tx = {
    execute: jest.fn(() => Promise.resolve([])),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit })),
      })),
    })),
  };
  const db = {
    transaction: jest.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
  } as unknown as DatabaseInstance;
  return { db, tx };
}

describe('database user context principal fencing', () => {
  it('holds an active principal lock for user-scoped mutations', async () => {
    const { db, tx } = databaseWithPrincipal([{ id: USER_ID }]);
    const operation = jest.fn(() => Promise.resolve('written'));

    await expect(withUserContext(db, USER_ID, operation)).resolves.toBe('written');
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('fails closed before reads or writes for an inactive principal', async () => {
    const writeFixture = databaseWithPrincipal([]);
    const readFixture = databaseWithPrincipal([]);
    const write = jest.fn(() => Promise.resolve());
    const read = jest.fn(() => Promise.resolve());

    await expect(withUserContext(writeFixture.db, USER_ID, write)).rejects.toBeInstanceOf(InactiveUserContextError);
    await expect(withUserRead(readFixture.db, USER_ID, read)).rejects.toBeInstanceOf(InactiveUserContextError);
    expect(write).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
