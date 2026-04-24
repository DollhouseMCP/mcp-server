/**
 * FileProvenanceStore
 *
 * File-mode implementation of IProvenanceStore. Stores provenance
 * records as JSON manifest files under `shared/.provenance/<name>.json`.
 *
 * Each manifest file contains a single ProvenanceRecord serialized as
 * JSON. File naming follows the element name (not path) — collisions
 * across element types are avoided because each element type has a
 * unique name within the shared pool.
 *
 * @module collection/shared-pool/FileProvenanceStore
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../../utils/logger.js';
import type { IProvenanceStore } from './IProvenanceStore.js';
import type {
  ProvenanceRecord,
  ProvenanceLookupResult,
  SharedPoolOrigin,
} from './types.js';

export class FileProvenanceStore implements IProvenanceStore {
  /**
   * @param provenanceDir — Absolute path to the `.provenance/` directory
   *   (typically `resolveDataDirectory('shared-provenance')`).
   */
  constructor(private readonly provenanceDir: string) {}

  async lookup(
    origin: SharedPoolOrigin,
    sourceUrl: string | null,
    sourceVersion: string | null,
    contentHash: string,
  ): Promise<ProvenanceLookupResult> {
    const records = await this.readAll();

    const match = records.find(r =>
      r.origin === origin &&
      r.sourceUrl === sourceUrl &&
      r.sourceVersion === sourceVersion
    );

    if (!match) return { status: 'not_found' };

    if (match.contentHash === contentHash) {
      return { status: 'match', record: match };
    }

    return { status: 'hash_mismatch', record: match, actualHash: contentHash };
  }

  async findByElementId(elementId: string): Promise<ProvenanceRecord | null> {
    const records = await this.readAll();
    return records.find(r => r.elementId === elementId) ?? null;
  }

  async save(record: ProvenanceRecord): Promise<void> {
    await fs.mkdir(this.provenanceDir, { recursive: true });
    const filePath = this.recordPath(record.elementId);

    try {
      await fs.access(filePath);
      throw new Error(
        `Provenance record already exists for element '${record.elementId}' at ${filePath}`
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    await this.writeRecord(filePath, record);
    logger.debug('[FileProvenanceStore] Saved provenance record', {
      elementId: record.elementId,
      origin: record.origin,
    });
  }

  async update(record: ProvenanceRecord): Promise<void> {
    const filePath = this.recordPath(record.elementId);
    await this.writeRecord(filePath, record);
    logger.debug('[FileProvenanceStore] Updated provenance record', {
      elementId: record.elementId,
      origin: record.origin,
    });
  }

  async listByOrigin(origin: SharedPoolOrigin): Promise<ProvenanceRecord[]> {
    const all = await this.readAll();
    return all.filter(r => r.origin === origin);
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Derive the manifest file path from an elementId.
   * elementId in file mode is a relative path like `personas/code-reviewer.md`.
   * The manifest includes the element type to prevent cross-type collisions
   * (e.g. `personas/code-reviewer.md` → `.provenance/personas--code-reviewer.json`).
   */
  private recordPath(elementId: string): string {
    const sanitized = elementId.replaceAll('\0', '').replaceAll('\\', '/');
    const withoutExt = sanitized.replace(/\.[^.]+$/, '');
    const safeKey = withoutExt.replaceAll('/', '--');
    return path.join(this.provenanceDir, `${safeKey}.json`);
  }

  private async writeRecord(filePath: string, record: ProvenanceRecord): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    const json = JSON.stringify(record, null, 2) + '\n';
    await fs.writeFile(tmpPath, json, 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  private async readAll(): Promise<ProvenanceRecord[]> {
    try {
      const entries = await fs.readdir(this.provenanceDir);
      const jsonFiles = entries.filter(e => e.endsWith('.json'));

      const records: ProvenanceRecord[] = [];
      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(
            path.join(this.provenanceDir, file),
            'utf-8',
          );
          records.push(JSON.parse(content) as ProvenanceRecord);
        } catch (err) {
          logger.warn(`[FileProvenanceStore] Failed to read provenance file ${file}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return records;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
