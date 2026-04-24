/**
 * Agent States Schema
 *
 * Agent .md files contain the definition; .state.yaml files contain
 * runtime state (goals, decisions, context). This table persists that
 * runtime state in the database with optimistic locking.
 * See DATABASE-STORAGE-REVIEW.md Section 11.2.
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

import {
  pgTable,
  uuid,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { elements } from './elements.js';

export const agentStates = pgTable('agent_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  goals: jsonb('goals').notNull().default([]),
  decisions: jsonb('decisions').notNull().default([]),
  context: jsonb('context').notNull().default({}),
  lastActive: timestamp('last_active', { withTimezone: true }),
  sessionCount: integer('session_count').notNull().default(0),
  stateVersion: integer('state_version').notNull().default(1),
}, (table) => [
  uniqueIndex('idx_agent_states_agent').on(table.agentId),
  index('idx_agent_states_user').on(table.userId),
]);
