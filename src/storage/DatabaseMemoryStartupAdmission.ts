/** Whole-database startup observation, independent of the optional profile switch. */
import { sql } from 'drizzle-orm';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import type { DatabaseInstance } from '../database/connection.js';
import { withSystemContext } from '../database/admin.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from './DatabaseMemoryAdmissionGate.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from './DatabaseMemoryLegacyMutationGuard.js';

function knownIdentity(row: Record<string, unknown> | undefined): boolean {
  return !!row && typeof row.database === 'string' && row.database.length > 0 &&
    typeof row.oid === 'string' && /^[1-9]\d*$/u.test(row.oid) &&
    typeof row.started === 'string' && row.started.length > 0 &&
    typeof row.address === 'string' && isIP(row.address) !== 0 &&
    typeof row.port === 'number' && Number.isInteger(row.port) && row.port > 0 && row.port <= 65535;
}

export async function requireDatabaseMemoryStartupAdmission(
  appDb: DatabaseInstance, systemDb: DatabaseInstance, hasTrustedComposition: boolean,
): Promise<void> {
  try { await inspectStartup(appDb, systemDb, hasTrustedComposition); }
  catch (cause) {
    try {
      SecurityMonitor.logSecurityEvent({ type: 'OPERATION_FAILED', severity: 'HIGH',
        source: 'DatabaseMemoryStartupAdmission',
        details: `Database memory startup boundary failed; outcome=unclassified; invocation=${randomUUID()}` });
    } catch {
      try { logger.warn('Memory startup observer failed'); } catch { /* Preserve original startup refusal. */ }
    }
    throw cause;
  }
}

async function inspectStartup(appDb: DatabaseInstance, systemDb: DatabaseInstance,
  hasTrustedComposition: boolean): Promise<void> {
  const applicationIdentity = await appDb.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return tx.execute(sql`SELECT pg_catalog.current_database() AS database,
      (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) AS oid,
      pg_catalog.inet_server_addr()::text AS address, pg_catalog.inet_server_port() AS port,
      extract(epoch from pg_catalog.pg_postmaster_start_time())::text AS started`);
  });
  // An ordinary RLS-filtered connection cannot establish absence of protected tenants.
  await withSystemContext(systemDb, async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const systemIdentity = await tx.execute(sql`SELECT pg_catalog.current_database() AS database,
      (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) AS oid,
      pg_catalog.inet_server_addr()::text AS address, pg_catalog.inet_server_port() AS port,
      extract(epoch from pg_catalog.pg_postmaster_start_time())::text AS started`);
    if (applicationIdentity.length !== 1 || systemIdentity.length !== 1 ||
      !knownIdentity(applicationIdentity[0]) || !knownIdentity(systemIdentity[0]) ||
      !['database', 'oid', 'address', 'port', 'started'].every(key =>
        applicationIdentity[0][key] === systemIdentity[0][key])) {
      throw new Error('Authoritative memory startup inspection must use the application database');
    }
    const rows = await tx.execute(sql`SELECT
      c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity AND
        (SELECT count(*) = 6 FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
          JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND tn.nspname = 'pg_catalog' AND (a.attname, t.typname) IN
              (('user_id', 'uuid'), ('backend', 'text'), ('protocol_version', 'int4'),
                ('profile', 'text'), ('mode', 'text'), ('generation', 'int8'))) AS catalog_known,
      (SELECT count(*)::text FROM public.memory_backend_modes WHERE
        (user_id IS NOT NULL AND backend = 'database' AND protocol_version = 1 AND generation > 0 AND
          ((mode = 'legacy' AND profile = ${DATABASE_MEMORY_LEGACY_PROFILE}) OR
            (mode IN ('guarded', 'read_only') AND profile = ${DATABASE_MEMORY_ADMISSION_PROFILE}))) IS NOT TRUE) AS invalid_modes,
      (SELECT count(*)::text FROM public.memory_backend_modes
        WHERE mode IN ('guarded', 'read_only')) AS protected_modes
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'memory_backend_modes'`);
    if (rows.length !== 1 || rows[0].catalog_known !== true || rows[0].invalid_modes !== '0' ||
      typeof rows[0].protected_modes !== 'string' || !/^\d+$/u.test(rows[0].protected_modes) ||
      (!hasTrustedComposition && rows[0].protected_modes !== '0')) {
      throw new Error('Database memory startup requires known mode state and matching trusted composition');
    }
  });
}
