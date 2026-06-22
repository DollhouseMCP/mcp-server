/**
 * Memory Entries Schema
 *
 * Split-source design: the elements table stores the memory container
 * (name, description, metadata). This table stores individual time-series
 * entries with proper indexing for temporal queries, tag filtering,
 * and privacy-level enforcement.
 *
 * DB is source of truth for entries (not raw YAML reconstruction).
 * See DATABASE-STORAGE-REVIEW.md Section 6.
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { elements } from './elements.js';

export const memoryEntries = pgTable('memory_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  memoryId: uuid('memory_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
  entryId: varchar('entry_id', { length: 255 }).notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  content: text('content').notNull(),
  sanitizedContent: text('sanitized_content'),
  sanitizedPatterns: jsonb('sanitized_patterns').default({}),
  tags: text('tags').array().default(sql`'{}'`),
  entryMetadata: jsonb('entry_metadata').default({}),
  privacyLevel: varchar('privacy_level', { length: 32 }),
  trustLevel: varchar('trust_level', { length: 32 }),
  source: varchar('source', { length: 64 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('idx_memory_entries_unique').on(table.memoryId, table.entryId),
  index('idx_memory_entries_user').on(table.userId, table.memoryId),
  index('idx_memory_entries_time').on(table.memoryId, table.timestamp),
  index('idx_memory_entries_tags').using('gin', table.tags),
  index('idx_memory_entries_privacy').on(table.memoryId, table.privacyLevel),
]);
