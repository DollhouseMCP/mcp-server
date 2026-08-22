import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import {
  consoleLoginTransactions,
  integrationCuratedProviderState,
  integrationProviderDescriptors,
  users,
  userIntegrations,
} from '../../database/schema/index.js';
import {
  areAuthorizedPermissionsEqual,
  cloneUserIntegrationRecord,
  type DescriptorCallbackConnectInput,
  type DescriptorCredentialConnectInput,
  GITHUB_USER_INTEGRATION_PROVIDER,
  IntegrationAlreadyConnectedError,
  IntegrationCredentialCleanupPendingError,
  IntegrationPrincipalInactiveError,
  type IUserIntegrationStore,
  type UserIntegrationConnectInput,
  type UserIntegrationCleanupCompleteInput,
  type UserIntegrationCleanupClaimInput,
  type UserIntegrationCleanupReleaseInput,
  type UserIntegrationCleanupRenewInput,
  type UserIntegrationCleanupConnectInput,
  type UserIntegrationDisconnectInput,
  type UserIntegrationErrorInput,
  type UserIntegrationProvider,
  type UserIntegrationRefreshInput,
  type UserIntegrationRefreshDecision,
  type UserIntegrationRefreshResult,
  type UserIntegrationRecord,
  validateUserIntegrationRecord,
} from './IUserIntegrationStore.js';
import { ConsoleStoreValidationError, assertHash, assertUuid } from './ConsoleStoreValidation.js';
import { integrationDescriptorRoutingFingerprint } from '../modules/integrations/IntegrationDescriptorRoutingFingerprint.js';
import { fromDescriptorRow } from './PostgresIntegrationDescriptorStore.js';
import { integrationDescriptorMutationKey } from './IIntegrationDescriptorStore.js';

type SystemTransaction = Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0];

class DescriptorCallbackCompletionLeaseExpiredError extends Error {
  constructor() {
    super('descriptor callback completion lease expired');
    this.name = 'DescriptorCallbackCompletionLeaseExpiredError';
  }
}

export class IntegrationRefreshBusyError extends Error {
  constructor() {
    super('integration credential refresh is already in progress');
    this.name = 'IntegrationRefreshBusyError';
  }
}

const REFRESH_LEASE_MS = 60_000;
const REFRESH_CLAIM_DELAYS_MS = [20, 40, 80, 160] as const;

export class PostgresUserIntegrationStore implements IUserIntegrationStore {
  constructor(private readonly db: DatabaseInstance) {}

  async listByUser(userId: string): Promise<readonly UserIntegrationRecord[]> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        isNull(userIntegrations.revokedAt),
      )).orderBy(asc(userIntegrations.provider)).limit(25),
    );
    return rows.map(fromRow);
  }

  async findByProvider(userId: string, provider: UserIntegrationProvider): Promise<UserIntegrationRecord | null> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, provider),
        isNull(userIntegrations.revokedAt),
      )).limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async captureCredentialOperationStartedAt(_requestedAt: Date): Promise<Date> {
    const rows: Array<{ operation_started_at: Date }> = await withSystemContext(this.db, tx =>
      tx.execute(sql`SELECT statement_timestamp() AS operation_started_at`));
    const operationStartedAt = rows[0]?.operation_started_at;
    if (!(operationStartedAt instanceof Date) || !Number.isFinite(operationStartedAt.getTime())) {
      throw new Error('PostgreSQL did not return a valid credential operation watermark');
    }
    return operationStartedAt;
  }

  async connect(input: UserIntegrationConnectInput): Promise<UserIntegrationRecord> {
    validateConnectInput(input);
    const rows = await withSystemContext(this.db, tx => connectWithTx(tx, input));
    if (!rows[0]) throw new Error('PostgreSQL did not return inserted user integration row');
    return fromRow(rows[0]);
  }

  async connectDescriptorCallback(
    input: DescriptorCallbackConnectInput,
  ): Promise<UserIntegrationRecord | null> {
    validateDescriptorCredentialInput(input);
    assertHash(input.transactionIdHash, 'transactionIdHash');

    let row: (typeof userIntegrations.$inferSelect) | null;
    try {
      row = await withSystemContext(this.db, async tx => {
        // Canonical lifecycle order is user -> descriptor -> login transaction.
        // Account deletion, disconnect, refresh, and cleanup all begin with the
        // same stable user row, preventing descriptor/user lock inversions.
        if (!await lockActiveIntegrationPrincipalWithTx(tx, input.connection.userId)) return null;
        if (input.descriptorId && !await descriptorRevisionMatchesWithTx(tx, input)) {
          return null;
        }

        const transactions = await tx.select({
          idHash: consoleLoginTransactions.idHash,
          createdAt: consoleLoginTransactions.createdAt,
          consumedAt: consoleLoginTransactions.consumedAt,
        }).from(consoleLoginTransactions).where(and(
          eq(consoleLoginTransactions.idHash, input.transactionIdHash),
          sql`${consoleLoginTransactions.integrationDescriptorId} IS NOT DISTINCT FROM ${input.descriptorId}`,
          sql`${consoleLoginTransactions.integrationDescriptorFingerprint} IS NOT DISTINCT FROM ${input.descriptorFingerprint}`,
          isNotNull(consoleLoginTransactions.consumedAt),
          // consume() first proves the original deadline, then replaces it with
          // a bounded completion lease. Compare database times so a valid token
          // exchange may finish after the original authorization deadline.
          gt(consoleLoginTransactions.expiresAt, consoleLoginTransactions.consumedAt),
          sql`${consoleLoginTransactions.expiresAt} > statement_timestamp()`,
        )).for('update').limit(1);
        const consumed = transactions[0];
        if (!consumed?.consumedAt) return null;
        // PostgreSQL timestamps can retain microseconds while JavaScript Date
        // has millisecond precision. Compare the returned Date values here;
        // exact SQL equality against the round-tripped input rejects valid rows.
        if (consumed.createdAt.getTime() !== input.authorizationStartedAt.getTime()) return null;
        const newerAuthorizations = await tx.select({ idHash: consoleLoginTransactions.idHash })
          .from(consoleLoginTransactions).where(and(
            eq(consoleLoginTransactions.flowKind, 'integration_link'),
            eq(consoleLoginTransactions.userId, input.connection.userId),
            sql`${consoleLoginTransactions.integrationDescriptorId} IS NOT DISTINCT FROM ${input.descriptorId}`,
            sql`${consoleLoginTransactions.idHash} <> ${input.transactionIdHash}`,
            gt(consoleLoginTransactions.createdAt, consumed.createdAt),
            sql`${consoleLoginTransactions.expiresAt} > statement_timestamp()`,
          )).limit(1);
        if (newerAuthorizations.length > 0) return null;

        const connected = await connectWithTx(tx, {
          ...input.connection,
          authorizationStartedAt: consumed.createdAt,
        }, consumed.createdAt, true);
        if (!connected[0]) return null;
        const completed = await tx.update(consoleLoginTransactions).set({
          expiresAt: consumed.consumedAt,
        }).where(and(
          eq(consoleLoginTransactions.idHash, input.transactionIdHash),
          gt(consoleLoginTransactions.expiresAt, consoleLoginTransactions.consumedAt),
          // Re-check at the final write. Throwing rolls back connectWithTx if
          // the lease expired while credential persistence was waiting.
          sql`${consoleLoginTransactions.expiresAt} > statement_timestamp()`,
        )).returning({ idHash: consoleLoginTransactions.idHash });
        if (completed.length === 0) {
          throw new DescriptorCallbackCompletionLeaseExpiredError();
        }
        return connected[0] ?? null;
      });
    } catch (error) {
      if (error instanceof DescriptorCallbackCompletionLeaseExpiredError
          || error instanceof IntegrationCredentialCleanupPendingError) return null;
      throw error;
    }
    return row ? fromRow(row) : null;
  }

  async connectDescriptorCredential(
    input: DescriptorCredentialConnectInput,
  ): Promise<UserIntegrationRecord | null> {
    validateDescriptorCredentialInput(input);
    const row = await withSystemContext(this.db, async tx => {
      if (!await lockActiveIntegrationPrincipalWithTx(tx, input.connection.userId)) return null;
      if (!await descriptorRevisionMatchesWithTx(tx, input)) return null;
      const connected = await connectWithTx(tx, input.connection, input.operationStartedAt, true);
      return connected[0] ?? null;
    });
    return row ? fromRow(row) : null;
  }

  async refresh(input: UserIntegrationRefreshInput): Promise<UserIntegrationRefreshResult> {
    assertUuid(input.userId, 'userId');
    if (input.integrationDescriptorId) {
      assertUuid(input.integrationDescriptorId, 'integrationDescriptorId');
    }
    const leaseId = randomUUID();
    const claimed = await this.claimRefresh(input, leaseId);
    if ('result' in claimed) return claimed.result;
    const current = claimed.record;
    let decision: UserIntegrationRefreshDecision;
    try {
      // Provider I/O remains outside a DB transaction. The durable lease keeps
      // other replicas out, while refreshFence prevents an expired owner from
      // committing after disconnect or a replacement lease wins.
      decision = await input.refresh(current);
    } catch (error) {
      await this.releaseRefreshLease(current.id, leaseId, claimed.refreshFence);
      throw error;
    }
    if (decision.kind === 'retryable') {
      await this.releaseRefreshLease(current.id, leaseId, claimed.refreshFence);
      const winner = await this.findRefreshCandidate(input);
      if (!winner || winner.status === 'revoked') return { kind: 'missing', record: null };
      if (winner.status === 'error') return { kind: 'failed', record: winner };
      return credentialsDiffer(winner, current)
        ? { kind: 'reused', record: winner }
        : { kind: 'retryable', record: winner };
    }
    let updated: (typeof userIntegrations.$inferSelect)[];
    try {
      updated = await withSystemContext(this.db, async tx => {
      await lockIntegrationLifecycleWithTx(tx, input.userId);
      const update = decision.kind === 'refreshed'
        ? {
            accessTokenCiphertext: decision.accessTokenCiphertext,
            refreshTokenCiphertext: decision.refreshTokenCiphertext,
            credentialKeyVersion: decision.credentialKeyVersion ?? current.credentialKeyVersion,
            authorizedPermissions: decision.authorizedPermissions ?? current.authorizedPermissions,
            credentialGeneration: sql`${userIntegrations.credentialGeneration} + 1`,
            status: 'connected' as const,
            errorReason: null,
            refreshLeaseId: null,
            refreshLeaseExpiresAt: null,
          }
        : {
            status: 'error' as const,
            errorReason: decision.errorReason,
            refreshLeaseId: null,
            refreshLeaseExpiresAt: null,
          };
      const allowedStatuses = decision.kind === 'refreshed'
        ? inArray(userIntegrations.status, ['connected', 'error'])
        : eq(userIntegrations.status, 'connected');
      return tx.update(userIntegrations).set(update).where(and(
        eq(userIntegrations.id, current.id),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        sql`${userIntegrations.integrationDescriptorId} IS NOT DISTINCT FROM ${input.integrationDescriptorId}`,
        allowedStatuses,
        isNull(userIntegrations.revokedAt),
        eq(userIntegrations.refreshLeaseId, leaseId),
        eq(userIntegrations.refreshFence, claimed.refreshFence),
        eq(userIntegrations.credentialGeneration, current.credentialGeneration),
        eq(userIntegrations.accessTokenCiphertext, input.staleAccessTokenCiphertext),
        eq(userIntegrations.credentialGeneration, input.staleCredentialGeneration),
        eq(userIntegrations.authorizedPermissions, input.staleAuthorizedPermissions),
        sql`${userIntegrations.refreshTokenCiphertext} IS NOT DISTINCT FROM ${current.refreshTokenCiphertext}`,
        sql`${userIntegrations.credentialKeyVersion} IS NOT DISTINCT FROM ${current.credentialKeyVersion}`,
        eq(userIntegrations.authorizedPermissions, current.authorizedPermissions),
      )).returning();
      });
    } catch (error) {
      await this.releaseRefreshLease(current.id, leaseId, claimed.refreshFence);
      throw error;
    }
    if (updated[0]) return { kind: decision.kind, record: fromRow(updated[0]) };

    if (decision.kind === 'refreshed') {
      // Persist a provider-minted credential before releasing the refresh
      // fence. A concurrent disconnect can then never return success while a
      // newly minted token remains untracked.
      const cleanupRows = await withSystemContext(this.db, async tx => {
        await lockIntegrationLifecycleWithTx(tx, input.userId);
        await tx.update(userIntegrations).set({
          refreshLeaseId: null,
          refreshLeaseExpiresAt: null,
        }).where(and(
          eq(userIntegrations.id, current.id),
          eq(userIntegrations.refreshLeaseId, leaseId),
          eq(userIntegrations.refreshFence, claimed.refreshFence),
        ));
        return tx.insert(userIntegrations).values({
          userId: input.userId,
          provider: input.provider,
          integrationDescriptorId: input.integrationDescriptorId,
          externalAccountLabel: current.externalAccountLabel,
          externalInstallationId: current.externalInstallationId,
          authorizedPermissions: decision.authorizedPermissions ?? current.authorizedPermissions,
          accessTokenCiphertext: decision.accessTokenCiphertext,
          refreshTokenCiphertext: decision.refreshTokenCiphertext,
          credentialKeyVersion: decision.credentialKeyVersion ?? current.credentialKeyVersion,
          credentialGeneration: 0,
          refreshFence: 0,
          refreshLeaseId: null,
          refreshLeaseExpiresAt: null,
          status: 'cleanup_pending',
          errorReason: 'revocation_failed',
          authorizationStartedAt: current.authorizationStartedAt ?? current.connectedAt ?? sql`statement_timestamp()`,
          connectedAt: sql`statement_timestamp()`,
          lastSyncAt: null,
          revokedAt: sql`statement_timestamp()`,
        }).returning();
      });
      if (cleanupRows[0]) return { kind: 'retryable', record: fromRow(cleanupRows[0]) };
    }

    await this.releaseRefreshLease(current.id, leaseId, claimed.refreshFence);
    const winner = await this.findRefreshCandidate(input);
    if (winner?.status === 'connected' && credentialsDiffer(winner, current)) {
      return { kind: 'reused', record: winner };
    }
    if (winner?.status === 'error') return { kind: 'failed', record: winner };
    return winner ? { kind: 'retryable', record: winner } : { kind: 'missing', record: null };
  }

  private async claimRefresh(
    input: UserIntegrationRefreshInput,
    leaseId: string,
  ): Promise<
    | { readonly record: UserIntegrationRecord; readonly refreshFence: number }
    | { readonly result: UserIntegrationRefreshResult }
  > {
    for (let attempt = 0; attempt <= REFRESH_CLAIM_DELAYS_MS.length; attempt++) {
      const rows = await withSystemContext(this.db, async tx => {
        await lockIntegrationLifecycleWithTx(tx, input.userId);
        return tx.update(userIntegrations).set({
          refreshLeaseId: leaseId,
          refreshLeaseExpiresAt: sql`statement_timestamp() + (${REFRESH_LEASE_MS} * interval '1 millisecond')`,
          refreshFence: sql`${userIntegrations.refreshFence} + 1`,
        }).where(and(
          eq(userIntegrations.userId, input.userId),
          eq(userIntegrations.provider, input.provider),
          sql`${userIntegrations.integrationDescriptorId} IS NOT DISTINCT FROM ${input.integrationDescriptorId}`,
          eq(userIntegrations.status, 'connected'),
          isNull(userIntegrations.revokedAt),
          eq(userIntegrations.accessTokenCiphertext, input.staleAccessTokenCiphertext),
          eq(userIntegrations.credentialGeneration, input.staleCredentialGeneration),
          eq(userIntegrations.authorizedPermissions, input.staleAuthorizedPermissions),
          or(
            isNull(userIntegrations.refreshLeaseId),
            sql`${userIntegrations.refreshLeaseExpiresAt} <= statement_timestamp()`,
          ),
        )).returning();
      });
      if (rows[0]) {
        return { record: fromRow(rows[0]), refreshFence: rows[0].refreshFence };
      }

      const winner = await this.findRefreshCandidate(input);
      if (!winner || winner.status === 'revoked') return { result: { kind: 'missing', record: null } };
      if (winner.status === 'error') return { result: { kind: 'failed', record: winner } };
      if (!winner.accessTokenCiphertext?.equals(input.staleAccessTokenCiphertext)) {
        return { result: { kind: 'reused', record: winner } };
      }
      if (winner.credentialGeneration !== input.staleCredentialGeneration
          || !areAuthorizedPermissionsEqual(winner.authorizedPermissions, input.staleAuthorizedPermissions)) {
        return { result: { kind: 'reused', record: winner } };
      }
      const delay = REFRESH_CLAIM_DELAYS_MS[attempt];
      if (delay === undefined) throw new IntegrationRefreshBusyError();
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw new IntegrationRefreshBusyError();
  }

  private async releaseRefreshLease(id: string, leaseId: string, refreshFence: number): Promise<void> {
    await withSystemContext(this.db, tx => tx.update(userIntegrations).set({
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
    }).where(and(
      eq(userIntegrations.id, id),
      eq(userIntegrations.refreshLeaseId, leaseId),
      eq(userIntegrations.refreshFence, refreshFence),
    )));
  }

  private async findRefreshCandidate(input: UserIntegrationRefreshInput): Promise<UserIntegrationRecord | null> {
    const rows = await withSystemContext(this.db, tx => tx.select().from(userIntegrations).where(and(
      eq(userIntegrations.userId, input.userId),
      eq(userIntegrations.provider, input.provider),
      sql`${userIntegrations.integrationDescriptorId} IS NOT DISTINCT FROM ${input.integrationDescriptorId}`,
      isNull(userIntegrations.revokedAt),
    )).limit(1));
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async recordError(input: UserIntegrationErrorInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    const rows = await withSystemContext(this.db, async tx => {
      assertUuid(input.integrationId, 'integrationId');
      await lockIntegrationLifecycleWithTx(tx, input.userId);
      const revoked = await tx.update(userIntegrations).set({
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        refreshFence: sql`${userIntegrations.refreshFence} + 1`,
        status: sql`CASE
          WHEN ${userIntegrations.accessTokenCiphertext} IS NOT NULL
            OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL
          THEN 'cleanup_pending'
          ELSE 'revoked'
        END`,
        errorReason: sql`CASE
          WHEN ${userIntegrations.accessTokenCiphertext} IS NOT NULL
            OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL
          THEN 'revocation_failed'
          ELSE NULL
        END`,
        revokedAt: input.occurredAt,
      }).where(and(
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.id, input.integrationId),
        eq(userIntegrations.credentialGeneration, input.credentialGeneration),
        isNull(userIntegrations.revokedAt),
      )).returning({ id: userIntegrations.id });
      if (revoked.length === 0) return [];
      return tx.insert(userIntegrations).values({
        userId: input.userId,
        provider: input.provider,
        integrationDescriptorId: input.integrationDescriptorId ?? null,
        externalAccountLabel: null,
        externalInstallationId: null,
        authorizedPermissions: defaultAuthorizedPermissions(input.provider),
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        credentialKeyVersion: null,
        credentialGeneration: 0,
        status: 'error',
        errorReason: input.errorReason,
        authorizationStartedAt: null,
        connectedAt: null,
        lastSyncAt: null,
        revokedAt: null,
      }).returning();
    });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async disconnect(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.integrationId, 'integrationId');
    const rows = await withSystemContext(this.db, async tx => {
      await lockIntegrationLifecycleWithTx(tx, input.userId);
      return tx.update(userIntegrations).set({
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        refreshFence: sql`${userIntegrations.refreshFence} + 1`,
        status: 'revoked',
        errorReason: null,
        revokedAt: input.revokedAt,
      }).where(and(
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.id, input.integrationId),
        eq(userIntegrations.credentialGeneration, input.credentialGeneration),
        isNull(userIntegrations.revokedAt),
      )).returning();
    });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async queueCredentialCleanup(input: UserIntegrationCleanupConnectInput): Promise<UserIntegrationRecord> {
    validateConnectInput(input);
    if (!(input.cleanupRequestedAt instanceof Date) || Number.isNaN(input.cleanupRequestedAt.getTime())) {
      throw new ConsoleStoreValidationError('cleanupRequestedAt must be a valid date');
    }
    const rows = await withSystemContext(this.db, async tx => {
      await lockIntegrationLifecycleWithTx(tx, input.userId);
      return tx.insert(userIntegrations).values({
        userId: input.userId,
        provider: input.provider,
        integrationDescriptorId: input.integrationDescriptorId ?? null,
        externalAccountLabel: input.externalAccountLabel,
        externalInstallationId: input.externalInstallationId,
        authorizedPermissions: input.authorizedPermissions,
        accessTokenCiphertext: input.accessTokenCiphertext,
        refreshTokenCiphertext: input.refreshTokenCiphertext,
        credentialKeyVersion: input.credentialKeyVersion ?? null,
        credentialGeneration: 0,
        refreshFence: 0,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        status: 'cleanup_pending',
        errorReason: 'revocation_failed',
        authorizationStartedAt: input.authorizationStartedAt ?? input.connectedAt,
        connectedAt: input.connectedAt,
        lastSyncAt: null,
        revokedAt: input.cleanupRequestedAt,
      }).returning();
    });
    if (!rows[0]) throw new Error('PostgreSQL did not return queued integration cleanup row');
    return fromRow(rows[0]);
  }

  async markCredentialCleanupPending(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.integrationId, 'integrationId');
    const rows = await withSystemContext(this.db, async tx => {
      await lockIntegrationLifecycleWithTx(tx, input.userId);
      return tx.update(userIntegrations).set({
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        refreshFence: sql`${userIntegrations.refreshFence} + 1`,
        status: 'cleanup_pending',
        errorReason: 'revocation_failed',
        revokedAt: input.revokedAt,
      }).where(and(
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.id, input.integrationId),
        eq(userIntegrations.credentialGeneration, input.credentialGeneration),
        isNull(userIntegrations.revokedAt),
        or(isNotNull(userIntegrations.accessTokenCiphertext), isNotNull(userIntegrations.refreshTokenCiphertext)),
      )).returning();
    });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async beginAuthorizationDisconnect(
    userId: string,
    provider: UserIntegrationProvider,
    _requestedAt: Date,
  ): Promise<UserIntegrationRecord | null> {
    assertUuid(userId, 'userId');
    const row = await withSystemContext(this.db, async tx => {
      await lockIntegrationLifecycleWithTx(tx, userId);
      const activeRows = await tx.select().from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, provider),
        isNull(userIntegrations.revokedAt),
      )).for('update').limit(1);
      const active = activeRows[0];
      let disconnected: (typeof userIntegrations.$inferSelect) | null = null;
      if (active) {
        const hasCredentials = active.accessTokenCiphertext !== null || active.refreshTokenCiphertext !== null;
        const updated = await tx.update(userIntegrations).set({
          // Preserve an in-flight refresh lease. Cleanup cannot claim the row
          // until refresh settles and releases it, or the lease expires after
          // a crashed worker. Incrementing the fence prevents token commit.
          refreshLeaseId: hasCredentials ? active.refreshLeaseId : null,
          refreshLeaseExpiresAt: hasCredentials ? active.refreshLeaseExpiresAt : null,
          refreshFence: sql`${userIntegrations.refreshFence} + 1`,
          status: hasCredentials ? 'cleanup_pending' : 'revoked',
          errorReason: hasCredentials ? 'revocation_failed' : null,
          revokedAt: sql`statement_timestamp()`,
        }).where(eq(userIntegrations.id, active.id)).returning();
        disconnected = updated[0] ?? null;
      }
      await tx.insert(userIntegrations).values({
        userId,
        provider,
        integrationDescriptorId: null,
        externalAccountLabel: null,
        externalInstallationId: null,
        authorizedPermissions: defaultAuthorizedPermissions(provider),
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        credentialKeyVersion: null,
        credentialGeneration: 0,
        refreshFence: 0,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        status: 'revoked',
        errorReason: null,
        authorizationStartedAt: sql`statement_timestamp()`,
        connectedAt: null,
        lastSyncAt: null,
        revokedAt: sql`statement_timestamp()`,
      });
      return disconnected;
    });
    return row ? fromRow(row) : null;
  }

  async listCredentialCleanup(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<readonly UserIntegrationRecord[]> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx => tx.select().from(userIntegrations).where(and(
      eq(userIntegrations.userId, userId),
      eq(userIntegrations.provider, provider),
      eq(userIntegrations.status, 'cleanup_pending'),
      isNotNull(userIntegrations.revokedAt),
    )).orderBy(asc(userIntegrations.revokedAt)));
    return rows.map(fromRow);
  }

  async claimCredentialCleanup(
    input: UserIntegrationCleanupClaimInput,
  ): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.integrationId, 'integrationId');
    assertUuid(input.cleanupLeaseId, 'cleanupLeaseId');
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new ConsoleStoreValidationError('leaseDurationMs must be a positive safe integer');
    }
    const rows = await withSystemContext(this.db, async tx => {
      await lockIntegrationLifecycleWithTx(tx, input.userId);
      return tx.update(userIntegrations).set({
        refreshLeaseId: input.cleanupLeaseId,
        refreshLeaseExpiresAt: sql`statement_timestamp() + (${input.leaseDurationMs} * interval '1 millisecond')`,
        refreshFence: sql`${userIntegrations.refreshFence} + 1`,
      }).where(and(
        eq(userIntegrations.id, input.integrationId),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.status, 'cleanup_pending'),
        eq(userIntegrations.credentialGeneration, input.credentialGeneration),
        or(
          isNull(userIntegrations.refreshLeaseId),
          sql`${userIntegrations.refreshLeaseExpiresAt} <= statement_timestamp()`,
        ),
      )).returning();
    });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async releaseCredentialCleanupClaim(input: UserIntegrationCleanupReleaseInput): Promise<void> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.integrationId, 'integrationId');
    assertUuid(input.cleanupLeaseId, 'cleanupLeaseId');
    await withSystemContext(this.db, async tx => {
      await lockIntegrationLifecycleWithTx(tx, input.userId);
      await tx.update(userIntegrations).set({
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
      }).where(and(
        eq(userIntegrations.id, input.integrationId),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.status, 'cleanup_pending'),
        eq(userIntegrations.refreshLeaseId, input.cleanupLeaseId),
      ));
    });
  }

  async renewCredentialCleanupClaim(input: UserIntegrationCleanupRenewInput): Promise<boolean> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.integrationId, 'integrationId');
    assertUuid(input.cleanupLeaseId, 'cleanupLeaseId');
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new ConsoleStoreValidationError('leaseDurationMs must be a positive safe integer');
    }
    const rows = await withSystemContext(this.db, async tx => {
      await lockIntegrationLifecycleWithTx(tx, input.userId);
      return tx.update(userIntegrations).set({
        refreshLeaseExpiresAt: sql`statement_timestamp() + (${input.leaseDurationMs} * interval '1 millisecond')`,
      }).where(and(
        eq(userIntegrations.id, input.integrationId),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.status, 'cleanup_pending'),
        eq(userIntegrations.credentialGeneration, input.credentialGeneration),
        eq(userIntegrations.refreshLeaseId, input.cleanupLeaseId),
      )).returning({ id: userIntegrations.id });
    });
    return rows.length > 0;
  }

  async completeCredentialCleanup(
    input: UserIntegrationCleanupCompleteInput,
  ): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.integrationId, 'integrationId');
    const rows = await withSystemContext(this.db, async tx => {
      await lockIntegrationLifecycleWithTx(tx, input.userId);
      return tx.update(userIntegrations).set({
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        credentialKeyVersion: null,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        refreshFence: sql`${userIntegrations.refreshFence} + 1`,
        status: 'revoked',
        errorReason: null,
        revokedAt: input.completedAt,
      }).where(and(
        eq(userIntegrations.id, input.integrationId),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.status, 'cleanup_pending'),
        eq(userIntegrations.credentialGeneration, input.credentialGeneration),
        eq(userIntegrations.refreshLeaseId, input.cleanupLeaseId),
      )).returning();
    });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async hasCredentialCleanupPending(userId: string, provider: UserIntegrationProvider): Promise<boolean> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx => tx.select({ id: userIntegrations.id })
      .from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, provider),
        eq(userIntegrations.status, 'cleanup_pending'),
      )).limit(1));
    return rows.length > 0;
  }

  async hasAnyCredentialMaterial(userId: string): Promise<boolean> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx => tx.select({ id: userIntegrations.id })
      .from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        or(
          isNotNull(userIntegrations.accessTokenCiphertext),
          isNotNull(userIntegrations.refreshTokenCiphertext),
        ),
      )).limit(1));
    return rows.length > 0;
  }

  async hasCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean> {
    assertUuid(integrationDescriptorId, 'integrationDescriptorId');
    const rows = await withSystemContext(this.db, tx => tx.select({ id: userIntegrations.id })
      .from(userIntegrations).where(and(
        eq(userIntegrations.integrationDescriptorId, integrationDescriptorId),
        or(
          isNotNull(userIntegrations.accessTokenCiphertext),
          isNotNull(userIntegrations.refreshTokenCiphertext),
        ),
      )).limit(1));
    return rows.length > 0;
  }

  async hasExecutableCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean> {
    assertUuid(integrationDescriptorId, 'integrationDescriptorId');
    const rows = await withSystemContext(this.db, tx => tx.select({ id: userIntegrations.id })
      .from(userIntegrations).where(and(
        eq(userIntegrations.integrationDescriptorId, integrationDescriptorId),
        isNull(userIntegrations.revokedAt),
        or(
          isNotNull(userIntegrations.accessTokenCiphertext),
          isNotNull(userIntegrations.refreshTokenCiphertext),
        ),
      )).limit(1));
    return rows.length > 0;
  }

  async revokeAllByDescriptor(integrationDescriptorId: string, revokedAt: Date): Promise<number> {
    assertUuid(integrationDescriptorId, 'integrationDescriptorId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(userIntegrations).set({
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        refreshFence: sql`${userIntegrations.refreshFence} + 1`,
        status: sql`CASE
          WHEN ${userIntegrations.accessTokenCiphertext} IS NOT NULL
            OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL
          THEN 'cleanup_pending'
          ELSE 'revoked'
        END`,
        errorReason: sql`CASE
          WHEN ${userIntegrations.accessTokenCiphertext} IS NOT NULL
            OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL
          THEN 'revocation_failed'
          ELSE NULL
        END`,
        revokedAt,
      }).where(and(
        eq(userIntegrations.integrationDescriptorId, integrationDescriptorId),
        isNull(userIntegrations.revokedAt),
      )).returning({ id: userIntegrations.id }),
    );
    return rows.length;
  }
}

function credentialsDiffer(left: UserIntegrationRecord, right: UserIntegrationRecord): boolean {
  return !buffersEqual(left.accessTokenCiphertext, right.accessTokenCiphertext)
    || !buffersEqual(left.refreshTokenCiphertext, right.refreshTokenCiphertext)
    || left.credentialKeyVersion !== right.credentialKeyVersion
    || left.credentialGeneration !== right.credentialGeneration
    || !areAuthorizedPermissionsEqual(left.authorizedPermissions, right.authorizedPermissions);
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

async function connectWithTx(
  tx: SystemTransaction,
  input: UserIntegrationConnectInput,
  authorizationStartedAt?: Date,
  lifecycleLocked = false,
): Promise<(typeof userIntegrations.$inferSelect)[]> {
  // A real row lock serializes lifecycle decisions even when no integration row
  // exists yet. SELECT FOR UPDATE on an empty integration result locks nothing.
  if (!lifecycleLocked && !await lockActiveIntegrationPrincipalWithTx(tx, input.userId)) {
    throw new IntegrationPrincipalInactiveError();
  }
  const pendingCleanup = await tx.select({ id: userIntegrations.id })
    .from(userIntegrations).where(and(
      eq(userIntegrations.userId, input.userId),
      eq(userIntegrations.provider, input.provider),
      eq(userIntegrations.status, 'cleanup_pending'),
    )).limit(1);
  if (pendingCleanup.length > 0) throw new IntegrationCredentialCleanupPendingError();

  const activeRows = await tx.select({
    id: userIntegrations.id,
    accessTokenCiphertext: userIntegrations.accessTokenCiphertext,
    refreshTokenCiphertext: userIntegrations.refreshTokenCiphertext,
    authorizationStartedAt: userIntegrations.authorizationStartedAt,
    connectedAt: userIntegrations.connectedAt,
  }).from(userIntegrations).where(and(
    eq(userIntegrations.userId, input.userId),
    eq(userIntegrations.provider, input.provider),
    isNull(userIntegrations.revokedAt),
  )).limit(1);
  const active = activeRows[0];
  if (active) {
    if (!authorizationStartedAt && (active.accessTokenCiphertext || active.refreshTokenCiphertext)) {
      throw new IntegrationAlreadyConnectedError();
    }
  }

  if (authorizationStartedAt) {
    const latestRows = await tx.select({
      authorizationStartedAt: userIntegrations.authorizationStartedAt,
      connectedAt: userIntegrations.connectedAt,
    }).from(userIntegrations).where(and(
      eq(userIntegrations.userId, input.userId),
      eq(userIntegrations.provider, input.provider),
      or(isNotNull(userIntegrations.authorizationStartedAt), isNotNull(userIntegrations.connectedAt)),
    )).orderBy(desc(userIntegrations.authorizationStartedAt), desc(userIntegrations.connectedAt)).limit(1);
    const latestAuthorization = latestRows[0]?.authorizationStartedAt ?? latestRows[0]?.connectedAt;
    if (latestAuthorization && latestAuthorization >= authorizationStartedAt) {
      return [];
    }
  }
  await tx.update(userIntegrations).set({
    refreshLeaseId: null,
    refreshLeaseExpiresAt: null,
    refreshFence: sql`${userIntegrations.refreshFence} + 1`,
    status: sql`CASE
      WHEN ${userIntegrations.accessTokenCiphertext} IS NOT NULL
        OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL
      THEN 'cleanup_pending'
      ELSE 'revoked'
    END`,
    errorReason: sql`CASE
      WHEN ${userIntegrations.accessTokenCiphertext} IS NOT NULL
        OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL
      THEN 'revocation_failed'
      ELSE NULL
    END`,
    revokedAt: input.connectedAt,
  }).where(and(
    eq(userIntegrations.userId, input.userId),
    eq(userIntegrations.provider, input.provider),
    isNull(userIntegrations.revokedAt),
  ));
  return tx.insert(userIntegrations).values({
    userId: input.userId,
    provider: input.provider,
    integrationDescriptorId: input.integrationDescriptorId ?? null,
    externalAccountLabel: input.externalAccountLabel,
    externalInstallationId: input.externalInstallationId,
    authorizedPermissions: input.authorizedPermissions,
    accessTokenCiphertext: input.accessTokenCiphertext,
    refreshTokenCiphertext: input.refreshTokenCiphertext,
    credentialKeyVersion: input.credentialKeyVersion ?? null,
    credentialGeneration: 0,
    refreshFence: 0,
    refreshLeaseId: null,
    refreshLeaseExpiresAt: null,
    status: 'connected',
    errorReason: null,
    authorizationStartedAt: input.authorizationStartedAt ?? input.connectedAt,
    connectedAt: input.connectedAt,
    lastSyncAt: null,
    revokedAt: null,
  }).returning();
}

async function lockIntegrationLifecycleWithTx(tx: SystemTransaction, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users)
    .where(eq(users.id, userId)).for('update').limit(1);
}

async function lockActiveIntegrationPrincipalWithTx(
  tx: SystemTransaction,
  userId: string,
): Promise<boolean> {
  const rows = await tx.select({ id: users.id }).from(users).where(and(
    eq(users.id, userId),
    isNull(users.disabledAt),
    isNull(users.deletedAt),
  )).for('update').limit(1);
  return rows.length > 0;
}

function validateDescriptorCredentialInput(input: DescriptorCredentialConnectInput | DescriptorCallbackConnectInput): void {
  if (input.descriptorId) assertUuid(input.descriptorId, 'descriptorId');
  if (input.descriptorId && !/^[a-f0-9]{64}$/.test(input.descriptorFingerprint ?? '')) {
    throw new ConsoleStoreValidationError('descriptorFingerprint must be a lowercase 256-bit hex fingerprint');
  }
  if (!input.descriptorId && input.descriptorFingerprint) {
    throw new ConsoleStoreValidationError('descriptorFingerprint requires descriptorId');
  }
  validateConnectInput(input.connection);
  if ((input.connection.integrationDescriptorId ?? null) !== input.descriptorId) {
    throw new ConsoleStoreValidationError(
      'descriptor credential must use the expected integration descriptor',
    );
  }
}

async function descriptorRevisionMatchesWithTx(
  tx: SystemTransaction,
  input: DescriptorCredentialConnectInput | DescriptorCallbackConnectInput,
): Promise<boolean> {
  if (!input.descriptorId) return false;
  const initialRows = await tx.select().from(integrationProviderDescriptors)
    .where(eq(integrationProviderDescriptors.id, input.descriptorId))
    .limit(1);
  const initial = initialRows[0] ? fromDescriptorRow(initialRows[0]) : null;
  if (!initial) return false;
  const mutationKey = integrationDescriptorMutationKey(initial);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${mutationKey}, 0))`);
  let curatedEnabled = true;
  if (initial.ownership === 'curated') {
    const states = await tx.select({ enabled: integrationCuratedProviderState.enabled })
      .from(integrationCuratedProviderState)
      .where(eq(integrationCuratedProviderState.provider, initial.provider))
      .limit(1);
    curatedEnabled = states[0]?.enabled !== false;
  }
  const descriptors = await tx.select().from(integrationProviderDescriptors)
    .where(eq(integrationProviderDescriptors.id, input.descriptorId))
    // Routing fields are non-key columns, so KEY SHARE would still allow an
    // admin update to race credential persistence after this fingerprint check.
    .for('update')
    .limit(1);
  const descriptor = descriptors[0] ? fromDescriptorRow(descriptors[0]) : null;
  return descriptor !== null
    && integrationDescriptorMutationKey(descriptor) === mutationKey
    && (descriptor.ownership !== 'curated' || (initial.ownership === 'curated' && curatedEnabled))
    && integrationDescriptorRoutingFingerprint(descriptor) === input.descriptorFingerprint;
}

function validateConnectInput(input: UserIntegrationConnectInput): void {
  validateUserIntegrationRecord({
    id: '00000000-0000-4000-8000-000000000000',
    userId: input.userId,
    provider: input.provider,
    integrationDescriptorId: input.integrationDescriptorId ?? null,
    externalAccountLabel: input.externalAccountLabel,
    externalInstallationId: input.externalInstallationId,
    authorizedPermissions: input.authorizedPermissions,
    accessTokenCiphertext: input.accessTokenCiphertext,
    refreshTokenCiphertext: input.refreshTokenCiphertext,
    credentialKeyVersion: null,
    credentialGeneration: 0,
    status: 'connected',
    errorReason: null,
    authorizationStartedAt: input.authorizationStartedAt ?? input.connectedAt,
    connectedAt: input.connectedAt,
    lastSyncAt: null,
    revokedAt: null,
  });
}

function defaultAuthorizedPermissions(provider: UserIntegrationProvider): Readonly<Record<string, unknown>> {
  if (provider === GITHUB_USER_INTEGRATION_PROVIDER) {
    return {
      repository_selection: 'unknown',
      permissions: { contents: 'none' },
    };
  }
  return { scopes: [] };
}

function fromRow(row: typeof userIntegrations.$inferSelect): UserIntegrationRecord {
  const record: UserIntegrationRecord = {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    integrationDescriptorId: row.integrationDescriptorId,
    externalAccountLabel: row.externalAccountLabel,
    externalInstallationId: row.externalInstallationId,
    authorizedPermissions: asJsonRecord(row.authorizedPermissions),
    accessTokenCiphertext: row.accessTokenCiphertext,
    refreshTokenCiphertext: row.refreshTokenCiphertext,
    credentialKeyVersion: row.credentialKeyVersion,
    credentialGeneration: row.credentialGeneration ?? 0,
    status: row.status,
    errorReason: row.errorReason,
    authorizationStartedAt: row.authorizationStartedAt
      ?? (row.status === 'connected' ? row.connectedAt : null),
    connectedAt: row.connectedAt,
    lastSyncAt: row.lastSyncAt,
    revokedAt: row.revokedAt,
  };
  validateUserIntegrationRecord(record);
  return cloneUserIntegrationRecord(record);
}

function asJsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
