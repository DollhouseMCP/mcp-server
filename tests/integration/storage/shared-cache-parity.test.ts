/**
 * ISharedCacheStore parity tests.
 *
 * Same suite runs against all three implementations (InMemory, Filesystem,
 * Postgres). Postgres backend gated on Docker Postgres reachability via
 * `DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1` (CI) or skipped locally.
 *
 * @since Phase 4.5 storage completion — Phase C
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { sql } from 'drizzle-orm';

import {
  InMemorySharedCacheStore,
  FilesystemSharedCacheStore,
  type ISharedCacheStore,
  type SharedCacheWriteEntry,
} from '../../../src/storage/sharedCache/index.js';
import { PostgresSharedCacheStore } from '../../../src/storage/sharedCache/PostgresSharedCacheStore.js';
import { withSystemContext } from '../../../src/database/admin.js';
import { closeTestDb, getTestDb, isDatabaseAvailable } from '../database/test-db-helpers.js';

function makeEntry(overrides: Partial<SharedCacheWriteEntry> = {}): SharedCacheWriteEntry {
  return {
    cacheKey: 'test-cache',
    payload: { hello: 'world', count: 42 },
    etag: '"abc123"',
    lastModified: 'Mon, 11 May 2026 19:00:00 GMT',
    version: '1.0.0',
    checksum: 'sha8',
    ...overrides,
  };
}

function runContractSuite(
  factory: () => Promise<ISharedCacheStore>,
  cleanup: (store: ISharedCacheStore) => Promise<void>,
): void {
  let store: ISharedCacheStore;

  beforeEach(async () => {
    store = await factory();
  });

  afterEach(async () => {
    await cleanup(store);
  });

  describe('get() / set()', () => {
    it('returns null for an unknown key', async () => {
      const result = await store.get('does-not-exist');
      expect(result).toBeNull();
    });

    it('round-trips a basic entry', async () => {
      await store.set(makeEntry());
      const loaded = await store.get('test-cache');
      expect(loaded).not.toBeNull();
      expect(loaded?.payload).toEqual({ hello: 'world', count: 42 });
      expect(loaded?.etag).toBe('"abc123"');
      expect(loaded?.lastModified).toBe('Mon, 11 May 2026 19:00:00 GMT');
      expect(loaded?.version).toBe('1.0.0');
      expect(loaded?.checksum).toBe('sha8');
    });

    it('fetchedAt is populated by set()', async () => {
      const before = Date.now();
      await store.set(makeEntry());
      const after = Date.now();
      const loaded = await store.get('test-cache');
      expect(loaded?.fetchedAt).toBeGreaterThanOrEqual(before);
      expect(loaded?.fetchedAt).toBeLessThanOrEqual(after + 100);
    });

    it('omitting expiresAt stores null/undefined (no TTL)', async () => {
      await store.set(makeEntry({ expiresAt: undefined }));
      const loaded = await store.get('test-cache');
      expect(loaded?.expiresAt).toBeUndefined();
    });

    it('expiresAt round-trips', async () => {
      const expiresAt = Date.now() + 3_600_000;
      await store.set(makeEntry({ expiresAt }));
      const loaded = await store.get('test-cache');
      expect(loaded?.expiresAt).toBe(expiresAt);
    });

    it('second set replaces the first', async () => {
      await store.set(makeEntry({ payload: { v: 1 } }));
      await store.set(makeEntry({ payload: { v: 2 } }));
      const loaded = await store.get('test-cache');
      expect(loaded?.payload).toEqual({ v: 2 });
    });

    it('multiple keys are independent', async () => {
      await store.set(makeEntry({ cacheKey: 'a', payload: { tag: 'A' } }));
      await store.set(makeEntry({ cacheKey: 'b', payload: { tag: 'B' } }));
      const a = await store.get('a');
      const b = await store.get('b');
      expect(a?.payload).toEqual({ tag: 'A' });
      expect(b?.payload).toEqual({ tag: 'B' });
    });

    it('preserves nested structures in payload', async () => {
      const payload = { items: [1, 2, 3], meta: { author: 'test', tags: ['x', 'y'] } };
      await store.set(makeEntry({ payload }));
      const loaded = await store.get('test-cache');
      expect(loaded?.payload).toEqual(payload);
    });

    it('does NOT auto-expire on get (returns expired entries verbatim)', async () => {
      const expiresAt = Date.now() - 1_000; // already expired
      await store.set(makeEntry({ expiresAt }));
      const loaded = await store.get('test-cache');
      // Contract: get returns whatever's stored. Caller decides what to do.
      expect(loaded).not.toBeNull();
      expect(loaded?.expiresAt).toBe(expiresAt);
    });
  });

  describe('delete()', () => {
    it('returns true when an entry was removed', async () => {
      await store.set(makeEntry());
      const removed = await store.delete('test-cache');
      expect(removed).toBe(true);
      expect(await store.get('test-cache')).toBeNull();
    });

    it('returns false when no entry exists for the key', async () => {
      const removed = await store.delete('does-not-exist');
      expect(removed).toBe(false);
    });
  });

  describe('sweepExpired()', () => {
    it('removes only entries with expiresAt < now', async () => {
      const now = Date.now();
      await store.set(makeEntry({ cacheKey: 'expired-1', expiresAt: now - 10_000 }));
      await store.set(makeEntry({ cacheKey: 'expired-2', expiresAt: now - 5_000 }));
      await store.set(makeEntry({ cacheKey: 'live', expiresAt: now + 60_000 }));
      await store.set(makeEntry({ cacheKey: 'no-ttl', expiresAt: undefined }));

      const removed = await store.sweepExpired();
      expect(removed).toBe(2);
      expect(await store.get('expired-1')).toBeNull();
      expect(await store.get('expired-2')).toBeNull();
      expect(await store.get('live')).not.toBeNull();
      expect(await store.get('no-ttl')).not.toBeNull();
    });

    it('returns 0 when nothing is expired', async () => {
      await store.set(makeEntry({ expiresAt: Date.now() + 60_000 }));
      const removed = await store.sweepExpired();
      expect(removed).toBe(0);
    });

    it('is idempotent (running again removes nothing more)', async () => {
      const now = Date.now();
      await store.set(makeEntry({ cacheKey: 'gone', expiresAt: now - 1_000 }));
      const first = await store.sweepExpired();
      const second = await store.sweepExpired();
      expect(first).toBe(1);
      expect(second).toBe(0);
    });
  });

  describe('input validation', () => {
    it('rejects empty cacheKey on get', async () => {
      await expect(store.get('')).rejects.toThrow(/cacheKey/);
    });

    it('rejects cacheKey with path traversal characters', async () => {
      await expect(store.get('../etc/passwd')).rejects.toThrow(/cacheKey/);
    });

    it('rejects cacheKey with slashes', async () => {
      await expect(store.set(makeEntry({ cacheKey: 'a/b' }))).rejects.toThrow(/cacheKey/);
    });
  });

  describe('isolation between gets', () => {
    it('mutating a loaded payload does not affect the stored entry', async () => {
      await store.set(makeEntry({ payload: { count: 1 } }));
      const a = await store.get('test-cache');
      (a?.payload as Record<string, unknown>).count = 999;
      const b = await store.get('test-cache');
      expect((b?.payload as Record<string, unknown>).count).toBe(1);
    });
  });
}

// ── InMemory ───────────────────────────────────────────────────────────

describe('ISharedCacheStore contract: InMemorySharedCacheStore', () => {
  runContractSuite(
    async () => new InMemorySharedCacheStore(),
    async () => { /* GC'd. */ },
  );
});

// ── Filesystem ────────────────────────────────────────────────────────

describe('ISharedCacheStore contract: FilesystemSharedCacheStore', () => {
  runContractSuite(
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sharedcache-fs-'));
      return new FilesystemSharedCacheStore({ rootDir: dir });
    },
    async (store) => {
      const fsStore = store as FilesystemSharedCacheStore;
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
      '[storage-parity] Skipping PostgresSharedCacheStore suite — local Docker Postgres unreachable.',
    );
  }
});

afterAll(async () => {
  if (pgAvailable) await closeTestDb();
});

const pgRequired = process.env.DOLLHOUSE_REQUIRE_PG_AUTH_TESTS === '1';
const describePg = pgRequired ? describe : describe.skip;

describePg('ISharedCacheStore contract: PostgresSharedCacheStore', () => {
  const reset = async () => {
    const db = getTestDb();
    await withSystemContext(db, async (tx) => {
      await tx.execute(sql`DELETE FROM shared_cache`);
    });
  };

  beforeAll(() => {
    if (!pgAvailable) {
      throw new Error(
        'PostgresSharedCacheStore parity tests required ' +
        '(DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1) but Postgres was not reachable.',
      );
    }
  });

  runContractSuite(
    async () => {
      await reset();
      return new PostgresSharedCacheStore({ db: getTestDb() });
    },
    async () => {
      if (pgAvailable) await reset();
    },
  );
});

// ── Filesystem durability ──────────────────────────────────────────────

describe('FilesystemSharedCacheStore — durable across instances', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sharedcache-fs-restart-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('entry survives a fresh instance pointed at the same directory', async () => {
    const a = new FilesystemSharedCacheStore({ rootDir: dir });
    await a.set(makeEntry({ payload: { persisted: true } }));

    const b = new FilesystemSharedCacheStore({ rootDir: dir });
    const found = await b.get('test-cache');
    expect((found?.payload as Record<string, unknown>).persisted).toBe(true);
  });
});
