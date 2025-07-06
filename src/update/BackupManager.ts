/**
 * Manage backups during updates
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { safeExec } from '../utils/git.js';

export interface BackupInfo {
  path: string;
  timestamp: string;
  version?: string;
}

export class BackupManager {
  private rootDir: string;
  private backupsDir: string;
  
  constructor() {
    // Use process.cwd() as the root directory
    this.rootDir = process.cwd();
    this.backupsDir = path.join(this.rootDir, "..", "dollhousemcp-backups");
  }
  
  /**
   * Create a backup of the current installation
   */
  async createBackup(version?: string): Promise<BackupInfo> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}`;
    const backupPath = path.join(this.backupsDir, backupName);
    
    // Ensure backups directory exists
    await fs.mkdir(this.backupsDir, { recursive: true });
    
    // Use git to create a clean copy (respecting .gitignore)
    await safeExec('git', [
      'archive',
      '--format=tar',
      'HEAD'
    ], { cwd: this.rootDir }).then(async ({ stdout }) => {
      // Create backup directory
      await fs.mkdir(backupPath, { recursive: true });
      
      // Extract tar to backup directory
      const tarPath = path.join(backupPath, 'archive.tar');
      await fs.writeFile(tarPath, stdout);
      
      // Extract using tar command
      await safeExec('tar', ['-xf', 'archive.tar'], { cwd: backupPath });
      await fs.unlink(tarPath);
    });
    
    // Also backup node_modules if it exists
    const nodeModulesPath = path.join(this.rootDir, 'node_modules');
    try {
      await fs.access(nodeModulesPath);
      await safeExec('cp', ['-r', 'node_modules', backupPath], { cwd: this.rootDir });
    } catch {
      // node_modules doesn't exist or copy failed, that's okay
    }
    
    // Save backup metadata
    const metadata = {
      timestamp,
      version,
      createdAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(backupPath, 'backup-metadata.json'),
      JSON.stringify(metadata, null, 2)
    );
    
    return {
      path: backupPath,
      timestamp,
      version
    };
  }
  
  /**
   * List available backups
   */
  async listBackups(): Promise<BackupInfo[]> {
    try {
      const entries = await fs.readdir(this.backupsDir, { withFileTypes: true });
      const backups: BackupInfo[] = [];
      
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('backup-')) {
          const backupPath = path.join(this.backupsDir, entry.name);
          const timestamp = entry.name.replace('backup-', '');
          
          // Try to read metadata
          let version: string | undefined;
          try {
            const metadataPath = path.join(backupPath, 'backup-metadata.json');
            const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
            version = metadata.version;
          } catch {
            // No metadata file, that's okay
          }
          
          backups.push({
            path: backupPath,
            timestamp,
            version
          });
        }
      }
      
      // Sort by timestamp descending (newest first)
      return backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch {
      return [];
    }
  }
  
  /**
   * Get the most recent backup
   */
  async getLatestBackup(): Promise<BackupInfo | null> {
    const backups = await this.listBackups();
    return backups.length > 0 ? backups[0] : null;
  }
  
  /**
   * Restore from a backup
   */
  async restoreBackup(backupPath: string): Promise<void> {
    // Verify backup exists
    try {
      await fs.access(backupPath);
    } catch {
      throw new Error(`Backup not found: ${backupPath}`);
    }
    
    // Create a temporary directory for the current state
    const tempDir = path.join(this.backupsDir, 'temp-current');
    await fs.mkdir(tempDir, { recursive: true });
    
    // Move current files to temp (except .git and node_modules)
    const entries = await fs.readdir(this.rootDir);
    for (const entry of entries) {
      if (entry !== '.git' && entry !== 'node_modules' && entry !== 'dist') {
        const sourcePath = path.join(this.rootDir, entry);
        const destPath = path.join(tempDir, entry);
        await fs.rename(sourcePath, destPath);
      }
    }
    
    // Copy backup files to root
    const backupEntries = await fs.readdir(backupPath);
    for (const entry of backupEntries) {
      if (entry !== 'backup-metadata.json' && entry !== '.git') {
        const sourcePath = path.join(backupPath, entry);
        const destPath = path.join(this.rootDir, entry);
        await safeExec('cp', ['-r', sourcePath, destPath]);
      }
    }
    
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  
  /**
   * Clean up old backups (keep the 5 most recent)
   */
  async cleanupOldBackups(keepCount: number = 5): Promise<number> {
    const backups = await this.listBackups();
    let deletedCount = 0;
    
    if (backups.length > keepCount) {
      const backupsToDelete = backups.slice(keepCount);
      
      for (const backup of backupsToDelete) {
        try {
          await fs.rm(backup.path, { recursive: true, force: true });
          deletedCount++;
        } catch (error) {
          console.error(`Failed to delete backup ${backup.path}:`, error);
        }
      }
    }
    
    return deletedCount;
  }
}