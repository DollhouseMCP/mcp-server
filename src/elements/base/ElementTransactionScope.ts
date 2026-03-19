import { logger } from '../../utils/logger.js';

export type TransactionAction = (error?: unknown) => Promise<void> | void;

/**
 * Minimal transaction helper that pairs commit/rollback actions for BaseElementManager flows.
 */
export class ElementTransactionScope {
  private readonly commitActions: TransactionAction[] = [];
  private readonly rollbackActions: TransactionAction[] = [];

  constructor(private readonly label: string, private readonly correlationId: string) {}

  addCommit(action: TransactionAction): void {
    this.commitActions.push(action);
  }

  addRollback(action: TransactionAction): void {
    // Rollback actions execute in reverse order of registration
    this.rollbackActions.unshift(action);
  }

  async run(work: () => Promise<void>): Promise<void> {
    try {
      await work();
      await this.executeActions(this.commitActions);
    } catch (error) {
      await this.executeActions(this.rollbackActions, error);
      throw error;
    }
  }

  private async executeActions(actions: TransactionAction[], error?: unknown): Promise<void> {
    for (const action of actions) {
      try {
        await action(error);
      } catch (actionError) {
        logger.warn('Transaction action failed', {
          label: this.label,
          correlationId: this.correlationId,
          error: actionError instanceof Error ? actionError.message : actionError
        });
      }
    }
  }
}
