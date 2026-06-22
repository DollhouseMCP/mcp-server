/**
 * Shared Pool — Installer Interface
 *
 * Backend-agnostic interface for writing content into the shared pool.
 * The installer is the only code path that creates SYSTEM-owned
 * elements — admin elevation is code-path-scoped, not user-role-scoped.
 *
 * Two consumers call this:
 * - `install_collection_content` MCP tool (collection origin)
 * - `DeploymentSeedLoader` at bootstrap (deployment_seed origin)
 *
 * @module collection/shared-pool/ISharedPoolInstaller
 */

import type { SharedPoolInstallRequest, SharedPoolInstallResult } from './types.js';

export interface ISharedPoolInstaller {
  /**
   * Install content into the shared pool.
   *
   * The method is idempotent: if identical content already exists in
   * the pool (same origin + source URL + version + hash), the call
   * returns `action: 'skipped'` without writing.
   *
   * If the same canonical identity exists but with a different hash,
   * behavior depends on origin:
   * - `collection`: reject (tamper detection)
   * - `deployment_seed`: update (operator changed the seed file)
   *
   * @param request - Content and metadata to install.
   * @returns Result describing what happened (installed, skipped, rejected).
   */
  install(request: SharedPoolInstallRequest): Promise<SharedPoolInstallResult>;
}
