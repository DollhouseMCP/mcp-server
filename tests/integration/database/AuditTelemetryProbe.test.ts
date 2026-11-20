/**
 * The audit and telemetry probe against the real PostgreSQL queries the
 * console's audit and operations pages use.
 *
 * Two things are proved here, and only here:
 *   - every read runs against a database migrated by this release, so the
 *     probe would report a missing table or column as unreadable;
 *   - nothing the probe does writes: the reads run on a connection whose
 *     every transaction is read-only, where a write of any kind is refused.
 *
 * What the probe makes of the chain results is not asserted. This database is
 * shared, and other suites leave admin audit events in it, some with chains
 * they broke on purpose. Each chain outcome has its own unit test in
 * tests/unit/web-console/setup/AuditTelemetryProbe.test.ts.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { DatabaseInstance } from '../../../src/database/connection.js';
import { getErrorCode } from '../../../src/database/db-utils.js';
import * as schema from '../../../src/database/schema/index.js';
import {
  PostgresAdminAuditQuery,
  PostgresApprovalAuditQuery,
  PostgresAuthenticationAuditQuery,
} from '../../../src/web-console/modules/audit/index.js';
import { PostgresConsoleTelemetryQuery } from '../../../src/web-console/modules/operations/index.js';
import { auditTelemetrySourcesFrom, probeAuditTelemetry } from '../../../src/web-console/setup/AuditTelemetryProbe.js';
import { TEST_DB_ADMIN_URL } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const PG_READ_ONLY_SQL_TRANSACTION = '25006';

required('probeAuditTelemetry on PostgreSQL', () => {
  let client: ReturnType<typeof postgres> | null = null;
  // Every transaction on this connection is read-only, set when it connects.
  const readOnlyDb = (): DatabaseInstance => {
    client ??= postgres(TEST_DB_ADMIN_URL, {
      max: 1,
      ssl: false,
      onnotice: () => {},
      connection: { default_transaction_read_only: 'on' },
    });
    return drizzle(client, { schema });
  };
  const sources = () => auditTelemetrySourcesFrom({
    adminAuditQuery: new PostgresAdminAuditQuery(readOnlyDb(), {
      // No key is offered; chain outcomes are not what this suite is about.
      resolve: () => Promise.reject(new Error('no signing key in this suite')),
      resolveForKeyId: () => Promise.resolve(null),
    }),
    approvalAuditQuery: new PostgresApprovalAuditQuery(readOnlyDb()),
    authenticationAuditQuery: new PostgresAuthenticationAuditQuery(readOnlyDb()),
    telemetryQuery: new PostgresConsoleTelemetryQuery(readOnlyDb(), { replicaId: 'audit-telemetry-probe-test' }),
  });

  afterAll(async () => {
    await client?.end();
  });

  it('is using a connection that refuses writes', async () => {
    const attempt = readOnlyDb().execute(sql`DELETE FROM "admin_audit_events" WHERE false`);
    await expect(attempt.catch(error => getErrorCode(error))).resolves.toBe(PG_READ_ONLY_SQL_TRANSACTION);
  });

  it('runs every read against a database migrated by this release, without writing', async () => {
    const built = sources();
    await expect(built.adminAuditIntegrity(5)).resolves.toBeInstanceOf(Array);
    await expect(built.approvalAudit()).resolves.toBeDefined();
    await expect(built.authenticationAudit()).resolves.toBeDefined();
    await expect(built.operationalLogs()).resolves.toBeDefined();
    await expect(built.operationalMetrics()).resolves.toBeDefined();
  });

  it('reports every read as working, whatever state the shared audit chain is in', async () => {
    const result = await probeAuditTelemetry(sources());
    expect(result.code).not.toBe('audit_or_telemetry_unreadable');
    expect(result.detail).not.toContain('Could not read');
  });
});
