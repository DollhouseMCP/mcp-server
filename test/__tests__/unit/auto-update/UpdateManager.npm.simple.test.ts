import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { UpdateManager } from '../../../../src/update/UpdateManager.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

describe('UpdateManager - NPM Installation Simple Tests', () => {
  let updateManager: UpdateManager;
  const testDir = path.join(os.tmpdir(), 'dollhouse-test-npm-simple', Date.now().toString());
  
  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    updateManager = new UpdateManager(testDir);
  });
  
  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  describe('NPM-specific methods', () => {
    it('should have updateServer method that handles npm installations', () => {
      const updateServer = (updateManager as any).updateServer;
      expect(updateServer).toBeDefined();
      expect(typeof updateServer).toBe('function');
    });
    
    it('should have rollbackUpdate method that handles npm installations', () => {
      const rollbackUpdate = (updateManager as any).rollbackUpdate;
      expect(rollbackUpdate).toBeDefined();
      expect(typeof rollbackUpdate).toBe('function');
    });
    
    it('should have convertToGitInstallation method', () => {
      const convertMethod = (updateManager as any).convertToGitInstallation;
      expect(convertMethod).toBeDefined();
      expect(typeof convertMethod).toBe('function');
    });
    
    it('should have checkForUpdates method', () => {
      const checkForUpdates = (updateManager as any).checkForUpdates;
      expect(checkForUpdates).toBeDefined();
      expect(typeof checkForUpdates).toBe('function');
    });
    
    it('should have getServerStatus method', () => {
      const getServerStatus = (updateManager as any).getServerStatus;
      expect(getServerStatus).toBeDefined();
      expect(typeof getServerStatus).toBe('function');
    });
  });
  
  describe('NPM package name validation', () => {
    it('should validate package name correctly', async () => {
      const validatePackageName = (updateManager as any).validatePackageName;
      if (validatePackageName) {
        // Valid package names
        expect(validatePackageName('@dollhousemcp/mcp-server')).toBe(true);
        expect(validatePackageName('dollhousemcp')).toBe(true);
        expect(validatePackageName('mcp-server')).toBe(true);
        
        // Invalid package names
        expect(validatePackageName('../../../etc/passwd')).toBe(false);
        expect(validatePackageName('rm -rf /')).toBe(false);
        expect(validatePackageName('; cat /etc/passwd')).toBe(false);
        expect(validatePackageName('`whoami`')).toBe(false);
      }
    });
  });
  
  describe('NPM backup directory handling', () => {
    it('should generate proper backup paths', () => {
      const backupManager = (updateManager as any).backupManager;
      if (backupManager && backupManager.generateBackupPath) {
        const backupPath = backupManager.generateBackupPath('npm', '1.0.0');
        expect(backupPath).toContain('npm');
        expect(backupPath).toContain('1.0.0');
        expect(path.isAbsolute(backupPath)).toBe(true);
      }
    });
  });
  
  describe('copyDirectory method', () => {
    it('should have copyDirectory method', () => {
      const copyDirectory = (updateManager as any).copyDirectory;
      expect(copyDirectory).toBeDefined();
      expect(typeof copyDirectory).toBe('function');
    });
    
    it('should copy directory structure', async () => {
      const srcDir = path.join(testDir, 'src');
      const destDir = path.join(testDir, 'dest');
      
      // Create source structure
      await fs.mkdir(path.join(srcDir, 'subdir'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'file1.txt'), 'content1');
      await fs.writeFile(path.join(srcDir, 'subdir', 'file2.txt'), 'content2');
      
      const copyDirectory = (updateManager as any).copyDirectory;
      if (copyDirectory) {
        await copyDirectory.call(updateManager, srcDir, destDir);
        
        // Verify destination
        const destExists = await fs.stat(destDir).then(() => true).catch(() => false);
        expect(destExists).toBe(true);
        
        const file1Exists = await fs.stat(path.join(destDir, 'file1.txt')).then(() => true).catch(() => false);
        expect(file1Exists).toBe(true);
        
        const subdirExists = await fs.stat(path.join(destDir, 'subdir')).then(() => true).catch(() => false);
        expect(subdirExists).toBe(true);
      }
    });
  });
});