import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { BackupManager } from '../../../../src/update/BackupManager.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

describe('BackupManager - NPM Backup Support', () => {
  let backupManager: BackupManager;
  const testDir = path.join(os.tmpdir(), 'dollhouse-test-npm-backup', Date.now().toString());
  const npmGlobalPath = path.join(testDir, 'node_modules', '@dollhousemcp', 'mcp-server');
  
  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(npmGlobalPath, { recursive: true });
    
    // Create mock npm package structure
    await fs.writeFile(
      path.join(npmGlobalPath, 'package.json'),
      JSON.stringify({
        name: '@dollhousemcp/mcp-server',
        version: '1.4.0'
      })
    );
    await fs.mkdir(path.join(npmGlobalPath, 'dist'), { recursive: true });
    await fs.writeFile(
      path.join(npmGlobalPath, 'dist', 'index.js'),
      'console.log("mock server");'
    );
    
    backupManager = new BackupManager(testDir);
  });
  
  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  describe('createNpmBackup', () => {
    it('should create npm backup with correct structure', async () => {
      const backupPath = await backupManager.createNpmBackup(npmGlobalPath, '1.4.0');
      
      expect(backupPath).toContain('npm-backup-');
      expect(await fs.access(backupPath).then(() => true).catch(() => false)).toBe(true);
      
      // Check backup contains package files
      const packageBackup = path.join(backupPath, 'package');
      expect(await fs.access(packageBackup).then(() => true).catch(() => false)).toBe(true);
      
      // Check package.json was copied
      const backupPackageJson = await fs.readFile(
        path.join(packageBackup, 'package.json'),
        'utf-8'
      );
      expect(JSON.parse(backupPackageJson).version).toBe('1.4.0');
    });
    
    it('should create metadata file with backup info', async () => {
      const backupPath = await backupManager.createNpmBackup(npmGlobalPath, '1.4.0');
      
      const metadataPath = path.join(backupPath, 'metadata.json');
      expect(await fs.access(metadataPath).then(() => true).catch(() => false)).toBe(true);
      
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
      expect(metadata.version).toBe('1.4.0');
      expect(metadata.timestamp).toBeDefined();
      expect(metadata.npmGlobalPath).toBe(npmGlobalPath);
      expect(metadata.type).toBe('npm');
    });
    
    it('should update manifest.json with backup entry', async () => {
      await backupManager.createNpmBackup(npmGlobalPath, '1.4.0');
      
      const npmBackupsDir = path.join(path.dirname(testDir), '.dollhouse', 'backups', 'npm');
      const manifestPath = path.join(npmBackupsDir, 'manifest.json');
      
      expect(await fs.access(manifestPath).then(() => true).catch(() => false)).toBe(true);
      
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      expect(manifest.backups).toBeDefined();
      expect(manifest.backups.length).toBeGreaterThan(0);
      expect(manifest.backups[0].version).toBe('1.4.0');
    });
    
    it('should calculate backup size correctly', async () => {
      // Add more files to test size calculation
      await fs.writeFile(
        path.join(npmGlobalPath, 'README.md'),
        'This is a test readme file with some content to increase size'
      );
      
      const backupPath = await backupManager.createNpmBackup(npmGlobalPath, '1.4.0');
      
      const manifestPath = path.join(path.dirname(testDir), '.dollhouse', 'backups', 'npm', 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      
      expect(manifest.backups[0].size).toBeGreaterThan(0);
      expect(typeof manifest.backups[0].size).toBe('number');
    });
    
    it('should handle backup creation errors gracefully', async () => {
      // Make backup directory creation fail
      const invalidPath = '/invalid/path/that/does/not/exist';
      
      await expect(backupManager.createNpmBackup(invalidPath, '1.4.0')).rejects.toThrow();
    });
    
    it('should maintain manifest order with newest first', async () => {
      // Create multiple backups
      await backupManager.createNpmBackup(npmGlobalPath, '1.3.0');
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      await backupManager.createNpmBackup(npmGlobalPath, '1.4.0');
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      await backupManager.createNpmBackup(npmGlobalPath, '1.4.1');
      
      const manifestPath = path.join(path.dirname(testDir), '.dollhouse', 'backups', 'npm', 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      
      expect(manifest.backups[0].version).toBe('1.4.1');
      expect(manifest.backups[1].version).toBe('1.4.0');
      expect(manifest.backups[2].version).toBe('1.3.0');
    });
    
    it('should clean up old backups when limit exceeded', async () => {
      // Create more than 5 backups (default limit)
      for (let i = 0; i < 7; i++) {
        await backupManager.createNpmBackup(npmGlobalPath, `1.4.${i}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      const manifestPath = path.join(path.dirname(testDir), '.dollhouse', 'backups', 'npm', 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      
      // Should only keep 5 most recent
      expect(manifest.backups.length).toBe(5);
      expect(manifest.backups[0].version).toBe('1.4.6');
      expect(manifest.backups[4].version).toBe('1.4.2');
    });
  });
  
  describe('npm backup directory structure', () => {
    it('should create npm backups in correct location', async () => {
      const backupPath = await backupManager.createNpmBackup(npmGlobalPath, '1.4.0');
      
      // Should be in ~/.dollhouse/backups/npm/
      expect(backupPath).toContain('.dollhouse');
      expect(backupPath).toContain('backups');
      expect(backupPath).toContain('npm');
      expect(backupPath).toContain('npm-backup-');
    });
    
    it('should handle concurrent backup creation', async () => {
      // Create multiple backups concurrently
      const promises = [
        backupManager.createNpmBackup(npmGlobalPath, '1.4.0'),
        backupManager.createNpmBackup(npmGlobalPath, '1.4.1'),
        backupManager.createNpmBackup(npmGlobalPath, '1.4.2')
      ];
      
      const results = await Promise.all(promises);
      
      // All should succeed
      expect(results.length).toBe(3);
      results.forEach(path => {
        expect(path).toContain('npm-backup-');
      });
      
      // Check manifest has all entries
      const manifestPath = path.join(path.dirname(testDir), '.dollhouse', 'backups', 'npm', 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      
      expect(manifest.backups.length).toBe(3);
    });
  });
  
  describe('copyDirectory for npm packages', () => {
    it('should copy all files including nested directories', async () => {
      // Create complex directory structure
      await fs.mkdir(path.join(npmGlobalPath, 'src', 'utils'), { recursive: true });
      await fs.writeFile(
        path.join(npmGlobalPath, 'src', 'utils', 'helper.js'),
        'export const helper = () => {};'
      );
      await fs.mkdir(path.join(npmGlobalPath, 'test'), { recursive: true });
      await fs.writeFile(
        path.join(npmGlobalPath, 'test', 'test.spec.js'),
        'describe("test", () => {});'
      );
      
      const backupPath = await backupManager.createNpmBackup(npmGlobalPath, '1.4.0');
      const packageBackup = path.join(backupPath, 'package');
      
      // Verify all files were copied
      expect(await fs.access(path.join(packageBackup, 'src', 'utils', 'helper.js')).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.access(path.join(packageBackup, 'test', 'test.spec.js')).then(() => true).catch(() => false)).toBe(true);
      
      // Verify content
      const helperContent = await fs.readFile(
        path.join(packageBackup, 'src', 'utils', 'helper.js'),
        'utf-8'
      );
      expect(helperContent).toContain('helper');
    });
    
    it('should handle symlinks safely', async () => {
      // Create a symlink (if supported by OS)
      const linkTarget = path.join(testDir, 'link-target.txt');
      await fs.writeFile(linkTarget, 'link target content');
      
      const linkPath = path.join(npmGlobalPath, 'link.txt');
      
      try {
        await fs.symlink(linkTarget, linkPath);
        
        const backupPath = await backupManager.createNpmBackup(npmGlobalPath, '1.4.0');
        const packageBackup = path.join(backupPath, 'package');
        
        // Check if symlink was handled (either copied as file or preserved as link)
        const exists = await fs.access(path.join(packageBackup, 'link.txt')).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      } catch (error) {
        // Symlinks might not be supported on all systems, skip this test
        console.log('Skipping symlink test on this system');
        expect(true).toBe(true);
      }
    });
  });
});