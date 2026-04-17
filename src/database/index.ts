/**
 * Database Module — Barrel Export
 *
 * PostgreSQL connection, schema, and RLS utilities for
 * database-backed storage mode.
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

export { createDatabaseConnection, type DatabaseConfig, type DatabaseInstance } from './connection.js';
export { withUserContext, withUserRead } from './rls.js';
// withSystemContext is NOT re-exported here — import from './admin.js' directly.
// This separation is intentional: see admin.ts for rationale.
export { bootstrapDatabase, type DatabaseBootstrapResult } from './bootstrap.js';
export * from './schema/index.js';
