/**
 * The allowlist parity probe against the real stores on PostgreSQL: the
 * earlier `auth_allowlist` table and the console's allowlist, read through
 * the same authority sign-in uses.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { createAuthProvider } from '../../../src/auth/AuthProviderFactory.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import { users } from '../../../src/database/schema/users.js';
import { InMemorySigningKeyStore } from '../../../src/storage/signingKeys/InMemorySigningKeyStore.js';
import { ConsoleAccountAllowlistSignInAuthority } from '../../../src/web-console/services/account-allowlist/ConsoleAccountAllowlistSignInAuthority.js';
import { probeAllowlistParity } from '../../../src/web-console/setup/AllowlistParityProbe.js';
import { PostgresConsoleAccountAllowlistStore } from '../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { closeTestDb, getTestAdminDb } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

required('probeAllowlistParity on PostgreSQL', () => {
  // The database is shared with other suites, so every identity here is unique
  // and the earlier list is narrowed to this suite's own entries.
  const tag = randomUUID().slice(0, 8);
  const email = `Parity-${tag}@Example.com`;
  const username = `parity-${tag}`;
  const adminId = randomUUID();
  const earlierIds: string[] = [];
  const consoleIds: string[] = [];

  const storage = () => new PostgresAuthStorageLayer({ db: getTestAdminDb() });
  const store = () => new PostgresConsoleAccountAllowlistStore(getTestAdminDb());
  const authority = () => new ConsoleAccountAllowlistSignInAuthority(store());
  const probe = () => probeAllowlistParity({
    listEarlier: async () => (await storage().allowlistList()).filter(entry => earlierIds.includes(entry.id)),
    listAuthority: () => authority().listEntries(),
  });
  const addEarlier = async (kind: 'email' | 'github_username', value: string) => {
    // The call `dollhouse-allowlist add` makes.
    earlierIds.push((await storage().allowlistAdd({ kind, value, note: null, createdBy: 'cli' })).id);
  };
  const addInConsole = async (kind: 'email' | 'github_username', value: string) => {
    const entry = await store().add({ kind, value, createdByUserId: adminId, createdAt: new Date() });
    consoleIds.push(entry.id);
    return entry;
  };

  beforeAll(async () => {
    await getTestAdminDb().insert(users).values({ id: adminId, username: `parity-admin-${tag}` });
  });

  afterAll(async () => {
    // Leave no earlier entry behind: one without a console counterpart would
    // stop any server started on this database.
    try {
      for (const id of earlierIds) await storage().allowlistRemove(id);
      for (const id of consoleIds) {
        await store().remove({ id, revokedByUserId: adminId, revokedAt: new Date() });
      }
    } finally {
      await closeTestDb();
    }
  });

  it('passes when an entry is in both lists, whatever its letter case', async () => {
    await addInConsole('email', email);
    await addEarlier('email', email.toUpperCase());
    expect(await probe()).toMatchObject({
      state: 'passed', code: 'allowlists_agree',
      detail: 'All 1 entries in the earlier sign-in allowlist are in the allowlist sign-in uses.',
    });
  });

  it('fails for an entry added with the allowlist command, which sign-in does not honour', async () => {
    await addEarlier('github_username', username);

    expect(await authority().matchesIdentity({ githubUsername: username })).toBe(false);
    expect(await probe()).toMatchObject({
      state: 'failed', code: 'allowlist_entries_not_carried_over',
      detail: expect.stringContaining('1 of 2 entries in the earlier sign-in allowlist are not in the allowlist sign-in uses (1 by GitHub username).'),
    });
  });

  it('reports the same gap that stops the authorization server from starting', async () => {
    await expect(createAuthProvider({
      enabled: true,
      provider: 'embedded',
      methods: ['local-password'],
      storage: storage(),
      signingKeyStore: new InMemorySigningKeyStore(),
      rateLimitStore: new InMemoryRateLimitStore(),
      publicBaseUrl: 'http://127.0.0.1:65530',
      signInAllowlistAuthority: authority(),
    })).rejects.toThrow(/cutover refused/);
  });

  it('passes again once the entry is added in the console, and sign-in honours it', async () => {
    const entry = await addInConsole('github_username', username);

    expect(await authority().matchesIdentity({ githubUsername: username })).toBe(true);
    expect(await probe()).toMatchObject({ state: 'passed' });

    // Removing it in the console leaves the earlier entry without a counterpart again.
    await store().remove({ id: entry.id, revokedByUserId: adminId, revokedAt: new Date() });
    consoleIds.splice(consoleIds.indexOf(entry.id), 1);
    expect(await probe()).toMatchObject({ state: 'failed', code: 'allowlist_entries_not_carried_over' });
  });
});
