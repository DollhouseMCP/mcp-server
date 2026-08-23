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
    await expect(authority.deniesIdentity?.({ email: 'alice@example.test' })).resolves.toBe(false);

    await store.add({
      kind: 'email',
      value: 'Alice@Example.Test',
      createdByUserId: USER_ID,
      createdAt: new Date('2026-05-30T00:00:00.000Z'),
    });

    await expect(authority.hasAnyEntries()).resolves.toBe(true);
    await expect(authority.listEntries()).resolves.toHaveLength(1);
    await expect(authority.matchesIdentity({ email: 'alice@example.test' })).resolves.toBe(true);

    const [entry] = await store.listActive();
    await store.remove({
      id: entry.id,
      revokedByUserId: USER_ID,
      revokedAt: new Date('2026-05-30T01:00:00.000Z'),
    });
    await expect(authority.matchesIdentity({ email: 'alice@example.test' })).resolves.toBe(false);
    await expect(authority.deniesIdentity?.({ email: 'alice@example.test' })).resolves.toBe(true);

    await store.add({
      kind: 'email',
      value: 'Alice@Example.Test',
      createdByUserId: USER_ID,
      createdAt: new Date('2026-05-30T02:00:00.000Z'),
    });
    await expect(authority.matchesIdentity({ email: 'alice@example.test' })).resolves.toBe(true);
    await expect(authority.deniesIdentity?.({ email: 'alice@example.test' })).resolves.toBe(false);
  });

  it('requires an active alias to be newer than a stable-identity tombstone', async () => {
    const store = new InMemoryConsoleAccountAllowlistStore([
      {
        id: '11111111-1111-4111-8111-111111111112',
        kind: 'github_username',
        normalizedValue: 'new-alias',
        displayValue: 'new-alias',
        note: null,
        createdByUserId: USER_ID,
        createdAt: new Date('2026-05-30T00:00:00.000Z'),
        revokedByUserId: null,
        revokedAt: null,
      },
      {
        id: '11111111-1111-4111-8111-111111111113',
        kind: 'github_id',
        normalizedValue: '42',
        displayValue: '42',
        note: 'Deny tombstone created by account deletion',
        createdByUserId: USER_ID,
        createdAt: new Date('2026-05-30T01:00:00.000Z'),
        revokedByUserId: USER_ID,
        revokedAt: new Date('2026-05-30T01:00:00.000Z'),
      },
    ]);
    const authority = new ConsoleAccountAllowlistSignInAuthority(store);
    const identity = { githubUsername: 'new-alias', githubId: '42' };

    await expect(authority.matchesIdentity(identity)).resolves.toBe(true);
    await expect(authority.deniesIdentity?.(identity)).resolves.toBe(true);

    await store.add({
      kind: 'email',
      value: 'alice@example.test',
      createdByUserId: USER_ID,
      createdAt: new Date('2026-05-30T02:00:00.000Z'),
    });
    await expect(authority.deniesIdentity?.({
      ...identity,
      email: 'alice@example.test',
    })).resolves.toBe(false);
  });
});
