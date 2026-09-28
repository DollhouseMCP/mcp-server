/** Immutable sealed memory archives, separate from replaceable live entries. */
import {
  pgTable, uuid, varchar, text, char, bigint, integer, timestamp,
  uniqueIndex, index, foreignKey, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { elements } from './elements.js';

export const memoryVolumes = pgTable('memory_volumes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  memoryId: uuid('memory_id').notNull(),
  elementType: varchar('element_type', { length: 32 }).notNull().default('memories'),
  volume: bigint('volume', { mode: 'number' }).notNull(),
  rawContent: text('raw_content').notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  entryCount: integer('entry_count').notNull(),
  firstEntryAt: timestamp('first_entry_at', { withTimezone: true }),
  lastEntryAt: timestamp('last_entry_at', { withTimezone: true }),
  sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  foreignKey({
    columns: [table.memoryId, table.userId, table.elementType],
    foreignColumns: [elements.id, elements.userId, elements.elementType],
    name: 'memory_volumes_memory_owner_fk',
  }).onDelete('cascade'),
  uniqueIndex('idx_memory_volumes_memory_number_unique').on(table.memoryId, table.volume),
  index('idx_memory_volumes_user_memory').on(table.userId, table.memoryId),
  check('memory_volumes_type_check', sql`${table.elementType} = 'memories'`),
  check('memory_volumes_number_check', sql`${table.volume} > 0 AND ${table.volume} <= 9007199254740991`),
  check('memory_volumes_entry_count_check', sql`${table.entryCount} >= 0`),
  check('memory_volumes_sha256_check', sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
]);
