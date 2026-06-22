/**
 * Elements Schema — Core Element Storage
 *
 * Strategy C (Hybrid): raw_content as source of truth, extracted metadata
 * in indexed columns for queries. See DATABASE-STORAGE-REVIEW.md Section 5.
 *
 * Tables:
 *   elements            — all element types with raw content + extracted metadata
 *   element_tags         — tag associations for filtering
 *   element_relationships — cross-element references (agent activates, template requires)
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  char,
  integer,
  boolean,
  date,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

// ── Elements ──────────────────────────────────────────────────────────────

export const elements = pgTable('elements', {
  // Identity
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Source of truth: raw file content
  rawContent: text('raw_content').notNull(),
  bodyContent: text('body_content'),
  contentHash: char('content_hash', { length: 64 }).notNull(),
  byteSize: integer('byte_size').notNull(),

  // Extracted metadata (indexed, query-optimized)
  elementType: varchar('element_type', { length: 32 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  version: varchar('version', { length: 32 }),
  author: varchar('author', { length: 255 }),
  elementCreated: date('element_created'),
  metadata: jsonb('metadata').notNull().default({}),

  // Visibility for multi-user deployments (default: private to user)
  visibility: varchar('visibility', { length: 32 }).notNull().default('private'),

  // Memory-specific extracted fields (NULL for non-memory elements)
  memoryType: varchar('memory_type', { length: 16 }),
  autoLoad: boolean('auto_load'),
  priority: integer('priority'),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  uniqueIndex('idx_elements_user_type_name').on(table.userId, table.elementType, table.name),
  index('idx_elements_user_type').on(table.userId, table.elementType),
  index('idx_elements_name').on(table.userId, table.name),
  index('idx_elements_author').on(table.author),
  index('idx_elements_metadata').using('gin', table.metadata),
  index('idx_elements_autoload').on(table.userId).where(sql`auto_load = true`),
  index('idx_elements_memory_type').on(table.userId, table.memoryType).where(sql`element_type = 'memories'`),
  // Incremental scan: efficient query for rows changed since last scan timestamp
  index('idx_elements_scan').on(table.userId, table.elementType, table.updatedAt),
]);

// ── Element Tags ──────────────────────────────────────────────────────────

export const elementTags = pgTable('element_tags', {
  elementId: uuid('element_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tag: varchar('tag', { length: 128 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.elementId, table.tag] }),
  index('idx_tags_tag').on(table.tag),
  index('idx_tags_user').on(table.userId),
]);

// ── Element Relationships ─────────────────────────────────────────────────

export const elementRelationships = pgTable('element_relationships', {
  sourceId: uuid('source_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetName: varchar('target_name', { length: 255 }).notNull(),
  targetType: varchar('target_type', { length: 32 }).notNull(),
  relationship: varchar('relationship', { length: 64 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.sourceId, table.targetName, table.targetType] }),
  // (user_id, target_name, target_type) composite — serves both reverse-lookup
  // queries ("who references this target within user X's partition?") AND any
  // leading-prefix query on user_id alone, so a separate (user_id) index would
  // just duplicate write amplification. Migration 0004_fts_and_rls creates this
  // index and drops the older (target_name, target_type) and (user_id) indexes.
  index('idx_relationships_user_target').on(table.userId, table.targetName, table.targetType),
]);
