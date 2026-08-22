import { and, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { consoleLoginTransactions, integrationProviderDescriptors, users } from '../../database/schema/index.js';
import type {
  ConsoleLoginTransaction,
  ILoginTransactionStore,
} from './ILoginTransactionStore.js';
import {
  cloneLoginTransaction,
  CONSUMED_TRANSACTION_COMPLETION_LEASE_MS,
  validateLoginTransaction,
} from './ILoginTransactionStore.js';
import {
  ConsoleStoreConflictError,
  IntegrationDescriptorChangedError,
  assertHash,
  assertUuid,
  isUniqueViolation,
} from './ConsoleStoreValidation.js';
import type { ConsoleCapability } from '../platform/ConsolePlatformTypes.js';
import { IntegrationPrincipalInactiveError } from './IUserIntegrationStore.js';
import { integrationDescriptorRoutingFingerprint } from '../modules/integrations/IntegrationDescriptorRoutingFingerprint.js';
import { fromDescriptorRow } from './PostgresIntegrationDescriptorStore.js';

export class PostgresLoginTransactionStore implements ILoginTransactionStore {
  constructor(private readonly db: DatabaseInstance) {}

  async create(transaction: ConsoleLoginTransaction): Promise<void> {
    validateLoginTransaction(transaction);
    const ttlMs = transaction.expiresAt.getTime() - transaction.createdAt.getTime();
    try {
      await withSystemContext(this.db, async tx => {
        if (transaction.flowKind === 'integration_link' && transaction.userId) {
          // Authorization start and callback completion use the same user-first
          // lock. A newer flow therefore cannot appear between a callback's
          // freshness check and its credential commit.
          const principals = await tx.select({ id: users.id }).from(users).where(and(
            eq(users.id, transaction.userId),
            isNull(users.disabledAt),
            isNull(users.deletedAt),
          )).for('update').limit(1);
          if (principals.length === 0) throw new IntegrationPrincipalInactiveError();
        }
        if (transaction.integrationDescriptorId) {
          const descriptors = await tx.select()
            .from(integrationProviderDescriptors)
            .where(eq(integrationProviderDescriptors.id, transaction.integrationDescriptorId))
            .for('key share')
            .limit(1);
          if (descriptors.length === 0) {
            throw new IntegrationDescriptorChangedError('integration descriptor no longer exists');
          }
          if (integrationDescriptorRoutingFingerprint(fromDescriptorRow(descriptors[0]))
              !== transaction.integrationDescriptorFingerprint) {
            throw new IntegrationDescriptorChangedError(
              'integration descriptor changed while starting authorization',
            );
          }
        }
        await tx.insert(consoleLoginTransactions).values({
          idHash: transaction.idHash,
          flowKind: transaction.flowKind,
          stateHash: transaction.stateHash,
          pkceVerifierEnc: transaction.pkceVerifierEnc,
          userId: transaction.userId,
          consoleSessionIdHash: transaction.consoleSessionIdHash,
          requestedCapability: transaction.requestedCapability,
          integrationDescriptorId: transaction.integrationDescriptorId ?? null,
          integrationDescriptorFingerprint: transaction.integrationDescriptorFingerprint ?? null,
          returnTo: transaction.returnTo,
          createdAt: sql`statement_timestamp()`,
          expiresAt: sql`statement_timestamp() + (${ttlMs} * interval '1 millisecond')`,
          consumedAt: transaction.consumedAt,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConsoleStoreConflictError('login transaction id hash already exists');
      }
      throw error;
    }
  }

  async consume(
    idHash: Buffer,
    stateHash: Buffer,
    _consumedAt: Date = new Date(),
  ): Promise<ConsoleLoginTransaction | null> {
    assertHash(idHash, 'idHash');
    assertHash(stateHash, 'stateHash');
    const rows = await withSystemContext(this.db, async tx => {
      const candidates = await tx.select({
        flowKind: consoleLoginTransactions.flowKind,
        userId: consoleLoginTransactions.userId,
      }).from(consoleLoginTransactions).where(and(
        eq(consoleLoginTransactions.idHash, idHash),
        eq(consoleLoginTransactions.stateHash, stateHash),
        isNull(consoleLoginTransactions.consumedAt),
        gt(consoleLoginTransactions.expiresAt, sql`statement_timestamp()`),
      )).limit(1);
      const candidate = candidates[0];
      if (!candidate) return [];
      if (candidate.flowKind === 'integration_link' && candidate.userId) {
        const principals = await tx.select({ id: users.id }).from(users).where(and(
          eq(users.id, candidate.userId),
          isNull(users.disabledAt),
          isNull(users.deletedAt),
        )).for('update').limit(1);
        if (principals.length === 0) return [];
      }
      return tx.update(consoleLoginTransactions).set({
        consumedAt: sql`statement_timestamp()`,
        expiresAt: sql`statement_timestamp() + (${CONSUMED_TRANSACTION_COMPLETION_LEASE_MS} * interval '1 millisecond')`,
      }).where(and(
        eq(consoleLoginTransactions.idHash, idHash),
        eq(consoleLoginTransactions.stateHash, stateHash),
        isNull(consoleLoginTransactions.consumedAt),
        gt(consoleLoginTransactions.expiresAt, sql`statement_timestamp()`),
      )).returning();
    });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async findByIdHash(idHash: Buffer): Promise<ConsoleLoginTransaction | null> {
    assertHash(idHash, 'idHash');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(consoleLoginTransactions).where(
        eq(consoleLoginTransactions.idHash, idHash),
      ).limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async completeConsumed(idHash: Buffer): Promise<boolean> {
    assertHash(idHash, 'idHash');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(consoleLoginTransactions).set({
        expiresAt: consoleLoginTransactions.consumedAt,
      }).where(and(
        eq(consoleLoginTransactions.idHash, idHash),
        isNotNull(consoleLoginTransactions.consumedAt),
      )).returning({ idHash: consoleLoginTransactions.idHash }),
    );
    return rows.length > 0;
  }

  async hasNewerIntegrationAuthorization(
    userId: string,
    integrationDescriptorId: string | null,
    transactionIdHash: Buffer,
  ): Promise<boolean> {
    assertHash(transactionIdHash, 'transactionIdHash');
    const rows = await withSystemContext(this.db, tx => tx.select({ idHash: consoleLoginTransactions.idHash })
      .from(consoleLoginTransactions)
      .where(and(
        eq(consoleLoginTransactions.flowKind, 'integration_link'),
        eq(consoleLoginTransactions.userId, userId),
        sql`${consoleLoginTransactions.integrationDescriptorId} IS NOT DISTINCT FROM ${integrationDescriptorId}`,
        sql`${consoleLoginTransactions.idHash} <> ${transactionIdHash}`,
        sql`${consoleLoginTransactions.createdAt} > (
          SELECT current_tx.created_at
          FROM console_login_transactions AS current_tx
          WHERE current_tx.id_hash = ${transactionIdHash}
        )`,
        gt(consoleLoginTransactions.expiresAt, sql`statement_timestamp()`),
      )).limit(1));
    return rows.length > 0;
  }

  async isIntegrationAuthorizationCompletionCurrent(transactionIdHash: Buffer): Promise<boolean> {
    assertHash(transactionIdHash, 'transactionIdHash');
    const rows = await withSystemContext(this.db, tx => tx.select({
      idHash: consoleLoginTransactions.idHash,
    }).from(consoleLoginTransactions).where(and(
      eq(consoleLoginTransactions.idHash, transactionIdHash),
      eq(consoleLoginTransactions.flowKind, 'integration_link'),
      isNotNull(consoleLoginTransactions.consumedAt),
      gt(consoleLoginTransactions.expiresAt, sql`statement_timestamp()`),
    )).limit(1));
    return rows.length > 0;
  }

  async hasInFlightIntegrationAuthorization(userId: string): Promise<boolean> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx => tx.select({
      idHash: consoleLoginTransactions.idHash,
    }).from(consoleLoginTransactions).where(and(
      eq(consoleLoginTransactions.flowKind, 'integration_link'),
      eq(consoleLoginTransactions.userId, userId),
      isNotNull(consoleLoginTransactions.consumedAt),
      gt(consoleLoginTransactions.expiresAt, sql`statement_timestamp()`),
    )).limit(1));
    return rows.length > 0;
  }

  async sweepExpired(_before: Date = new Date()): Promise<number> {
    const rows = await withSystemContext(this.db, tx =>
      // An in-flight callback owns its row through the bounded completion lease.
      // completeConsumed() moves expiresAt back to consumedAt for prompt cleanup.
      tx.delete(consoleLoginTransactions)
        .where(lte(consoleLoginTransactions.expiresAt, sql`statement_timestamp()`))
        .returning({ idHash: consoleLoginTransactions.idHash }),
    );
    return rows.length;
  }
}

function fromRow(row: typeof consoleLoginTransactions.$inferSelect): ConsoleLoginTransaction {
  const transaction: ConsoleLoginTransaction = {
    idHash: row.idHash,
    flowKind: row.flowKind,
    stateHash: row.stateHash,
    pkceVerifierEnc: row.pkceVerifierEnc,
    userId: row.userId,
    consoleSessionIdHash: row.consoleSessionIdHash,
    requestedCapability: row.requestedCapability as ConsoleCapability | null,
    integrationDescriptorId: row.integrationDescriptorId,
    integrationDescriptorFingerprint: row.integrationDescriptorFingerprint,
    returnTo: row.returnTo,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
  validateLoginTransaction(transaction);
  return cloneLoginTransaction(transaction);
}
