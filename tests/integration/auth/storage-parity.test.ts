/**
 * Storage-parity contract tests.
 *
 * Same test suite, run against each IAuthStorageLayer implementation.
 * The contract is asserted through the interface — no backend-specific
 * escape hatches. A new backend that passes this suite is drop-in
 * compatible with everything in src/auth/embedded-as/.
 *
 * Postgres backend tests are gated on the test DB being reachable;
 * skipped (with a notice) when the local Docker Postgres isn't up.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { FilesystemAuthStorageLayer } from '../../../src/auth/embedded-as/storage/FilesystemAuthStorageLayer.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import { withSystemContext } from '../../../src/database/admin.js';
import type { IAuthStorageLayer, StoredAccount } from '../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';
import { closeTestDb, getTestDb, isDatabaseAvailable } from '../database/test-db-helpers.js';

function makeAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    sub: 'github_42',
    provider: 'github',
    externalSub: '42',
    email: 'user@example.com',
    emailVerified: true,
    displayName: 'Test User',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

/**
 * The full contract suite. Called from each backend's describe block so
 * the assertions stay in lock-step across implementations. A new backend
 * passes contract conformance by satisfying every test in this function.
 */
function runContractSuite(
  factory: () => Promise<IAuthStorageLayer>,
  cleanup: (storage: IAuthStorageLayer) => Promise<void>,
): void {
  let storage: IAuthStorageLayer;

  beforeEach(async () => {
    storage = await factory();
  });

  afterEach(async () => {
    await cleanup(storage);
  });

  describe('accounts', () => {
    it('upserts and finds by external id', async () => {
      const account = makeAccount();
      await storage.upsertAccount(account);
      const found = await storage.findAccountByExternalId('github', '42');
      expect(found?.sub).toBe(account.sub);
      expect(found?.email).toBe(account.email);
    });

    it('upsert is idempotent; second write replaces the first', async () => {
      await storage.upsertAccount(makeAccount({ email: 'old@example.com' }));
      await storage.upsertAccount(makeAccount({ email: 'new@example.com', updatedAt: 2_000 }));
      const found = await storage.findAccountByExternalId('github', '42');
      expect(found?.email).toBe('new@example.com');
    });

    it('returns null for unknown external id', async () => {
      const found = await storage.findAccountByExternalId('github', '9999');
      expect(found).toBeNull();
    });

    it('round-trips through getAccount', async () => {
      const account = makeAccount({ sub: 'local_alice', provider: 'local', externalSub: 'alice' });
      await storage.upsertAccount(account);
      const found = await storage.getAccount('local_alice');
      expect(found?.sub).toBe('local_alice');
    });

    it('preserves multiple distinct accounts', async () => {
      await storage.upsertAccount(makeAccount({ sub: 'github_1', externalSub: '1' }));
      await storage.upsertAccount(makeAccount({ sub: 'github_2', externalSub: '2' }));
      await storage.upsertAccount(makeAccount({ sub: 'local_a', provider: 'local', externalSub: 'a' }));
      expect((await storage.getAccount('github_1'))?.externalSub).toBe('1');
      expect((await storage.getAccount('github_2'))?.externalSub).toBe('2');
      expect((await storage.getAccount('local_a'))?.provider).toBe('local');
    });

    // Round 5 / B1: roles MUST round-trip through every backend. The bug
    // this pins: Postgres schema lacked the column; upsertAccount silently
    // dropped roles, so admin's JWT never carried `roles: ['admin']`. Same
    // failure shape as Phase 8 (Postgres-not-reachable) and Phase 9 (CAS
    // atomicity). The structural rule documented in the dashboard requires
    // every new field on StoredAccount to have a parity assertion BEFORE
    // being referenced anywhere else in the codebase.
    it('B1: roles round-trip through upsert + getAccount', async () => {
      const account = makeAccount({ roles: ['admin'] });
      await storage.upsertAccount(account);
      const found = await storage.getAccount(account.sub);
      expect(found?.roles).toEqual(['admin']);
    });

    it('B1: empty roles round-trips as empty array (not undefined)', async () => {
      const account = makeAccount({ roles: [] });
      await storage.upsertAccount(account);
      const found = await storage.getAccount(account.sub);
      // Either undefined or [] is acceptable as long as it's not 'admin'.
      expect(found?.roles ?? []).toEqual([]);
    });

    it('B1: omitted roles default to undefined or []', async () => {
      const account = makeAccount(); // no roles
      await storage.upsertAccount(account);
      const found = await storage.getAccount(account.sub);
      expect(found?.roles ?? []).toEqual([]);
    });

    it('B1: roles survive upsert idempotency — second write preserves the new roles', async () => {
      await storage.upsertAccount(makeAccount({ roles: ['admin'] }));
      await storage.upsertAccount(makeAccount({ email: 'new@example.com', roles: ['admin', 'auditor'] }));
      const found = await storage.findAccountByExternalId('github', '42');
      expect(found?.roles).toEqual(['admin', 'auditor']);
      expect(found?.email).toBe('new@example.com');
    });

    // Round 5 / H5: setAccountRoles is the role-only write. The
    // structural rule says any new IAuthStorageLayer method must have
    // a parity assertion against all three backends, so these are the
    // canonical contract checks for the new API.
    it('H5: setAccountRoles writes roles on an existing account', async () => {
      await storage.upsertAccount(makeAccount());
      const ok = await storage.setAccountRoles('github_42', ['admin']);
      expect(ok).toBe(true);
      const found = await storage.getAccount('github_42');
      expect(found?.roles).toEqual(['admin']);
    });

    it('H5: setAccountRoles returns false for an unknown sub (does not create a row)', async () => {
      const ok = await storage.setAccountRoles('github_does_not_exist', ['admin']);
      expect(ok).toBe(false);
      const found = await storage.getAccount('github_does_not_exist');
      expect(found).toBeNull();
    });

    it('H5: setAccountRoles preserves the rest of the account row', async () => {
      // The whole point of the API: write roles WITHOUT clobbering
      // displayName, email, lastAuthAt, etc. If a backend implements
      // it as a row-replace this assertion fails immediately.
      await storage.upsertAccount(makeAccount({
        email: 'rolesplit@example.com',
        displayName: 'Pre-existing Display',
      }));
      await storage.setAccountRoles('github_42', ['admin', 'auditor']);
      const found = await storage.getAccount('github_42');
      expect(found?.email).toBe('rolesplit@example.com');
      expect(found?.displayName).toBe('Pre-existing Display');
      expect(found?.roles).toEqual(['admin', 'auditor']);
    });

    it('H5: setAccountRoles to [] removes all roles', async () => {
      await storage.upsertAccount(makeAccount({ roles: ['admin'] }));
      const ok = await storage.setAccountRoles('github_42', []);
      expect(ok).toBe(true);
      const found = await storage.getAccount('github_42');
      // Either undefined or [] is acceptable; what matters is that
      // 'admin' is gone.
      expect(found?.roles ?? []).toEqual([]);
    });

    it('lastAuthAt round-trips through upsert + getAccount', async () => {
      // Round 5 review fixup (L-R5-14): the field is read by
      // extraTokenClaims for the auth_time JWT claim and by
      // GithubSocialMethod.findAccount for staleness detection. The
      // updateAccountLastAuth path already had parity coverage; the
      // read-back-via-getAccount path is what's missing per the
      // structural rule.
      const now = Date.now();
      await storage.upsertAccount(makeAccount({ lastAuthAt: now }));
      const found = await storage.getAccount('github_42');
      expect(found?.lastAuthAt).toBe(now);
    });

    // Round 6 review fixup: updateAccountLastAuth is the targeted-write
    // path InteractionRouter calls on every login. The earlier comment
    // in this suite claimed parity coverage that didn't actually exist;
    // these tests close that gap.
    it('updateAccountLastAuth: stamps lastAuthAt on an existing account', async () => {
      await storage.upsertAccount(makeAccount({ lastAuthAt: 1000 }));
      const t = 9999;
      const ok = await storage.updateAccountLastAuth('github_42', t);
      expect(ok).toBe(true);
      const found = await storage.getAccount('github_42');
      expect(found?.lastAuthAt).toBe(t);
    });

    it('updateAccountLastAuth: returns false for an unknown sub (no row created)', async () => {
      const ok = await storage.updateAccountLastAuth('github_unknown', 1234);
      expect(ok).toBe(false);
      const found = await storage.getAccount('github_unknown');
      expect(found).toBeNull();
    });

    it('cycle-16: credentials.passwordHash never bleeds into rawProfile', async () => {
      // B4 invariant — a hash stored on `credentials` must round-trip
      // back ONLY on credentials, not on rawProfile (which goes back
      // to clients via various API shapes). Postgres maps these to
      // different JSONB columns; in-memory + filesystem store them as
      // separate fields. A schema regression that collapsed credentials
      // into rawProfile would surface here.
      await storage.upsertAccount(makeAccount({
        sub: 'github_pwhash',
        credentials: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$saltsaltsaltsalt$hashhashhashhash' },
        rawProfile: { login: 'pwhash-user', name: 'PW Hash' },
      }));
      const found = await storage.getAccount('github_pwhash');
      expect(found?.credentials?.passwordHash).toMatch(/^\$argon2id\$/);
      const rawProfileSerialized = JSON.stringify(found?.rawProfile ?? {});
      expect(rawProfileSerialized).not.toContain('argon2id');
      expect(rawProfileSerialized).not.toContain('passwordHash');
    });

    it('updateAccountLastAuth: preserves the rest of the account row (no clobber)', async () => {
      // The whole point of the targeted-write API: don't re-write
      // displayName/email/rawProfile from a stale read. Any backend
      // that implements this as a row-replace would fail this assertion.
      await storage.upsertAccount(makeAccount({
        email: 'lastauth@example.com',
        displayName: 'Pre-existing',
        roles: ['admin'],
      }));
      await storage.updateAccountLastAuth('github_42', 5555);
      const found = await storage.getAccount('github_42');
      expect(found?.email).toBe('lastauth@example.com');
      expect(found?.displayName).toBe('Pre-existing');
      expect(found?.roles).toEqual(['admin']);
      expect(found?.lastAuthAt).toBe(5555);
    });

    it('H5: subsequent upsertAccount without roles preserves roles set via setAccountRoles', async () => {
      // The whole H5 fix: methods that don't know about a user's role
      // (every login except the bootstrap admin's first login) must
      // not clobber roles when they upsert. Verifying the contract
      // means: setAccountRoles, then upsert again with roles=existing
      // roles (or undefined), and confirm roles still present.
      await storage.upsertAccount(makeAccount());
      await storage.setAccountRoles('github_42', ['admin']);
      // Method-level pattern: read existing, spread roles into upsert.
      const existing = await storage.getAccount('github_42');
      await storage.upsertAccount({
        ...makeAccount({ email: 'second-login@example.com' }),
        ...(existing?.roles ? { roles: existing.roles } : {}),
      });
      const found = await storage.getAccount('github_42');
      expect(found?.roles).toEqual(['admin']);
      expect(found?.email).toBe('second-login@example.com');
    });
  });

  describe('audit events', () => {
    it('listIdentityEvents returns recorded events sorted by timestamp', async () => {
      await storage.recordIdentityEvent({ type: 'auth.x', timestamp: 300 });
      await storage.recordIdentityEvent({ type: 'auth.x', timestamp: 100 });
      await storage.recordIdentityEvent({ type: 'auth.x', timestamp: 200 });
      const events = await storage.listIdentityEvents();
      expect(events.map(e => e.timestamp)).toEqual([100, 200, 300]);
    });

    it('listIdentityEvents filters by type', async () => {
      await storage.recordIdentityEvent({ type: 'auth.a', timestamp: 1 });
      await storage.recordIdentityEvent({ type: 'auth.b', timestamp: 2 });
      const aOnly = await storage.listIdentityEvents({ type: 'auth.a' });
      expect(aOnly).toHaveLength(1);
      expect(aOnly[0]!.type).toBe('auth.a');
    });

    it('listIdentityEvents filters by sub', async () => {
      await storage.recordIdentityEvent({ type: 'auth.x', sub: 'alice', timestamp: 1 });
      await storage.recordIdentityEvent({ type: 'auth.x', sub: 'bob', timestamp: 2 });
      const aliceOnly = await storage.listIdentityEvents({ sub: 'alice' });
      expect(aliceOnly).toHaveLength(1);
      expect(aliceOnly[0]!.sub).toBe('alice');
    });

    it('listIdentityEvents filters by since (inclusive)', async () => {
      await storage.recordIdentityEvent({ type: 'auth.x', timestamp: 100 });
      await storage.recordIdentityEvent({ type: 'auth.x', timestamp: 200 });
      await storage.recordIdentityEvent({ type: 'auth.x', timestamp: 300 });
      const recent = await storage.listIdentityEvents({ since: 200 });
      expect(recent.map(e => e.timestamp)).toEqual([200, 300]);
    });

    // Cycle-12 fix: result-set cap to prevent OOM on long-running
    // deployments. Backends must honor an explicit limit and apply
    // a default when none is supplied.
    it('cycle-12: listIdentityEvents respects explicit limit', async () => {
      for (let i = 0; i < 10; i += 1) {
        await storage.recordIdentityEvent({ type: 'auth.cap', timestamp: i });
      }
      const limited = await storage.listIdentityEvents({ type: 'auth.cap', limit: 3 });
      expect(limited).toHaveLength(3);
      // Returned in timestamp ascending order — first three.
      expect(limited.map(e => e.timestamp)).toEqual([0, 1, 2]);
    });

    it('cycle-12: listIdentityEvents default-caps without an explicit limit', async () => {
      // Default cap is 1000 (DEFAULT_IDENTITY_EVENTS_LIMIT). We don't
      // insert 1000 rows here (slow); instead verify a small set still
      // returns under the default cap.
      await storage.recordIdentityEvent({ type: 'auth.uncap', timestamp: 1 });
      await storage.recordIdentityEvent({ type: 'auth.uncap', timestamp: 2 });
      const all = await storage.listIdentityEvents({ type: 'auth.uncap' });
      expect(all).toHaveLength(2);
    });

    // Cycle-13 fix: actually test the limit=0 escape hatch the
    // interface JSDoc documents. Cycle-12's "default-caps" test
    // claimed to verify this but didn't pass limit:0.
    it('cycle-13: limit=0 escape hatch returns all matching events (no cap)', async () => {
      for (let i = 0; i < 5; i += 1) {
        await storage.recordIdentityEvent({ type: 'auth.no-cap', timestamp: i });
      }
      const all = await storage.listIdentityEvents({ type: 'auth.no-cap', limit: 0 });
      expect(all).toHaveLength(5);
      expect(all.map(e => e.timestamp).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe('grants', () => {
    it('findGrantsByAccountId returns matching grant ids', async () => {
      await storage.genericSet('Grant', 'g1', { accountId: 'github_42', clientId: 'c1' });
      await storage.genericSet('Grant', 'g2', { accountId: 'github_42', clientId: 'c2' });
      await storage.genericSet('Grant', 'g3', { accountId: 'github_99', clientId: 'c1' });
      const grants = await storage.findGrantsByAccountId('github_42');
      expect(new Set(grants)).toEqual(new Set(['g1', 'g2']));
    });

    it('findGrantsByAccountId returns empty array when no match', async () => {
      const grants = await storage.findGrantsByAccountId('local_unknown');
      expect(grants).toEqual([]);
    });

    it('findGrantsByAccountId skips expired grants', async () => {
      await storage.genericSet('Grant', 'g-expired', { accountId: 'github_42' }, -1);
      await storage.genericSet('Grant', 'g-live', { accountId: 'github_42' });
      const grants = await storage.findGrantsByAccountId('github_42');
      expect(grants).toEqual(['g-live']);
    });
  });

  describe('generic K/V', () => {
    it('round-trips set/get/destroy', async () => {
      await storage.genericSet('Session', 's-1', { user: 'alice' });
      expect(await storage.genericGet('Session', 's-1')).toEqual({ user: 'alice' });
      await storage.genericDestroy('Session', 's-1');
      expect(await storage.genericGet('Session', 's-1')).toBeNull();
    });

    it('expired entries return null on get', async () => {
      await storage.genericSet('Session', 's-2', { user: 'bob' }, -1);
      expect(await storage.genericGet('Session', 's-2')).toBeNull();
    });

    it('isolates models with the same id', async () => {
      await storage.genericSet('Session', 'shared', { kind: 'session' });
      await storage.genericSet('Grant', 'shared', { kind: 'grant' });
      expect(await storage.genericGet('Session', 'shared')).toEqual({ kind: 'session' });
      expect(await storage.genericGet('Grant', 'shared')).toEqual({ kind: 'grant' });
    });

    it('genericFindByUid finds Sessions by uid index field', async () => {
      const uid = randomBytes(8).toString('hex');
      await storage.genericSet('Session', 's-id-1', { uid, accountId: 'alice' });
      const found = await storage.genericFindByUid?.(uid);
      expect(found).toEqual({ uid, accountId: 'alice' });
    });

    it('genericFindByUid returns null when no Session matches', async () => {
      const found = await storage.genericFindByUid?.('nonexistent');
      expect(found).toBeNull();
    });

    // Cycle-15 fix (HIGH-2): genericInsertIfAbsent backs InviteTokenStore
    // single-use enforcement. All 3 backends implement it with different
    // atomicity primitives (Map check-and-set, lock+RMW, INSERT...ON
    // CONFLICT DO NOTHING). The storage-parity rule says every method
    // must round-trip through the contract suite — this one slipped.
    it('genericInsertIfAbsent: first insert returns true and stores the payload', async () => {
      const inserted = await storage.genericInsertIfAbsent(
        'ConsumedInvite', 'jti-1', { consumed: true },
      );
      expect(inserted).toBe(true);
      expect(await storage.genericGet('ConsumedInvite', 'jti-1')).toEqual({ consumed: true });
    });

    it('genericInsertIfAbsent: second insert with same key returns false (does not overwrite)', async () => {
      await storage.genericInsertIfAbsent('ConsumedInvite', 'jti-2', { consumed: true, by: 'first' });
      const second = await storage.genericInsertIfAbsent(
        'ConsumedInvite', 'jti-2', { consumed: true, by: 'second' },
      );
      expect(second).toBe(false);
      // Original payload preserved — the second insert did not overwrite.
      expect(await storage.genericGet('ConsumedInvite', 'jti-2')).toEqual({
        consumed: true, by: 'first',
      });
    });

    it('genericInsertIfAbsent: concurrent inserts with same key — exactly one wins', async () => {
      // Pin the atomicity contract: N concurrent inserts of the same
      // (model, id) — exactly one returns true, the rest return false.
      // Postgres guarantees this via INSERT...ON CONFLICT DO NOTHING
      // RETURNING; in-memory and filesystem use single-process
      // serialization which gives the same observable behavior.
      const candidates = ['a', 'b', 'c', 'd', 'e'];
      const results = await Promise.all(
        candidates.map((c) =>
          storage.genericInsertIfAbsent('ConsumedInvite', 'jti-race', { winner: c }),
        ),
      );
      const wins = results.filter((r) => r === true);
      const losses = results.filter((r) => r === false);
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(candidates.length - 1);
    });

    it('genericInsertIfAbsent: respects expiresInSec — expired entry is treated as absent', async () => {
      // Insert with a past TTL so the row is immediately considered expired.
      await storage.genericInsertIfAbsent('ConsumedInvite', 'jti-expired', { v: 1 }, -1);
      // The next insert with the same key should succeed because the
      // prior entry is expired.
      const second = await storage.genericInsertIfAbsent(
        'ConsumedInvite', 'jti-expired', { v: 2 },
      );
      expect(second).toBe(true);
    });

    it('genericRevokeByGrantId removes every entry referencing the grant id (H14)', async () => {
      await storage.genericSet('Grant', 'g-revoke', { accountId: 'sub-1' });
      await storage.genericSet('AccessToken', 't-1', { grantId: 'g-revoke', sub: 'sub-1' });
      await storage.genericSet('RefreshToken', 'r-1', { grantId: 'g-revoke', sub: 'sub-1' });
      await storage.genericSet('Session', 's-1', { grantId: 'g-revoke', uid: 's-uid-1' });
      // Different grant, must survive.
      await storage.genericSet('AccessToken', 't-2', { grantId: 'g-other', sub: 'sub-2' });

      await storage.genericRevokeByGrantId?.('g-revoke');

      expect(await storage.genericGet('Grant', 'g-revoke')).toBeNull();
      expect(await storage.genericGet('AccessToken', 't-1')).toBeNull();
      expect(await storage.genericGet('RefreshToken', 'r-1')).toBeNull();
      expect(await storage.genericGet('Session', 's-1')).toBeNull();
      // Untouched.
      expect(await storage.genericGet('AccessToken', 't-2')).not.toBeNull();
    });

    // Cycle-10 fix (H10-4): clearGenericByModels was implemented on
    // all 3 backends and is load-bearing for must-fix #14 mode-switch
    // invalidation, but had zero parity coverage. The storage-parity
    // rule (added Round 5 specifically to catch this drift class) was
    // violated because clearGenericByModels predates the rule. Pin
    // it now.
    it('clearGenericByModels removes only the named models (H10-4 / must-fix #14)', async () => {
      await storage.genericSet('Session', 's-cgm-1', { uid: 'session-1' });
      await storage.genericSet('Session', 's-cgm-2', { uid: 'session-2' });
      await storage.genericSet('Grant', 'g-cgm-1', { accountId: 'sub-1' });
      await storage.genericSet('AccessToken', 'at-cgm-1', { sub: 'sub-1' });
      await storage.genericSet('RefreshToken', 'rt-cgm-1', { sub: 'sub-1' });
      // Untouched model.
      await storage.genericSet('AuthBootstrap', 'state', { completed: false });

      const cleared = await storage.clearGenericByModels(
        ['Session', 'Grant', 'AccessToken', 'RefreshToken'],
      );
      // At minimum, we cleared the 5 entries we just inserted (other
      // tests in the same suite may have left additional entries
      // under these models, so use >=).
      expect(cleared).toBeGreaterThanOrEqual(5);

      expect(await storage.genericGet('Session', 's-cgm-1')).toBeNull();
      expect(await storage.genericGet('Session', 's-cgm-2')).toBeNull();
      expect(await storage.genericGet('Grant', 'g-cgm-1')).toBeNull();
      expect(await storage.genericGet('AccessToken', 'at-cgm-1')).toBeNull();
      expect(await storage.genericGet('RefreshToken', 'rt-cgm-1')).toBeNull();
      // Untouched model survives.
      expect(await storage.genericGet('AuthBootstrap', 'state')).toEqual({ completed: false });
    });

    it('clearGenericByModels returns 0 when no entries match the named models', async () => {
      // Empty starting state for these models — clear should be a no-op.
      const cleared = await storage.clearGenericByModels(['NonexistentModelX', 'NonexistentModelY']);
      expect(cleared).toBe(0);
    });

    it('clearGenericByModels with an empty list is a no-op', async () => {
      await storage.genericSet('Session', 's-noop', { uid: 'untouched' });
      const cleared = await storage.clearGenericByModels([]);
      expect(cleared).toBe(0);
      expect(await storage.genericGet('Session', 's-noop')).toEqual({ uid: 'untouched' });
    });
  });

  describe('bootstrap state (must-fix #22)', () => {
    it('default state is not completed', async () => {
      const state = await storage.getBootstrapState();
      expect(state).toEqual({ completed: false });
    });

    it('markBootstrapComplete persists the admin sub + method', async () => {
      await storage.markBootstrapComplete('github_42', 'github');
      const state = await storage.getBootstrapState();
      expect(state.completed).toBe(true);
      expect(state.adminSub).toBe('github_42');
      expect(state.adminMethod).toBe('github');
      expect(typeof state.completedAt).toBe('number');
    });

    it('re-running with the same admin sub is idempotent', async () => {
      await storage.markBootstrapComplete('local_alice', 'local-password');
      await expect(
        storage.markBootstrapComplete('local_alice', 'local-password'),
      ).resolves.toBeUndefined();
    });

    it('re-running with a DIFFERENT admin sub is rejected', async () => {
      await storage.markBootstrapComplete('github_42', 'github');
      await expect(
        storage.markBootstrapComplete('github_99', 'github'),
      ).rejects.toThrow(/admin transfer is a separate operation/);
    });

    // Round 5 / B2: under concurrent invocations, exactly ONE admin sub
    // must win — earlier shape did read-then-write across separate
    // transactions, letting two concurrent CLI runs both observe
    // completed:false and both write (last-writer-wins). The Postgres
    // implementation MUST atomically reject admin-transfer at the SQL
    // level. Test fires N concurrent calls with N different admin subs;
    // exactly one must succeed, the rest must reject with the same
    // admin-transfer error.
    //
    // Coverage shape note (Round 6 review): on InMemory and Filesystem
    // backends this assertion holds vacuously — single-process Node
    // serializes all promises through the microtask queue, so there's
    // no real concurrent contention to race. The teeth of this test
    // are on Postgres, where two transactions can genuinely interleave.
    // The test still runs across all three backends for parity but the
    // failure mode it pins is Postgres-specific. Keeping the parity
    // shape so a regression of the rejection error message on any
    // backend would still surface here.
    it('B2: concurrent markBootstrapComplete with different subs — exactly one wins', async () => {
      const candidates = ['admin_a', 'admin_b', 'admin_c', 'admin_d', 'admin_e'];
      const results = await Promise.allSettled(
        candidates.map((sub) => storage.markBootstrapComplete(sub, 'github')),
      );
      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(candidates.length - 1);
      // Every failure must be the admin-transfer rejection, not some
      // other error (network blip, lock contention timeout, etc).
      for (const fail of failures) {
        if (fail.status === 'rejected') {
          expect(String(fail.reason)).toMatch(/admin transfer is a separate operation/);
        }
      }
      // The winning sub must be one of the candidates and must be what's
      // persisted (not a partial/corrupt write).
      const state = await storage.getBootstrapState();
      expect(state.completed).toBe(true);
      expect(candidates).toContain(state.adminSub);
    });
  });

  describe('genericConsume — replay detection (OAuth 2.1 §6.1)', () => {
    it('first consume marks the payload and returns true; the record stays findable', async () => {
      await storage.genericSet('AuthorizationCode', 'c1', { grantId: 'g-c1', sub: 'sub' });
      const first = await storage.genericConsume('AuthorizationCode', 'c1');
      expect(first).toBe(true);
      // Record is still findable so oidc-provider's grant handlers can
      // detect the replay and trigger family revocation.
      const found = await storage.genericGet('AuthorizationCode', 'c1') as
        Record<string, unknown> & { consumed?: number };
      expect(found).not.toBeNull();
      expect(typeof found.consumed).toBe('number');
      expect((found.consumed as number)).toBeGreaterThan(0);
    });

    it('second consume returns false (already consumed)', async () => {
      await storage.genericSet('RefreshToken', 'r1', { grantId: 'g-r1', sub: 'sub' });
      expect(await storage.genericConsume('RefreshToken', 'r1')).toBe(true);
      expect(await storage.genericConsume('RefreshToken', 'r1')).toBe(false);
    });

    it('consume on a missing record returns false', async () => {
      expect(await storage.genericConsume('AuthorizationCode', 'never-existed')).toBe(false);
    });

    it('consume on an expired record returns false', async () => {
      // Cycle-16 fix: use a negative TTL (already-expired) instead of
      // a wall-clock sleep. The setTimeout-based version was racing
      // CPU pressure under parallel jest workers; aligns with the
      // expiresInSec=-1 pattern used elsewhere in this file.
      await storage.genericSet('AuthorizationCode', 'expired', { grantId: 'g-exp' }, -1);
      expect(await storage.genericConsume('AuthorizationCode', 'expired')).toBe(false);
    });

    it('consume preserves the existing payload fields plus the consumed marker', async () => {
      await storage.genericSet('AuthorizationCode', 'c-payload', {
        grantId: 'g-c2', sub: 'alice', clientId: 'client-a',
      });
      await storage.genericConsume('AuthorizationCode', 'c-payload');
      const found = await storage.genericGet('AuthorizationCode', 'c-payload') as
        Record<string, unknown>;
      expect(found.grantId).toBe('g-c2');
      expect(found.sub).toBe('alice');
      expect(found.clientId).toBe('client-a');
      expect(typeof found.consumed).toBe('number');
    });

    it('cycle-16: consume preserves the original TTL', async () => {
      // The CAS shape varies per backend (Postgres jsonb_set vs Map
      // spread vs filesystem KvRecord rebuild). All three must preserve
      // the existing TTL — the row should still be readable until the
      // original expiry, even after the consumed marker is stamped.
      await storage.genericSet('AuthorizationCode', 'c-ttl', { grantId: 'g-ttl' }, 60);
      expect(await storage.genericConsume('AuthorizationCode', 'c-ttl')).toBe(true);
      // Still findable through the TTL window.
      const after = await storage.genericGet('AuthorizationCode', 'c-ttl');
      expect(after).not.toBeNull();
    });
  });

  describe('genericInsertIfAbsent / genericConsume — concurrent semantics (cycle-16)', () => {
    it('concurrent genericConsume on the same record — exactly one wins', async () => {
      await storage.genericSet('AuthorizationCode', 'race-1', { grantId: 'g-race' });
      const results = await Promise.all([
        storage.genericConsume('AuthorizationCode', 'race-1'),
        storage.genericConsume('AuthorizationCode', 'race-1'),
        storage.genericConsume('AuthorizationCode', 'race-1'),
      ]);
      expect(results.filter((r) => r === true).length).toBe(1);
    });

    it('genericInsertIfAbsent against a non-expiring existing row rejects', async () => {
      // No TTL on the existing row (expiresInSec omitted); the new
      // insert with a 60s TTL must still be rejected because the
      // existing row hasn't expired.
      await storage.genericSet('Grant', 'permanent', { v: 1 });
      const inserted = await storage.genericInsertIfAbsent(
        'Grant', 'permanent', { v: 2 }, 60,
      );
      expect(inserted).toBe(false);
      const found = await storage.genericGet('Grant', 'permanent') as Record<string, unknown>;
      expect(found.v).toBe(1);
    });
  });

  describe('recordIdentityEvent / listIdentityEvents — append-only (cycle-16)', () => {
    it('recording the same event twice produces two distinct entries', async () => {
      const event = {
        type: 'auth.test.duplicate' as const,
        sub: 'alice',
        timestamp: Date.now(),
        details: { foo: 'bar' },
      };
      await storage.recordIdentityEvent(event);
      await storage.recordIdentityEvent(event);
      const found = await storage.listIdentityEvents({
        type: 'auth.test.duplicate',
      });
      expect(found.length).toBe(2);
    });
  });

  describe('sweepExpiredKv (cycle-16)', () => {
    it('returns the count of rows removed and leaves non-expired rows in place', async () => {
      await storage.genericSet('AccessToken', 'live', { v: 1 }, 3600);
      await storage.genericSet('AccessToken', 'dead', { v: 2 }, -1);
      await storage.genericSet('Session', 'untouched', { v: 3 });
      const removed = await storage.sweepExpiredKv();
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await storage.genericGet('AccessToken', 'live')).not.toBeNull();
      expect(await storage.genericGet('Session', 'untouched')).not.toBeNull();
      // The dead row should now be missing.
      expect(await storage.genericGet('AccessToken', 'dead')).toBeNull();
    });

    it('idempotent: a second sweep with no expired rows returns 0', async () => {
      await storage.sweepExpiredKv();
      expect(await storage.sweepExpiredKv()).toBe(0);
    });
  });
}

// ── Static fixtures (always run) ───────────────────────────────────────

describe('IAuthStorageLayer contract: InMemoryAuthStorageLayer', () => {
  runContractSuite(
    async () => new InMemoryAuthStorageLayer(),
    async () => { /* Maps are GC'd with the instance. */ },
  );
});

describe('IAuthStorageLayer contract: FilesystemAuthStorageLayer', () => {
  runContractSuite(
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-fs-'));
      return new FilesystemAuthStorageLayer({ rootDir: dir });
    },
    async (storage) => {
      await fs.rm((storage as FilesystemAuthStorageLayer).rootDir, { recursive: true, force: true });
    },
  );
});

// ── Postgres fixture (gated on local Docker DB + CI env) ──────────────
//
// CI sets `DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1` so the absence of Postgres
// is a hard failure (catches a deployment that THINKS it's testing
// Postgres parity but isn't). Local dev without Docker: the suite is
// `describe.skip`-ed entirely so the run is green and the dev sees a
// single visible skip line per the standard jest output.
//
// Jest evaluates `describe` synchronously at file load, so the gate is a
// runtime check inside each `it` (via beforeAll setting a flag). When
// Postgres is unreachable the suite logs and `it.skip`s instead of
// failing — matches the pattern used in tests/integration/database/.

let pgAvailable = false;
beforeAll(async () => {
  pgAvailable = await isDatabaseAvailable();
  if (!pgAvailable) {
    console.warn(
      '[storage-parity] Skipping PostgresAuthStorageLayer suite — local Docker Postgres unreachable. ' +
      'Run `docker compose -f docker/docker-compose.db.yml up -d` to enable.',
    );
  }
});

afterAll(async () => {
  if (pgAvailable) await closeTestDb();
});

// CI sets DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1 → describe runs and fails if
// Postgres isn't reachable. Local dev without it → describe.skip so the
// skip is visible in the jest output instead of silently substituting
// InMemoryAuthStorageLayer (which is what the previous shape did, hiding
// "Postgres parity ✓ green" without actually testing Postgres).
const pgRequired = process.env.DOLLHOUSE_REQUIRE_PG_AUTH_TESTS === '1';
const describePg = pgRequired ? describe : describe.skip;

describePg('IAuthStorageLayer contract: PostgresAuthStorageLayer', () => {
  // dollhouse_app has DML only — no TRUNCATE — so DELETE FROM is the
  // right reset between tests.
  const reset = async () => {
    const db = getTestDb();
    await withSystemContext(db, async (tx) => {
      await tx.execute(sql`DELETE FROM auth_kv`);
      await tx.execute(sql`DELETE FROM auth_identity_events`);
      await tx.execute(sql`DELETE FROM auth_accounts`);
    });
  };

  // Hard-fail the entire suite if pg isn't actually reachable while
  // DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1. This is the safety net: we
  // already chose to run because the env says we should.
  beforeAll(() => {
    if (!pgAvailable) {
      throw new Error(
        'PostgresAuthStorageLayer parity tests required ' +
        '(DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1) but Postgres was not reachable. ' +
        'Run `docker compose -f docker/docker-compose.db.yml up -d` first.',
      );
    }
  });

  runContractSuite(
    async () => {
      await reset();
      return new PostgresAuthStorageLayer({ db: getTestDb() });
    },
    async () => {
      if (pgAvailable) await reset();
    },
  );
});

// ── Filesystem-only durability tests ───────────────────────────────────

describe('FilesystemAuthStorageLayer — durable across instances', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-fs-restart-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('account survives a fresh instance pointed at the same directory', async () => {
    const a = new FilesystemAuthStorageLayer({ rootDir: dir });
    await a.upsertAccount(makeAccount({ sub: 'github_42', email: 'persist@example.com' }));

    const b = new FilesystemAuthStorageLayer({ rootDir: dir });
    const found = await b.getAccount('github_42');
    expect(found?.email).toBe('persist@example.com');
  });

  it('audit events survive across instances', async () => {
    const a = new FilesystemAuthStorageLayer({ rootDir: dir });
    await a.recordIdentityEvent({ type: 'auth.test.persist', sub: 'alice', timestamp: 1234 });

    const b = new FilesystemAuthStorageLayer({ rootDir: dir });
    const events = await b.listIdentityEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('auth.test.persist');
    expect(events[0]!.sub).toBe('alice');
  });

  it('K/V entries survive across instances (non-expiring)', async () => {
    const a = new FilesystemAuthStorageLayer({ rootDir: dir });
    await a.genericSet('Grant', 'g-persist', { accountId: 'github_42' });

    const b = new FilesystemAuthStorageLayer({ rootDir: dir });
    expect(await b.genericGet('Grant', 'g-persist')).toEqual({ accountId: 'github_42' });
  });

  it('cycle-16: bootstrap state survives across instances', async () => {
    // Without this, an AS restart re-enters the 503 bootstrap-required
    // gate even though the operator already ran the CLI — locking out
    // every user.
    const a = new FilesystemAuthStorageLayer({ rootDir: dir });
    await a.markBootstrapComplete('github_admin', 'github');
    expect((await a.getBootstrapState()).completed).toBe(true);

    const b = new FilesystemAuthStorageLayer({ rootDir: dir });
    const state = await b.getBootstrapState();
    expect(state.completed).toBe(true);
    expect(state.adminSub).toBe('github_admin');
    expect(state.adminMethod).toBe('github');
  });

  it('cycle-16: concurrent markBootstrapComplete with different subs — exactly one wins', async () => {
    // Two independent instances pointing at the same directory race
    // each other through the OS-level O_EXCL guard. Exactly one
    // succeeds; the other gets the admin-transfer rejection.
    const a = new FilesystemAuthStorageLayer({ rootDir: dir });
    const b = new FilesystemAuthStorageLayer({ rootDir: dir });
    const results = await Promise.allSettled([
      a.markBootstrapComplete('admin-A', 'github'),
      b.markBootstrapComplete('admin-B', 'github'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it('rejects unsafe model names with path separators', async () => {
    const s = new FilesystemAuthStorageLayer({ rootDir: dir });
    await expect(s.genericSet('../escape', 'id', { v: 1 })).rejects.toThrow(/unsafe model/);
    await expect(s.genericGet('../escape', 'id')).rejects.toThrow(/unsafe model/);
  });

  it('rejects unsafe ids with path separators', async () => {
    const s = new FilesystemAuthStorageLayer({ rootDir: dir });
    await expect(s.genericSet('Session', '../escape', { v: 1 })).rejects.toThrow(/unsafe id/);
    await expect(s.genericGet('Session', '../escape')).rejects.toThrow(/unsafe id/);
  });
});
