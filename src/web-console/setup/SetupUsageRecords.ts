/*
 * What real use has left behind.
 *
 * Five setup checks cannot be tested by the server: they are true once
 * somebody has actually done the thing. Each is answered here from the record
 * that doing it leaves, read-only and across the whole deployment. Only
 * whether it has happened and when is read. No account, repository owner or
 * other identity leaves this module.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import {
  accountInvitations,
  adminAuditEvents,
  authIdentityEvents,
  portfolioSyncJobs,
  userIntegrations,
} from '../../database/schema/index.js';
import {
  PORTFOLIO_SYNC_SUMMARY_REPOSITORY_KEY,
  PORTFOLIO_SYNC_SUMMARY_REPOSITORY_REACHED_KEY,
} from '../stores/IPortfolioSyncJobStore.js';

/** The events the authorization server records when an admin's one-time code is accepted. */
export const ADMIN_STEP_UP_EVENT_TYPES = ['auth.admin_step_up.succeeded', 'auth.admin_step_up.backup_code_consumed'] as const;
/** The admin audit operation for revoking an account's credentials. */
export const CREDENTIALS_REVOKE_ALL_OPERATION = 'accounts.users.credentials.revoke_all';
/** The audit phase written once the account's sessions and client grants have actually been revoked. */
export const CREDENTIALS_REVOKED_PHASE = 'post_commit_revocation';

export interface UsageRecord {
  readonly happened: boolean;
  /** When it last happened. Null when it has not, or when the record carries no time. */
  readonly lastAt: Date | null;
}

export interface SyncUsageRecord extends UsageRecord {
  /** The repository name the last such sync used. It is the deployment's setting, the same for every account. */
  readonly repositoryName: string | null;
}

export interface SetupUsageRecords {
  adminStepUp(): Promise<UsageRecord>;
  invitationAccepted(): Promise<UsageRecord>;
  credentialsRevoked(): Promise<UsageRecord>;
  githubConnected(): Promise<UsageRecord>;
  portfolioSyncSucceeded(): Promise<SyncUsageRecord>;
}

const GITHUB_PROVIDER = 'github';
const NOT_YET: UsageRecord = { happened: false, lastAt: null };
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export class PostgresSetupUsageRecords implements SetupUsageRecords {
  constructor(private readonly db: DatabaseInstance) {}

  async adminStepUp(): Promise<UsageRecord> {
    const rows = await withSystemContext(this.db, tx => tx
      .select({ at: authIdentityEvents.timestamp })
      .from(authIdentityEvents)
      .where(inArray(authIdentityEvents.type, [...ADMIN_STEP_UP_EVENT_TYPES]))
      .orderBy(desc(authIdentityEvents.timestamp))
      .limit(1));
    return rows[0] ? { happened: true, lastAt: new Date(Number(rows[0].at)) } : NOT_YET;
  }

  async invitationAccepted(): Promise<UsageRecord> {
    const rows = await withSystemContext(this.db, tx => tx
      .select({ at: accountInvitations.acceptedAt })
      .from(accountInvitations)
      .where(eq(accountInvitations.state, 'accepted'))
      .orderBy(desc(accountInvitations.acceptedAt))
      .limit(1));
    return rows[0] ? { happened: true, lastAt: rows[0].at } : NOT_YET;
  }

  async credentialsRevoked(): Promise<UsageRecord> {
    const rows = await withSystemContext(this.db, tx => tx
      .select({ at: adminAuditEvents.occurredAt })
      .from(adminAuditEvents)
      .where(and(
        eq(adminAuditEvents.operation, CREDENTIALS_REVOKE_ALL_OPERATION),
        eq(adminAuditEvents.result, 'approved'),
        sql`${adminAuditEvents.argsRedacted}->>'phase' = ${CREDENTIALS_REVOKED_PHASE}`,
      ))
      .orderBy(desc(adminAuditEvents.sequenceId))
      .limit(1));
    return rows[0] ? { happened: true, lastAt: rows[0].at } : NOT_YET;
  }

  async githubConnected(): Promise<UsageRecord> {
    const rows = await withSystemContext(this.db, tx => tx
      .select({ at: userIntegrations.connectedAt })
      .from(userIntegrations)
      .where(and(sql`${userIntegrations.provider} = ${GITHUB_PROVIDER}`, eq(userIntegrations.status, 'connected')))
      .orderBy(desc(userIntegrations.connectedAt))
      .limit(1));
    return rows[0] ? { happened: true, lastAt: rows[0].at } : NOT_YET;
  }

  async portfolioSyncSucceeded(): Promise<SyncUsageRecord> {
    const rows = await withSystemContext(this.db, tx => tx
      .select({ at: portfolioSyncJobs.completedAt, summary: portfolioSyncJobs.resultSummary })
      .from(portfolioSyncJobs)
      // A job can succeed without asking the repository anything, for
      // instance a push from an empty portfolio. Only one the repository
      // answered shows that sync works against a real repository.
      .where(and(
        eq(portfolioSyncJobs.status, 'succeeded'),
        sql`${portfolioSyncJobs.resultSummary}->>${PORTFOLIO_SYNC_SUMMARY_REPOSITORY_REACHED_KEY} = 'true'`,
      ))
      .orderBy(desc(portfolioSyncJobs.completedAt))
      .limit(1));
    if (!rows[0]) return { ...NOT_YET, repositoryName: null };
    return { happened: true, lastAt: rows[0].at, repositoryName: repositoryNameFrom(rows[0].summary) };
  }
}

/** The summary is stored JSON. Only a value shaped like a repository name is passed on. */
function repositoryNameFrom(summary: unknown): string | null {
  if (!summary || typeof summary !== 'object') return null;
  const value = (summary as Record<string, unknown>)[PORTFOLIO_SYNC_SUMMARY_REPOSITORY_KEY];
  return typeof value === 'string' && REPOSITORY_NAME.test(value) ? value : null;
}
