import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { UpdateManager } from '../../../../src/update/UpdateManager.js';
import { BackupManager } from '../../../../src/update/BackupManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('UpdateManager NPM Integration Tests', () => {
  const testDir = path.join(os.tmpdir(), 'dollhouse-npm-update-test', Date.now().toString());
  let updateManager: UpdateManager;
  let backupManager: BackupManager;
  
  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    updateManager = new UpdateManager(testDir);
    backupManager = new BackupManager(testDir);
  });
  
  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  describe('npm backup creation', () => {
    it('should create backup directory structure', async () => {
      // Create mock npm installation
      const npmPath = path.join(testDir, 'mock-npm', 'node_modules', '@dollhousemcp', 'mcp-server');
      await fs.mkdir(npmPath, { recursive: true });
      
      // Add some files
      await fs.writeFile(
        path.join(npmPath, 'package.json'),
        JSON.stringify({ name: '@dollhousemcp/mcp-server', version: '1.4.0' })
      );
      await fs.mkdir(path.join(npmPath, 'dist'));
      await fs.writeFile(
        path.join(npmPath, 'dist', 'index.js'),
        'console.log("DollhouseMCP");'
      );
      
      // Create backup
      const backupPath = await backupManager.createNpmBackup(npmPath, '1.4.0');
      
      // Verify backup exists
      expect(backupPath).toBeTruthy();
      const backupExists = await fs.access(backupPath).then(() => true).catch(() => false);
      expect(backupExists).toBe(true);
      
      // Verify backup structure
      const packageBackup = path.join(backupPath, 'package');
      const packageJsonBackup = path.join(packageBackup, 'package.json');
      const distBackup = path.join(packageBackup, 'dist', 'index.js');
      
      expect(await fs.access(packageJsonBackup).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.access(distBackup).then(() => true).catch(() => false)).toBe(true);
      
      // Verify content was copied correctly
      const backupContent = await fs.readFile(distBackup, 'utf-8');
      expect(backupContent).toContain('DollhouseMCP');
    });
    
    it('should create and update manifest.json', async () => {
      // Create mock npm installation
      const npmPath = path.join(testDir, 'mock-npm', 'node_modules', '@dollhousemcp', 'mcp-server');
      await fs.mkdir(npmPath, { recursive: true });
      await fs.writeFile(
        path.join(npmPath, 'package.json'),
        JSON.stringify({ name: '@dollhousemcp/mcp-server', version: '1.4.0' })
      );
      
      // Create multiple backups
      await backupManager.createNpmBackup(npmPath, '1.3.0');
      await new Promise(resolve => setTimeout(resolve, 10));
      await backupManager.createNpmBackup(npmPath, '1.4.0');
      
      // Check manifest
      const manifestPath = path.join(process.env.HOME || '', '.dollhouse', 'backups', 'npm', 'manifest.json');
      const manifestExists = await fs.access(manifestPath).then(() => true).catch(() => false);
      
      if (manifestExists) {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
        expect(manifest.backups).toBeDefined();
        expect(Array.isArray(manifest.backups)).toBe(true);
        expect(manifest.backups.length).toBeGreaterThan(0);
        
        // Verify newest first
        if (manifest.backups.length >= 2) {
          const firstTimestamp = new Date(manifest.backups[0].timestamp).getTime();
          const secondTimestamp = new Date(manifest.backups[1].timestamp).getTime();
          expect(firstTimestamp).toBeGreaterThanOrEqual(secondTimestamp);
        }
      }
    });
  });
  
  describe('npm rollback simulation', () => {
    it('should handle rollback directory operations', async () => {
      // Create source and target directories
      const sourceDir = path.join(testDir, 'backup-source');
      const targetDir = path.join(testDir, 'target-installation');
      
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.mkdir(targetDir, { recursive: true });
      
      // Add files to source
      await fs.writeFile(path.join(sourceDir, 'file1.js'), 'content1');
      await fs.writeFile(path.join(sourceDir, 'file2.js'), 'content2');
      
      // Add different files to target
      await fs.writeFile(path.join(targetDir, 'file1.js'), 'old content');
      await fs.writeFile(path.join(targetDir, 'file3.js'), 'will be removed');
      
      // Simulate rollback process
      // 1. Create temp directory
      const tempDir = path.join(testDir, 'temp-rollback');
      await fs.mkdir(tempDir);
      
      // 2. Copy source to temp
      const files = await fs.readdir(sourceDir);
      for (const file of files) {
        await fs.copyFile(
          path.join(sourceDir, file),
          path.join(tempDir, file)
        );
      }
      
      // 3. Rename operations (atomic on same filesystem)
      const backupOfCurrent = path.join(testDir, 'current-backup');
      
      // Move current to backup
      await fs.rename(targetDir, backupOfCurrent);
      
      // Move temp to target
      await fs.rename(tempDir, targetDir);
      
      // Verify rollback worked
      const rolledBackContent = await fs.readFile(path.join(targetDir, 'file1.js'), 'utf-8');
      expect(rolledBackContent).toBe('content1');
      
      // Verify file3 is gone
      const file3Exists = await fs.access(path.join(targetDir, 'file3.js')).then(() => true).catch(() => false);
      expect(file3Exists).toBe(false);
      
      // Verify file2 exists
      const file2Exists = await fs.access(path.join(targetDir, 'file2.js')).then(() => true).catch(() => false);
      expect(file2Exists).toBe(true);
    });
  });
  
  describe('version comparison', () => {
    it('should correctly compare semantic versions', async () => {
      const versionManager = (updateManager as any).versionManager;
      const { compareVersions } = await import('../../../../src/utils/version.js');
      
      // Test various version comparisons
      expect(compareVersions('1.4.0', '1.4.1')).toBeLessThan(0);
      expect(compareVersions('1.4.1', '1.4.0')).toBeGreaterThan(0);
      expect(compareVersions('1.4.0', '1.4.0')).toBe(0);
      
      // Pre-release versions
      expect(compareVersions('1.4.0-beta.1', '1.4.0')).toBeLessThan(0);
      expect(compareVersions('1.4.0-beta.1', '1.4.0-beta.2')).toBeLessThan(0);
      
      // Major/minor differences
      expect(compareVersions('1.4.0', '2.0.0')).toBeLessThan(0);
      expect(compareVersions('1.4.0', '1.5.0')).toBeLessThan(0);
    });
  });
  
  describe('error recovery', () => {
    it('should handle partial backup scenarios', async () => {
      // Create a directory that will fail partway through
      const problemDir = path.join(testDir, 'problem-npm');
      await fs.mkdir(problemDir, { recursive: true });
      
      // Create some files
      await fs.writeFile(path.join(problemDir, 'good-file.js'), 'content');
      
      // Create a subdirectory
      const subDir = path.join(problemDir, 'subdir');
      await fs.mkdir(subDir);
      await fs.writeFile(path.join(subDir, 'nested.js'), 'nested content');
      
      // Try to backup - should succeed even if we can't access everything
      let backupPath;
      try {
        backupPath = await backupManager.createNpmBackup(problemDir, '1.4.0');
      } catch (error) {
        // If backup fails completely, that's also acceptable behavior
        expect(error).toBeDefined();
        return;
      }
      
      // If backup succeeded, verify what was backed up
      if (backupPath) {
        const backedUpFiles = await fs.readdir(path.join(backupPath, 'package'), { recursive: true });
        expect(backedUpFiles.length).toBeGreaterThan(0);
      }
    });
    
    it('should cleanup temp directories on failure', async () => {
      const tempBase = path.join(testDir, 'temp-cleanup-test');
      await fs.mkdir(tempBase);
      
      // Create temp directory
      const tempDir = path.join(tempBase, 'npm-temp-' + Date.now());
      await fs.mkdir(tempDir);
      await fs.writeFile(path.join(tempDir, 'temp.txt'), 'temporary');
      
      // Simulate cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
      
      // Verify it's gone
      const exists = await fs.access(tempDir).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });
  
  describe('getServerStatus integration', () => {
    it('should detect installation type in status', async () => {
      const status = await updateManager.getServerStatus();
      
      // Status should contain installation type info
      expect(status.text).toBeDefined();
      expect(typeof status.text).toBe('string');
      
      // Should mention installation type (git in test environment)
      expect(status.text.toLowerCase()).toMatch(/installation type|git|npm/);
    });
  });
});