/*
 * The setup status report: every check in the catalog with what is known
 * about it right now.
 *
 * Nothing is tested here. Each check's answer comes from the probe, the
 * canary or the usage record that already knows it, and a source that cannot
 * answer leaves its check pending instead of failing the report.
 */

import { getErrorCode } from '../../database/db-utils.js';
import type { CanaryStatus } from '../canary/CanaryMonitor.js';
import type { ConsoleSecurityInvalidationReadinessSnapshot } from '../services/invalidation/ConsoleSecurityInvalidationReadiness.js';
import type { AllowlistParityResult } from './AllowlistParityProbe.js';
import type { AuditTelemetryResult } from './AuditTelemetryProbe.js';
import type { MigrationLedgerResult } from './MigrationLedgerProbe.js';
import type { SetupUsageRecords, SyncUsageRecord, UsageRecord } from './SetupUsageRecords.js';
import type { WebConsoleSetupCheckId } from './WebConsoleSetupChecks.js';
import {
  listWebConsoleSetupCheckStatuses,
  type WebConsoleSetupCheckResult,
  type WebConsoleSetupCheckStatus,
} from './WebConsoleSetupStatus.js';

export interface SetupStatusSources {
  /** Null without a database: there is no migration ledger. */
  readonly databaseMigrations: (() => Promise<MigrationLedgerResult>) | null;
  readonly securityInvalidation: () => Promise<Pick<ConsoleSecurityInvalidationReadinessSnapshot, 'ready' | 'failureCodes'>>;
  /** Null unless the console's allowlist is the sign-in authority: otherwise there is one list. */
  readonly allowlistParity: (() => Promise<AllowlistParityResult>) | null;
  readonly auditTelemetry: () => Promise<AuditTelemetryResult>;
  /** Null without a database: the canary has no per-session stores to exercise. Reading it never starts a run. */
  readonly canary: (() => CanaryStatus) | null;
  /** Null without a database: there are no records to read. */
  readonly usage: SetupUsageRecords | null;
  /** Whether this deployment offers invitations that leave a record when accepted. */
  readonly invitationsOffered: boolean;
}

export interface SetupStatusReport {
  readonly checkedAt: Date;
  readonly checks: readonly WebConsoleSetupCheckStatus[];
}

type Result = WebConsoleSetupCheckResult;

const NO_DATABASE = 'This deployment has no database, so there is nothing to read.';

/** Every check in catalog order. Sources are asked together; one that fails affects only its own check. */
export async function buildSetupStatusReport(sources: SetupStatusSources, now: () => Date = () => new Date()): Promise<SetupStatusReport> {
  const usage = sources.usage;
  const results = await Promise.all([
    answered('production_database_migrations', sources.databaseMigrations, NO_DATABASE),
    guarded('security_invalidation_multi_replica', async () => describeInvalidation(await sources.securityInvalidation())),
    answered('allowlist_authority_parity', sources.allowlistParity,
      'This deployment has one sign-in allowlist, so there is nothing to compare.'),
    answered('audit_telemetry_projection', sources.auditTelemetry, NO_DATABASE),
    guarded('approval_execution_projection', () => Promise.resolve(describeCanary(sources.canary))),
    Promise.resolve<Result>({
      id: 'signing_key_auth_policy_multi_replica',
      state: 'pending',
      detail: 'The server does not compare replicas yet, so this is not verified.',
    }),
    used('embedded_as_login_step_up', usage && (() => usage.adminStepUp()),
      'An administrator has elevated with a one-time code.', 'No administrator has elevated with a one-time code yet.'),
    sources.invitationsOffered
      ? used('account_invite_redemption', usage && (() => usage.invitationAccepted()),
        'An invited person has accepted an invitation.', 'No invitation has been accepted yet.')
      : Promise.resolve<Result>({
        id: 'account_invite_redemption',
        state: 'not_applicable',
        detail: 'This deployment does not offer invitations that are recorded when accepted.',
      }),
    used('oauth_grant_revocation', usage && (() => usage.credentialsRevoked()),
      'An administrator has revoked an account\'s credentials, and its sessions and client grants were removed.',
      'No account\'s credentials have been revoked yet.'),
    used('github_integration_connect_callback', usage && (() => usage.githubConnected()),
      'An account has GitHub connected.', 'No account has GitHub connected.'),
    used('portfolio_sync_live_repository', usage && (() => usage.portfolioSyncSucceeded()),
      describeSync, 'No portfolio sync has succeeded yet.'),
  ]);
  return { checkedAt: now(), checks: listWebConsoleSetupCheckStatuses(results) };
}

/** The driver's message can carry connection details; only the error code is used. */
function couldNotCheck(id: WebConsoleSetupCheckId, error: unknown): Result {
  const code = getErrorCode(error);
  const reason = code ? `error ${code}` : 'an unexpected error';
  return { id, state: 'pending', detail: `This could not be checked just now (${reason}), so nothing is verified.` };
}

async function guarded(id: WebConsoleSetupCheckId, ask: () => Promise<Result>): Promise<Result> {
  try {
    return await ask();
  } catch (error) {
    return couldNotCheck(id, error);
  }
}

/** A check a probe answers in full. Without the probe the check does not apply here. */
function answered(
  id: WebConsoleSetupCheckId,
  probe: (() => Promise<Result>) | null,
  whyNotApplicable: string,
): Promise<Result> {
  if (!probe) return Promise.resolve({ id, state: 'not_applicable', detail: whyNotApplicable });
  return guarded(id, async () => {
    const result = await probe();
    return { id, state: result.state, ...(result.detail === undefined ? {} : { detail: result.detail }) };
  });
}

/** A check that is true once somebody has done the thing. Until then it is pending, never failed. */
function used<Record extends UsageRecord>(
  id: WebConsoleSetupCheckId,
  read: (() => Promise<Record>) | null,
  done: string | ((record: Record) => string),
  notYet: string,
): Promise<Result> {
  if (!read) return Promise.resolve({ id, state: 'pending', detail: NO_DATABASE });
  return guarded(id, async () => {
    const record = await read();
    if (!record.happened) return { id, state: 'pending', detail: notYet };
    return {
      id,
      state: 'passed',
      detail: typeof done === 'string' ? done : done(record),
      ...(record.lastAt ? { observedAt: record.lastAt } : {}),
    };
  });
}

function describeSync(record: SyncUsageRecord): string {
  return record.repositoryName
    // Each account syncs with its own repository. Only the name is shared: it is this deployment's setting.
    ? `A portfolio sync has succeeded, with a repository named ${record.repositoryName}, the name this deployment is set to use.`
    : 'A portfolio sync has succeeded. Its repository name was not recorded, because the sync ran on a version from before that was added.';
}

const INVALIDATION_REASONS: Readonly<Record<string, string>> = {
  security_invalidation_processor_not_ready: 'the processor that applies security changes is not running on this replica',
  security_invalidation_replica_lease_not_live: 'this replica does not hold a live lease',
  security_invalidation_events_pending: 'security changes are waiting to be applied on this replica',
  security_invalidation_check_failed: 'the check itself could not run',
};
/** Faults in the replica, as against work in hand or a check that could not run. */
const INVALIDATION_FAULTS = new Set(['security_invalidation_processor_not_ready', 'security_invalidation_replica_lease_not_live']);

function describeInvalidation(snapshot: Pick<ConsoleSecurityInvalidationReadinessSnapshot, 'ready' | 'failureCodes'>): Result {
  const id = 'security_invalidation_multi_replica';
  if (snapshot.ready) {
    return { id, state: 'passed', detail: 'This replica holds its lease and has no security changes waiting. Other replicas report for themselves.' };
  }
  const reasons = snapshot.failureCodes.map(code => INVALIDATION_REASONS[code] ?? code).join('; ');
  return {
    id,
    state: snapshot.failureCodes.some(code => INVALIDATION_FAULTS.has(code)) ? 'failed' : 'pending',
    detail: `Not ready on this replica: ${reasons || 'no reason was given'}.`,
  };
}

function describeCanary(canary: (() => CanaryStatus) | null): Result {
  const id = 'approval_execution_projection';
  if (!canary) {
    return { id, state: 'not_applicable', detail: 'This deployment has no database, so there are no per-session stores for the canary to check.' };
  }
  const status = canary();
  return {
    id,
    state: status.state,
    detail: status.detail,
    ...(status.lastRun ? { observedAt: status.lastRun.finishedAt } : {}),
  };
}
