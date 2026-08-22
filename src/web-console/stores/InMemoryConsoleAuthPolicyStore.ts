import {
  cloneConsoleAuthPolicy,
  ConsoleAuthPolicyConflictError,
  DEFAULT_CONSOLE_AUTH_POLICY,
  type ConsoleAuthPolicy,
  type IConsoleAuthPolicyStore,
} from './IConsoleAuthPolicyStore.js';
import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';

export class InMemoryConsoleAuthPolicyStore implements IConsoleAuthPolicyStore {
  private current: ConsoleAuthPolicy | null = null;
  private transactionGate: InMemoryTransactionGate | null = null;

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  createTransactionSnapshot(): unknown {
    return this.current ? cloneConsoleAuthPolicy(this.current) : null;
  }

  restoreTransactionSnapshot(snapshot: unknown): void {
    this.current = snapshot ? cloneConsoleAuthPolicy(snapshot as ConsoleAuthPolicy) : null;
  }

  load(): Promise<ConsoleAuthPolicy> {
    return this.runRead(async () => cloneConsoleAuthPolicy(this.current ?? DEFAULT_CONSOLE_AUTH_POLICY));
  }

  async save(
    policy: Pick<ConsoleAuthPolicy, 'maxAdminElevationSeconds'>,
    options: { readonly expectedUpdatedAt?: Date } = {},
  ): Promise<ConsoleAuthPolicy> {
    return this.runMutation(async () => {
      const current = this.current ?? DEFAULT_CONSOLE_AUTH_POLICY;
      if (options.expectedUpdatedAt && current.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
        throw new ConsoleAuthPolicyConflictError();
      }
      const updated: ConsoleAuthPolicy = {
        maxAdminElevationSeconds: policy.maxAdminElevationSeconds,
        updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
      };
      this.current = updated;
      return cloneConsoleAuthPolicy(updated);
    });
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runMutation(operation) ?? operation();
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runRead(operation) ?? operation();
  }
}
