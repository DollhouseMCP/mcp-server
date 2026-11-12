import { describe, expect, it, jest } from '@jest/globals';

import type { AdminAuditIntegrityStatus } from '../../../../src/web-console/audit/AdminAuditChain.js';
import {
  AUDIT_CHAIN_SAMPLE_SIZE,
  auditTelemetrySourcesFrom,
  probeAuditTelemetry,
  type AuditTelemetrySources,
} from '../../../../src/web-console/setup/AuditTelemetryProbe.js';

function sources(overrides: Partial<AuditTelemetrySources> = {}, integrity: readonly AdminAuditIntegrityStatus[] = []) {
  return {
    adminAuditIntegrity: jest.fn(() => Promise.resolve(integrity)),
    approvalAudit: jest.fn(() => Promise.resolve({ items: [] })),
    authenticationAudit: jest.fn(() => Promise.resolve({ items: [] })),
    operationalLogs: jest.fn(() => Promise.resolve({ items: [] })),
    operationalMetrics: jest.fn(() => Promise.resolve({ items: [] })),
    ...overrides,
  };
}
const postgresError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('probeAuditTelemetry', () => {
  it('passes on a new install with no admin audit events, and says there was nothing to check', async () => {
    expect(await probeAuditTelemetry(sources())).toEqual({
      id: 'audit_telemetry_projection', state: 'passed', code: 'audit_and_telemetry_readable',
      detail: 'The audit and telemetry reads work. There are no admin audit events to check yet.',
    });
  });

  it('passes when every read works and every sampled event verifies', async () => {
    const all = sources({}, ['verified', 'verified', 'verified']);
    expect(await probeAuditTelemetry(all)).toEqual({
      id: 'audit_telemetry_projection', state: 'passed', code: 'audit_and_telemetry_readable',
      detail: 'The audit and telemetry reads work, and the first 3 admin audit events pass the tamper-evident chain check.',
    });
    expect(all.adminAuditIntegrity).toHaveBeenCalledWith(AUDIT_CHAIN_SAMPLE_SIZE);
    for (const read of Object.values(all)) expect(read).toHaveBeenCalledTimes(1);
  });

  it('fails when an event breaks the chain, ahead of anything it could not verify', async () => {
    expect(await probeAuditTelemetry(sources({}, ['verified', 'failed', 'not_available', 'failed']))).toEqual({
      id: 'audit_telemetry_projection', state: 'failed', code: 'admin_audit_chain_broken',
      detail: '2 of the first 4 admin audit events failed the tamper-evident chain check. ' +
        'Investigate before trusting the admin audit trail.',
    });
  });

  it('reports events it cannot verify as pending: nothing is known to be wrong', async () => {
    expect(await probeAuditTelemetry(sources({}, ['verified', 'not_available']))).toEqual({
      id: 'audit_telemetry_projection', state: 'pending', code: 'admin_audit_integrity_unverified',
      detail: '1 of the first 2 admin audit events could not be checked against the tamper-evident chain, ' +
        'because the key that signed them is not available to this server.',
    });
  });

  it('fails, naming each read that did not work, and still runs the others', async () => {
    const some = sources({
      approvalAudit: jest.fn(() => Promise.reject(postgresError('42P01', 'relation "approval_audit" does not exist'))),
      operationalMetrics: jest.fn(() => Promise.reject(new Error('socket hang up'))),
    }, ['failed']);
    expect(await probeAuditTelemetry(some)).toEqual({
      id: 'audit_telemetry_projection', state: 'failed', code: 'audit_or_telemetry_unreadable',
      detail: 'Could not read: approval audit events (error 42P01), operational metrics (no answer). ' +
        'The console pages that show these will fail until it can.',
    });
    expect(some.authenticationAudit).toHaveBeenCalledTimes(1);
    expect(some.operationalLogs).toHaveBeenCalledTimes(1);
  });

  it('never puts the driver message in the result, since it can carry connection details', async () => {
    const result = await probeAuditTelemetry(sources({
      adminAuditIntegrity: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED db.internal.example:5432 user=dollhouse_app'))),
    }));
    expect(result.detail).toBe('Could not read: admin audit events (no answer). The console pages that show these will fail until it can.');
  });
});

describe('auditTelemetrySourcesFrom', () => {
  it('asks each query for as little as it can, and keeps only chain results from admin audit events', async () => {
    const page = { limit: 1, cursor: null, next_cursor: null };
    const adminAuditQuery = { listAdminAudit: jest.fn(() => Promise.resolve({
      items: [{ id: 'event-1', actor_sub: 'github_42', integrity: { status: 'verified', reason: null } }], page,
    })) };
    const approvalAuditQuery = { listApprovalAudit: jest.fn(() => Promise.resolve({ items: [], page })) };
    const authenticationAuditQuery = { listAuthenticationAudit: jest.fn(() => Promise.resolve({ items: [], page })) };
    const telemetryQuery = {
      queryOperationalLogs: jest.fn(() => Promise.resolve({ items: [], page })),
      queryOperationalMetrics: jest.fn(() => Promise.resolve({ items: [] })),
    };
    const built = auditTelemetrySourcesFrom({
      adminAuditQuery, approvalAuditQuery, authenticationAuditQuery, telemetryQuery,
    } as unknown as Parameters<typeof auditTelemetrySourcesFrom>[0]);

    expect(await built.adminAuditIntegrity(50)).toEqual(['verified']);
    await Promise.all([built.approvalAudit(), built.authenticationAudit(), built.operationalLogs(), built.operationalMetrics()]);

    expect(adminAuditQuery.listAdminAudit).toHaveBeenCalledWith({ limit: 50, cursor: null });
    expect(approvalAuditQuery.listApprovalAudit).toHaveBeenCalledWith({ limit: 1, cursor: null });
    expect(authenticationAuditQuery.listAuthenticationAudit).toHaveBeenCalledWith({ limit: 1, cursor: null });
    expect(telemetryQuery.queryOperationalLogs).toHaveBeenCalledWith({ limit: 1, cursor: null, level: null, subsystem: null, event: null });
    expect(telemetryQuery.queryOperationalMetrics).toHaveBeenCalledWith({ subsystem: null, name: null });
  });
});
