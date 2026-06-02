/**
 * InMemoryUserConfigStore
 *
 * Non-durable in-process backend keyed by userId. State lost on restart —
 * tests + dev opt-in. Mirror of `InMemoryOperatorConfigStore` with a Map
 * keyed on userId since multiple users can have configs.
 *
 * @module storage/userConfig/InMemoryUserConfigStore
 */

import type { IUserConfigStore, UserConfig } from './IUserConfigStore.js';
import { DEFAULT_USER_CONFIG, UserConfigConflictError } from './IUserConfigStore.js';

export class InMemoryUserConfigStore implements IUserConfigStore {
  private readonly configs = new Map<string, UserConfig>();

  async load(userId: string): Promise<UserConfig> {
    assertValidUserId(userId);
    const stored = this.configs.get(userId);
    return Promise.resolve(stored ? cloneConfig(stored) : cloneDefault());
  }

  async save(
    userId: string,
    config: Omit<UserConfig, 'updatedAt'> & { updatedAt?: number },
    options: { readonly expectedUpdatedAt?: number } = {},
  ): Promise<void> {
    assertValidUserId(userId);
    const current = this.configs.get(userId)?.updatedAt ?? DEFAULT_USER_CONFIG.updatedAt;
    if (options.expectedUpdatedAt !== undefined && current !== options.expectedUpdatedAt) {
      throw new UserConfigConflictError();
    }
    this.configs.set(userId, {
      githubConfig: { ...config.githubConfig },
      syncConfig: { ...config.syncConfig },
      autoloadConfig: { ...config.autoloadConfig },
      retentionConfig: { ...config.retentionConfig },
      wizardConfig: { ...config.wizardConfig },
      displayConfig: { ...config.displayConfig },
      collectionConfig: { ...config.collectionConfig },
      autoActivateConfig: { ...config.autoActivateConfig },
      sourcePriorityConfig: { ...config.sourcePriorityConfig },
      userIdentityConfig: { ...config.userIdentityConfig },
      configVersion: config.configVersion,
      updatedAt: Date.now(),
    });
    return Promise.resolve();
  }
}

function cloneConfig(c: UserConfig): UserConfig {
  return {
    githubConfig: { ...c.githubConfig },
    syncConfig: { ...c.syncConfig },
    autoloadConfig: { ...c.autoloadConfig },
    retentionConfig: { ...c.retentionConfig },
    wizardConfig: { ...c.wizardConfig },
    displayConfig: { ...c.displayConfig },
    collectionConfig: { ...c.collectionConfig },
    autoActivateConfig: { ...c.autoActivateConfig },
    sourcePriorityConfig: { ...c.sourcePriorityConfig },
    userIdentityConfig: { ...c.userIdentityConfig },
    configVersion: c.configVersion,
    updatedAt: c.updatedAt,
  };
}

function cloneDefault(): UserConfig {
  return cloneConfig(DEFAULT_USER_CONFIG);
}

// UUID v4 (8-4-4-4-12 hex). Defensive — the Postgres FK constraint on
// `user_settings.user_id → users.id` already rejects non-UUIDs at the
// DB layer, but we want the same shape in the in-memory + filesystem
// backends so behavioral parity holds.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertValidUserId(userId: string): void {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    const got = typeof userId === 'string' ? `"${userId}"` : typeof userId;
    throw new Error(`IUserConfigStore: userId must be a UUID; got ${got}`);
  }
}
