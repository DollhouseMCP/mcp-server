/**
 * Element Provenance Schema — Shared Pool Metadata
 *
 * Tracks the origin, source, version, and content hash of shared-pool
 * elements. Separate from the `elements` table so the shared-pool
 * feature is schema-modular — dropping this table removes provenance
 * without touching core element storage.
 *
 * @since v2.2.0 — Phase 4, Step 4.6
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  char,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { elements } from './elements.js';

export const elementProvenance = pgTable('element_provenance', {
  elementId: uuid('element_id')
    .primaryKey()
    .references(() => elements.id, { onDelete: 'cascade' }),

  origin: varchar('origin', { length: 32 }).notNull(),

  sourceUrl: text('source_url'),

  sourceVersion: varchar('source_version', { length: 128 }),

  contentHash: char('content_hash', { length: 64 }).notNull(),

  forkedFrom: uuid('forked_from')
    .references(() => elements.id, { onDelete: 'set null' }),

  installedAt: timestamp('installed_at', { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
}, (table) => [
  uniqueIndex('idx_provenance_canonical')
    .on(table.origin, table.sourceUrl, table.sourceVersion)
    .where(sql`source_url IS NOT NULL`),
  index('idx_provenance_origin').on(table.origin),
  index('idx_provenance_forked_from')
    .on(table.forkedFrom)
    .where(sql`forked_from IS NOT NULL`),
]);
