/**
 * IUserConfigStore parity tests.
 *
 * Same suite runs against all three implementations (InMemory, Filesystem,
 * Postgres). A new backend that passes this suite is drop-in compatible
 * with every consumer of IUserConfigStore.
 *
 * Postgres backend gated on Docker Postgres reachability (same gate as
 * the auth/operator-config storage parity tests:
 * `DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1` in CI; silent skip locally).
 *
 * Includes RLS isolation tests for the Postgres backend specifically —
 * critical that user A can never see user B's row even if they share
 * a connection pool.
 *
 * @since Phase 4.5 storage completion — Phase B
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import {
  InMemoryUserConfigStore,
  FilesystemUserConfigStore,
  type IUserConfigStore,
  type UserConfig,
} from '../../../src/storage/userConfig/index.js';
import { PostgresUserConfigStore } from '../../../src/storage/userConfig/PostgresUserConfigStore.js';
import { withSystemContext } from '../../../src/database/admin.js';
import {
  closeTestDb,
  ensureTestUser,
  ensureTestUserB,
  getTestDb,
  isDatabaseAvailable,
} from '../database/test-db-helpers.js';

function makeConfig(overrides: Partial<UserConfig> = {}): Omit<UserConfig, 'updatedAt'> {
  return {
    githubConfig: { auth: { client_id: 'Ovtest' } },
    syncConfig: { enabled: true, individual: { require_confirmation: false } },
    autoloadConfig: { memories: ['baseline'], maxTokenBudget: 8000 },
    retentionConfig: { enabled: false },
    wizardConfig: { completed: true },
    displayConfig: { persona_indicators: { enabled: true } },
    collectionConfig: { auto_submit: false },
    autoActivateConfig: { personas: [] },
    sourcePriorityConfig: { order: ['local', 'github', 'collection'] },
    userIdentityConfig: { username: 'testuser', email: 'test@example.com', display_name: 'Test User' },
    configVersion: 1,
    ...overrides,
  };
}

/**
 * The full contract suite. `factory` returns a (store, userId) pair so the
 * suite can use the userId for save/load consistently across backends.
 * For InMemory + Filesystem the userId is generated locally; for Postgres
 * it must be a real `users` row (FK constraint).
 */
function runContractSuite(
  factory: () => Promise<{ store: IUserConfigStore; userId: string }>,
  cleanup: (handle: { store: IUserConfigStore; userId: string }) => Promise<void>,
): void {
  let handle: { store: IUserConfigStore; userId: string };

  beforeEach(async () => {
    handle = await factory();
  });

  afterEach(async () => {
    await cleanup(handle);
  });

  describe('load() before save()', () => {
    it('returns the default config shape, not null', async () => {
      const result = await handle.store.load(handle.userId);
      expect(result).not.toBeNull();
      expect(result.githubConfig).toEqual({});
      expect(result.syncConfig).toEqual({});
      expect(result.wizardConfig).toEqual({});
      expect(result.displayConfig).toEqual({});
      expect(result.collectionConfig).toEqual({});
      expect(result.autoActivateConfig).toEqual({});
      expect(result.sourcePriorityConfig).toEqual({});
      expect(result.userIdentityConfig).toEqual({});
      expect(result.configVersion).toBe(1);
    });

    it('returns a fresh copy each call (mutating one does not leak to the next)', async () => {
      const first = await handle.store.load(handle.userId);
      (first.githubConfig as Record<string, unknown>).poisoned = true;
      const second = await handle.store.load(handle.userId);
      expect((second.githubConfig as Record<string, unknown>).poisoned).toBeUndefined();
    });
  });

  describe('save() then load()', () => {
    it('round-trips every section verbatim', async () => {
      const cfg = makeConfig();
      await handle.store.save(handle.userId, cfg);
      const loaded = await handle.store.load(handle.userId);
      expect(loaded.githubConfig).toEqual(cfg.githubConfig);
      expect(loaded.syncConfig).toEqual(cfg.syncConfig);
      expect(loaded.autoloadConfig).toEqual(cfg.autoloadConfig);
      expect(loaded.retentionConfig).toEqual(cfg.retentionConfig);
      expect(loaded.wizardConfig).toEqual(cfg.wizardConfig);
      expect(loaded.displayConfig).toEqual(cfg.displayConfig);
      expect(loaded.collectionConfig).toEqual(cfg.collectionConfig);
      expect(loaded.autoActivateConfig).toEqual(cfg.autoActivateConfig);
      expect(loaded.sourcePriorityConfig).toEqual(cfg.sourcePriorityConfig);
      expect(loaded.userIdentityConfig).toEqual(cfg.userIdentityConfig);
    });

    it('updatedAt is populated by save()', async () => {
      const before = Date.now();
      await handle.store.save(handle.userId, makeConfig());
      const after = Date.now();
      const loaded = await handle.store.load(handle.userId);
      expect(loaded.updatedAt).toBeGreaterThanOrEqual(before);
      expect(loaded.updatedAt).toBeLessThanOrEqual(after + 100);
    });

    it('second save replaces the first wholesale', async () => {
      await handle.store.save(handle.userId, makeConfig({ syncConfig: { enabled: true } }));
      await handle.store.save(handle.userId, makeConfig({ syncConfig: { enabled: false } }));
      const loaded = await handle.store.load(handle.userId);
      expect((loaded.syncConfig as Record<string, unknown>).enabled).toBe(false);
    });

    it('preserves nested structures in jsonb sections', async () => {
      const cfg = makeConfig({
        autoloadConfig: {
          memories: ['m1', 'm2', 'm3'],
          limits: { byPriority: { high: 100, low: 10 } },
        },
      });
      await handle.store.save(handle.userId, cfg);
      const loaded = await handle.store.load(handle.userId);
      expect(loaded.autoloadConfig).toEqual(cfg.autoloadConfig);
    });

    it('handles empty section objects', async () => {
      const cfg = makeConfig({
        githubConfig: {},
        syncConfig: {},
        autoloadConfig: {},
        retentionConfig: {},
        wizardConfig: {},
        displayConfig: {},
        collectionConfig: {},
        autoActivateConfig: {},
        sourcePriorityConfig: {},
      });
      await handle.store.save(handle.userId, cfg);
      const loaded = await handle.store.load(handle.userId);
      expect(loaded.githubConfig).toEqual({});
      expect(loaded.sourcePriorityConfig).toEqual({});
    });
  });

  describe('isolation between loads', () => {
    it('mutating a loaded copy does not affect the stored row', async () => {
      await handle.store.save(handle.userId, makeConfig({ syncConfig: { enabled: true } }));
      const a = await handle.store.load(handle.userId);
      (a.syncConfig as Record<string, unknown>).enabled = false;
      const b = await handle.store.load(handle.userId);
      expect((b.syncConfig as Record<string, unknown>).enabled).toBe(true);
    });
  });

  describe('input validation', () => {
    it('rejects non-UUID userId on load', async () => {
      await expect(handle.store.load('not-a-uuid')).rejects.toThrow(/UUID/);
    });

    it('rejects non-UUID userId on save', async () => {
      await expect(
        handle.store.save('not-a-uuid', makeConfig()),
      ).rejects.toThrow(/UUID/);
    });
  });
}

// ── InMemory (always run) ──────────────────────────────────────────────

describe('IUserConfigStore contract: InMemoryUserConfigStore', () => {
  runContractSuite(
    async () => ({ store: new InMemoryUserConfigStore(), userId: randomUUID() }),
    async () => { /* GC'd with the instance. */ },
  );
});

// ── Filesystem (always run) ────────────────────────────────────────────

describe('IUserConfigStore contract: FilesystemUserConfigStore', () => {
  runContractSuite(
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usercfg-fs-'));
      return { store: new FilesystemUserConfigStore({ rootDir: dir }), userId: randomUUID() };
    },
    async (handle) => {
      const fsStore = handle.store as FilesystemUserConfigStore;
      const rootDir = (fsStore as unknown as { rootDir: string }).rootDir;
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  );
});

// ── Postgres (gated) ───────────────────────────────────────────────────

let pgAvailable = false;
beforeAll(async () => {
  pgAvailable = await isDatabaseAvailable();
  if (!pgAvailable) {
    console.warn(
      '[storage-parity] Skipping PostgresUserConfigStore suite — local Docker Postgres unreachable. ' +
      'Run `docker compose -f docker/docker-compose.db.yml up -d` to enable.',
    );
  }
});

afterAll(async () => {
  if (pgAvailable) await closeTestDb();
});

const pgRequired = process.env.DOLLHOUSE_REQUIRE_PG_AUTH_TESTS === '1';
const describePg = pgRequired ? describe : describe.skip;

describePg('IUserConfigStore contract: PostgresUserConfigStore', () => {
  // user_settings.user_id has FK to users(id) ON DELETE CASCADE, so
  // deleting the test user cascades the config row. But for parity we
  // delete the config row directly (preserves the user across tests).
  const reset = async () => {
    const db = getTestDb();
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    // RLS is FORCEd, so DELETE needs a user context too.
    const { withUserContext } = await import('../../../src/database/rls.js');
    for (const uid of [userIdA, userIdB]) {
      await withUserContext(db, uid, async (tx) => {
        await tx.execute(sql`DELETE FROM user_settings WHERE user_id = ${uid}::uuid`);
      });
    }
  };

  beforeAll(() => {
    if (!pgAvailable) {
      throw new Error(
        'PostgresUserConfigStore parity tests required ' +
        '(DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1) but Postgres was not reachable.',
      );
    }
  });

  runContractSuite(
    async () => {
      await reset();
      const userId = await ensureTestUser();
      return { store: new PostgresUserConfigStore({ db: getTestDb() }), userId };
    },
    async () => {
      if (pgAvailable) await reset();
    },
  );

  // RLS isolation — Postgres-only, can't be tested for in-memory/filesystem
  // backends since they don't enforce isolation at the storage layer.
  describe('RLS isolation', () => {
    it('user A cannot see user B row even on the same store instance', async () => {
      await reset();
      const userIdA = await ensureTestUser();
      const userIdB = await ensureTestUserB();
      const store = new PostgresUserConfigStore({ db: getTestDb() });

      await store.save(userIdA, makeConfig({ syncConfig: { tag: 'A' } }));
      await store.save(userIdB, makeConfig({ syncConfig: { tag: 'B' } }));

      const loadedA = await store.load(userIdA);
      const loadedB = await store.load(userIdB);

      expect((loadedA.syncConfig as Record<string, unknown>).tag).toBe('A');
      expect((loadedB.syncConfig as Record<string, unknown>).tag).toBe('B');
    });

    it('load(userId) returns default when only OTHER users have rows', async () => {
      await reset();
      const userIdA = await ensureTestUser();
      const userIdB = await ensureTestUserB();
      const store = new PostgresUserConfigStore({ db: getTestDb() });

      await store.save(userIdA, makeConfig({ syncConfig: { tag: 'A' } }));
      // userIdB has no row of their own; load must return default,
      // NOT leak userIdA's row.
      const loadedB = await store.load(userIdB);
      expect(loadedB.syncConfig).toEqual({});
    });
  });
});

// ── Filesystem durability ──────────────────────────────────────────────

describe('FilesystemUserConfigStore — durable across instances', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usercfg-fs-restart-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('config survives a fresh instance pointed at the same directory', async () => {
    const userId = randomUUID();
    const a = new FilesystemUserConfigStore({ rootDir: dir });
    await a.save(userId, makeConfig({ syncConfig: { enabled: true } }));

    const b = new FilesystemUserConfigStore({ rootDir: dir });
    const found = await b.load(userId);
    expect((found.syncConfig as Record<string, unknown>).enabled).toBe(true);
  });

  it('multiple users share the rootDir without collision', async () => {
    const userIdA = randomUUID();
    const userIdB = randomUUID();
    const store = new FilesystemUserConfigStore({ rootDir: dir });

    await store.save(userIdA, makeConfig({ syncConfig: { tag: 'A' } }));
    await store.save(userIdB, makeConfig({ syncConfig: { tag: 'B' } }));

    expect((await store.load(userIdA)).syncConfig).toEqual({ tag: 'A' });
    expect((await store.load(userIdB)).syncConfig).toEqual({ tag: 'B' });
  });

  it('tolerates ENOENT on first load (returns default)', async () => {
    const store = new FilesystemUserConfigStore({ rootDir: dir });
    const found = await store.load(randomUUID());
    expect(found.syncConfig).toEqual({});
  });
});
