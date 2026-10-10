/** Durable mode evidence. No production admission or mode-writing API. */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, bigint, primaryKey, check } from 'drizzle-orm/pg-core';

export const memoryBackendModes = pgTable('memory_backend_modes', {
  userId: uuid('user_id').notNull(),
  backend: text('backend').notNull(),
  protocolVersion: integer('protocol_version').notNull(),
  profile: text('profile').notNull(),
  mode: text('mode').notNull(),
  generation: bigint('generation', { mode: 'bigint' }).notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.backend] }),
  check('memory_backend_modes_backend_check', sql`${table.backend} = 'database'`),
  check('memory_backend_modes_protocol_check', sql`${table.protocolVersion} > 0`),
  check('memory_backend_modes_profile_check', sql`length(${table.profile}) > 0`),
  check('memory_backend_modes_mode_check', sql`${table.mode} IN ('legacy', 'guarded', 'read_only')`),
  check('memory_backend_modes_generation_check', sql`${table.generation} > 0`),
]);
