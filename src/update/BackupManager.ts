/**
 * Manage backups during updates
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { safeExec } from '../utils/git.js';
import { logger } from '../utils/logger.js';

export interface BackupInfo {
  path: string;
  timestamp: string;
  version?: string;
}

export class BackupManager {
  private rootDir: string;
  private backupsDir: string;
  
  constructor(rootDir?: string) {
    // Validate rootDir parameter if provided
    if (rootDir) {
      // Prevent path traversal attacks first
      if (rootDir.includes('../') || rootDir.includes('..\\')) {
        throw new Error('rootDir cannot contain path traversal sequences');
      }
      // Then check if it's absolute
      if (!path.isAbsolute(rootDir)) {
        throw new Error('rootDir must be an absolute path');
      }
    }
    
    // Allow override for testing, default to process.cwd()
    this.rootDir = rootDir || process.cwd();
    
    // Safety check: Don't allow operations on directories containing critical files
    // This prevents accidental deletion of the actual project directory
    if (this.hasProductionFiles() && !this.isSafeTestDirectory()) {
      throw new Error('BackupManager cannot operate on production directory. Pass a safe test directory to the constructor.');
    }
    
    this.backupsDir = path.join(this.rootDir, "..", "dollhousemcp-backups");
  }
  
  /**
   * Check if the directory contains production files
   */
  private hasProductionFiles(): boolean {
    try {
      const productionIndicators = [
        'package.json',
        'tsconfig.json',
        '.git',
        'src',
        'LICENSE'
      ];
      
      const files = fsSync.readdirSync(this.rootDir);
      const hasProductionFile = productionIndicators.some(indicator => 
        files.includes(indicator)
      );
      
      // Additional check: if package.json exists, check if it's a real project
      if (hasProductionFile && files.includes('package.json')) {
        const packageJsonPath = path.join(this.rootDir, 'package.json');
        const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8'));
        // If it has a name and dependencies, it's likely a real project
        return !!(packageJson.name && packageJson.dependencies);
      }
      
      return hasProductionFile;
    } catch {
      // If we can't read the directory, assume it's safe
      return false;
    }
  }
  
  /**
   * Check if this appears to be a safe test directory
   */
  private isSafeTestDirectory(): boolean {
    const safePaths = ['test', 'tmp', 'temp', '.test', '__test__'];
    const dirPath = this.rootDir.toLowerCase();
    
    // Check if running in Docker container
    if (this.isDockerEnvironment()) {
      return true; // Docker containers are immutable, updates don't apply
    }
    
    return safePaths.some(safe => dirPath.includes(safe));
  }
  
  /**
   * Check if running in a Docker container
   */
  private isDockerEnvironment(): boolean {
    // Check common Docker indicators
    if (process.env.DOLLHOUSE_DISABLE_UPDATES === 'true') {
      return true;
    }
    
    // Check if running from /app directory (common Docker practice)
    if (this.rootDir === '/app') {
      return true;
    }
    
    // Check for Docker-specific files
    try {
      const hasDockerEnv = fsSync.existsSync('/.dockerenv');
      if (hasDockerEnv) {
        return true;
      }
    } catch {
      // Ignore errors
    }
    
    return false;
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
    
    // Backup all persona files (including user-created ones not in git)
    const personasDir = path.join(this.rootDir, 'personas');
    const backupPersonasDir = path.join(backupPath, 'personas');
    
    try {
      await fs.access(personasDir);
      await fs.mkdir(backupPersonasDir, { recursive: true });
      
      const personaFiles = await fs.readdir(personasDir);
      for (const file of personaFiles) {
        if (file.endsWith('.md')) {
          const sourcePath = path.join(personasDir, file);
          const destPath = path.join(backupPersonasDir, file);
          
          // Copy the file, overwriting if it already exists from git archive
          await fs.copyFile(sourcePath, destPath);
        }
      }
    } catch (error) {
      // Log warning but don't fail the backup
      logger.warn('Could not backup all personas:', error);
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
   * Create a backup specifically for npm installations
   */
  async createNpmBackup(npmGlobalPath: string, version?: string): Promise<string> {
    try {
      // Create npm-specific backup directory
      const npmBackupsDir = path.join(path.dirname(this.backupsDir), '.dollhouse', 'backups', 'npm');
      await fs.mkdir(npmBackupsDir, { recursive: true });
      
      // Create timestamp-based backup directory
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
      const backupName = `npm-backup-${timestamp}`;
      const backupPath = path.join(npmBackupsDir, backupName);
      
      logger.info(`[BackupManager] Creating npm backup at: ${backupPath}`);
      
      // Create backup directory
      await fs.mkdir(backupPath, { recursive: true });
      
      // Copy the npm package directory
      await this.copyDirectory(npmGlobalPath, path.join(backupPath, 'package'));
      
      // Save backup metadata
      const metadata = {
        timestamp,
        version,
        npmGlobalPath,
        installationType: 'npm',
        createdAt: new Date().toISOString()
      };
      
      await fs.writeFile(
        path.join(backupPath, 'backup-metadata.json'),
        JSON.stringify(metadata, null, 2)
      );
      
      // Update manifest
      await this.updateNpmBackupManifest(npmBackupsDir, {
        backupName,
        timestamp,
        version,
        path: backupPath
      });
      
      // Cleanup old npm backups (keep last 3)
      await this.cleanupOldNpmBackups(npmBackupsDir, 3);
      
      return backupPath;
    } catch (error) {
      logger.error('[BackupManager] Failed to create npm backup:', error);
      throw error;
    }
  }
  
  /**
   * Copy directory recursively
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
  
  /**
   * Update npm backup manifest
   */
  private async updateNpmBackupManifest(npmBackupsDir: string, backupInfo: {
    backupName: string;
    timestamp: string;
    version?: string;
    path: string;
  }): Promise<void> {
    const manifestPath = path.join(npmBackupsDir, 'manifest.json');
    
    let manifest: { backups: Array<{
      backupName: string;
      timestamp: string;
      version?: string;
      path: string;
    }> } = { backups: [] };
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(content);
    } catch {
      // File doesn't exist or is invalid, use default
    }
    
    // Add new backup to beginning of list
    manifest.backups.unshift(backupInfo);
    
    // Keep only last 10 entries in manifest
    manifest.backups = manifest.backups.slice(0, 10);
    
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  
  /**
   * Clean up old npm backups
   */
  private async cleanupOldNpmBackups(npmBackupsDir: string, keepCount: number): Promise<void> {
    try {
      const entries = await fs.readdir(npmBackupsDir, { withFileTypes: true });
      const backupDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('npm-backup-'))
        .map(e => e.name)
        .sort()
        .reverse();
      
      // Remove old backups
      const toRemove = backupDirs.slice(keepCount);
      for (const dir of toRemove) {
        const dirPath = path.join(npmBackupsDir, dir);
        logger.info(`[BackupManager] Removing old npm backup: ${dir}`);
        await fs.rm(dirPath, { recursive: true, force: true });
      }
    } catch (error) {
      logger.warn('[BackupManager] Failed to cleanup old npm backups:', error);
    }
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
          logger.error(`Failed to delete backup ${backup.path}:`, error);
        }
      }
    }
    
    return deletedCount;
  }
}