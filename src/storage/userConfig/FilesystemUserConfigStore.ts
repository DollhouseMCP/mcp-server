/**
 * FilesystemUserConfigStore
 *
 * Durable JSON-on-disk backend, one file per user. State lives at
 * `<rootDir>/users/<userId>/config.json`. Atomic write-temp + rename
 * via `FileOperationsService.writeFile`; reads tolerate ENOENT (returns
 * default) and malformed JSON (logs and returns default).
 *
 * UserId is validated as a UUID before being interpolated into the
 * filesystem path — defensive against accidental path traversal.
 *
 * @module storage/userConfig/FilesystemUserConfigStore
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { IFileOperationsService } from '../../services/FileOperationsService.js';
import { logger } from '../../utils/logger.js';
import type { IUserConfigStore, UserConfig } from './IUserConfigStore.js';
import { DEFAULT_USER_CONFIG } from './IUserConfigStore.js';

export interface FilesystemUserConfigStoreOptions {
  /** Root directory for per-user JSON files; the store appends `users/<userId>/config.json`. */
  rootDir: string;
  fileOperations: IFileOperationsService;
}

export class FilesystemUserConfigStore implements IUserConfigStore {
  private readonly rootDir: string;
  private readonly fileOperations: IFileOperationsService;

  constructor(options: FilesystemUserConfigStoreOptions) {
    this.rootDir = options.rootDir;
    this.fileOperations = options.fileOperations;
  }

  async load(userId: string): Promise<UserConfig> {
    assertValidUserId(userId);
    const configPath = this.pathForUser(userId);
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isUserConfig(parsed)) {
        logger.warn(
          '[UserConfigStore:fs] config.json has wrong shape; treating as empty',
          { userId, path: configPath },
        );
        return cloneDefault();
      }
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return cloneDefault();
      if (err instanceof SyntaxError) {
        logger.warn(
          '[UserConfigStore:fs] config.json failed to parse; treating as empty',
          { userId, path: configPath, error: err.message },
        );
        return cloneDefault();
      }
      throw err;
    }
  }

  async save(
    userId: string,
    config: Omit<UserConfig, 'updatedAt'> & { updatedAt?: number },
  ): Promise<void> {
    assertValidUserId(userId);
    const configPath = this.pathForUser(userId);
    const payload: UserConfig = {
      githubConfig: config.githubConfig,
      syncConfig: config.syncConfig,
      autoloadConfig: config.autoloadConfig,
      retentionConfig: config.retentionConfig,
      wizardConfig: config.wizardConfig,
      displayConfig: config.displayConfig,
      collectionConfig: config.collectionConfig,
      autoActivateConfig: config.autoActivateConfig,
      sourcePriorityConfig: config.sourcePriorityConfig,
      userIdentityConfig: config.userIdentityConfig,
      configVersion: config.configVersion,
      updatedAt: Date.now(),
    };

    await this.ensureUserDir(userId);
    await this.fileOperations.writeFile(configPath, JSON.stringify(payload, null, 2), {
      source: 'FilesystemUserConfigStore.save',
    });
  }

  private pathForUser(userId: string): string {
    // Already validated as UUID by assertValidUserId — safe to interpolate.
    return path.join(this.rootDir, 'users', userId, 'config.json');
  }

  private async ensureUserDir(userId: string): Promise<void> {
    const dir = path.dirname(this.pathForUser(userId));
    try {
      await this.fileOperations.createDirectory(dir);
      await this.fileOperations.chmod(dir, 0o700, {
        source: 'FilesystemUserConfigStore.ensureUserDir',
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
    }
  }
}

function cloneDefault(): UserConfig {
  return {
    githubConfig: { ...DEFAULT_USER_CONFIG.githubConfig },
    syncConfig: { ...DEFAULT_USER_CONFIG.syncConfig },
    autoloadConfig: { ...DEFAULT_USER_CONFIG.autoloadConfig },
    retentionConfig: { ...DEFAULT_USER_CONFIG.retentionConfig },
    wizardConfig: { ...DEFAULT_USER_CONFIG.wizardConfig },
    displayConfig: { ...DEFAULT_USER_CONFIG.displayConfig },
    collectionConfig: { ...DEFAULT_USER_CONFIG.collectionConfig },
    autoActivateConfig: { ...DEFAULT_USER_CONFIG.autoActivateConfig },
    sourcePriorityConfig: { ...DEFAULT_USER_CONFIG.sourcePriorityConfig },
    userIdentityConfig: { ...DEFAULT_USER_CONFIG.userIdentityConfig },
    configVersion: DEFAULT_USER_CONFIG.configVersion,
    updatedAt: DEFAULT_USER_CONFIG.updatedAt,
  };
}

function isUserConfig(value: unknown): value is UserConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.configVersion === 'number'
    && typeof v.updatedAt === 'number'
    && isPlainObject(v.githubConfig)
    && isPlainObject(v.syncConfig)
    && isPlainObject(v.autoloadConfig)
    && isPlainObject(v.retentionConfig)
    && isPlainObject(v.wizardConfig)
    && isPlainObject(v.displayConfig)
    && isPlainObject(v.collectionConfig)
    && isPlainObject(v.autoActivateConfig)
    && isPlainObject(v.sourcePriorityConfig)
    && isPlainObject(v.userIdentityConfig)
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertValidUserId(userId: string): void {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    const got = typeof userId === 'string' ? `"${userId}"` : typeof userId;
    throw new Error(`IUserConfigStore: userId must be a UUID; got ${got}`);
  }
}
