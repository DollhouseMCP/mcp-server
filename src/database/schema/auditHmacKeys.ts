/**
 * Audit HMAC keys.
 *
 * Separate from `auth_signing_keys` because the two have different retention
 * contracts. Auth keys can be pruned 30 days after rotation (signed tokens
 * have a bounded lifetime). Audit HMAC keys must be retained for the full
 * lifetime of the audit records that reference them — a rotated key is still
 * needed to verify historical `kid:hex` hashes. The `keyId` field on every
 * persisted hash is the `kid` of the row that produced it, so verification
 * is a direct lookup by primary key.
 *
 * Retention contract: NEVER DELETE rows from this table. Rotation marks the
 * old row `active = false` and inserts a new active row; the old row stays.
 * Do not add periodic pruning here without first redesigning the hash
 * verification path to tolerate missing keys.
 */
import { pgTable, varchar, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const auditHmacKeys = pgTable('audit_hmac_keys', {
  kid: varchar('kid', { length: 255 }).primaryKey(),
  secret: text('secret').notNull(),
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
}, (table) => [
  index('idx_audit_hmac_keys_active').on(table.active),
  uniqueIndex('idx_audit_hmac_keys_active_unique')
    .on(table.active)
    .where(sql`${table.active} = TRUE`),
]);
