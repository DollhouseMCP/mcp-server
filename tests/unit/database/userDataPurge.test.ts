import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  collectDeletionIdentity,
  purgeNonCascadeUserIdentity,
  purgeUserScopedData,
} from '../../../src/database/userDataPurge.js';
import {
  approvalAuditEvents,
  accountAllowlistEntries,
  authAllowlist,
  authIdentityEvents,
  authKv,
  consoleLoginTransactions,
  consoleSessions,
  elements,
  integrationProviderDescriptors,
  portfolioSyncJobs,
  runtimeSessionPresence,
  securityInvalidationEvents,
  sessionActivationEvents,
  sessionActivityEvents,
  sessions,
  userIntegrations,
  userOauthTokens,
  userSettings,
} from '../../../src/database/schema/index.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const ADMIN_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb2';
const DELETED_AT = new Date('2026-08-19T12:00:00.000Z');

function captureTx(
  grantRows: readonly { id: string }[] = [],
  accountAllowlistRows: readonly { kind: string; normalizedValue: string }[] = [],
) {
  const deletes: { readonly table: unknown; readonly predicate: unknown }[] = [];
  const updates: { readonly table: unknown; readonly values: unknown; readonly predicate: unknown }[] = [];
  const inserts: { readonly table: unknown; readonly values: unknown }[] = [];
  const executes: unknown[] = [];
  const tx = {
    execute: (statement: unknown) => {
      executes.push(statement);
      return Promise.resolve([]);
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(
          table === accountAllowlistEntries ? accountAllowlistRows : grantRows,
        ),
      }),
    }),
    delete: (table: unknown) => ({
      where: (predicate: unknown) => {
        deletes.push({ table, predicate });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: (predicate: unknown) => {
          updates.push({ table, values, predicate });
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserts.push({ table, values });
        return Promise.resolve();
      },
    }),
  };
  return { tx: tx as unknown as DrizzleTx, deletes, updates, inserts, executes };
}

describe('collectDeletionIdentity', () => {
  it('gathers deduped, lowercased identity values from the account and its logins', () => {
    const identity = collectDeletionIdentity('User@Example.com', [
      { sub: 'sub-1', provider: 'github', externalSub: '42', email: 'GH@x.com', rawProfile: { login: 'OctoCat' } },
      { sub: 'sub-2', provider: 'google', externalSub: 'g-1', email: null, rawProfile: null },
    ]);

    expect(identity.subs).toEqual(['sub-1', 'sub-2']);
    expect([...identity.emails].sort((a, b) => a.localeCompare(b))).toEqual(['gh@x.com', 'user@example.com']);
    expect(identity.githubIds).toEqual(['42']);
    expect(identity.githubLogins).toEqual(['octocat']);
  });

  it('handles an account with no email or github login', () => {
    const identity = collectDeletionIdentity(null, [
      { sub: 's', provider: 'local', externalSub: 'x', email: null, rawProfile: null },
    ]);
    expect(identity).toEqual({ subs: ['s'], emails: [], githubIds: [], githubLogins: [] });
  });

  it('reads the projected GitHub username persisted under rawProfile.user', () => {
    const identity = collectDeletionIdentity(null, [{
      sub: 'github_42',
      provider: 'github',
      externalSub: '42',
      email: null,
      rawProfile: { user: { id: 42, login: 'Insomnolence', name: 'Todd' } },
    }]);

    expect(identity.githubLogins).toEqual(['insomnolence']);
  });

  it('uses allowlist canonicalization for deletion identities', () => {
    const identity = collectDeletionIdentity(' Cafe\u0301@Example.com ', [
      {
        sub: 'sub-1',
        provider: 'github',
        externalSub: ' 184286 ',
        email: 'CAF\u00c9@EXAMPLE.COM',
        rawProfile: { login: ' Octo\u0301Cat ' },
      },
    ]);

    expect(identity.emails).toEqual([
      'caf\u00e9@example.com',
      ' cafe\u0301@example.com ',
    ]);
    expect(identity.githubIds).toEqual(['184286', ' 184286 ']);
    expect(identity.githubLogins).toEqual([
      'oct\u00f3cat',
      ' octo\u0301cat ',
    ]);
  });

  it('retains a legacy NFD spelling so deletion removes pre-canonicalization rows', () => {
    const identity = collectDeletionIdentity('cafe\u0301@example.com', []);

    expect(identity.emails).toEqual([
      'caf\u00e9@example.com',
      'cafe\u0301@example.com',
    ]);
  });
});

describe('purgeUserScopedData', () => {
  it('purges the whole user-owned cascade closure, scoped to the user, sync-jobs before integrations', async () => {
    const { tx, deletes } = captureTx();

    await purgeUserScopedData(tx, USER_ID);

    const tables = deletes.map(d => d.table);
    for (const table of [
      sessionActivityEvents, portfolioSyncJobs, userIntegrations, userOauthTokens,
      integrationProviderDescriptors, securityInvalidationEvents, runtimeSessionPresence,
      sessionActivationEvents, approvalAuditEvents, consoleLoginTransactions, consoleSessions,
      sessions, userSettings, elements,
    ]) {
      expect(tables).toContain(table);
    }
    // Scope: each purge targets exactly this user.
    expect(deletes.find(d => d.table === elements)?.predicate).toEqual(eq(elements.userId, USER_ID));
    expect(deletes.find(d => d.table === integrationProviderDescriptors)?.predicate)
      .toEqual(eq(integrationProviderDescriptors.ownerUserId, USER_ID));
    // Ordering: RESTRICT dependency.
    expect(tables.indexOf(portfolioSyncJobs)).toBeLessThan(tables.indexOf(userIntegrations));
  });
});

describe('purgeNonCascadeUserIdentity', () => {
  it('purges auth_kv per subject, identity events by sub, and allowlist by matched identity', async () => {
    const { tx, deletes, updates, inserts, executes } = captureTx();

    await purgeNonCascadeUserIdentity(tx, {
      subs: ['sub-1', 'sub-2'],
      emails: ['a@b.com'],
      githubIds: ['42'],
      githubLogins: ['octo'],
    }, ADMIN_ID, DELETED_AT);

    // Each subject clears a matching bootstrap claim and its account-linked K/V rows.
    expect(deletes.filter(d => d.table === authKv)).toHaveLength(4);
    expect(deletes.filter(d => d.table === authIdentityEvents)).toHaveLength(1);
    expect(deletes.filter(d => d.table === authAllowlist)).toHaveLength(1);
    expect(updates).toEqual([
      expect.objectContaining({
        table: accountAllowlistEntries,
        values: { revokedByUserId: ADMIN_ID, revokedAt: DELETED_AT },
      }),
    ]);
    expect(inserts).toEqual([{
      table: accountAllowlistEntries,
      values: expect.arrayContaining([
        expect.objectContaining({ kind: 'email', normalizedValue: 'a@b.com', revokedAt: DELETED_AT }),
        expect.objectContaining({ kind: 'github_id', normalizedValue: '42', revokedAt: DELETED_AT }),
        expect.objectContaining({ kind: 'github_username', normalizedValue: 'octo', revokedAt: DELETED_AT }),
      ]),
    }]);
    expect(executes).toHaveLength(2);
  });

  it('does not duplicate a canonical deny tombstone that already exists', async () => {
    const { tx, inserts } = captureTx([], [{ kind: 'email', normalizedValue: 'a@b.com' }]);

    await purgeNonCascadeUserIdentity(tx, {
      subs: ['sub-1'],
      emails: ['a@b.com'],
      githubIds: [],
      githubLogins: [],
    }, ADMIN_ID, DELETED_AT);

    expect(inserts).toHaveLength(0);
  });

  it('also purges auth_kv rows linked to the account\'s grants by grantId', async () => {
    const { tx, deletes } = captureTx([{ id: 'grant-1' }, { id: 'grant-2' }]);

    await purgeNonCascadeUserIdentity(
      tx,
      { subs: ['sub-1'], emails: [], githubIds: [], githubLogins: [] },
      ADMIN_ID,
      DELETED_AT,
    );

    // one subject → bootstrap claim + two grant-linked deletes + one accountId delete.
    expect(deletes.filter(d => d.table === authKv)).toHaveLength(4);
  });

  it('deletes nothing when the account has no resolvable identity', async () => {
    const { tx, deletes, updates, inserts, executes } = captureTx();
    await purgeNonCascadeUserIdentity(
      tx,
      { subs: [], emails: [], githubIds: [], githubLogins: [] },
      ADMIN_ID,
      DELETED_AT,
    );
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(executes).toHaveLength(0);
  });
});
