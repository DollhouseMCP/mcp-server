/**
 * IUserConfigStore
 *
 * Storage for per-user configuration. One row per user; tenant data —
 * accessed only inside the requesting user's RLS context (Postgres backend
 * runs all operations through `withUserContext`).
 *
 * Mirrors the shape of `IOperatorConfigStore`: typed contract with three
 * backends (InMemory + Filesystem + Postgres), backend selected at
 * construction time by `createUserConfigStore`. All three implementations
 * pass `tests/integration/storage/user-config-parity.test.ts`.
 *
 * Why this exists: `ConfigManager` historically read/wrote a single YAML
 * file at `~/.dollhouse/config.yml` for both per-user AND per-host settings
 * mixed together. Phase 4.5 splits them: per-host moves to
 * `IOperatorConfigStore`; per-user moves here. With
 * `DOLLHOUSE_STORAGE_BACKEND=database` everything routes to Postgres
 * (RLS-enforced); the filesystem fallback retains the existing layout
 * for `npx dollhousemcp` and other non-containerized deployments.
 *
 * @module storage/userConfig/IUserConfigStore
 */

/**
 * The per-user config payload. Each section is a free-form jsonb-shaped
 * object; the keys inside are owned by `ConfigManager`. Schema-agnostic
 * about section contents so adding ConfigManager keys does not require
 * a storage migration.
 *
 * Section list matches the columns added by migration 0013 plus the four
 * sections originally scaffolded in migration 0000:
 *   - github / sync / autoload / retention (original Phase 4 scaffolding)
 *   - wizard / display / collection / autoActivate / sourcePriority
 *     (Phase 4.5 additions)
 */
export interface UserConfig {
  /** `github.auth.*` + `github.portfolio.*` (per-user portfolio sync settings). */
  githubConfig: Record<string, unknown>;
  /** `sync.*` (individual / bulk / privacy preferences). */
  syncConfig: Record<string, unknown>;
  /** `autoLoad.*` (per-user memories list, token budget). */
  autoloadConfig: Record<string, unknown>;
  /** `retentionPolicy.*` (per-user TTL / enforcement). */
  retentionConfig: Record<string, unknown>;
  /** `wizard.*` (per-user setup-wizard state). */
  wizardConfig: Record<string, unknown>;
  /** `display.*` (UI indicators, verbose logging, progress display). */
  displayConfig: Record<string, unknown>;
  /** `collection.auto_submit / require_review / add_attribution`. */
  collectionConfig: Record<string, unknown>;
  /** `elements.auto_activate.*` (per-user activation lists). */
  autoActivateConfig: Record<string, unknown>;
  /** `source_priority` (element source preference order). */
  sourcePriorityConfig: Record<string, unknown>;
  /** ConfigManager's config-file schema version; used by migration code. */
  configVersion: number;
  /** Epoch ms of the most recent write; populated by `save()`. */
  updatedAt: number;
}

/**
 * Sentinel returned by `load(userId)` when no row exists for that user
 * yet (first-touch case). Consumers can read keys without null-checking;
 * ConfigManager's defaults take over for any missing values.
 */
export const DEFAULT_USER_CONFIG: UserConfig = Object.freeze({
  githubConfig: {},
  syncConfig: {},
  autoloadConfig: {},
  retentionConfig: {},
  wizardConfig: {},
  displayConfig: {},
  collectionConfig: {},
  autoActivateConfig: {},
  sourcePriorityConfig: {},
  configVersion: 1,
  updatedAt: 0,
});

/**
 * Storage contract for per-user config. All methods async, all keyed
 * on `userId` (UUID v4 string).
 *
 * Atomicity guarantees per backend:
 *   - InMemory: synchronous reference swap on the in-process Map.
 *   - Filesystem: atomic write-temp + rename via `FileLockManager`,
 *     one file per user under `<rootDir>/users/<userId>/config.json`.
 *   - Postgres: single-statement `INSERT ... ON CONFLICT (user_id) DO
 *     UPDATE`, run inside `withUserContext(userId, ...)` so the RLS
 *     `user_settings_isolation` policy enforces per-user write isolation.
 */
export interface IUserConfigStore {
  /**
   * Load this user's config. Returns a fresh copy of `DEFAULT_USER_CONFIG`
   * when no row exists for the user yet — implementations MUST NOT return
   * null. Lets ConfigManager initialize without branching on first-touch
   * vs subsequent-touch.
   */
  load(userId: string): Promise<UserConfig>;

  /**
   * Atomically write this user's config. Replaces all sections — partial
   * updates are the caller's responsibility (ConfigManager reads, mutates,
   * writes). `updatedAt` is set by the implementation; the caller may
   * pass any value or omit it.
   */
  save(userId: string, config: Omit<UserConfig, 'updatedAt'> & { updatedAt?: number }): Promise<void>;
}
