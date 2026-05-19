/**
 * PostgresUserConfigStore
 *
 * Database-backed `IUserConfigStore` using Drizzle against the
 * `user_settings` table (created in migration 0000, identity columns
 * dropped in 0001, RLS enabled in 0004, columns extended in 0013).
 *
 * RLS: every operation runs inside `withUserContext(userId, ...)`. The
 * `user_settings_isolation` policy filters rows where
 * `user_id = current_setting('app.current_user_id')::uuid`, with
 * `FORCE ROW LEVEL SECURITY` so even the app role can't bypass it.
 * A `load(userIdA)` call CANNOT see `userIdB`'s row — guaranteed at
 * the database layer, not just by application logic.
 *
 * Atomicity: `save()` issues a single `INSERT ... ON CONFLICT (user_id)
 * DO UPDATE` statement. Per-user, so even if two writes race for the
 * same user, the database serializes them.
 *
 * Foreign key: `user_settings.user_id → users.id ON DELETE CASCADE`,
 * so callers MUST ensure the user row exists before calling `save()`.
 * (The Phase 4 user-bootstrap path handles this; integration tests
 * use `ensureTestUser()` from test-db-helpers.)
 *
 * @module storage/userConfig/PostgresUserConfigStore
 */

import { eq } from 'drizzle-orm';

import type { DatabaseInstance } from '../../database/connection.js';
import { withUserContext, withUserRead } from '../../database/rls.js';
import { userSettings } from '../../database/schema/index.js';
import type { IUserConfigStore, UserConfig } from './IUserConfigStore.js';
import { DEFAULT_USER_CONFIG } from './IUserConfigStore.js';

export interface PostgresUserConfigStoreOptions {
  /** Drizzle DB instance. Pass the same instance the rest of the app uses. */
  db: DatabaseInstance;
}

interface UserSettingsRow {
  userId: string;
  githubConfig: unknown;
  syncConfig: unknown;
  autoloadConfig: unknown;
  retentionConfig: unknown;
  wizardConfig: unknown;
  displayConfig: unknown;
  collectionConfig: unknown;
  autoActivateConfig: unknown;
  sourcePriorityConfig: unknown;
  userIdentityConfig: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export class PostgresUserConfigStore implements IUserConfigStore {
  private readonly db: DatabaseInstance;

  constructor(options: PostgresUserConfigStoreOptions) {
    this.db = options.db;
  }

  async load(userId: string): Promise<UserConfig> {
    assertValidUserId(userId);
    const rows = await withUserRead(this.db, userId, (tx) =>
      tx.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1),
    );
    if (rows.length === 0) return cloneDefault();
    return rowToConfig(rows[0] as UserSettingsRow);
  }

  async save(
    userId: string,
    config: Omit<UserConfig, 'updatedAt'> & { updatedAt?: number },
  ): Promise<void> {
    assertValidUserId(userId);
    const now = new Date();
    const writeRow = {
      userId,
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
      updatedAt: now,
    };

    await withUserContext(this.db, userId, async (tx) => {
      await tx
        .insert(userSettings)
        .values(writeRow)
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            githubConfig: writeRow.githubConfig,
            syncConfig: writeRow.syncConfig,
            autoloadConfig: writeRow.autoloadConfig,
            retentionConfig: writeRow.retentionConfig,
            wizardConfig: writeRow.wizardConfig,
            displayConfig: writeRow.displayConfig,
            collectionConfig: writeRow.collectionConfig,
            autoActivateConfig: writeRow.autoActivateConfig,
            sourcePriorityConfig: writeRow.sourcePriorityConfig,
            userIdentityConfig: writeRow.userIdentityConfig,
            updatedAt: writeRow.updatedAt,
          },
        });
    });
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

function rowToConfig(row: UserSettingsRow): UserConfig {
  return {
    githubConfig: coerceObject(row.githubConfig),
    syncConfig: coerceObject(row.syncConfig),
    autoloadConfig: coerceObject(row.autoloadConfig),
    retentionConfig: coerceObject(row.retentionConfig),
    wizardConfig: coerceObject(row.wizardConfig),
    displayConfig: coerceObject(row.displayConfig),
    collectionConfig: coerceObject(row.collectionConfig),
    autoActivateConfig: coerceObject(row.autoActivateConfig),
    sourcePriorityConfig: coerceObject(row.sourcePriorityConfig),
    userIdentityConfig: coerceObject(row.userIdentityConfig),
    // The schema stores configVersion implicitly as the schema version
    // of the user_settings table itself — no per-row column. Map to the
    // default; future migrations may add a per-row config_version column
    // if section-shape evolution requires it.
    configVersion: DEFAULT_USER_CONFIG.configVersion,
    updatedAt: row.updatedAt.getTime(),
  };
}

function coerceObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertValidUserId(userId: string): void {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    const got = typeof userId === 'string' ? `"${userId}"` : typeof userId;
    throw new Error(`IUserConfigStore: userId must be a UUID; got ${got}`);
  }
}
