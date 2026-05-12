/**
 * FilesystemSharedCacheStore
 *
 * Durable JSON-on-disk backend, one file per cache key. State lives at
 * `<rootDir>/<cacheKey>.json`. Atomic write-temp + rename via
 * `FileLockManager.atomicWriteFile`; reads tolerate ENOENT (returns null)
 * and malformed JSON (logs warning, treats as missing).
 *
 * `cacheKey` is validated against a strict regex before being interpolated
 * into the filesystem path (defensive against accidental path traversal —
 * even though the validation already rejects '/' and '..').
 *
 * @module storage/sharedCache/FilesystemSharedCacheStore
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { FileLockManager } from '../../security/fileLockManager.js';
import { logger } from '../../utils/logger.js';
import type {
  ISharedCacheStore,
  SharedCacheEntry,
  SharedCacheWriteEntry,
} from './ISharedCacheStore.js';

export interface FilesystemSharedCacheStoreOptions {
  /** Directory holding `<cacheKey>.json` files. */
  rootDir: string;
}

export class FilesystemSharedCacheStore implements ISharedCacheStore {
  private readonly rootDir: string;
  private readonly locks = new FileLockManager();

  constructor(options: FilesystemSharedCacheStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(cacheKey: string): Promise<SharedCacheEntry | null> {
    assertValidCacheKey(cacheKey);
    const filePath = this.pathFor(cacheKey);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isSharedCacheEntry(parsed)) {
        logger.warn(
          '[SharedCacheStore:fs] cache file has wrong shape; treating as missing',
          { cacheKey, path: filePath },
        );
        return null;
      }
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      if (err instanceof SyntaxError) {
        logger.warn(
          '[SharedCacheStore:fs] cache file failed to parse; treating as missing',
          { cacheKey, path: filePath, error: err.message },
        );
        return null;
      }
      throw err;
    }
  }

  async set(entry: SharedCacheWriteEntry): Promise<void> {
    assertValidCacheKey(entry.cacheKey);
    const filePath = this.pathFor(entry.cacheKey);
    const payload: SharedCacheEntry = {
      cacheKey: entry.cacheKey,
      payload: entry.payload,
      etag: entry.etag,
      lastModified: entry.lastModified,
      version: entry.version,
      checksum: entry.checksum,
      fetchedAt: Date.now(),
      expiresAt: entry.expiresAt,
    };

    await this.locks.withLock(`shared-cache:${filePath}`, async () => {
      await this.ensureRoot();
      await this.locks.atomicWriteFile(filePath, JSON.stringify(payload));
    });
  }

  async delete(cacheKey: string): Promise<boolean> {
    assertValidCacheKey(cacheKey);
    const filePath = this.pathFor(cacheKey);
    return this.locks.withLock(`shared-cache:${filePath}`, async () => {
      try {
        await fs.unlink(filePath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  async sweepExpired(): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }

    const now = Date.now();
    let removed = 0;
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(this.rootDir, name);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as SharedCacheEntry;
        if (parsed.expiresAt !== undefined && parsed.expiresAt < now) {
          await fs.unlink(filePath).catch(() => { /* race with concurrent delete; benign */ });
          removed++;
        }
      } catch {
        // Malformed or vanished while sweeping — leave it for next call to handle.
      }
    }
    return removed;
  }

  private pathFor(cacheKey: string): string {
    // Already validated as safe by assertValidCacheKey.
    return path.join(this.rootDir, `${cacheKey}.json`);
  }

  private async ensureRoot(): Promise<void> {
    try {
      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

function isSharedCacheEntry(value: unknown): value is SharedCacheEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.cacheKey === 'string' && typeof v.fetchedAt === 'number';
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
