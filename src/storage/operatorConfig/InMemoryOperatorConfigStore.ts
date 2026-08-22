/**
 * InMemoryOperatorConfigStore
 *
 * Non-durable in-process backend. State lost on restart — appropriate for
 * tests and for the explicit dev opt-in (NODE_ENV=test or
 * `DOLLHOUSE_STORAGE_BACKEND` unset with no FS available).
 *
 * @module storage/operatorConfig/InMemoryOperatorConfigStore
 */

import type { IOperatorConfigStore, OperatorConfig } from './IOperatorConfigStore.js';
import { DEFAULT_OPERATOR_CONFIG, OperatorConfigConflictError } from './IOperatorConfigStore.js';
import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';

export class InMemoryOperatorConfigStore implements IOperatorConfigStore {
  private current: OperatorConfig | null = null;
  private transactionGate: InMemoryTransactionGate | null = null;

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  createTransactionSnapshot(): unknown {
    return this.current ? cloneConfig(this.current) : null;
  }

  restoreTransactionSnapshot(snapshot: unknown): void {
    this.current = snapshot ? cloneConfig(snapshot as OperatorConfig) : null;
  }

  load(): Promise<OperatorConfig> {
    return this.runRead(async () => {
      if (!this.current) {
      // Clone the frozen default so callers can mutate their copy
      // freely without affecting subsequent loads or each other.
        return cloneConfig(DEFAULT_OPERATOR_CONFIG);
      }
      return cloneConfig(this.current);
    });
  }

  save(
    config: Omit<OperatorConfig, 'updatedAt'> & { updatedAt?: number },
    options: { readonly expectedUpdatedAt?: number } = {},
  ): Promise<void> {
    return this.runMutation(async () => {
      const currentUpdatedAt = this.current?.updatedAt ?? DEFAULT_OPERATOR_CONFIG.updatedAt;
      if (options.expectedUpdatedAt !== undefined && currentUpdatedAt !== options.expectedUpdatedAt) {
        throw new OperatorConfigConflictError();
      }
      const updatedAt = Math.max(Date.now(), currentUpdatedAt + 1);
      this.current = {
        enhancedIndexConfig: structuredClone(config.enhancedIndexConfig),
        consoleConfig: structuredClone(config.consoleConfig),
        licenseConfig: structuredClone(config.licenseConfig),
        defaultsConfig: structuredClone(config.defaultsConfig),
        configVersion: config.configVersion,
        updatedAt,
      };
    });
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runMutation(operation) ?? operation();
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runRead(operation) ?? operation();
  }
}

function cloneConfig(c: OperatorConfig): OperatorConfig {
  return {
    enhancedIndexConfig: structuredClone(c.enhancedIndexConfig),
    consoleConfig: structuredClone(c.consoleConfig),
    licenseConfig: structuredClone(c.licenseConfig),
    defaultsConfig: structuredClone(c.defaultsConfig),
    configVersion: c.configVersion,
    updatedAt: c.updatedAt,
  };
}
