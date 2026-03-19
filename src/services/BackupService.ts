/**
 * BackupService - Universal pre-save and pre-delete backups for all element types
 *
 * Provides automatic backup creation before destructive operations (edit/delete)
 * with bounded retention (max N backups per element per date folder).
 *
 * Design principles:
 * - Non-fatal: backup failures never block the primary operation
 * - Bounded: pruning prevents unbounded disk growth
 * - Configurable: enabled/disabled via env var, max backups configurable
 *
 * Backup directory structure:
 *   {backupRootDir}/{elementType}/YYYY-MM-DD/{name}.backup-{ISO-timestamp}.{ext}
 *
 * @module BackupService
 */

import * as path from 'path';
import type { IFileOperationsService } from './FileOperationsService.js';
import { logger } from '../utils/logger.js';

export interface BackupConfig {
  /** Root directory for all backups (e.g., ~/.dollhouse/portfolio/.backups) */
  backupRootDir: string;
  /** Maximum backup files to keep per element per date folder */
  maxBackupsPerElement: number;
  /** Whether backups are enabled */
  enabled: boolean;
}

export interface BackupResult {
  /** Whether a backup was successfully created (by rename or copy) */
  success: boolean;
  /** Path to the backup file, if created */
  backupPath?: string;
  /** Whether the original file was moved (renamed) to the backup location.
   *  When true, the caller should skip deleting the original file. */
  movedOriginal?: boolean;
  error?: string;
}

export class BackupService {
  private readonly fileOperations: IFileOperationsService;
  private readonly config: BackupConfig;

  constructor(fileOperations: IFileOperationsService, config: BackupConfig) {
    this.fileOperations = fileOperations;
    this.config = config;
  }

  /**
   * Create a backup copy of a file before it is overwritten (save/edit).
   * No-op if backups are disabled or the file doesn't exist yet (new element).
   * Non-fatal: catches all errors and returns a result instead of throwing.
   */
  async backupBeforeSave(absolutePath: string, elementType: string): Promise<BackupResult> {
    if (!this.config.enabled) {
      return { success: false, error: 'backups disabled' };
    }

    try {
      const exists = await this.fileOperations.exists(absolutePath);
      if (!exists) {
        return { success: false, error: 'source file does not exist (new element)' };
      }

      const backupPath = await this.createBackup(absolutePath, elementType);
      return { success: true, backupPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[BackupService] backupBeforeSave failed for ${path.basename(absolutePath)}: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Create a backup of a file before it is deleted.
   * Moves the file to the backup directory (rename) so the caller can skip deleteFile().
   * Falls back to copy if rename fails (cross-device).
   * Non-fatal: catches all errors and returns a result instead of throwing.
   */
  async backupBeforeDelete(absolutePath: string, elementType: string): Promise<BackupResult> {
    if (!this.config.enabled) {
      return { success: false, error: 'backups disabled' };
    }

    try {
      const exists = await this.fileOperations.exists(absolutePath);
      if (!exists) {
        return { success: false, error: 'source file does not exist' };
      }

      const backupDir = this.getDateBackupDir(elementType);
      await this.fileOperations.createDirectory(backupDir);

      const originalBasename = path.basename(absolutePath);
      const backupFilename = this.generateBackupFilename(originalBasename);
      const backupPath = path.join(backupDir, backupFilename);

      try {
        await this.fileOperations.renameFile(absolutePath, backupPath);
        // Rename succeeded — original is gone, safe to prune old backups
        await this.pruneBackups(backupDir, originalBasename);
        return { success: true, backupPath, movedOriginal: true };
      } catch {
        // Cross-device rename fails — fall back to copy.
        // Original file still exists; caller must delete it.
        // Do NOT prune here: the backup we just created is the safety net
        // for the original that hasn't been deleted yet. Pruning could
        // evict it before the caller deletes the original, losing the
        // only backup. Pruning will happen on the next backupBeforeSave
        // or successful rename.
        await this.fileOperations.copyFile(absolutePath, backupPath);
        return { success: true, backupPath, movedOriginal: false };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[BackupService] backupBeforeDelete failed for ${path.basename(absolutePath)}: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Prune old backups for a given element, keeping only maxBackupsPerElement newest.
   */
  async pruneBackups(backupDir: string, originalBasename: string): Promise<void> {
    try {
      const entries = await this.fileOperations.listDirectory(backupDir);

      // Match backup files for this specific element
      const baseName = this.stripExtension(originalBasename);
      const ext = path.extname(originalBasename);
      const pattern = `${baseName}.backup-`;

      const matching = entries
        .filter(e => e.startsWith(pattern) && e.endsWith(ext))
        .sort((a, b) => a.localeCompare(b)); // ISO timestamps sort lexicographically

      if (matching.length <= this.config.maxBackupsPerElement) {
        return;
      }

      // Delete oldest (sorted ascending, so oldest first)
      const toDelete = matching.slice(0, matching.length - this.config.maxBackupsPerElement);
      for (const filename of toDelete) {
        try {
          await this.fileOperations.deleteFile(path.join(backupDir, filename));
        } catch (err) {
          logger.debug(`[BackupService] Failed to prune backup ${filename}: ${err}`);
        }
      }
    } catch (error) {
      logger.debug(`[BackupService] pruneBackups failed: ${error}`);
    }
  }

  /**
   * Build the date-partitioned backup directory path.
   * e.g., {backupRootDir}/personas/2026-03-04/
   */
  private getDateBackupDir(elementType: string): string {
    const today = new Date().toISOString().split('T')[0];
    return path.join(this.config.backupRootDir, elementType, today);
  }

  /**
   * Generate a backup filename from the original basename.
   * e.g., "creative-writer.md" → "creative-writer.backup-2026-03-04T14-30-00-000Z.md"
   */
  private generateBackupFilename(originalBasename: string): string {
    const ext = path.extname(originalBasename);
    const baseName = this.stripExtension(originalBasename);
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    return `${baseName}.backup-${timestamp}${ext}`;
  }

  private stripExtension(filename: string): string {
    const ext = path.extname(filename);
    return ext ? filename.slice(0, -ext.length) : filename;
  }

  /**
   * Internal helper used by backupBeforeSave — copies file to backup dir then prunes.
   */
  private async createBackup(absolutePath: string, elementType: string): Promise<string> {
    const backupDir = this.getDateBackupDir(elementType);
    await this.fileOperations.createDirectory(backupDir);

    const originalBasename = path.basename(absolutePath);
    const backupFilename = this.generateBackupFilename(originalBasename);
    const backupPath = path.join(backupDir, backupFilename);

    await this.fileOperations.copyFile(absolutePath, backupPath);
    await this.pruneBackups(backupDir, originalBasename);

    return backupPath;
  }
}
