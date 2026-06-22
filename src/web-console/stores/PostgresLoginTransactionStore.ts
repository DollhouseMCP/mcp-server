import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { consoleLoginTransactions } from '../../database/schema/index.js';
import type {
  ConsoleLoginTransaction,
  ILoginTransactionStore,
} from './ILoginTransactionStore.js';
import { cloneLoginTransaction, validateLoginTransaction } from './ILoginTransactionStore.js';
import {
  ConsoleStoreConflictError,
  assertHash,
  isUniqueViolation,
} from './ConsoleStoreValidation.js';
import type { ConsoleCapability } from '../platform/ConsolePlatformTypes.js';

export class PostgresLoginTransactionStore implements ILoginTransactionStore {
  constructor(private readonly db: DatabaseInstance) {}

  async create(transaction: ConsoleLoginTransaction): Promise<void> {
    validateLoginTransaction(transaction);
    try {
      await withSystemContext(this.db, tx =>
        tx.insert(consoleLoginTransactions).values({
          idHash: transaction.idHash,
          flowKind: transaction.flowKind,
          stateHash: transaction.stateHash,
          pkceVerifierEnc: transaction.pkceVerifierEnc,
          userId: transaction.userId,
          consoleSessionIdHash: transaction.consoleSessionIdHash,
          requestedCapability: transaction.requestedCapability,
          returnTo: transaction.returnTo,
          createdAt: transaction.createdAt,
          expiresAt: transaction.expiresAt,
          consumedAt: transaction.consumedAt,
        }),
      );
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
    consumedAt: Date = new Date(),
  ): Promise<ConsoleLoginTransaction | null> {
    assertHash(idHash, 'idHash');
    assertHash(stateHash, 'stateHash');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(consoleLoginTransactions).set({ consumedAt }).where(and(
        eq(consoleLoginTransactions.idHash, idHash),
        eq(consoleLoginTransactions.stateHash, stateHash),
        isNull(consoleLoginTransactions.consumedAt),
        gt(consoleLoginTransactions.expiresAt, consumedAt),
      )).returning(),
    );
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

  async sweepExpired(before: Date = new Date()): Promise<number> {
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(consoleLoginTransactions).where(or(
        lte(consoleLoginTransactions.expiresAt, before),
        lte(consoleLoginTransactions.consumedAt, before),
      )).returning({ idHash: consoleLoginTransactions.idHash }),
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
    returnTo: row.returnTo,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
  validateLoginTransaction(transaction);
  return cloneLoginTransaction(transaction);
}
