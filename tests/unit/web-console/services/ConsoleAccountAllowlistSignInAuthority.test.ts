import { describe, expect, it } from '@jest/globals';

import { ConsoleAccountAllowlistSignInAuthority } from '../../../../src/web-console/services/account-allowlist/ConsoleAccountAllowlistSignInAuthority.js';
import { InMemoryConsoleAccountAllowlistStore } from '../../../../src/web-console/stores/InMemoryConsoleAccountAllowlistStore.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('ConsoleAccountAllowlistSignInAuthority', () => {
  it('uses active console account allowlist entries as the sign-in authority', async () => {
    const store = new InMemoryConsoleAccountAllowlistStore();
    const authority = new ConsoleAccountAllowlistSignInAuthority(store);

    await expect(authority.hasAnyEntries()).resolves.toBe(false);
    await expect(authority.listEntries()).resolves.toEqual([]);
    await expect(authority.matchesIdentity({ email: 'alice@example.test' })).resolves.toBe(false);

    await store.add({
      kind: 'email',
      value: 'Alice@Example.Test',
      createdByUserId: USER_ID,
      createdAt: new Date('2026-05-30T00:00:00.000Z'),
    });

    await expect(authority.hasAnyEntries()).resolves.toBe(true);
    await expect(authority.listEntries()).resolves.toHaveLength(1);
    await expect(authority.matchesIdentity({ email: 'alice@example.test' })).resolves.toBe(true);
  });
});
