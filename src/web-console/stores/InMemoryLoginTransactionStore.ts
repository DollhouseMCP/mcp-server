import {
  ConsoleStoreConflictError,
  assertHash,
  buffersEqual,
  hashKey,
  assertUuid,
} from './ConsoleStoreValidation.js';
import type {
  ConsoleLoginTransaction,
  ILoginTransactionStore,
} from './ILoginTransactionStore.js';
import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';
import {
  cloneLoginTransaction,
  CONSUMED_TRANSACTION_COMPLETION_LEASE_MS,
  validateLoginTransaction,
} from './ILoginTransactionStore.js';

export class InMemoryLoginTransactionStore implements ILoginTransactionStore {
  private readonly transactions = new Map<string, ConsoleLoginTransaction>();
  private transactionGate: InMemoryTransactionGate | null = null;
  private principalLifecycleFence: { isPrincipalActive(userId: string): Promise<boolean> } | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  configurePrincipalLifecycleFence(fence: { isPrincipalActive(userId: string): Promise<boolean> }): void {
    this.principalLifecycleFence = fence;
  }

  async create(transaction: ConsoleLoginTransaction): Promise<void> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateLoginTransaction(transaction);
      const key = hashKey(transaction.idHash);
      if (this.transactions.has(key)) {
        throw new ConsoleStoreConflictError('login transaction id hash already exists');
      }
      this.transactions.set(key, cloneLoginTransaction(transaction));
    });
  }

  async consume(
    idHash: Buffer,
    stateHash: Buffer,
    consumedAt: Date = new Date(),
  ): Promise<ConsoleLoginTransaction | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      assertHash(idHash, 'idHash');
      assertHash(stateHash, 'stateHash');
      const key = hashKey(idHash);
      const transaction = this.transactions.get(key);
      if (!transaction || transaction.consumedAt || transaction.expiresAt <= consumedAt
          || !buffersEqual(transaction.stateHash, stateHash)) {
        return null;
      }
      if (transaction.flowKind === 'integration_link'
          && transaction.userId
          && this.principalLifecycleFence
          && !await this.principalLifecycleFence.isPrincipalActive(transaction.userId)) {
        return null;
      }
      const consumed = cloneLoginTransaction({
        ...transaction,
        consumedAt,
        expiresAt: new Date(consumedAt.getTime() + CONSUMED_TRANSACTION_COMPLETION_LEASE_MS),
      });
      this.transactions.set(key, consumed);
      return cloneLoginTransaction(consumed);
    });
  }

  async findByIdHash(idHash: Buffer): Promise<ConsoleLoginTransaction | null> {
    await Promise.resolve();
    assertHash(idHash, 'idHash');
    const transaction = this.transactions.get(hashKey(idHash));
    return transaction ? cloneLoginTransaction(transaction) : null;
  }

  async completeConsumed(idHash: Buffer): Promise<boolean> {
    return this.runMutation(async () => {
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
    });
  }

  async hasNewerIntegrationAuthorization(
    userId: string,
    integrationDescriptorId: string | null,
    transactionIdHash: Buffer,
  ): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertHash(transactionIdHash, 'transactionIdHash');
      const current = this.transactions.get(hashKey(transactionIdHash));
      if (!current) return false;
      const now = this.now();
      return [...this.transactions.values()].some(transaction =>
        transaction.flowKind === 'integration_link'
        && transaction.userId === userId
        && (transaction.integrationDescriptorId ?? null) === integrationDescriptorId
        && !buffersEqual(transaction.idHash, transactionIdHash)
        && transaction.createdAt > current.createdAt
        && transaction.expiresAt > now);
    });
  }

  async isIntegrationAuthorizationCompletionCurrent(transactionIdHash: Buffer): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertHash(transactionIdHash, 'transactionIdHash');
      const transaction = this.transactions.get(hashKey(transactionIdHash));
      return transaction?.flowKind === 'integration_link'
        && transaction.consumedAt !== null
        && transaction.expiresAt > this.now();
    });
  }

  async fenceIntegrationAuthorizationsByDescriptor(integrationDescriptorId: string): Promise<boolean> {
    return this.runMutation(async () => {
      await Promise.resolve();
      assertUuid(integrationDescriptorId, 'integrationDescriptorId');
      const now = this.now();
      const active = [...this.transactions.entries()].filter(([, transaction]) =>
        transaction.flowKind === 'integration_link'
        && transaction.integrationDescriptorId === integrationDescriptorId
        && transaction.expiresAt > now);
      if (active.some(([, transaction]) => transaction.consumedAt !== null)) return false;
      for (const [key] of active) this.transactions.delete(key);
      return true;
    });
  }

  async hasInFlightIntegrationAuthorization(userId: string): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      const now = this.now();
      return [...this.transactions.values()].some(transaction =>
        transaction.flowKind === 'integration_link'
        && transaction.userId === userId
        && transaction.consumedAt !== null
        && transaction.expiresAt > now);
    });
  }

  async sweepExpired(before: Date = new Date()): Promise<number> {
    return this.runMutation(async () => {
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
    });
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate ? this.transactionGate.runMutation(operation) : operation();
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate ? this.transactionGate.runRead(operation) : operation();
  }
}
