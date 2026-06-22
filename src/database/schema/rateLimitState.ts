import { pgTable, text, jsonb, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const rateLimitState = pgTable('rate_limit_state', {
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  state: jsonb('state').notNull(),
  version: integer('version').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  primaryKey({ columns: [table.scope, table.key] }),
  index('idx_rate_limit_state_expires').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
]);
