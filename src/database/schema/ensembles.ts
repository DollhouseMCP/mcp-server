/**
 * Ensemble Members Schema
 *
 * Richer than element_relationships because ensemble membership carries
 * role, priority, activation mode, and intra-ensemble dependencies.
 * See DATABASE-STORAGE-REVIEW.md Section 11.2.
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { elements } from './elements.js';

export const ensembleMembers = pgTable('ensemble_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  ensembleId: uuid('ensemble_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  memberName: varchar('member_name', { length: 255 }).notNull(),
  memberType: varchar('member_type', { length: 32 }).notNull(),
  role: varchar('role', { length: 32 }).notNull().default('core'),
  priority: integer('priority').notNull().default(0),
  activation: varchar('activation', { length: 32 }).notNull().default('always'),
  condition: text('condition'),
  purpose: text('purpose'),
  dependencies: text('dependencies').array().default(sql`'{}'`),
}, (table) => [
  uniqueIndex('idx_ensemble_members_unique').on(table.ensembleId, table.memberName, table.memberType),
  index('idx_ensemble_members_ensemble').on(table.ensembleId),
  index('idx_ensemble_members_user').on(table.userId),
]);
