/**
 * Operator Settings Schema
 *
 * Per-host / operator-level configuration: settings that belong to the
 * deployment as a whole, not to any individual user. Singleton row enforced
 * by a `CHECK (id = 1)` constraint at the database level (see migration
 * 0012_operator_settings.sql).
 *
 * Columns hold ConfigManager's per-host sections as jsonb:
 *   enhancedIndexConfig — `elements.enhanced_index.*` (limits, telemetry,
 *                         verbPatterns, backgroundAnalysis, resources)
 *   consoleConfig       — `console.port`
 *   licenseConfig       — `license.*` (commercial tier + attestation)
 *   defaultsConfig      — `elements.default_element_dir`, schema version
 *
 * No RLS — operator-level data, accessed by the AS via system context.
 *
 * @since Phase 4.5 storage completion
 */

import { pgTable, smallint, integer, jsonb, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const operatorSettings = pgTable('operator_settings', {
  id: smallint('id').primaryKey().default(1),
  enhancedIndexConfig: jsonb('enhanced_index_config').notNull().default({}),
  consoleConfig: jsonb('console_config').notNull().default({}),
  licenseConfig: jsonb('license_config').notNull().default({}),
  defaultsConfig: jsonb('defaults_config').notNull().default({}),
  configVersion: integer('config_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  check('operator_settings_singleton', sql`${table.id} = 1`),
]);
