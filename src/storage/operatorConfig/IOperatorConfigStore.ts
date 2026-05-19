/**
 * IOperatorConfigStore
 *
 * Storage for per-host / operator-level configuration. Singleton row —
 * one operator config per deployment, no user_id.
 *
 * Mirrors the shape of `IAuthStorageLayer`: typed contract with three
 * backends (InMemory + Filesystem + Postgres), backend selected at
 * construction time by `createOperatorConfigStore`. All three implementations
 * pass the same `tests/integration/storage/operator-config-parity.test.ts`
 * cross-backend assertions.
 *
 * Why this exists: `ConfigManager` historically read/wrote a YAML file
 * at `~/.dollhouse/config.yml` for both per-user AND per-host settings
 * mixed together. Phase 4.5 splits them: per-host settings (enhanced
 * index, console port, license, deployment defaults) move here; per-user
 * settings move to `IUserConfigStore`. With `DOLLHOUSE_STORAGE_BACKEND=database`,
 * this store routes to Postgres, eliminating the filesystem touch that
 * broke containerized read-only-root deployments.
 *
 * Filesystem backend retains the existing file layout for operators on
 * `npx dollhousemcp` and other non-containerized deployments — zero
 * behavioral regression.
 *
 * @module storage/operatorConfig/IOperatorConfigStore
 */

/**
 * The operator config payload. Each section is a free-form jsonb-shaped
 * object; the keys inside are owned by `ConfigManager`. The storage layer
 * is intentionally schema-agnostic about section contents so that adding
 * new ConfigManager keys does not require a storage migration.
 */
export interface OperatorConfig {
  /** `elements.enhanced_index.*` — limits, telemetry, verbPatterns, etc. */
  enhancedIndexConfig: Record<string, unknown>;
  /** `console.port` and any future operator-level console settings. */
  consoleConfig: Record<string, unknown>;
  /** `license.*` — commercial license tier + attestation. */
  licenseConfig: Record<string, unknown>;
  /** `elements.default_element_dir`, schema `version`, deployment defaults. */
  defaultsConfig: Record<string, unknown>;
  /** ConfigManager's config-file schema version; used by migration code. */
  configVersion: number;
  /** Epoch ms of the most recent write; populated by `save()`. */
  updatedAt: number;
}

/**
 * Sentinel returned by `load()` when no operator config exists yet
 * (first start). Consumers can read keys without null-checking; ConfigManager's
 * defaults take over for any missing values.
 */
export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = Object.freeze({
  enhancedIndexConfig: {},
  consoleConfig: {},
  licenseConfig: {},
  defaultsConfig: {},
  configVersion: 1,
  updatedAt: 0,
});

/**
 * Storage contract for the singleton operator config. All methods async.
 *
 * Atomicity guarantees per backend:
 *   - InMemory: synchronous reference swap on the in-process object.
 *   - Filesystem: atomic write-temp + rename via `FileLockManager`.
 *   - Postgres: single-statement `INSERT ... ON CONFLICT (id) DO UPDATE`.
 */
export interface IOperatorConfigStore {
  /**
   * Load the singleton operator config. Returns a fresh copy of
   * `DEFAULT_OPERATOR_CONFIG` when no row exists yet — implementations MUST
   * NOT return null. The default lets ConfigManager initialize without
   * branching on first-start vs subsequent-start.
   */
  load(): Promise<OperatorConfig>;

  /**
   * Atomically write the singleton operator config. Replaces all sections —
   * partial updates are the caller's responsibility (ConfigManager reads,
   * mutates, writes). `updatedAt` is set by the implementation; the caller
   * may pass any value or omit it.
   */
  save(config: Omit<OperatorConfig, 'updatedAt'> & { updatedAt?: number }): Promise<void>;
}
