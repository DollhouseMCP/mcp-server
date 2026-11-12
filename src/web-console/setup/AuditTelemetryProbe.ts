import { getErrorCode } from '../../database/db-utils.js';
import type { AdminAuditIntegrityStatus } from '../audit/AdminAuditChain.js';
import type { IAdminAuditQuery, IApprovalAuditQuery, IAuthenticationAuditQuery } from '../modules/audit/AuditQueries.js';
import type { IConsoleTelemetryQuery } from '../modules/operations/OperationsTelemetry.js';
import type { WebConsoleSetupCheckResult, WebConsoleSetupCheckState } from './WebConsoleSetupStatus.js';

const CHECK_ID = 'audit_telemetry_projection';

/** How many admin audit events one run verifies, from the start of the chain. */
export const AUDIT_CHAIN_SAMPLE_SIZE = 50;

export type AuditTelemetryCode =
  | 'audit_and_telemetry_readable'
  | 'audit_or_telemetry_unreadable'
  | 'admin_audit_chain_broken'
  | 'admin_audit_integrity_unverified';

export interface AuditTelemetryResult extends WebConsoleSetupCheckResult {
  readonly id: typeof CHECK_ID;
  readonly state: Exclude<WebConsoleSetupCheckState, 'not_applicable'>;
  /** Stable code for surfaces that show codes, not prose. */
  readonly code: AuditTelemetryCode;
  readonly detail: string;
}

/**
 * The reads the console's audit and telemetry pages make, each kept as small
 * as its query allows. Only the admin audit read returns anything the probe
 * looks at: the per-event result of the tamper-evident chain check.
 */
export interface AuditTelemetrySources {
  readonly adminAuditIntegrity: (limit: number) => Promise<readonly AdminAuditIntegrityStatus[]>;
  readonly approvalAudit: () => Promise<unknown>;
  readonly authenticationAudit: () => Promise<unknown>;
  readonly operationalLogs: () => Promise<unknown>;
  readonly operationalMetrics: () => Promise<unknown>;
}

/** The smallest form of each read the audit and telemetry pages make. */
export function auditTelemetrySourcesFrom(queries: {
  readonly adminAuditQuery: IAdminAuditQuery;
  readonly approvalAuditQuery: IApprovalAuditQuery;
  readonly authenticationAuditQuery: IAuthenticationAuditQuery;
  readonly telemetryQuery: IConsoleTelemetryQuery;
}): AuditTelemetrySources {
  const firstRow = { limit: 1, cursor: null };
  return {
    adminAuditIntegrity: async limit => (await queries.adminAuditQuery.listAdminAudit({ limit, cursor: null }))
      .items.map(event => event.integrity.status),
    approvalAudit: () => queries.approvalAuditQuery.listApprovalAudit(firstRow),
    authenticationAudit: () => queries.authenticationAuditQuery.listAuthenticationAudit(firstRow),
    operationalLogs: () => queries.telemetryQuery.queryOperationalLogs({ ...firstRow, level: null, subsystem: null, event: null }),
    operationalMetrics: () => queries.telemetryQuery.queryOperationalMetrics({ subsystem: null, name: null }),
  };
}

const READ_LABELS = {
  adminAuditIntegrity: 'admin audit events',
  approvalAudit: 'approval audit events',
  authenticationAudit: 'sign-in audit events',
  operationalLogs: 'operational logs',
  operationalMetrics: 'operational metrics',
} as const satisfies Record<keyof AuditTelemetrySources, string>;

/**
 * Runs the audit and telemetry reads and checks the admin audit chain.
 * Read-only: it looks at whether each read works and at chain results, and
 * keeps no event content.
 *
 * Unlike a ledger or a list that cannot be read, a read that fails here is
 * the fault itself: the page that makes it cannot display. So it is reported
 * as failed, not pending. The driver's message is left out; only the error
 * code is used.
 *
 * The chain check covers the first events in the chain, the same slice the
 * audit page's first screen verifies. It shows the chain can be verified with
 * the configured key; it is not a full-chain proof.
 */
export async function probeAuditTelemetry(sources: AuditTelemetrySources): Promise<AuditTelemetryResult> {
  const names = Object.keys(READ_LABELS) as (keyof AuditTelemetrySources)[];
  const settled = await Promise.allSettled([
    sources.adminAuditIntegrity(AUDIT_CHAIN_SAMPLE_SIZE),
    sources.approvalAudit(),
    sources.authenticationAudit(),
    sources.operationalLogs(),
    sources.operationalMetrics(),
  ]);

  const unreadable = settled.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') return [];
    const code = getErrorCode(outcome.reason);
    return [`${READ_LABELS[names[index]]} (${code ? `error ${code}` : 'no answer'})`];
  });
  if (unreadable.length > 0) {
    return {
      id: CHECK_ID,
      state: 'failed',
      code: 'audit_or_telemetry_unreadable',
      detail: `Could not read: ${unreadable.join(', ')}. The console pages that show these will fail until it can.`,
    };
  }

  const integrity = (settled[0] as PromiseFulfilledResult<readonly AdminAuditIntegrityStatus[]>).value;
  const broken = integrity.filter(status => status === 'failed').length;
  if (broken > 0) {
    return {
      id: CHECK_ID,
      state: 'failed',
      code: 'admin_audit_chain_broken',
      detail: `${broken} of the first ${integrity.length} admin audit events failed the tamper-evident chain check. ` +
        'Investigate before trusting the admin audit trail.',
    };
  }
  const unverified = integrity.filter(status => status === 'not_available').length;
  if (unverified > 0) {
    return {
      id: CHECK_ID,
      state: 'pending',
      code: 'admin_audit_integrity_unverified',
      detail: `${unverified} of the first ${integrity.length} admin audit events could not be checked against the tamper-evident chain, ` +
        'because the key that signed them is not available to this server.',
    };
  }
  return {
    id: CHECK_ID,
    state: 'passed',
    code: 'audit_and_telemetry_readable',
    detail: integrity.length === 0
      ? 'The audit and telemetry reads work. There are no admin audit events to check yet.'
      : `The audit and telemetry reads work, and the first ${integrity.length} admin audit events pass the tamper-evident chain check.`,
  };
}
