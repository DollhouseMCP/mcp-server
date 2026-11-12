/**
 * The audit and telemetry probe against the real PostgreSQL queries the
 * console's audit and operations pages use.
 */

import { afterAll, describe, expect, it } from '@jest/globals';

import {
  PostgresAdminAuditQuery,
  PostgresApprovalAuditQuery,
  PostgresAuthenticationAuditQuery,
} from '../../../src/web-console/modules/audit/index.js';
import { PostgresConsoleTelemetryQuery } from '../../../src/web-console/modules/operations/index.js';
import { auditTelemetrySourcesFrom, probeAuditTelemetry } from '../../../src/web-console/setup/AuditTelemetryProbe.js';
import { closeTestDb, getTestAdminDb } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

afterAll(async () => {
  await closeTestDb();
});

required('probeAuditTelemetry on PostgreSQL', () => {
  const sources = () => auditTelemetrySourcesFrom({
    // No key is offered, so any event already in this shared database reads as
    // unverifiable, never as broken: this suite is about the reads themselves.
    adminAuditQuery: new PostgresAdminAuditQuery(getTestAdminDb(), {
      resolve: () => Promise.reject(new Error('no signing key in this suite')),
      resolveForKeyId: () => Promise.resolve(null),
    }),
    approvalAuditQuery: new PostgresApprovalAuditQuery(getTestAdminDb()),
    authenticationAuditQuery: new PostgresAuthenticationAuditQuery(getTestAdminDb()),
    telemetryQuery: new PostgresConsoleTelemetryQuery(getTestAdminDb(), { replicaId: 'audit-telemetry-probe-test' }),
  });

  it('runs every read against a database migrated by this release', async () => {
    const built = sources();
    await expect(built.adminAuditIntegrity(5)).resolves.toBeInstanceOf(Array);
    await expect(built.approvalAudit()).resolves.toBeDefined();
    await expect(built.authenticationAudit()).resolves.toBeDefined();
    await expect(built.operationalLogs()).resolves.toBeDefined();
    await expect(built.operationalMetrics()).resolves.toBeDefined();
  });

  it('reports the reads as working: passed, or pending where events exist that it holds no key for', async () => {
    const result = await probeAuditTelemetry(sources());
    expect(['audit_and_telemetry_readable', 'admin_audit_integrity_unverified']).toContain(result.code);
    expect(result.detail).not.toContain('Could not read');
  });
});
