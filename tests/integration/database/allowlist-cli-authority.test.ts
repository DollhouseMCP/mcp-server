/**
 * `dollhouse-allowlist` on an install where the console manages the sign-in
 * allowlist, against the real stores on PostgreSQL.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { and, eq, sql } from 'drizzle-orm';

import { createAuthProvider } from '../../../src/auth/AuthProviderFactory.js';
import { findAllowlistEntriesMissingFromAuthority } from '../../../src/auth/embedded-as/allowlistGate.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import {
  chooseActor,
  ConsoleAllowlistCliTarget,
  listConsoleAdmins,
  readEarlierAllowlistWithTx,
  reconcileEarlierAllowlist,
  type AllowlistCliActor,
} from '../../../src/cli/allowlistAuthority.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { authIdentityEvents } from '../../../src/database/schema/auth.js';
import { users } from '../../../src/database/schema/users.js';
import { userAdminRoles } from '../../../src/database/schema/webConsole.js';
import { InMemorySigningKeyStore } from '../../../src/storage/signingKeys/InMemorySigningKeyStore.js';
import { ConsoleAccountAllowlistSignInAuthority } from '../../../src/web-console/services/account-allowlist/ConsoleAccountAllowlistSignInAuthority.js';
import { PostgresConsoleAccountAllowlistStore } from '../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { closeTestDb, getTestAdminDb } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

required('dollhouse-allowlist where the console manages the allowlist', () => {
  // The database is shared with other suites. Every identity here is unique,
  // and the earlier allowlist is narrowed to this suite's own entries, so
  // reconcile can never clear or carry another suite's rows.
  const tag = randomUUID().slice(0, 8);
  const actor: AllowlistCliActor = { userId: randomUUID(), username: `allowlist-cli-admin-${tag}` };
  const earlierIds: string[] = [];

  const db = () => getTestAdminDb();
  const storage = () => new PostgresAuthStorageLayer({ db: db() });
  const authority = () => new ConsoleAccountAllowlistSignInAuthority(new PostgresConsoleAccountAllowlistStore(db()));
  const target = () => new ConsoleAllowlistCliTarget(db(), () => Promise.resolve(actor));
  const ownEarlier = {
    allowlistList: async () => (await storage().allowlistList()).filter(entry => earlierIds.includes(entry.id)),
  };
  // Reconcile reads and locks the earlier list inside its transaction. Here it is narrowed to this suite's rows.
  const readOwnEarlier = async (tx: DrizzleTx) => (await readEarlierAllowlistWithTx(tx)).filter(entry => earlierIds.includes(entry.id));
  const strand = async (kind: 'email' | 'github_username', value: string, note: string | null = null) => {
    // What the command did on such an install before the fix: write the earlier table.
    const entry = await storage().allowlistAdd({ kind, value, note, createdBy: 'cli' });
    earlierIds.push(entry.id);
    return entry;
  };
  const changesFor = async (entryId: string) => db().select().from(authIdentityEvents).where(and(
    eq(authIdentityEvents.type, 'auth.allowlist_changed'),
    sql`${authIdentityEvents.details}->>'entryId' = ${entryId}`,
  ));

  beforeAll(async () => {
    await db().insert(users).values({ id: actor.userId, username: actor.username });
    await db().insert(userAdminRoles).values({ userId: actor.userId, role: 'admin', grantedByUserId: actor.userId });
  });

  afterAll(async () => {
    try {
      for (const id of earlierIds) await storage().allowlistRemove(id);
      for (const entry of await target().list()) {
        if (entry.value.includes(tag)) await target().remove(entry.id);
      }
    } finally {
      await closeTestDb();
    }
  });

  it('finds the console admin to record changes against', async () => {
    const admins = await listConsoleAdmins(db());
    expect(chooseActor(admins, actor.username)).toEqual(actor);
  });

  it('adds to the allowlist sign-in uses, records who and what, and leaves the earlier allowlist alone', async () => {
    const username = `added-${tag}`;
    const entry = await target().add({ kind: 'github_username', value: username, note: 'via the command' });

    expect(entry).toMatchObject({ kind: 'github_username', value: username, note: 'via the command', createdBy: actor.userId });
    expect(await authority().matchesIdentity({ githubUsername: username })).toBe(true);
    expect((await storage().allowlistList()).some(earlier => earlier.value === username)).toBe(false);
    expect((await target().list()).some(listed => listed.id === entry.id)).toBe(true);

    const changes = await changesFor(entry.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sub: actor.username,
      details: { source: 'dollhouse-allowlist', actorUserId: actor.userId, operation: 'add', kind: 'github_username', entryId: entry.id },
    });
    // The audit record says which entry, not who it admits.
    expect(JSON.stringify(changes[0].details)).not.toContain(username);
  });

  it('refuses a second entry for the same identity in the words the command matches on', async () => {
    await expect(target().add({ kind: 'github_username', value: `added-${tag}`, note: null }))
      .rejects.toThrow(/already exists/);
  });

  it('updates a note, then removes the entry so sign-in refuses it, recording both', async () => {
    const username = `removed-${tag}`;
    const entry = await target().add({ kind: 'github_username', value: username, note: null });

    expect(await target().updateNote(entry.id, 'renamed')).toMatchObject({ id: entry.id, note: 'renamed' });
    expect(await target().remove(entry.id)).toBe(true);
    expect(await authority().matchesIdentity({ githubUsername: username })).toBe(false);
    expect(await authority().deniesIdentity({ githubUsername: username })).toBe(true);
    expect(await target().remove(entry.id)).toBe(false);
    expect(await target().updateNote(randomUUID(), 'nobody')).toBeNull();

    expect((await changesFor(entry.id)).map(change => (change.details as { operation: string }).operation).sort())
      .toEqual(['add', 'remove', 'update']);
  });

  it('finds an entry by value with the rules sign-in uses, so removing one never removes its look-alike', async () => {
    // Two different identities to sign-in: the console folds only ASCII case.
    const capital = `\u00dcmlaut-${tag}@example.com`;
    const small = `\u00fcmlaut-${tag}@example.com`;
    const first = await target().add({ kind: 'email', value: capital, note: null });
    const second = await target().add({ kind: 'email', value: small, note: null });

    expect((await target().findByValue('email', capital))?.id).toBe(first.id);
    expect((await target().findByValue('email', small))?.id).toBe(second.id);
    // ASCII letters are still matched whatever their case.
    expect((await target().findByValue('email', capital.replace('example', 'EXAMPLE')))?.id).toBe(first.id);
    expect(await target().findByValue('github_username', capital)).toBeNull();

    // Removing the capital one, as `remove --kind email --value …` does, leaves the other admitted.
    expect(await target().remove((await target().findByValue('email', capital))!.id)).toBe(true);
    expect(await authority().matchesIdentity({ email: capital })).toBe(false);
    expect(await authority().matchesIdentity({ email: small })).toBe(true);
    expect(await target().findByValue('email', capital)).toBeNull();
  });

  describe('reconcile', () => {
    const carried = `Carried-${tag}@Example.com`;
    const removed = `removed-in-console-${tag}`;
    const stranded = `stranded-${tag}`;

    beforeAll(async () => {
      // One entry in both lists, one the console has since removed, one only in the earlier list.
      await target().add({ kind: 'email', value: carried, note: null });
      await strand('email', carried);
      const gone = await target().add({ kind: 'github_username', value: removed, note: null });
      await target().remove(gone.id);
      await strand('github_username', removed);
      await strand('github_username', stranded, 'added before the fix');
    });

    it('reports the three kinds of leftover and changes nothing', async () => {
      const result = await reconcileEarlierAllowlist({
        db: db(), readEarlier: readOwnEarlier, mode: 'report',
        resolveActor: () => Promise.reject(new Error('a report must not need an admin')),
      });

      expect(result).toMatchObject({ mode: 'report', added: 0, cleared: 0 });
      expect(result.carried.map(entry => entry.value)).toEqual([carried.toLowerCase()]);
      expect(result.removedInConsole.map(entry => entry.value)).toEqual([removed]);
      expect(result.uncarried.map(entry => entry.value)).toEqual([stranded]);
      expect(await ownEarlier.allowlistList()).toHaveLength(3);
      expect(await authority().matchesIdentity({ githubUsername: stranded })).toBe(false);
    });

    it('names the stranded entry and the way out when the server would refuse to start', async () => {
      const refusal = createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: ['local-password'],
        storage: storage(),
        signingKeyStore: new InMemorySigningKeyStore(),
        rateLimitStore: new InMemoryRateLimitStore(),
        publicBaseUrl: 'http://127.0.0.1:65530',
        signInAllowlistAuthority: authority(),
      });
      await expect(refusal).rejects.toThrow(/cutover refused/);
      await expect(refusal).rejects.toThrow('dollhouse-allowlist reconcile --carry');
    });

    it('carries the stranded entry over, never re-adds the removed one, and empties the earlier allowlist', async () => {
      const result = await reconcileEarlierAllowlist({
        db: db(), readEarlier: readOwnEarlier, mode: 'carry', resolveActor: () => Promise.resolve(actor),
      });

      expect(result).toMatchObject({ mode: 'carry', added: 1, cleared: 3 });
      expect(await ownEarlier.allowlistList()).toEqual([]);
      expect(await authority().matchesIdentity({ githubUsername: stranded })).toBe(true);
      expect(await authority().matchesIdentity({ email: carried.toLowerCase() })).toBe(true);
      // An admin took this one off in the console. Reconciling must not put it back.
      expect(await authority().matchesIdentity({ githubUsername: removed })).toBe(false);
      expect(await authority().deniesIdentity({ githubUsername: removed })).toBe(true);

      const carriedOver = (await target().list()).find(entry => entry.value === stranded);
      expect(carriedOver).toMatchObject({ note: 'added before the fix', createdBy: actor.userId });
      expect((await changesFor(carriedOver!.id))[0].details).toMatchObject({ operation: 'carry_over' });
      // With the earlier allowlist empty there is nothing left for start-up to refuse.
      expect(findAllowlistEntriesMissingFromAuthority(await ownEarlier.allowlistList(), await authority().listEntries())).toEqual([]);
    });

    it('does not call an entry redundant unless sign-in really admits that identity', async () => {
      // The two allowlists fold case differently outside ASCII. The earlier one
      // stores this address all in lower case; the console keeps the capital.
      // Comparing stored values would call them the same entry. Sign-in does not.
      const consoleAddress = `\u00dcser-${tag}@example.com`;
      const earlierAddress = `\u00fcser-${tag}@example.com`;
      await target().add({ kind: 'email', value: consoleAddress, note: null });
      await strand('email', earlierAddress);
      expect(await authority().matchesIdentity({ email: earlierAddress })).toBe(false);

      const report = await reconcileEarlierAllowlist({
        db: db(), readEarlier: readOwnEarlier, mode: 'report', resolveActor: () => Promise.resolve(actor),
      });
      expect(report.uncarried.map(entry => entry.value)).toEqual([earlierAddress]);
      expect(report.carried).toEqual([]);

      const result = await reconcileEarlierAllowlist({
        db: db(), readEarlier: readOwnEarlier, mode: 'carry', resolveActor: () => Promise.resolve(actor),
      });
      expect(result).toMatchObject({ added: 1, cleared: 1 });
      // Clearing the earlier entry lost nothing: sign-in now admits the identity it named.
      expect(await authority().matchesIdentity({ email: earlierAddress })).toBe(true);
      expect(await ownEarlier.allowlistList()).toEqual([]);
    });

    it('discards without adding anything', async () => {
      const dropped = `discarded-${tag}`;
      await strand('github_username', dropped);

      const result = await reconcileEarlierAllowlist({
        db: db(), readEarlier: readOwnEarlier, mode: 'discard', resolveActor: () => Promise.resolve(actor),
      });

      expect(result).toMatchObject({ mode: 'discard', added: 0, cleared: 1 });
      expect(result.uncarried.map(entry => entry.value)).toEqual([dropped]);
      expect(await ownEarlier.allowlistList()).toEqual([]);
      expect(await authority().matchesIdentity({ githubUsername: dropped })).toBe(false);
    });

    it('does nothing, and needs no admin, when the earlier allowlist is already empty', async () => {
      const result = await reconcileEarlierAllowlist({
        db: db(), readEarlier: readOwnEarlier, mode: 'carry',
        resolveActor: () => Promise.reject(new Error('nothing to change, so no admin is needed')),
      });
      expect(result).toMatchObject({ added: 0, cleared: 0, carried: [], removedInConsole: [], uncarried: [] });
    });
  });
});
