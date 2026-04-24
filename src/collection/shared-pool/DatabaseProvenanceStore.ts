/**
 * DatabaseProvenanceStore
 *
 * DB-mode implementation of IProvenanceStore. Reads and writes the
 * `element_provenance` table via Drizzle ORM.
 *
 * All reads use the app role (RLS-enforced — provenance is visible
 * only if the linked element is visible). All writes go through
 * `withSystemContext()` since only the admin role can INSERT into
 * element_provenance (no app-role INSERT policy).
 *
 * @module collection/shared-pool/DatabaseProvenanceStore
 */

import { eq, and, isNull } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import { elementProvenance } from '../../database/schema/provenance.js';
import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { IProvenanceStore } from './IProvenanceStore.js';
import type {
  ProvenanceRecord,
  ProvenanceLookupResult,
  SharedPoolOrigin,
} from './types.js';

export class DatabaseProvenanceStore implements IProvenanceStore {
  constructor(private readonly db: DatabaseInstance) {}

  async lookup(
    origin: SharedPoolOrigin,
    sourceUrl: string | null,
    sourceVersion: string | null,
    contentHash: string,
  ): Promise<ProvenanceLookupResult> {
    const conditions = [eq(elementProvenance.origin, origin)];

    if (sourceUrl === null) {
      conditions.push(isNull(elementProvenance.sourceUrl));
    } else {
      conditions.push(eq(elementProvenance.sourceUrl, sourceUrl));
    }

    if (sourceVersion === null) {
      conditions.push(isNull(elementProvenance.sourceVersion));
    } else {
      conditions.push(eq(elementProvenance.sourceVersion, sourceVersion));
    }

    const rows = await this.db
      .select()
      .from(elementProvenance)
      .where(and(...conditions))
      .limit(1);

    if (rows.length === 0) return { status: 'not_found' };

    const record = this.toRecord(rows[0]);

    if (record.contentHash === contentHash) {
      return { status: 'match', record };
    }

    return { status: 'hash_mismatch', record, actualHash: contentHash };
  }

  async findByElementId(elementId: string): Promise<ProvenanceRecord | null> {
    const rows = await this.db
      .select()
      .from(elementProvenance)
      .where(eq(elementProvenance.elementId, elementId))
      .limit(1);

    if (rows.length === 0) return null;
    return this.toRecord(rows[0]);
  }

  async save(record: ProvenanceRecord): Promise<void> {
    await withSystemContext(this.db, async (tx) => {
      await tx.insert(elementProvenance).values({
        elementId: record.elementId,
        origin: record.origin,
        sourceUrl: record.sourceUrl,
        sourceVersion: record.sourceVersion,
        contentHash: record.contentHash,
        forkedFrom: record.forkedFrom,
        installedAt: new Date(record.installedAt),
      });
    });

    logger.debug('[DatabaseProvenanceStore] Saved provenance record', {
      elementId: record.elementId,
      origin: record.origin,
    });
  }

  async update(record: ProvenanceRecord): Promise<void> {
    await withSystemContext(this.db, async (tx) => {
      await tx
        .update(elementProvenance)
        .set({
          origin: record.origin,
          sourceUrl: record.sourceUrl,
          sourceVersion: record.sourceVersion,
          contentHash: record.contentHash,
          forkedFrom: record.forkedFrom,
          installedAt: new Date(record.installedAt),
        })
        .where(eq(elementProvenance.elementId, record.elementId));
    });

    logger.debug('[DatabaseProvenanceStore] Updated provenance record', {
      elementId: record.elementId,
      origin: record.origin,
    });
  }

  async listByOrigin(origin: SharedPoolOrigin): Promise<ProvenanceRecord[]> {
    const rows = await this.db
      .select()
      .from(elementProvenance)
      .where(eq(elementProvenance.origin, origin));

    return rows.map(r => this.toRecord(r));
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private toRecord(row: typeof elementProvenance.$inferSelect): ProvenanceRecord {
    return {
      elementId: row.elementId,
      origin: row.origin as SharedPoolOrigin,
      sourceUrl: row.sourceUrl,
      sourceVersion: row.sourceVersion,
      contentHash: row.contentHash,
      forkedFrom: row.forkedFrom,
      installedAt: row.installedAt.toISOString(),
    };
  }
}
