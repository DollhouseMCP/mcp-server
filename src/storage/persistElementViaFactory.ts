/**
 * Persist an element through the injected IStorageLayerFactory when the
 * factory produces a writable (database-backed) storage layer.
 *
 * This is the shared routing helper that closes the Phase 4 storage-refactor
 * gap: code paths that pre-date the database-backend (`ElementInstaller`,
 * `PortfolioPullHandler.downloadAndSaveElement`,
 * `PortfolioSyncManager.downloadElement`) historically wrote element content
 * directly via `fileOperations.writeFile`. In DB-mode deployments that
 * filesystem write lands on the per-user portfolio dir — often tmpfs in
 * containerized deployments — and vanishes on every restart. Routing through
 * the factory uses the same storage layer the `create_element` MCP tool
 * already uses, so installs/pulls/syncs actually persist to Postgres.
 *
 * Behavior:
 * - When `factory` is undefined → returns false (caller falls back to filesystem)
 * - When `factory.createForElement` returns a non-writable layer (filesystem
 *   backend) → returns false (caller falls back to filesystem)
 * - When the layer is writable → calls `writeContent` and returns true
 *
 * The `writeContent` storage layer already extracts metadata (author, version,
 * description, tags) from the content's YAML frontmatter via
 * `FrontmatterParser.extractMetadata`, so callers don't need to pre-parse —
 * the metadata arg we pass is just a fallback when frontmatter is absent.
 *
 * @since Phase 4.5 PoC verification follow-up
 */

import type { IStorageLayerFactory, FileStorageOptions } from './IStorageLayerFactory.js';
import { isWritableStorageLayer } from './IStorageLayer.js';

export interface PersistViaFactoryOptions {
  /** When true, throw if an element with this name already exists. */
  exclusive?: boolean;
  /** Human-readable element label for error messages (e.g. "Persona"). */
  elementLabel?: string;
}

/**
 * Attempt to persist element content through the storage-layer factory.
 *
 * @param factory      Optional IStorageLayerFactory; when undefined caller
 *                     should fall back to its legacy filesystem write path.
 * @param elementType  Element type (e.g. 'personas', 'skills', 'memories').
 * @param elementName  Element name as it will appear in the elements table.
 * @param content      Full element content (YAML frontmatter + body).
 * @param fileOptions  FileStorageOptions for the filesystem variant — ignored
 *                     by the database backend, but required by the factory's
 *                     interface contract. Pass the appropriate elementDir
 *                     for filesystem-backend symmetry.
 * @param options      Optional writeContent options (exclusive flag, label).
 * @returns true if persistence happened through the storage layer, false if
 *          the caller should fall back to its filesystem write path.
 */
export async function persistElementViaFactory(
  factory: IStorageLayerFactory | undefined,
  elementType: string,
  elementName: string,
  content: string,
  fileOptions: FileStorageOptions,
  options?: PersistViaFactoryOptions,
): Promise<boolean> {
  if (!factory) return false;
  const layer = factory.createForElement(elementType, fileOptions);
  if (!isWritableStorageLayer(layer)) return false;
  await layer.writeContent(
    elementType,
    elementName,
    content,
    // Fallback metadata only — DatabaseStorageLayer.writeContent extracts
    // author/version/description/tags from the content's YAML frontmatter
    // via FrontmatterParser.extractMetadata, so empty strings here are
    // overridden whenever the frontmatter is well-formed.
    { author: '', version: '', description: '', tags: [] },
    {
      exclusive: options?.exclusive ?? false,
      elementLabel: options?.elementLabel,
    },
  );
  return true;
}
