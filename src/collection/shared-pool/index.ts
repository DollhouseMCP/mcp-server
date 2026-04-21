/**
 * Shared Pool Module
 *
 * Deployment-scoped pool of public elements visible to all users.
 * Gated on `DOLLHOUSE_SHARED_POOL_ENABLED` (default: false).
 *
 * See `docs/COLLECTION-SHARED-POOL.md` for the full spec.
 *
 * @module collection/shared-pool
 */

// Types and data model
export type {
  SharedPoolOrigin,
  ProvenanceRecord,
  ProvenanceLookupResult,
  SharedPoolInstallRequest,
  SharedPoolInstallResult,
  EditRedirect,
  WriteRedirect,
} from './types.js';

// Configuration and feature flag
export {
  SYSTEM_USER_UUID,
  SYSTEM_USERNAME,
  SYSTEM_DISPLAY_NAME,
  isSharedPoolEnabled,
  resolveSharedPoolConfig,
  type SharedPoolConfiguration,
} from './SharedPoolConfig.js';

// Interfaces (backend-agnostic contracts)
export type { IProvenanceStore } from './IProvenanceStore.js';
export type { ISharedPoolInstaller } from './ISharedPoolInstaller.js';

// ContentHashVerifier (no Drizzle dependency — safe for barrel export)
export { ContentHashVerifier } from './ContentHashVerifier.js';

// FileProvenanceStore (no Drizzle dependency — safe for barrel export)
export { FileProvenanceStore } from './FileProvenanceStore.js';

// ForkOnEditStrategy (no Drizzle dependency — safe for barrel export)
export { ForkOnEditStrategy } from './ForkOnEditStrategy.js';
export type { ForkDecision, ForkResult, NoForkNeeded, ForkContext } from './ForkOnEditStrategy.js';

// DatabaseProvenanceStore is intentionally NOT re-exported here.
// It statically imports drizzle-orm, so barrel-exporting it would
// pull Drizzle into the static import graph. The registrar
// dynamic-imports it: `await import('./DatabaseProvenanceStore.js')`.

// SystemUserProvisioner is intentionally NOT re-exported here.
// It statically imports drizzle-orm (eq), so barrel-exporting it would
// pull Drizzle into the static import graph for file-mode deployments.
// The registrar dynamic-imports it: `await import('./SystemUserProvisioner.js')`.

// DI registrar
export { SharedPoolServiceRegistrar } from './SharedPoolServiceRegistrar.js';
