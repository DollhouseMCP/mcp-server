import { AsyncLocalStorage } from 'node:async_hooks';

import type { DrizzleTx } from '../database/db-utils.js';

interface AgentReplacementTransactionScope {
  readonly tx: DrizzleTx;
  readonly userId: string;
  readonly afterCommit: Array<() => void | Promise<void>>;
  readonly afterRollback: Array<(error: unknown) => void | Promise<void>>;
}

const transactionScope = new AsyncLocalStorage<AgentReplacementTransactionScope>();

export async function runInAgentReplacementTransaction<T>(
  tx: DrizzleTx,
  userId: string,
  operation: () => Promise<T>,
  afterCommit: Array<() => void | Promise<void>>,
  afterRollback: Array<(error: unknown) => void | Promise<void>> = [],
): Promise<T> {
  return transactionScope.run({ tx, userId, afterCommit, afterRollback }, operation);
}

export async function withAgentReplacementTransactionOr<T>(
  userId: string,
  fallback: (operation: (tx: DrizzleTx) => Promise<T>) => Promise<T>,
  operation: (tx: DrizzleTx) => Promise<T>,
): Promise<T> {
  const scope = transactionScope.getStore();
  if (!scope) return fallback(operation);
  if (scope.userId !== userId) {
    throw new Error('Agent replacement transaction user identity changed during mutation');
  }
  return operation(scope.tx);
}

export function afterAgentReplacementCommit(operation: () => void | Promise<void>): boolean {
  const scope = transactionScope.getStore();
  if (!scope) return false;
  scope.afterCommit.push(operation);
  return true;
}

export function afterAgentReplacementRollback(
  operation: (error: unknown) => void | Promise<void>,
): boolean {
  const scope = transactionScope.getStore();
  if (!scope) return false;
  scope.afterRollback.push(operation);
  return true;
}

export function hasAgentReplacementTransaction(userId?: string): boolean {
  const scope = transactionScope.getStore();
  return scope !== undefined && (userId === undefined || scope.userId === userId);
}
