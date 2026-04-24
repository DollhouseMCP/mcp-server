/**
 * DeploymentSeedLoader
 *
 * Scans a deployment-configured directory for element files and
 * upserts them into the shared pool at server startup. This enables
 * operators to ship custom elements to all users without depending
 * on the upstream collection or GitHub.
 *
 * The seed directory follows the portfolio layout:
 *   <seed-dir>/<type>/<name>.md
 *
 * Idempotent: runs on every boot, skips unchanged content, updates
 * modified seeds, and warns (but does not delete) orphaned records.
 *
 * @module collection/shared-pool/DeploymentSeedLoader
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import type { ISharedPoolInstaller } from './ISharedPoolInstaller.js';
import type { IProvenanceStore } from './IProvenanceStore.js';

const SUPPORTED_ELEMENT_TYPES = new Set([
  'personas', 'skills', 'templates', 'agents', 'memories', 'ensembles',
]);

const SUPPORTED_EXTENSIONS = new Set(['.md', '.yaml', '.yml']);

export interface DeploymentSeedLoaderResult {
  installed: number;
  skipped: number;
  failed: number;
  orphans: number;
}

export class DeploymentSeedLoader {
  constructor(
    private readonly seedDir: string,
    private readonly installer: ISharedPoolInstaller,
    private readonly provenanceStore: IProvenanceStore,
  ) {}

  /**
   * Scan the seed directory and upsert all element files into the
   * shared pool. Safe to call on every startup.
   *
   * @returns Summary of what happened.
   */
  async loadSeeds(): Promise<DeploymentSeedLoaderResult> {
    const result: DeploymentSeedLoaderResult = {
      installed: 0, skipped: 0, failed: 0, orphans: 0,
    };

    const seedDirExists = await this.dirExists(this.seedDir);
    if (!seedDirExists) {
      logger.debug('[DeploymentSeedLoader] Seed directory does not exist, skipping', {
        seedDir: this.seedDir,
      });
      return result;
    }

    const files = await this.scanSeedFiles();
    if (files.length === 0) {
      logger.debug('[DeploymentSeedLoader] No seed files found');
      return result;
    }

    logger.info(`[DeploymentSeedLoader] Found ${files.length} seed file(s)`, {
      seedDir: this.seedDir,
    });

    for (const file of files) {
      try {
        const action = await this.processSeedFile(file);
        switch (action) {
          case 'installed': result.installed++; break;
          case 'skipped': result.skipped++; break;
          case 'rejected': result.failed++; break;
        }
      } catch (err) {
        result.failed++;
        logger.error(`[DeploymentSeedLoader] Failed to process seed file: ${file.relativePath}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    result.orphans = await this.detectOrphans(files);

    logger.info('[DeploymentSeedLoader] Seed loading complete', result);

    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION' as 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'DeploymentSeedLoader.loadSeeds',
      details: `Deployment seed loading complete: ${result.installed} installed, ${result.skipped} skipped, ${result.failed} failed, ${result.orphans} orphans`,
    });

    return result;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async scanSeedFiles(): Promise<SeedFile[]> {
    const files: SeedFile[] = [];

    let typeDirs: string[];
    try {
      typeDirs = await fs.readdir(this.seedDir);
    } catch {
      return files;
    }

    for (const typeDir of typeDirs) {
      if (!SUPPORTED_ELEMENT_TYPES.has(typeDir)) continue;

      const typePath = path.join(this.seedDir, typeDir);
      const stat = await fs.stat(typePath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      let entries: string[];
      try {
        entries = await fs.readdir(typePath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

        files.push({
          absolutePath: path.join(typePath, entry),
          relativePath: `${typeDir}/${entry}`,
          elementType: typeDir,
          name: path.basename(entry, ext),
        });
      }
    }

    return files;
  }

  private async processSeedFile(file: SeedFile): Promise<'installed' | 'skipped' | 'rejected'> {
    const content = await fs.readFile(file.absolutePath, 'utf-8');
    const sourceUrl = `file://${file.absolutePath}`;

    const result = await this.installer.install({
      content,
      elementType: file.elementType,
      name: file.name,
      origin: 'deployment_seed',
      sourceUrl,
      sourceVersion: null,
    });

    if (result.action === 'installed') {
      logger.debug(`[DeploymentSeedLoader] Installed: ${file.relativePath}`);
    } else if (result.action === 'skipped') {
      logger.debug(`[DeploymentSeedLoader] Skipped (unchanged): ${file.relativePath}`);
    }

    return result.action;
  }

  private async detectOrphans(currentFiles: SeedFile[]): Promise<number> {
    const seedRecords = await this.provenanceStore.listByOrigin('deployment_seed');
    if (seedRecords.length === 0) return 0;

    const currentSourceUrls = new Set(
      currentFiles.map(f => `file://${f.absolutePath}`)
    );

    let orphanCount = 0;
    for (const record of seedRecords) {
      if (record.sourceUrl && !currentSourceUrls.has(record.sourceUrl)) {
        orphanCount++;
        logger.warn(`[DeploymentSeedLoader] Orphaned seed record: ${record.sourceUrl}`, {
          elementId: record.elementId,
          origin: record.origin,
        });
      }
    }

    return orphanCount;
  }

  private async dirExists(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}

interface SeedFile {
  absolutePath: string;
  relativePath: string;
  elementType: string;
  name: string;
}
