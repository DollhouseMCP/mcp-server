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
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { elements } from './elements.js';

export const agentStates = pgTable('agent_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  goals: jsonb('goals').notNull().default([]),
  decisions: jsonb('decisions').notNull().default([]),
  context: jsonb('context').notNull().default({}),
  lastActive: timestamp('last_active', { withTimezone: true }),
  sessionCount: integer('session_count').notNull().default(0),
  stateVersion: integer('state_version').notNull().default(1),
}, (table) => [
  uniqueIndex('idx_agent_states_agent_session').on(table.agentId, table.sessionId),
  index('idx_agent_states_user').on(table.userId),
  index('idx_agent_states_session').on(table.sessionId),
]);

export const agentReplacementJournals = pgTable('agent_replacement_journals', {
  operationId: uuid('operation_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  agentId: uuid('agent_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
  agentName: text('agent_name').notNull(),
  ownerHost: text('owner_host').notNull(),
  ownerPid: integer('owner_pid').notNull(),
  ownerProcessIncarnation: jsonb('owner_process_incarnation'),
  ownerInstanceId: uuid('owner_instance_id').notNull(),
  leaseToken: uuid('lease_token').notNull(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
  payload: jsonb('payload').notNull(),
  quarantinedAt: timestamp('quarantined_at', { withTimezone: true }),
  quarantineReason: text('quarantine_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex('idx_agent_replacement_journal_scope')
    .on(table.userId, table.agentId)
    .where(sql`${table.quarantinedAt} IS NULL`),
  index('idx_agent_replacement_journal_lease').on(table.leaseExpiresAt),
]);
