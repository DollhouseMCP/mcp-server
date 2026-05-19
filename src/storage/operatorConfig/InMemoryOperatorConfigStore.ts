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
import { DEFAULT_OPERATOR_CONFIG } from './IOperatorConfigStore.js';

export class InMemoryOperatorConfigStore implements IOperatorConfigStore {
  private current: OperatorConfig | null = null;

  async load(): Promise<OperatorConfig> {
    if (!this.current) {
      // Clone the frozen default so callers can mutate their copy
      // freely without affecting subsequent loads or each other.
      return cloneConfig(DEFAULT_OPERATOR_CONFIG);
    }
    return cloneConfig(this.current);
  }

  async save(config: Omit<OperatorConfig, 'updatedAt'> & { updatedAt?: number }): Promise<void> {
    this.current = {
      enhancedIndexConfig: { ...config.enhancedIndexConfig },
      consoleConfig: { ...config.consoleConfig },
      licenseConfig: { ...config.licenseConfig },
      defaultsConfig: { ...config.defaultsConfig },
      configVersion: config.configVersion,
      updatedAt: Date.now(),
    };
  }
}

function cloneConfig(c: OperatorConfig): OperatorConfig {
  return {
    enhancedIndexConfig: { ...c.enhancedIndexConfig },
    consoleConfig: { ...c.consoleConfig },
    licenseConfig: { ...c.licenseConfig },
    defaultsConfig: { ...c.defaultsConfig },
    configVersion: c.configVersion,
    updatedAt: c.updatedAt,
  };
}
