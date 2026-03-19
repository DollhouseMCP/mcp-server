import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';
import { IFileOperationsService, FileOperationsService } from '../services/FileOperationsService.js';
import { FileLockManager } from '../security/fileLockManager.js';

// Singleton file operations service for static methods
let fileOperationsService: IFileOperationsService | null = null;

function getFileOperationsService(): IFileOperationsService {
  if (!fileOperationsService) {
    fileOperationsService = new FileOperationsService(new FileLockManager());
  }
  return fileOperationsService;
}

export interface CopyOptions {
  onProgress?: (copied: number, total: number, currentFile: string) => void;
  excludePatterns?: string[];
  maxRetries?: number;
}

export interface FileStats {
  totalFiles: number;
  totalSize: number;
}

/**
 * Cross-platform file operations utility
 * Centralizes common file operations with progress reporting and error handling
 */
export class FileOperations {
  /**
   * Recursively copy a directory with progress reporting
   * Works cross-platform without relying on shell commands
   */
  static async copyDirectory(
    src: string, 
    dest: string, 
    options: CopyOptions = {}
  ): Promise<void> {
    const { onProgress, excludePatterns = [], maxRetries = 3 } = options;
    
    // First, calculate total files for progress reporting
    const stats = await this.calculateDirectoryStats(src, excludePatterns);
    let copiedFiles = 0;
    
    await this.copyDirectoryRecursive(
      src, 
      dest, 
      excludePatterns,
      maxRetries,
      (currentFile) => {
        copiedFiles++;
        if (onProgress) {
          onProgress(copiedFiles, stats.totalFiles, currentFile);
        }
      }
    );
  }
  
  /**
   * Calculate directory statistics for progress reporting
   */
  private static async calculateDirectoryStats(
    dir: string,
    excludePatterns: string[]
  ): Promise<FileStats> {
    const fileOps = getFileOperationsService();
    let totalFiles = 0;
    let totalSize = 0;

    try {
      const entries = await fileOps.listDirectoryWithTypes(dir);

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip excluded patterns
        if (this.shouldExclude(entry.name, excludePatterns)) {
          continue;
        }

        if (entry.isDirectory) {
          const subStats = await this.calculateDirectoryStats(fullPath, excludePatterns);
          totalFiles += subStats.totalFiles;
          totalSize += subStats.totalSize;
        } else {
          totalFiles++;
          try {
            const stat = await fileOps.stat(fullPath);
            totalSize += stat.size;
          } catch (error) {
            // Log stat errors for debugging - could indicate permissions, corruption, or disk errors
            logger.warn(`[FileOperations] Failed to stat file ${fullPath}:`, {
              error: error instanceof Error ? error.message : String(error),
              code: (error as NodeJS.ErrnoException).code
            });
            // Continue without this file's size
          }
        }
      }
    } catch (error) {
      logger.warn(`[FileOperations] Error calculating stats for ${dir}:`, error);
    }

    return { totalFiles, totalSize };
  }
  
  /**
   * Internal recursive copy implementation
   */
  private static async copyDirectoryRecursive(
    src: string,
    dest: string,
    excludePatterns: string[],
    maxRetries: number,
    onFileCopied: (file: string) => void
  ): Promise<void> {
    const fileOps = getFileOperationsService();

    // Ensure destination directory exists
    await fileOps.createDirectory(dest);

    const entries = await fileOps.listDirectoryWithTypes(src);

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      // Skip excluded patterns
      if (this.shouldExclude(entry.name, excludePatterns)) {
        logger.debug(`[FileOperations] Skipping excluded: ${entry.name}`);
        continue;
      }

      if (entry.isDirectory) {
        await this.copyDirectoryRecursive(
          srcPath,
          destPath,
          excludePatterns,
          maxRetries,
          onFileCopied
        );
      } else {
        await this.copyFileWithRetry(srcPath, destPath, maxRetries);
        onFileCopied(srcPath);
      }
    }
  }
  
  /**
   * Copy a single file with retry logic
   */
  private static async copyFileWithRetry(
    src: string,
    dest: string,
    maxRetries: number
  ): Promise<void> {
    const fileOps = getFileOperationsService();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await fileOps.copyFile(src, dest, { source: 'FileOperations.copyFileWithRetry' });
        return; // Success
      } catch (error) {
        lastError = error as Error;
        logger.debug(`[FileOperations] Copy attempt ${attempt} failed for ${src}: ${error}`);

        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
        }
      }
    }

    // All retries failed
    throw new Error(`Failed to copy ${src} after ${maxRetries} attempts: ${lastError?.message}`);
  }
  
  /**
   * Check if a file/directory should be excluded
   *
   * FIX: ReDoS vulnerability - replaced unsafe glob-to-regex conversion
   * Previously: Used pattern.replace with .* which could cause catastrophic backtracking
   * Now: Uses safe glob matching with proper escaping and bounded patterns
   * SonarCloud: Resolves DOS vulnerability hotspot
   */
  private static shouldExclude(name: string, patterns: string[]): boolean {
    // Input validation to prevent DOS
    if (name.length > 1000) {
      return false; // Reject overly long inputs
    }

    for (const pattern of patterns) {
      if (pattern.includes('*')) {
        // Safe glob support - prevent ReDoS
        // Escape special regex chars except *
        // FIX: Use String.raw and replaceAll (SonarCloud S7780, S7781)
        const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);
        // Replace * with [^/]* (match anything except path separator)
        // This prevents catastrophic backtracking
        const safePattern = escaped.replaceAll('*', '[^/]*');

        try {
          // FIX: Use template literal to avoid security scanner false positive (PR #1187)
          // This is NOT SQL injection - it's a RegExp pattern
          const regex = new RegExp(`^${safePattern}$`);
          if (regex.test(name)) return true;
        } catch (error) {
          // Invalid pattern - log and skip it
          logger.debug(`[FileOperations] Invalid regex pattern: ${pattern}`, {
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
      } else if (name === pattern) {
        return true;
      }
    }
    return false;
  }
  
  /**
   * Remove a directory with progress reporting
   */
  static async removeDirectory(
    dir: string,
    options: { onProgress?: (removed: number, total: number) => void } = {}
  ): Promise<void> {
    const stats = await this.calculateDirectoryStats(dir, []);
    let removedFiles = 0;
    
    await this.removeDirectoryRecursive(dir, () => {
      removedFiles++;
      if (options.onProgress) {
        options.onProgress(removedFiles, stats.totalFiles);
      }
    });
  }
  
  /**
   * Internal recursive remove implementation
   */
  private static async removeDirectoryRecursive(
    dir: string,
    onFileRemoved: () => void
  ): Promise<void> {
    const fileOps = getFileOperationsService();

    try {
      const entries = await fileOps.listDirectoryWithTypes(dir);

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory) {
          await this.removeDirectoryRecursive(fullPath, onFileRemoved);
        } else {
          await fileOps.deleteFile(fullPath, undefined, { source: 'FileOperations.removeDirectoryRecursive' });
          onFileRemoved();
        }
      }

      // Remove the now-empty directory
      await fs.rmdir(dir);
    } catch (error) {
      logger.error(`[FileOperations] Error removing directory ${dir}:`, error);
      throw error;
    }
  }
  
  /**
   * Create a transaction manager for atomic file operations
   */
  static createTransaction(): FileTransaction {
    return new FileTransaction();
  }
}

/**
 * Transaction manager for atomic file operations
 * Ensures all operations succeed or all are rolled back
 */
export class FileTransaction {
  // FIX: Mark as readonly since never reassigned (SonarCloud S2933)
  private readonly operations: Array<{
    type: 'move' | 'copy' | 'delete' | 'create';
    source?: string;
    destination?: string;
    rollback: () => Promise<void>;
  }> = [];

  private completed = false;
  private readonly fileOps: IFileOperationsService;

  constructor(fileOperations?: IFileOperationsService) {
    this.fileOps = fileOperations || getFileOperationsService();
  }
  
  /**
   * Add a move operation to the transaction
   */
  async addMove(source: string, destination: string): Promise<void> {
    if (this.completed) {
      throw new Error('Transaction already completed');
    }

    // Perform the move
    await this.fileOps.renameFile(source, destination);

    // Add rollback operation
    this.operations.push({
      type: 'move',
      source,
      destination,
      rollback: async () => {
        try {
          await this.fileOps.renameFile(destination, source);
        } catch (error) {
          logger.error(`[FileTransaction] Failed to rollback move from ${destination} to ${source}:`, error);
        }
      }
    });
  }
  
  /**
   * Add a copy operation to the transaction
   */
  async addCopy(source: string, destination: string): Promise<void> {
    if (this.completed) {
      throw new Error('Transaction already completed');
    }
    
    // Perform the copy
    await FileOperations.copyDirectory(source, destination);
    
    // Add rollback operation
    this.operations.push({
      type: 'copy',
      source,
      destination,
      rollback: async () => {
        try {
          await fs.rm(destination, { recursive: true, force: true });
        } catch (error) {
          logger.error(`[FileTransaction] Failed to rollback copy at ${destination}:`, error);
        }
      }
    });
  }
  
  /**
   * Add a delete operation to the transaction
   */
  async addDelete(deletePath: string, backupPath?: string): Promise<void> {
    if (this.completed) {
      throw new Error('Transaction already completed');
    }

    // If backup path provided, move instead of delete
    if (backupPath) {
      await this.fileOps.renameFile(deletePath, backupPath);

      this.operations.push({
        type: 'delete',
        source: deletePath,
        destination: backupPath,
        rollback: async () => {
          try {
            await this.fileOps.renameFile(backupPath, deletePath);
          } catch (error) {
            logger.error(`[FileTransaction] Failed to restore deleted item from ${backupPath} to ${deletePath}:`, error);
          }
        }
      });
    } else {
      // Direct delete (no rollback possible)
      await fs.rm(deletePath, { recursive: true, force: true });

      this.operations.push({
        type: 'delete',
        source: deletePath,
        rollback: async () => {
          logger.warn(`[FileTransaction] Cannot rollback permanent deletion of ${deletePath}`);
        }
      });
    }
  }
  
  /**
   * Commit the transaction (mark as successful)
   */
  commit(): void {
    this.completed = true;
  }
  
  /**
   * Rollback all operations in reverse order
   */
  async rollback(): Promise<void> {
    logger.info(`[FileTransaction] Rolling back ${this.operations.length} operations`);
    
    // Rollback in reverse order
    for (let i = this.operations.length - 1; i >= 0; i--) {
      const operation = this.operations[i];
      logger.info(`[FileTransaction] Rolling back ${operation.type} operation`);
      
      try {
        await operation.rollback();
      } catch (error) {
        logger.error(`[FileTransaction] Rollback failed for operation ${i}:`, error);
        // Continue with other rollbacks
      }
    }
    
    this.completed = true;
  }
  
  /**
   * Check if any operations have been performed
   */
  hasOperations(): boolean {
    return this.operations.length > 0;
  }
}