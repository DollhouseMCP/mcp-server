/**
 * Users and User Settings Schema
 *
 * Core identity tables for multi-user deployments.
 * users: authentication identity (populated by auth provider)
 * user_settings: per-user configuration (GitHub, sync, autoload, retention)
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

import { pgTable, uuid, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalId: varchar('external_id', { length: 255 }),
  username: varchar('username', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  displayName: varchar('display_name', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
});

// Identity fields (username, email, displayName) live exclusively in the
// users table. Join on users.id when display information is needed alongside
// settings — the PK-to-FK join cost is negligible.
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  githubConfig: jsonb('github_config').notNull().default({}),
  syncConfig: jsonb('sync_config').notNull().default({}),
  autoloadConfig: jsonb('autoload_config').notNull().default({}),
  retentionConfig: jsonb('retention_config').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
});
