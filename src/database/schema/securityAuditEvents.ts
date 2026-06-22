import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const securityAuditEvents = pgTable('security_audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventType: text('event_type').notNull(),
  actorId: text('actor_id'),
  targetId: text('target_id'),
  metadata: jsonb('metadata').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  index('idx_security_audit_events_occurred').on(table.occurredAt),
  index('idx_security_audit_events_type').on(table.eventType),
  // Composite for "all events for operator X" + time-scoped variants;
  // partial so rows without an actor (system events) don't bloat the index.
  index('idx_security_audit_events_actor')
    .on(table.actorId, table.occurredAt.desc())
    .where(sql`${table.actorId} IS NOT NULL`),
]);
