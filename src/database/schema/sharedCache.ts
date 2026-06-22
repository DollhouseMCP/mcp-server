/**
 * Shared Cache Schema
 *
 * Operator-shared, network-fetched cache entries that are not per-user.
 * First consumer is the public collection-catalog cache (today on filesystem
 * at ~/.dollhouse/cache/collection-index.json; this table replaces that in
 * DB-backend mode).
 *
 * cache_key is a stable identifier the caller chooses (e.g.
 * 'collection-index'). Storing multiple cache types in one table avoids
 * joining and keeps the storage-layer surface small.
 *
 * HTTP conditional-refresh fields (etag, lastModified) let consumers
 * issue If-None-Match / If-Modified-Since on refresh. TTL-based
 * invalidation via expiresAt — null means "no expiry, refresh on demand."
 *
 * No RLS — operator-shared resource.
 *
 * @since Phase 4.5 storage completion
 */

import { pgTable, varchar, jsonb, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const sharedCache = pgTable('shared_cache', {
  cacheKey: varchar('cache_key', { length: 128 }).primaryKey(),
  payload: jsonb('payload').notNull(),
  etag: text('etag'),
  lastModified: text('last_modified'),
  version: text('version'),
  checksum: text('checksum'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (table) => [
  index('idx_shared_cache_expires_at')
    .on(table.expiresAt)
    .where(sql`${table.expiresAt} IS NOT NULL`),
]);
