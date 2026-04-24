/**
 * Shared Pool — Provenance Store Interface
 *
 * Backend-agnostic interface for reading and writing provenance records.
 * Two implementations exist:
 *
 * - `DatabaseProvenanceStore`: reads/writes the `element_provenance`
 *   table via Drizzle (DB mode).
 * - `FileProvenanceStore`: reads/writes `.provenance/<name>.json`
 *   manifest files under the shared directory (file mode).
 *
 * The interface is intentionally narrow — just enough for the
 * SharedPoolInstaller and ContentHashVerifier to do their work
 * without knowing which backend they're running on.
 *
 * @module collection/shared-pool/IProvenanceStore
 */

import type { ProvenanceRecord, ProvenanceLookupResult, SharedPoolOrigin } from './types.js';

export interface IProvenanceStore {
  /**
   * Look up a provenance record by canonical identity tuple.
   *
   * @param origin - How the element entered the pool.
   * @param sourceUrl - Source location (null-safe equality).
   * @param sourceVersion - Version tag (null-safe equality).
   * @param contentHash - SHA-256 hex digest of the content being checked.
   * @returns Lookup result: match (identical hash), hash_mismatch, or not_found.
   */
  lookup(
    origin: SharedPoolOrigin,
    sourceUrl: string | null,
    sourceVersion: string | null,
    contentHash: string,
  ): Promise<ProvenanceLookupResult>;

  /**
   * Look up a provenance record by element ID.
   *
   * @param elementId - UUID (DB) or relative path (file).
   * @returns The record, or null if no provenance exists for this element.
   */
  findByElementId(elementId: string): Promise<ProvenanceRecord | null>;

  /**
   * Persist a new provenance record.
   *
   * @param record - The provenance record to store.
   * @throws If a record with the same canonical identity already exists.
   */
  save(record: ProvenanceRecord): Promise<void>;

  /**
   * Update an existing provenance record (e.g. when a deployment seed
   * file changes and the hash needs updating).
   *
   * @param record - The updated record. Must already exist by elementId.
   */
  update(record: ProvenanceRecord): Promise<void>;

  /**
   * List all provenance records for a given origin.
   * Used by orphan detection in the deployment seed loader.
   *
   * @param origin - Filter by origin type.
   * @returns All matching records.
   */
  listByOrigin(origin: SharedPoolOrigin): Promise<ProvenanceRecord[]>;
}
