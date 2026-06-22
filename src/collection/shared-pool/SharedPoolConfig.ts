/**
 * Shared Pool — Configuration
 *
 * Reads feature flags and env-driven configuration for the shared pool
 * module. All config is resolved through the validated `env` object in
 * `src/config/env.ts` — the single source of truth for environment
 * variables. The Zod schema handles parsing, validation, and defaults.
 *
 * @module collection/shared-pool/SharedPoolConfig
 */

import { env } from '../../config/env.js';

/**
 * Well-known UUID for the SYSTEM user that owns shared-pool elements
 * in DB mode. Pinned so every deployment agrees on the identity and
 * migrations can reference it deterministically.
 *
 * In file mode this UUID is unused — the `shared/` directory itself
 * is the trust boundary.
 */
export const SYSTEM_USER_UUID = '00000000-0000-0000-0000-000000000001';

/** Username for the SYSTEM user row in the `users` table. */
export const SYSTEM_USERNAME = 'dollhousemcp-system';

/** Display name for the SYSTEM user. */
export const SYSTEM_DISPLAY_NAME = 'DollhouseMCP System';

/**
 * Resolved configuration for the shared pool module.
 */
export interface SharedPoolConfiguration {
  /** Whether the shared pool feature is enabled. */
  enabled: boolean;

  /** Override for the collection base URL (default: upstream DollhouseMCP). */
  collectionUrl: string | undefined;

  /** Additional hosts to add to GitHubClient's SSRF allowlist.
   *  Validated against the HTTP_ALLOWED_HOST_PATTERN by env.ts. */
  collectionAllowlist: readonly string[];

  /** Override for the shared-pool seed directory. */
  sharedPoolDir: string | undefined;
}

/**
 * Read the shared-pool feature flag from the validated env config.
 *
 * Default is `false` — the feature is opt-in. When disabled, the
 * registrar skips all service registrations and the rest of the
 * codebase behaves identically to pre-4.6.
 */
export function isSharedPoolEnabled(): boolean {
  return env.DOLLHOUSE_SHARED_POOL_ENABLED;
}

/**
 * Resolve the full shared-pool configuration from the validated env.
 */
export function resolveSharedPoolConfig(): SharedPoolConfiguration {
  return {
    enabled: isSharedPoolEnabled(),
    collectionUrl: env.DOLLHOUSE_COLLECTION_URL,
    collectionAllowlist: env.DOLLHOUSE_COLLECTION_ALLOWLIST ?? [],
    sharedPoolDir: env.DOLLHOUSE_SHARED_POOL_DIR,
  };
}
