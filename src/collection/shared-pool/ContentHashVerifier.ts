/**
 * ContentHashVerifier
 *
 * Computes SHA-256 content hashes and compares them against stored
 * provenance records. Backend-agnostic — delegates storage to the
 * injected IProvenanceStore.
 *
 * Three outcomes:
 * - `match`: identical content already exists in the pool (skip write).
 * - `hash_mismatch`: same canonical identity but different content
 *   (tamper detection for collection installs; update for seeds).
 * - `not_found`: no existing record — proceed with install.
 *
 * @module collection/shared-pool/ContentHashVerifier
 */

import { createHash } from 'node:crypto';
import type { IProvenanceStore } from './IProvenanceStore.js';
import type { ProvenanceLookupResult, SharedPoolOrigin } from './types.js';

export class ContentHashVerifier {
  constructor(private readonly store: IProvenanceStore) {}

  /**
   * Compute the SHA-256 hex digest of raw content.
   */
  computeHash(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * Check whether content with the given canonical identity already
   * exists in the provenance store, and whether the hash matches.
   */
  async verify(
    origin: SharedPoolOrigin,
    sourceUrl: string | null,
    sourceVersion: string | null,
    content: string,
  ): Promise<ProvenanceLookupResult> {
    const contentHash = this.computeHash(content);
    return this.store.lookup(origin, sourceUrl, sourceVersion, contentHash);
  }
}
