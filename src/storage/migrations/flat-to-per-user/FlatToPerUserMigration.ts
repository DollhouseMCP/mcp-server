/**
 * FlatToPerUserMigration — migrates a flat single-user portfolio layout
 * to the per-user multi-user layout.
 *
 * Flat layout (before):
 *   ~/.dollhouse/
 *   ├── portfolio/personas/
 *   ├── portfolio/skills/
 *   ├── portfolio/.backups/
 *   ├── state/activations-*.json
 *   ├── .auth/github_token.enc
 *   └── security/blocked-agents.json
 *
 * Per-user layout (after):
 *   ~/.dollhouse/
 *   ├── users/<userId>/
 *   │   ├── portfolio/personas/
 *   │   ├── portfolio/skills/
 *   │   ├── backups/
 *   │   ├── state/activations-*.json
 *   │   ├── auth/github_token.enc
 *   │   └── security/blocked-agents.json
 *   ├── shared/
 *   └── .dollhouse-per-user-migrated   ← marker file
 *
 * The migration is:
 * - Invoked explicitly via the migrate_portfolio_layout MCP tool
 * - Never automatic at startup
 * - Idempotent (safe to re-run — already-moved dirs are skipped)
 * - Partial runs are safe to retry (moves that succeeded stay; remaining retry)
 *
 * @since Step 4.5 Commit 4
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../../utils/logger.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import { MIGRATION_MARKER_FILENAME } from '../../../paths/LegacyDetectingPathResolver.js';
import { ElementType } from '../../../portfolio/types.js';

export interface MigrationStatus {
  layout: 'flat' | 'per-user' | 'new-install';
  legacyRoot: string;
  userId?: string;
}

export interface MigrationPreview {
  moves: Array<{ from: string; to: string }>;
  dirsToCreate: string[];
  markerFile: string;
}

export interface MigrationResult {
  success: boolean;
  movedCount: number;
  errors: string[];
}

export class FlatToPerUserMigration {
  constructor(
    private readonly legacyRoot: string,
    private readonly userId: string,
  ) {}

  /**
   * Detect the current layout without modifying anything.
   */
  async status(): Promise<MigrationStatus> {
    const legacyExists = await this.dirExists(this.legacyRoot);
    if (!legacyExists) {
      return { layout: 'new-install', legacyRoot: this.legacyRoot };
    }

    const markerPath = path.join(this.legacyRoot, MIGRATION_MARKER_FILENAME);
    const markerExists = await this.fileExists(markerPath);
    if (markerExists) {
      return { layout: 'per-user', legacyRoot: this.legacyRoot, userId: this.userId };
    }

    return { layout: 'flat', legacyRoot: this.legacyRoot, userId: this.userId };
  }

  /**
   * Show what would be moved without doing it.
   */
  async preview(): Promise<MigrationPreview> {
    const userRoot = path.join(this.legacyRoot, 'users', this.userId);
    const moves: MigrationPreview['moves'] = [];
    const dirsToCreate: string[] = [
      path.join(this.legacyRoot, 'users'),
      userRoot,
      path.join(userRoot, 'portfolio'),
      path.join(userRoot, 'state'),
      path.join(userRoot, 'auth'),
      path.join(userRoot, 'backups'),
      path.join(userRoot, 'security'),
      path.join(this.legacyRoot, 'shared'),
    ];

    // Portfolio element dirs
    for (const type of Object.values(ElementType)) {
      const src = path.join(this.legacyRoot, 'portfolio', type);
      if (await this.dirExists(src)) {
        moves.push({ from: src, to: path.join(userRoot, 'portfolio', type) });
      }
    }

    // Agent .state dir is inside agents/ — it moves with the agents element
    // dir above. No separate move needed.

    // Portfolio backups
    const backups = path.join(this.legacyRoot, 'portfolio', '.backups');
    if (await this.dirExists(backups)) {
      moves.push({ from: backups, to: path.join(userRoot, 'backups') });
    }

    // State files (activations, confirmations, challenges)
    const stateDir = path.join(this.legacyRoot, 'state');
    if (await this.dirExists(stateDir)) {
      moves.push({ from: stateDir, to: path.join(userRoot, 'state') });
    }

    // Auth dir
    const authDir = path.join(this.legacyRoot, '.auth');
    if (await this.dirExists(authDir)) {
      moves.push({ from: authDir, to: path.join(userRoot, 'auth') });
    }

    // Security dir
    const securityDir = path.join(this.legacyRoot, 'security');
    if (await this.dirExists(securityDir)) {
      moves.push({ from: securityDir, to: path.join(userRoot, 'security') });
    }

    return {
      moves,
      dirsToCreate,
      markerFile: path.join(this.legacyRoot, MIGRATION_MARKER_FILENAME),
    };
  }

  /**
   * Execute the migration. Creates per-user directories, copies content,
   * and writes the migration marker file.
   */
  async execute(): Promise<MigrationResult> {
    const currentStatus = await this.status();
    if (currentStatus.layout === 'per-user') {
      return { success: true, movedCount: 0, errors: [] };
    }
    if (currentStatus.layout === 'new-install') {
      return { success: false, movedCount: 0, errors: ['No legacy root found — nothing to migrate'] };
    }

    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: 'LOW',
      source: 'FlatToPerUserMigration',
      details: `Starting flat-to-per-user migration for userId ${this.userId}`,
    });

    const preview = await this.preview();
    const result: MigrationResult = { success: true, movedCount: 0, errors: [] };

    // Create target directories
    for (const dir of preview.dirsToCreate) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (err) {
        const msg = `Failed to create ${dir}: ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(msg);
        result.success = false;
        logger.error(`[FlatToPerUserMigration] ${msg}`);
        return result;
      }
    }

    // Move content
    for (const move of preview.moves) {
      try {
        await this.moveDir(move.from, move.to);
        result.movedCount++;
        logger.info(`[FlatToPerUserMigration] Moved ${move.from} → ${move.to}`);
      } catch (err) {
        const msg = `Failed to move ${move.from} → ${move.to}: ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(msg);
        result.success = false;
        logger.error(`[FlatToPerUserMigration] ${msg}`);
      }
    }

    // Write migration marker
    if (result.success) {
      try {
        const markerPath = path.join(this.legacyRoot, MIGRATION_MARKER_FILENAME);
        await fs.writeFile(markerPath, JSON.stringify({
          version: 1,
          migratedAt: new Date().toISOString(),
          userId: this.userId,
          movedCount: result.movedCount,
        }, null, 2));
        logger.info(`[FlatToPerUserMigration] Migration complete — marker written`);
      } catch (err) {
        const msg = `Failed to write marker: ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(msg);
        result.success = false;
      }
    }

    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: result.success ? 'LOW' : 'MEDIUM',
      source: 'FlatToPerUserMigration',
      details: result.success
        ? `Migration complete: ${result.movedCount} items moved`
        : `Migration failed: ${result.errors.join('; ')}`,
    });

    return result;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async moveDir(src: string, dest: string): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true });

    try {
      // Try atomic rename first (same filesystem)
      await fs.rename(src, dest);
    } catch {
      // Cross-filesystem: recursive copy then remove
      await this.copyDirRecursive(src, dest);
      await fs.rm(src, { recursive: true, force: true });
    }
  }

  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirRecursive(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
        // Preserve file permissions (e.g., 0600 on encrypted tokens)
        const stat = await fs.stat(srcPath);
        await fs.chmod(destPath, stat.mode);
      }
    }
  }

  private async dirExists(p: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(p);
      return stat.isDirectory();
    } catch { return false; }
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(p);
      return stat.isFile();
    } catch { return false; }
  }
}
