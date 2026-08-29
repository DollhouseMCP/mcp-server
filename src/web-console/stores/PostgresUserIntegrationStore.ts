import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import {
  consoleLoginTransactions,
  integrationProviderDescriptors,
  userIntegrations,
} from '../../database/schema/index.js';
import {
  cloneUserIntegrationRecord,
  type DescriptorCallbackConnectInput,
  type DescriptorCredentialConnectInput,
  GITHUB_USER_INTEGRATION_PROVIDER,
  IntegrationCredentialCleanupPendingError,
  type IUserIntegrationStore,
  type UserIntegrationCleanupAbandonInput,
  type UserIntegrationCleanupClaimInput,
  type UserIntegrationCleanupCompleteInput,
  type UserIntegrationCleanupFailInput,
  type UserIntegrationCleanupReleaseInput,
  type UserIntegrationConnectInput,
  type UserIntegrationDisconnectInput,
  type UserIntegrationErrorInput,
  type UserIntegrationProvider,
  type UserIntegrationRefreshInput,
  type UserIntegrationRefreshResult,
  type UserIntegrationRecord,
  validateUserIntegrationRecord,
} from './IUserIntegrationStore.js';
import { ConsoleStoreValidationError, assertHash, assertUuid } from './ConsoleStoreValidation.js';
import { integrationDescriptorRoutingFingerprint } from '../modules/integrations/IntegrationDescriptorRoutingFingerprint.js';
import { fromDescriptorRow } from './PostgresIntegrationDescriptorStore.js';

type SystemTransaction = Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0];

class DescriptorCallbackCompletionLeaseExpiredError extends Error {
  constructor() {
    super('descriptor callback completion lease expired');
    this.name = 'DescriptorCallbackCompletionLeaseExpiredError';
  }
}

export class PostgresUserIntegrationStore implements IUserIntegrationStore {
  constructor(private readonly db: DatabaseInstance) {}

  async listByUser(
    userId: string,
    providers: readonly UserIntegrationProvider[],
  ): Promise<readonly UserIntegrationRecord[]> {
    assertUuid(userId, 'userId');
    if (providers.length === 0) return [];
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        inArray(userIntegrations.provider, [...providers]),
        sql`(${userIntegrations.revokedAt} IS NULL OR ${userIntegrations.status} IN ('cleanup_pending', 'cleanup_failed'))`,
      )).orderBy(asc(userIntegrations.provider)),
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

  async findCredentialCleanupPending(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<UserIntegrationRecord | null> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, provider),
        eq(userIntegrations.status, 'cleanup_pending'),
      )).limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async findCredentialCleanupFailed(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<UserIntegrationRecord | null> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, provider),
        eq(userIntegrations.status, 'cleanup_failed'),
      )).orderBy(desc(userIntegrations.revokedAt)).limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
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
        if (!await descriptorRevisionMatchesWithTx(tx, input)) {
          return null;
        }

        const transactions = await tx.select({
          idHash: consoleLoginTransactions.idHash,
          consumedAt: consoleLoginTransactions.consumedAt,
        }).from(consoleLoginTransactions).where(and(
          eq(consoleLoginTransactions.idHash, input.transactionIdHash),
          eq(consoleLoginTransactions.integrationDescriptorId, input.descriptorId),
          eq(consoleLoginTransactions.integrationDescriptorFingerprint, input.descriptorFingerprint),
          isNotNull(consoleLoginTransactions.consumedAt),
          // consume() first proves the original deadline, then replaces it with
          // a bounded completion lease. Compare database times so a valid token
          // exchange may finish after the original authorization deadline.
          gt(consoleLoginTransactions.expiresAt, consoleLoginTransactions.consumedAt),
          sql`${consoleLoginTransactions.expiresAt} > statement_timestamp()`,
        )).for('update').limit(1);
        const consumed = transactions.at(0);
        if (!consumed?.consumedAt) return null;

        const connected = await connectWithTx(tx, input.connection);
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
      if (error instanceof DescriptorCallbackCompletionLeaseExpiredError) return null;
      throw error;
    }
    return row ? fromRow(row) : null;
  }

  async connectDescriptorCredential(
    input: DescriptorCredentialConnectInput,
  ): Promise<UserIntegrationRecord | null> {
    validateDescriptorCredentialInput(input);
    const row = await withSystemContext(this.db, async tx => {
      if (!await descriptorRevisionMatchesWithTx(tx, input)) return null;
      const connected = await connectWithTx(tx, input.connection);
      return connected[0] ?? null;
    });
    return row ? fromRow(row) : null;
  }

  async refresh(input: UserIntegrationRefreshInput): Promise<UserIntegrationRefreshResult> {
    assertUuid(input.userId, 'userId');
    if (input.integrationDescriptorId) {
      assertUuid(input.integrationDescriptorId, 'integrationDescriptorId');
    }
    const rows = await withSystemContext(this.db, async tx => {
      const lockedRows: (typeof userIntegrations.$inferSelect)[] = await tx.execute(sql`
        SELECT
          id,
          user_id AS "userId",
          provider,
          integration_descriptor_id AS "integrationDescriptorId",
          external_account_label AS "externalAccountLabel",
          external_installation_id AS "externalInstallationId",
          authorized_permissions AS "authorizedPermissions",
          access_token_ciphertext AS "accessTokenCiphertext",
          refresh_token_ciphertext AS "refreshTokenCiphertext",
          credential_key_version AS "credentialKeyVersion",
          status,
          error_reason AS "errorReason",
          cleanup_attempt_count AS "cleanupAttemptCount",
          cleanup_next_attempt_at AS "cleanupNextAttemptAt",
          cleanup_lease_id AS "cleanupLeaseId",
          cleanup_lease_expires_at AS "cleanupLeaseExpiresAt",
          connected_at AS "connectedAt",
          last_sync_at AS "lastSyncAt",
          revoked_at AS "revokedAt"
        FROM user_integrations
        WHERE user_id = ${input.userId}
          AND provider = ${input.provider}
          AND integration_descriptor_id IS NOT DISTINCT FROM ${input.integrationDescriptorId}
          AND revoked_at IS NULL
        LIMIT 1
        FOR UPDATE
      `);
      const locked = lockedRows[0] ? fromRow(lockedRows[0]) : null;
      if (locked?.status !== 'connected' || !locked.accessTokenCiphertext) {
        return { kind: 'missing' as const, record: null };
      }
      if (!locked.accessTokenCiphertext.equals(input.staleAccessTokenCiphertext)) {
        return { kind: 'reused' as const, record: locked };
      }
      const decision = await input.refresh(locked);
      if (decision.kind === 'refreshed') {
        validateUserIntegrationRecord({
          ...locked,
          accessTokenCiphertext: decision.accessTokenCiphertext,
          refreshTokenCiphertext: decision.refreshTokenCiphertext,
          authorizedPermissions: decision.authorizedPermissions ?? locked.authorizedPermissions,
          credentialKeyVersion: decision.credentialKeyVersion ?? locked.credentialKeyVersion,
          status: 'connected',
          errorReason: null,
          lastSyncAt: input.refreshedAt,
        });
      }
      const update = decision.kind === 'refreshed'
        ? {
            accessTokenCiphertext: decision.accessTokenCiphertext,
            refreshTokenCiphertext: decision.refreshTokenCiphertext,
            authorizedPermissions: decision.authorizedPermissions ?? locked.authorizedPermissions,
            credentialKeyVersion: decision.credentialKeyVersion ?? locked.credentialKeyVersion,
            status: 'connected' as const,
            errorReason: null,
            lastSyncAt: input.refreshedAt,
          }
        : {
            status: 'error' as const,
            errorReason: decision.errorReason,
          };
      const updated = await tx.update(userIntegrations).set(update).where(
        eq(userIntegrations.id, locked.id),
      ).returning();
      return { kind: decision.kind, record: updated[0] ? fromRow(updated[0]) : null };
    });
    if (!rows.record) return { kind: 'missing', record: null };
    return {
      kind: rows.kind,
      record: rows.record,
    };
  }

  async recordError(input: UserIntegrationErrorInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    if (input.expectedActiveRecordId !== null) {
      assertUuid(input.expectedActiveRecordId, 'expectedActiveRecordId');
    }
    const row = await withSystemContext(this.db, async tx => {
      await lockProviderMutation(tx, input.userId, input.provider);
      if (input.errorReason === 'revocation_failed' && input.expectedActiveRecordId !== null) {
        return beginCredentialCleanupWithTx(tx, {
          userId: input.userId,
          provider: input.provider,
          expectedActiveRecordId: input.expectedActiveRecordId,
          revokedAt: input.occurredAt,
        });
      }
      if (input.expectedActiveRecordId !== null) {
        const replaced = await tx.update(userIntegrations).set({
          accessTokenCiphertext: null,
          refreshTokenCiphertext: null,
          status: 'revoked',
          errorReason: null,
          revokedAt: input.occurredAt,
        }).where(and(
          eq(userIntegrations.id, input.expectedActiveRecordId),
          eq(userIntegrations.userId, input.userId),
          eq(userIntegrations.provider, input.provider),
          isNull(userIntegrations.revokedAt),
        )).returning();
        if (!replaced[0]) return findActiveRow(tx, input.userId, input.provider);
      }
      const inserted = await tx.insert(userIntegrations).values({
        userId: input.userId,
        provider: input.provider,
        integrationDescriptorId: input.integrationDescriptorId ?? null,
        externalAccountLabel: null,
        externalInstallationId: null,
        authorizedPermissions: defaultAuthorizedPermissions(input.provider),
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        credentialKeyVersion: null,
        status: 'error',
        errorReason: input.errorReason,
        cleanupAttemptCount: 0,
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
        connectedAt: null,
        lastSyncAt: null,
        revokedAt: null,
      }).onConflictDoNothing().returning();
      return inserted[0] ?? findActiveRow(tx, input.userId, input.provider);
    });
    return row ? fromRow(row) : null;
  }

  async beginCredentialCleanup(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.expectedActiveRecordId, 'expectedActiveRecordId');
    const row = await withSystemContext(this.db, async tx => {
      await lockProviderMutation(tx, input.userId, input.provider);
      return beginCredentialCleanupWithTx(tx, input);
    });
    return row ? fromRow(row) : null;
  }

  async claimCredentialCleanup(input: UserIntegrationCleanupClaimInput): Promise<UserIntegrationRecord | null> {
    validateCleanupClaimInput(input);
    const rows = await withSystemContext(this.db, tx =>
      tx.update(userIntegrations).set({
        cleanupAttemptCount: sql`LEAST(${userIntegrations.cleanupAttemptCount} + 1, 2147483647)`,
        cleanupLeaseId: input.leaseId,
        cleanupLeaseExpiresAt: input.leaseExpiresAt,
      }).where(and(
        eq(userIntegrations.id, input.cleanupRecordId),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.status, 'cleanup_pending'),
        lte(userIntegrations.cleanupNextAttemptAt, input.attemptedAt),
        or(
          isNull(userIntegrations.cleanupLeaseId),
          lte(userIntegrations.cleanupLeaseExpiresAt, input.attemptedAt),
        ),
      )).returning(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async releaseCredentialCleanup(input: UserIntegrationCleanupReleaseInput): Promise<UserIntegrationRecord | null> {
    validateCleanupMutationInput(input);
    const rows = await withSystemContext(this.db, tx =>
      tx.update(userIntegrations).set({
        cleanupNextAttemptAt: input.retryAt,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
      }).where(and(
        eq(userIntegrations.id, input.cleanupRecordId),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.status, 'cleanup_pending'),
        eq(userIntegrations.cleanupLeaseId, input.leaseId),
      )).returning(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async failCredentialCleanup(input: UserIntegrationCleanupFailInput): Promise<UserIntegrationRecord | null> {
    validateCleanupMutationInput(input);
    const rows = await withSystemContext(this.db, tx =>
      tx.update(userIntegrations).set({
        status: 'cleanup_failed',
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
      }).where(and(
        eq(userIntegrations.id, input.cleanupRecordId),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.status, 'cleanup_pending'),
        eq(userIntegrations.cleanupLeaseId, input.leaseId),
      )).returning(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async abandonCredentialCleanupForUser(
    input: UserIntegrationCleanupAbandonInput,
  ): Promise<readonly UserIntegrationRecord[]> {
    assertUuid(input.userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(userIntegrations).set({
        status: 'cleanup_failed',
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
      }).where(and(
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.status, 'cleanup_pending'),
      )).returning(),
    );
    return rows.map(fromRow);
  }

  async completeCredentialCleanup(input: UserIntegrationCleanupCompleteInput): Promise<UserIntegrationRecord | null> {
    validateCleanupMutationInput(input);
    const rows = await withSystemContext(this.db, tx =>
      tx.update(userIntegrations).set({
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        status: 'revoked',
        errorReason: null,
        cleanupAttemptCount: 0,
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
        revokedAt: input.completedAt,
      }).where(and(
        eq(userIntegrations.id, input.cleanupRecordId),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        eq(userIntegrations.status, 'cleanup_pending'),
        eq(userIntegrations.cleanupLeaseId, input.leaseId),
      )).returning(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async hasAnyCredentialMaterial(userId: string): Promise<boolean> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx => tx.select({ id: userIntegrations.id })
      .from(userIntegrations)
      .where(and(
        eq(userIntegrations.userId, userId),
        sql`(${userIntegrations.accessTokenCiphertext} IS NOT NULL OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL)`,
      )).limit(1));
    return rows.length > 0;
  }

  async hasCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean> {
    assertUuid(integrationDescriptorId, 'integrationDescriptorId');
    const rows = await withSystemContext(this.db, tx => tx.select({ id: userIntegrations.id })
      .from(userIntegrations)
      .where(and(
        eq(userIntegrations.integrationDescriptorId, integrationDescriptorId),
        sql`(${userIntegrations.accessTokenCiphertext} IS NOT NULL OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL)`,
      )).limit(1));
    return rows.length > 0;
  }

  async hasBlockingCredentialMaterial(userId: string): Promise<boolean> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx => tx.select({ id: userIntegrations.id })
      .from(userIntegrations)
      .where(and(
        eq(userIntegrations.userId, userId),
        sql`${userIntegrations.status} <> 'cleanup_failed'`,
        sql`(${userIntegrations.accessTokenCiphertext} IS NOT NULL OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL)`,
      )).limit(1));
    return rows.length > 0;
  }

  async hasBlockingCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean> {
    assertUuid(integrationDescriptorId, 'integrationDescriptorId');
    const rows = await withSystemContext(this.db, tx => tx.select({ id: userIntegrations.id })
      .from(userIntegrations)
      .where(and(
        eq(userIntegrations.integrationDescriptorId, integrationDescriptorId),
        sql`${userIntegrations.status} <> 'cleanup_failed'`,
        sql`(${userIntegrations.accessTokenCiphertext} IS NOT NULL OR ${userIntegrations.refreshTokenCiphertext} IS NOT NULL)`,
      )).limit(1));
    return rows.length > 0;
  }

  async disconnect(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.expectedActiveRecordId, 'expectedActiveRecordId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(userIntegrations).set({
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        status: 'revoked',
        errorReason: null,
        cleanupAttemptCount: 0,
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
        revokedAt: input.revokedAt,
      }).where(and(
        eq(userIntegrations.id, input.expectedActiveRecordId),
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        isNull(userIntegrations.revokedAt),
      )).returning(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

}

async function connectWithTx(
  tx: SystemTransaction,
  input: UserIntegrationConnectInput,
): Promise<(typeof userIntegrations.$inferSelect)[]> {
  await lockProviderMutation(tx, input.userId, input.provider);
  const pending: { id: string }[] = await tx.execute(sql`
    SELECT id
    FROM user_integrations
    WHERE user_id = ${input.userId}
      AND provider = ${input.provider}
      AND status = 'cleanup_pending'
    LIMIT 1
    FOR UPDATE
  `);
  if (pending.length > 0) throw new IntegrationCredentialCleanupPendingError();
  await tx.update(userIntegrations).set({
    accessTokenCiphertext: null,
    refreshTokenCiphertext: null,
    status: 'revoked',
    errorReason: null,
    cleanupAttemptCount: 0,
    cleanupNextAttemptAt: null,
    cleanupLeaseId: null,
    cleanupLeaseExpiresAt: null,
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
    status: 'connected',
    errorReason: null,
    cleanupAttemptCount: 0,
    cleanupNextAttemptAt: null,
    cleanupLeaseId: null,
    cleanupLeaseExpiresAt: null,
    connectedAt: input.connectedAt,
    lastSyncAt: null,
    revokedAt: null,
  }).returning();
}

function validateDescriptorCredentialInput(input: DescriptorCredentialConnectInput): void {
  assertUuid(input.descriptorId, 'descriptorId');
  if (!/^[a-f0-9]{64}$/.test(input.descriptorFingerprint)) {
    throw new ConsoleStoreValidationError('descriptorFingerprint must be a lowercase 256-bit hex fingerprint');
  }
  validateConnectInput(input.connection);
  if (input.connection.integrationDescriptorId !== input.descriptorId) {
    throw new ConsoleStoreValidationError(
      'descriptor credential must use the expected integration descriptor',
    );
  }
}

async function descriptorRevisionMatchesWithTx(
  tx: SystemTransaction,
  input: DescriptorCredentialConnectInput,
): Promise<boolean> {
  const descriptors = await tx.select().from(integrationProviderDescriptors)
    .where(eq(integrationProviderDescriptors.id, input.descriptorId))
    .for('key share')
    .limit(1);
  const descriptor = descriptors[0] ? fromDescriptorRow(descriptors[0]) : null;
  return descriptor !== null
    && integrationDescriptorRoutingFingerprint(descriptor) === input.descriptorFingerprint;
}

async function findActiveRow(
  tx: Parameters<Parameters<typeof withSystemContext>[1]>[0],
  userId: string,
  provider: UserIntegrationProvider,
): Promise<typeof userIntegrations.$inferSelect | null> {
  const rows = await tx.select().from(userIntegrations).where(and(
    eq(userIntegrations.userId, userId),
    eq(userIntegrations.provider, provider),
    isNull(userIntegrations.revokedAt),
  )).limit(1);
  return rows[0] ?? null;
}

async function lockProviderMutation(
  tx: SystemTransaction,
  userId: string,
  provider: UserIntegrationProvider,
): Promise<void> {
  const providerLockKey = `${userId}:${provider}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${providerLockKey}, 0))`);
}

async function beginCredentialCleanupWithTx(
  tx: SystemTransaction,
  input: UserIntegrationDisconnectInput,
): Promise<typeof userIntegrations.$inferSelect | null> {
  const rows = await tx.update(userIntegrations).set({
    status: 'cleanup_pending',
    errorReason: 'revocation_failed',
    cleanupAttemptCount: 0,
    cleanupNextAttemptAt: input.revokedAt,
    cleanupLeaseId: null,
    cleanupLeaseExpiresAt: null,
    revokedAt: input.revokedAt,
  }).where(and(
    eq(userIntegrations.id, input.expectedActiveRecordId),
    eq(userIntegrations.userId, input.userId),
    eq(userIntegrations.provider, input.provider),
    isNull(userIntegrations.revokedAt),
  )).returning();
  if (rows[0]) return rows[0];
  const pending = await tx.select().from(userIntegrations).where(and(
    eq(userIntegrations.userId, input.userId),
    eq(userIntegrations.provider, input.provider),
    eq(userIntegrations.status, 'cleanup_pending'),
  )).limit(1);
  return pending[0] ?? null;
}

function validateCleanupClaimInput(input: UserIntegrationCleanupClaimInput): void {
  validateCleanupMutationInput(input);
  if (input.leaseExpiresAt.getTime() <= input.attemptedAt.getTime()) {
    throw new ConsoleStoreValidationError('cleanup lease must expire after the attempt starts');
  }
}

function validateCleanupMutationInput(
  input: UserIntegrationCleanupClaimInput | UserIntegrationCleanupReleaseInput
    | UserIntegrationCleanupFailInput | UserIntegrationCleanupCompleteInput,
): void {
  assertUuid(input.userId, 'userId');
  assertUuid(input.cleanupRecordId, 'cleanupRecordId');
  assertUuid(input.leaseId, 'leaseId');
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
    credentialKeyVersion: input.credentialKeyVersion ?? null,
    status: 'connected',
    errorReason: null,
    cleanupAttemptCount: 0,
    cleanupNextAttemptAt: null,
    cleanupLeaseId: null,
    cleanupLeaseExpiresAt: null,
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
    status: row.status,
    errorReason: row.errorReason,
    cleanupAttemptCount: row.cleanupAttemptCount,
    cleanupNextAttemptAt: row.cleanupNextAttemptAt,
    cleanupLeaseId: row.cleanupLeaseId,
    cleanupLeaseExpiresAt: row.cleanupLeaseExpiresAt,
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
