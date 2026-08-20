import {
  ConsoleStoreConflictError,
  assertHash,
  buffersEqual,
  hashKey,
} from './ConsoleStoreValidation.js';
import type {
  ConsoleLoginTransaction,
  ILoginTransactionStore,
} from './ILoginTransactionStore.js';
import {
  cloneLoginTransaction,
  CONSUMED_TRANSACTION_COMPLETION_LEASE_MS,
  validateLoginTransaction,
} from './ILoginTransactionStore.js';

export class InMemoryLoginTransactionStore implements ILoginTransactionStore {
  private readonly transactions = new Map<string, ConsoleLoginTransaction>();

  async create(transaction: ConsoleLoginTransaction): Promise<void> {
    await Promise.resolve();
    validateLoginTransaction(transaction);
    const key = hashKey(transaction.idHash);
    if (this.transactions.has(key)) {
      throw new ConsoleStoreConflictError('login transaction id hash already exists');
    }
    this.transactions.set(key, cloneLoginTransaction(transaction));
  }

  async consume(
    idHash: Buffer,
    stateHash: Buffer,
    consumedAt: Date = new Date(),
  ): Promise<ConsoleLoginTransaction | null> {
    await Promise.resolve();
    assertHash(idHash, 'idHash');
    assertHash(stateHash, 'stateHash');
    const key = hashKey(idHash);
    const transaction = this.transactions.get(key);
    if (!transaction || transaction.consumedAt || transaction.expiresAt <= consumedAt
        || !buffersEqual(transaction.stateHash, stateHash)) {
      return null;
    }
    const consumed = cloneLoginTransaction({
      ...transaction,
      consumedAt,
      expiresAt: new Date(consumedAt.getTime() + CONSUMED_TRANSACTION_COMPLETION_LEASE_MS),
    });
    this.transactions.set(key, consumed);
    return cloneLoginTransaction(consumed);
  }

  async findByIdHash(idHash: Buffer): Promise<ConsoleLoginTransaction | null> {
    await Promise.resolve();
    assertHash(idHash, 'idHash');
    const transaction = this.transactions.get(hashKey(idHash));
    return transaction ? cloneLoginTransaction(transaction) : null;
  }

  async completeConsumed(idHash: Buffer): Promise<boolean> {
    await Promise.resolve();
    assertHash(idHash, 'idHash');
    const key = hashKey(idHash);
    const transaction = this.transactions.get(key);
    if (!transaction?.consumedAt) return false;
    this.transactions.set(key, cloneLoginTransaction({
      ...transaction,
      expiresAt: transaction.consumedAt,
    }));
    return true;
  }

  async sweepExpired(before: Date = new Date()): Promise<number> {
    await Promise.resolve();
    let deleted = 0;
    for (const [key, transaction] of this.transactions) {
      // Consumed callbacks remain live through their bounded completion lease.
      // completeConsumed() makes a completed row eligible for the next sweep.
      if (transaction.expiresAt <= before) {
        this.transactions.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}
