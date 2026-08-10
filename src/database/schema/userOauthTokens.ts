import { customType, integer, timestamp, uuid, pgTable } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Per-user encrypted GitHub OAuth token storage.
 *
 * RLS is enabled and forced in migration 0017; application code must access
 * this table through withUserContext/withUserRead, not withSystemContext.
 */
export const userOauthTokens = pgTable('user_oauth_tokens', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  tokenCiphertext: bytea('token_ciphertext').notNull(),
  tokenIv: bytea('token_iv').notNull(),
  tokenTag: bytea('token_tag').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  dekIv: bytea('dek_iv').notNull(),
  dekTag: bytea('dek_tag').notNull(),
  keyVersion: integer('key_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
});
