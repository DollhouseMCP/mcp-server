import { pgTable, uuid, text, jsonb, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const dangerZoneBlocks = pgTable('danger_zone_blocks', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  agentName: text('agent_name').notNull(),
  version: integer('version').notNull().default(1),
  block: jsonb('block').notNull(),
  blockedAt: timestamp('blocked_at', { withTimezone: true }).notNull(),
}, table => [primaryKey({ columns: [table.userId, table.agentName] })]);

export const dangerZoneBlockEvidence = pgTable('danger_zone_block_evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  snapshot: jsonb('snapshot').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('danger_zone_block_evidence_user_id_idx').on(table.userId)]);
