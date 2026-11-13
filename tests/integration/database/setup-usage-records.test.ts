/**
 * The usage records the setup status reads, on PostgreSQL.
 *
 * The database is shared with other suites, which may have left records of
 * their own. So nothing here asserts "has not happened". Each test writes its
 * own record, dated far in the future where the reader orders by time, and
 * checks that the reader reports exactly that one as the latest.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { inArray } from 'drizzle-orm';

import { accountInvitations } from '../../../src/database/schema/invitations.js';
import { authIdentityEvents, portfolioSyncJobs, userIntegrations, users } from '../../../src/database/schema/index.js';
import { PostgresAdminAuditWriter } from '../../../src/web-console/audit/PostgresAdminAuditWriter.js';
import {
  CREDENTIALS_REVOKE_ALL_OPERATION,
  PostgresSetupUsageRecords,
} from '../../../src/web-console/setup/SetupUsageRecords.js';
import { invitationAuditKey } from '../../helpers/web-console/durableInvitationAdmin.js';
import { closeTestDb, getTestAdminDb } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

required('the setup status usage records on PostgreSQL', () => {
  const db = () => getTestAdminDb();
  const records = () => new PostgresSetupUsageRecords(db());
  const tag = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const FUTURE = new Date('2999-01-01T00:00:00.000Z');
  const LATER = new Date('2999-01-02T00:00:00.000Z');
  const eventIds: string[] = [];
  const integrationIds: string[] = [];
  const jobIds: string[] = [];
  const invitationIds: string[] = [];

  beforeAll(async () => {
    await db().insert(users).values({ id: userId, username: `setup-usage-${tag}` });
  });

  afterAll(async () => {
    try {
      if (jobIds.length > 0) await db().delete(portfolioSyncJobs).where(inArray(portfolioSyncJobs.id, jobIds));
      if (integrationIds.length > 0) await db().delete(userIntegrations).where(inArray(userIntegrations.id, integrationIds));
      if (invitationIds.length > 0) await db().delete(accountInvitations).where(inArray(accountInvitations.id, invitationIds));
      if (eventIds.length > 0) await db().delete(authIdentityEvents).where(inArray(authIdentityEvents.id, eventIds));
    } finally {
      await closeTestDb();
    }
  });

  it('finds an admin step-up from either kind of accepted code, and is not fooled by a refused one', async () => {
    const event = async (type: string, at: Date) => {
      const [row] = await db().insert(authIdentityEvents).values({ type, sub: `setup-usage-${tag}`, timestamp: at.getTime() }).returning();
      eventIds.push(row.id);
    };
    await event('auth.admin_step_up.succeeded', FUTURE);
    // A refused code, later still, is not a step-up.
    await event('auth.admin_step_up.failed', new Date(LATER.getTime() + 86_400_000));
    expect(await records().adminStepUp()).toEqual({ happened: true, lastAt: FUTURE });

    await event('auth.admin_step_up.backup_code_consumed', LATER);
    expect(await records().adminStepUp()).toEqual({ happened: true, lastAt: LATER });
  });

  it('finds an accepted invitation, not one that is only pending', async () => {
    const invite = async (state: 'pending' | 'accepted', acceptedAt: Date | null) => {
      const invitee = randomUUID();
      await db().insert(users).values({ id: invitee, username: `setup-usage-invitee-${invitee.slice(0, 8)}` });
      const [row] = await db().insert(accountInvitations).values({
        userId: invitee,
        emailOriginal: `invitee-${invitee}@example.test`,
        emailNormalized: `invitee-${invitee}@example.test`,
        inviterUserId: userId,
        intendedUsername: `invitee-${invitee.slice(0, 8)}`,
        state,
        acceptedAt,
        correlationId: randomUUID(),
      }).returning();
      invitationIds.push(row.id);
    };
    await invite('accepted', FUTURE);
    await invite('pending', null);

    expect(await records().invitationAccepted()).toEqual({ happened: true, lastAt: FUTURE });
  });

  it('finds a credential revocation only once the grants were actually revoked', async () => {
    const writer = new PostgresAdminAuditWriter(db(), { resolve: async () => invitationAuditKey });
    const write = (occurredAt: Date, result: 'approved' | 'failed', phase: string) => writer.write({
      occurredAt,
      actorUserId: userId,
      actorSub: `setup-usage-${tag}`,
      actorRole: null,
      actorCapabilityRole: 'account_admin',
      actorConsoleSessionHash: randomBytes(32),
      capability: 'console:admin:accounts',
      elevationAcr: null,
      elevationAmr: [],
      elevationAuthTime: null,
      correlationId: randomUUID(),
      endpoint: 'POST /api/v1/admin/accounts/users/:user_id/credentials/revoke-all',
      operation: CREDENTIALS_REVOKE_ALL_OPERATION,
      resourceKind: 'account_principal',
      resourceId: null,
      targetUserId: null,
      argsRedacted: { operation: 'credentials_revoke_all', phase },
      result,
      errorCode: result === 'failed' ? 'service_unavailable' : null,
      resultDetailRedacted: null,
      clientIp: null,
      userAgent: null,
    });
    // The audit table is append-only and ordered by sequence, so the latest written is the latest read.
    const revokedAt = new Date(Date.now() - 60_000);
    await write(revokedAt, 'approved', 'post_commit_revocation');
    // Neither of these, written afterwards, is a completed revocation.
    await write(new Date(), 'approved', 'state_committed');
    await write(new Date(), 'failed', 'post_commit_revocation');

    expect(await records().credentialsRevoked()).toEqual({ happened: true, lastAt: revokedAt });
  });

  it('finds a connected GitHub integration, and a successful sync only when its repository answered', async () => {
    const [connected] = await db().insert(userIntegrations)
      .values({ userId, provider: 'github' as never, status: 'connected', connectedAt: FUTURE }).returning();
    integrationIds.push(connected.id);

    expect(await records().githubConnected()).toEqual({ happened: true, lastAt: FUTURE });

    const job = async (status: 'succeeded' | 'failed', completedAt: Date, resultSummary: Record<string, unknown>) => {
      const [row] = await db().insert(portfolioSyncJobs).values({
        userId, integrationId: connected.id, direction: 'push', conflictPolicy: 'prefer_local', status,
        startedAt: completedAt, completedAt, resultSummary,
        ...(status === 'failed' ? { operationalErrorCode: 'portfolio_sync_conflict' } : {}),
      }).returning();
      jobIds.push(row.id);
      return row.id;
    };
    await job('succeeded', FUTURE, { provider: 'github', repository: 'dollhouse-portfolio', repository_reached: true });
    // None of these, all later, shows that sync works against a real repository:
    // a failure; a success that asked the repository nothing; and a success
    // from before the evidence was recorded.
    const muchLater = new Date(LATER.getTime() + 86_400_000);
    await job('failed', muchLater, { provider: 'github', repository: 'other', repository_reached: true });
    await job('succeeded', muchLater, { provider: 'github', repository: 'other', repository_reached: false });
    await job('succeeded', muchLater, { provider: 'github' });
    expect(await records().portfolioSyncSucceeded()).toEqual({ happened: true, lastAt: FUTURE, repositoryName: 'dollhouse-portfolio' });

    // A stored name that is not shaped like a repository name is not passed on.
    await job('succeeded', LATER, { provider: 'github', repository: '../../etc/passwd', repository_reached: true });
    expect(await records().portfolioSyncSucceeded()).toEqual({ happened: true, lastAt: LATER, repositoryName: null });
  });
});
