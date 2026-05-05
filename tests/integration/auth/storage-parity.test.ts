/**
 * Storage-parity contract tests.
 *
 * Same test suite, parameterized over each IAuthStorageLayer implementation.
 * The contract is asserted through the interface — no backend-specific
 * escape hatches. A new backend that passes this suite is drop-in
 * compatible with everything in src/auth/embedded-as/.
 *
 * Phase 1 wires Memory + Filesystem; Phase 1.3 (pending user input on
 * schema integration) adds Postgres.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { FilesystemAuthStorageLayer } from '../../../src/auth/embedded-as/storage/FilesystemAuthStorageLayer.js';
import type { IAuthStorageLayer, StoredAccount } from '../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';

interface BackendFixture {
  name: string;
  factory: () => Promise<IAuthStorageLayer>;
  cleanup: (storage: IAuthStorageLayer) => Promise<void>;
}

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

const fixtures: BackendFixture[] = [
  {
    name: 'InMemoryAuthStorageLayer',
    factory: async () => new InMemoryAuthStorageLayer(),
    cleanup: async () => {
      // Maps are GC'd with the instance.
    },
  },
  {
    name: 'FilesystemAuthStorageLayer',
    factory: async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-fs-'));
      return new FilesystemAuthStorageLayer({ rootDir: dir });
    },
    cleanup: async (storage) => {
      await fs.rm((storage as FilesystemAuthStorageLayer).rootDir, { recursive: true, force: true });
    },
  },
];

describe.each(fixtures)('IAuthStorageLayer contract: $name', ({ factory, cleanup }) => {
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
  });
});

// Filesystem-only: persistence across instance lifecycle (proves restart survival).
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
