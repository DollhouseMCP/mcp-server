/**
 * FilesystemOperatorConfigStore
 *
 * Durable JSON-on-disk backend. Atomic write-temp + rename via
 * `FileLockManager.atomicWriteFile`; reads tolerate ENOENT (returns
 * the default config) and malformed JSON (logs and returns default).
 *
 * State lives at `<rootDir>/operator-config.json`. `rootDir` is selected
 * by `createOperatorConfigStore`, defaulting to
 * `resolveDataDirectory('state') + '/operator'` to match the auth
 * filesystem layout convention (one subdir per storage domain).
 *
 * @module storage/operatorConfig/FilesystemOperatorConfigStore
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { FileLockManager } from '../../security/fileLockManager.js';
import { logger } from '../../utils/logger.js';
import type { IOperatorConfigStore, OperatorConfig } from './IOperatorConfigStore.js';
import { DEFAULT_OPERATOR_CONFIG } from './IOperatorConfigStore.js';

export interface FilesystemOperatorConfigStoreOptions {
  /** Root directory for the JSON file; the store appends `operator-config.json`. */
  rootDir: string;
}

export class FilesystemOperatorConfigStore implements IOperatorConfigStore {
  private readonly rootDir: string;
  private readonly configPath: string;
  private readonly locks = new FileLockManager();

  constructor(options: FilesystemOperatorConfigStoreOptions) {
    this.rootDir = options.rootDir;
    this.configPath = path.join(this.rootDir, 'operator-config.json');
  }

  async load(): Promise<OperatorConfig> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isOperatorConfig(parsed)) {
        logger.warn(
          '[OperatorConfigStore:fs] operator-config.json has wrong shape; treating as empty',
          { path: this.configPath },
        );
        return cloneDefault();
      }
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return cloneDefault();
      if (err instanceof SyntaxError) {
        logger.warn(
          '[OperatorConfigStore:fs] operator-config.json failed to parse; treating as empty',
          { path: this.configPath, error: err.message },
        );
        return cloneDefault();
      }
      throw err;
    }
  }

  async save(config: Omit<OperatorConfig, 'updatedAt'> & { updatedAt?: number }): Promise<void> {
    const payload: OperatorConfig = {
      enhancedIndexConfig: config.enhancedIndexConfig,
      consoleConfig: config.consoleConfig,
      licenseConfig: config.licenseConfig,
      defaultsConfig: config.defaultsConfig,
      configVersion: config.configVersion,
      updatedAt: Date.now(),
    };

    await this.locks.withLock(`operator-config:${this.configPath}`, async () => {
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.configPath, JSON.stringify(payload, null, 2));
    });
  }

  private async ensureRoot(): Promise<void> {
    try {
      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
    }
  }
}

function cloneDefault(): OperatorConfig {
  return {
    enhancedIndexConfig: { ...DEFAULT_OPERATOR_CONFIG.enhancedIndexConfig },
    consoleConfig: { ...DEFAULT_OPERATOR_CONFIG.consoleConfig },
    licenseConfig: { ...DEFAULT_OPERATOR_CONFIG.licenseConfig },
    defaultsConfig: { ...DEFAULT_OPERATOR_CONFIG.defaultsConfig },
    configVersion: DEFAULT_OPERATOR_CONFIG.configVersion,
    updatedAt: DEFAULT_OPERATOR_CONFIG.updatedAt,
  };
}

function isOperatorConfig(value: unknown): value is OperatorConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.configVersion === 'number'
    && typeof v.updatedAt === 'number'
    && isPlainObject(v.enhancedIndexConfig)
    && isPlainObject(v.consoleConfig)
    && isPlainObject(v.licenseConfig)
    && isPlainObject(v.defaultsConfig)
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
