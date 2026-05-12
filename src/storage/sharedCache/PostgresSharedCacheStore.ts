/**
 * PostgresSharedCacheStore
 *
 * Database-backed `ISharedCacheStore` using Drizzle against the
 * `shared_cache` table (migration 0014). Operations run inside
 * `withSystemContext` — shared cache is operator-shared infrastructure,
 * not per-user tenant data, so RLS context is cleared.
 *
 * Atomicity: `set()` uses single-statement `INSERT ... ON CONFLICT
 * (cache_key) DO UPDATE`. `sweepExpired()` is a single
 * `DELETE WHERE expires_at < NOW()` statement; the partial index on
 * `expires_at` (created in migration 0014) keeps it cheap.
 *
 * @module storage/sharedCache/PostgresSharedCacheStore
 */

import { eq, lt, sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../../database/connection.js';
import { withSystemContext } from '../../database/admin.js';
import { sharedCache } from '../../database/schema/index.js';
import type {
  ISharedCacheStore,
  SharedCacheEntry,
  SharedCacheWriteEntry,
} from './ISharedCacheStore.js';

export interface PostgresSharedCacheStoreOptions {
  /** Drizzle DB instance. Pass the same instance the rest of the app uses. */
  db: DatabaseInstance;
}

interface SharedCacheRow {
  cacheKey: string;
  payload: unknown;
  etag: string | null;
  lastModified: string | null;
  version: string | null;
  checksum: string | null;
  fetchedAt: Date;
  expiresAt: Date | null;
}

export class PostgresSharedCacheStore implements ISharedCacheStore {
  private readonly db: DatabaseInstance;

  constructor(options: PostgresSharedCacheStoreOptions) {
    this.db = options.db;
  }

  async get(cacheKey: string): Promise<SharedCacheEntry | null> {
    assertValidCacheKey(cacheKey);
    const rows = await withSystemContext(this.db, (tx) =>
      tx.select().from(sharedCache).where(eq(sharedCache.cacheKey, cacheKey)).limit(1),
    );
    if (rows.length === 0) return null;
    return rowToEntry(rows[0] as SharedCacheRow);
  }

  async set(entry: SharedCacheWriteEntry): Promise<void> {
    assertValidCacheKey(entry.cacheKey);
    const now = new Date();
    const row = {
      cacheKey: entry.cacheKey,
      payload: entry.payload as object,
      etag: entry.etag,
      lastModified: entry.lastModified,
      version: entry.version,
      checksum: entry.checksum,
      fetchedAt: now,
      expiresAt: entry.expiresAt === undefined ? null : new Date(entry.expiresAt),
    };

    await withSystemContext(this.db, async (tx) => {
      await tx
        .insert(sharedCache)
        .values(row)
        .onConflictDoUpdate({
          target: sharedCache.cacheKey,
          set: {
            payload: row.payload,
            etag: row.etag,
            lastModified: row.lastModified,
            version: row.version,
            checksum: row.checksum,
            fetchedAt: row.fetchedAt,
            expiresAt: row.expiresAt,
          },
        });
    });
  }

  async delete(cacheKey: string): Promise<boolean> {
    assertValidCacheKey(cacheKey);
    const result = await withSystemContext(this.db, (tx) =>
      tx
        .delete(sharedCache)
        .where(eq(sharedCache.cacheKey, cacheKey))
        .returning({ cacheKey: sharedCache.cacheKey }),
    );
    return result.length > 0;
  }

  async sweepExpired(): Promise<number> {
    const result = await withSystemContext(this.db, (tx) =>
      tx
        .delete(sharedCache)
        .where(lt(sharedCache.expiresAt, sql`NOW()`))
        .returning({ cacheKey: sharedCache.cacheKey }),
    );
    return result.length;
  }
}

function rowToEntry(row: SharedCacheRow): SharedCacheEntry {
  return {
    cacheKey: row.cacheKey,
    payload: row.payload,
    etag: row.etag ?? undefined,
    lastModified: row.lastModified ?? undefined,
    version: row.version ?? undefined,
    checksum: row.checksum ?? undefined,
    fetchedAt: row.fetchedAt.getTime(),
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : undefined,
  };
}

const CACHE_KEY_RE = /^[a-zA-Z0-9._-]{1,128}$/;
function assertValidCacheKey(cacheKey: string): void {
  if (typeof cacheKey !== 'string' || !CACHE_KEY_RE.test(cacheKey)) {
    throw new Error(
      `ISharedCacheStore: cacheKey must match /^[a-zA-Z0-9._-]{1,128}$/; got ${
        typeof cacheKey === 'string' ? `"${cacheKey}"` : typeof cacheKey
      }`,
    );
  }
}
