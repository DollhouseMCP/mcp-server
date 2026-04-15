/**
 * Sessions Schema
 *
 * Persists session-scoped state (activation state, Gatekeeper confirmations,
 * verification challenges) so hosted sessions survive process restarts.
 * Replaces FileActivationStateStore, FileConfirmationStore, FileChallengeStore
 * in database mode.
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: varchar('session_id', { length: 255 }).notNull(),
  transport: varchar('transport', { length: 16 }).notNull().default('stdio'),

  // Activation state (per element type)
  activations: jsonb('activations').notNull().default({}),

  // Gatekeeper confirmation state
  confirmations: jsonb('confirmations').notNull().default([]),
  cliApprovals: jsonb('cli_approvals').notNull().default([]),
  cliSessionApprovals: jsonb('cli_session_approvals').notNull().default([]),
  permissionPromptActive: boolean('permission_prompt_active').notNull().default(false),

  // Verification challenges
  challenges: jsonb('challenges').notNull().default([]),

  // Lifecycle
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().default(sql`NOW()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  // Composite unique covers userId-only queries via leading-column prefix scan
  uniqueIndex('idx_sessions_user_session').on(table.userId, table.sessionId),
]);
