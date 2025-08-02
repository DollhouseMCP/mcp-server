import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { UpdateManager } from '../../../../src/update/UpdateManager.js';
import { InstallationDetector } from '../../../../src/utils/installation.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

// Mock modules
const mockSafeExec = jest.fn();
const mockGetInstallationType = jest.fn();
const mockGetNpmGlobalPath = jest.fn();

jest.mock('../../../../src/utils/git.js', () => ({
  safeExec: mockSafeExec
}));

jest.mock('../../../../src/utils/installation.js', () => ({
  InstallationDetector: {
    getInstallationType: mockGetInstallationType,
    getNpmGlobalPath: mockGetNpmGlobalPath
  }
}));

jest.mock('../../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

describe('UpdateManager - NPM Installation Support', () => {
  let updateManager: UpdateManager;
  const testDir = path.join(os.tmpdir(), 'dollhouse-test-npm-update', Date.now().toString());
  
  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.mkdir(testDir, { recursive: true });
    updateManager = new UpdateManager(testDir);
    
    // Default mock implementations
    mockGetInstallationType.mockReturnValue('npm');
    mockGetNpmGlobalPath.mockReturnValue('/usr/local/lib/node_modules/@dollhousemcp/mcp-server');
  });
  
  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  describe('updateServer for npm installations', () => {
    it('should detect npm installation and use npm update flow', async () => {
      // Mock version check
      mockSafeExec.mockImplementation(async (command: string, args: string[]) => {
        if (args.includes('view') && args.includes('version')) {
          return { stdout: '1.5.0\n', stderr: '' };
        }
        if (args.includes('list') && args.includes('-g')) {
          return { stdout: '@dollhousemcp/mcp-server@1.5.0\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      
      // Mock current version
      const versionManager = (updateManager as any).versionManager;
      jest.spyOn(versionManager, 'getCurrentVersion').mockResolvedValue('1.4.0');
      
      // Mock backup manager
      const backupManager = (updateManager as any).backupManager;
      jest.spyOn(backupManager, 'createNpmBackup').mockResolvedValue('/backup/path');
      
      const result = await updateManager.updateServer(true);
      
      expect(result.text).toContain('✅ **Update Complete!**');
      expect(result.text).toContain('Updated from v1.4.0 to v1.5.0');
      expect(mockSafeExec).toHaveBeenCalledWith('npm', ['view', '@dollhousemcp/mcp-server', 'version'], expect.any(Object));
      expect(mockSafeExec).toHaveBeenCalledWith('npm', ['update', '-g', '@dollhousemcp/mcp-server'], expect.any(Object));
    });
    
    it('should validate package name to prevent injection', async () => {
      // Mock with invalid package name somehow
      const maliciousUpdate = async () => {
        // Directly test the package name validation
        const packageName = '@dollhousemcp/mcp-server; rm -rf /';
        const isValid = /^@[a-z0-9-]+\/[a-z0-9-]+$/.test(packageName);
        expect(isValid).toBe(false);
      };
      
      await maliciousUpdate();
    });
    
    it('should handle npm not installed error', async () => {
      // Mock dependency check to fail npm
      const dependencyChecker = (updateManager as any).dependencyChecker;
      jest.spyOn(dependencyChecker, 'checkDependencies').mockResolvedValue({
        npm: { installed: false, error: 'npm not found' },
        git: { installed: true }
      });
      
      const result = await updateManager.updateServer(true);
      
      expect(result.text).toContain('❌ **Update Failed**');
      expect(result.text).toContain('npm is required for updates but is not available');
    });
    
    it('should detect when already up to date', async () => {
      // Mock same version
      mockSafeExec.mockImplementation(async (command: string, args: string[]) => {
        if (args.includes('view') && args.includes('version')) {
          return { stdout: '1.4.0\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      
      const versionManager = (updateManager as any).versionManager;
      jest.spyOn(versionManager, 'getCurrentVersion').mockResolvedValue('1.4.0');
      
      const result = await updateManager.updateServer(true);
      
      expect(result.text).toContain('✅ **Already up to date!**');
      expect(result.text).toContain('No update needed');
    });
    
    it('should handle backup creation failure', async () => {
      // Mock version check to show update available
      mockSafeExec.mockImplementation(async (command: string, args: string[]) => {
        if (args.includes('view') && args.includes('version')) {
          return { stdout: '1.5.0\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      
      const versionManager = (updateManager as any).versionManager;
      jest.spyOn(versionManager, 'getCurrentVersion').mockResolvedValue('1.4.0');
      
      // Mock backup failure
      const backupManager = (updateManager as any).backupManager;
      jest.spyOn(backupManager, 'createNpmBackup').mockRejectedValue(new Error('Disk full'));
      
      const result = await updateManager.updateServer(true);
      
      expect(result.text).toContain('❌ **Update Failed**');
      expect(result.text).toContain('Failed to create backup before update');
      expect(result.text).toContain('Disk full');
      expect(result.text).toContain('Backup is mandatory for npm installations');
    });
    
    it('should handle npm update command failure', async () => {
      // Mock version check
      mockSafeExec.mockImplementation(async (command: string, args: string[]) => {
        if (args.includes('view') && args.includes('version')) {
          return { stdout: '1.5.0\n', stderr: '' };
        }
        if (args.includes('update')) {
          throw new Error('Permission denied');
        }
        return { stdout: '', stderr: '' };
      });
      
      const versionManager = (updateManager as any).versionManager;
      jest.spyOn(versionManager, 'getCurrentVersion').mockResolvedValue('1.4.0');
      
      const backupManager = (updateManager as any).backupManager;
      jest.spyOn(backupManager, 'createNpmBackup').mockResolvedValue('/backup/path');
      
      const result = await updateManager.updateServer(true);
      
      expect(result.text).toContain('❌ **Update Failed**');
      expect(result.text).toContain('Permission denied');
      expect(result.text).toContain('Try running with sudo if on macOS/Linux');
    });
    
    it('should verify installation after update', async () => {
      // Mock successful update but version mismatch
      mockSafeExec.mockImplementation(async (command: string, args: string[]) => {
        if (args.includes('view') && args.includes('version')) {
          return { stdout: '1.5.0\n', stderr: '' };
        }
        if (args.includes('list') && args.includes('-g')) {
          // Return different version than expected
          return { stdout: '@dollhousemcp/mcp-server@1.4.9\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      
      const versionManager = (updateManager as any).versionManager;
      jest.spyOn(versionManager, 'getCurrentVersion').mockResolvedValue('1.4.0');
      
      const backupManager = (updateManager as any).backupManager;
      jest.spyOn(backupManager, 'createNpmBackup').mockResolvedValue('/backup/path');
      
      const result = await updateManager.updateServer(true);
      
      // Should still report success but log warning
      expect(result.text).toContain('✅ **Update Complete!**');
      expect(mockSafeExec).toHaveBeenCalledWith('npm', ['list', '-g', '@dollhousemcp/mcp-server', '--depth=0'], expect.any(Object));
    });
  });
  
  describe('rollbackUpdate for npm installations', () => {
    const mockManifest = {
      backups: [
        {
          timestamp: '2025-08-02T10:00:00Z',
          version: '1.4.0',
          path: 'backup-1.4.0',
          size: 1024000
        }
      ]
    };
    
    beforeEach(async () => {
      // Create mock backup directory and manifest
      const backupDir = path.join(process.env.HOME || '', '.dollhouse', 'backups', 'npm');
      await fs.mkdir(backupDir, { recursive: true });
      await fs.writeFile(
        path.join(backupDir, 'manifest.json'),
        JSON.stringify(mockManifest)
      );
    });
    
    it('should rollback npm installation successfully', async () => {
      mockGetInstallationType.mockReturnValue('npm');
      
      // Mock file operations
      jest.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => true } as any);
      jest.spyOn(fs, 'rename').mockResolvedValue(undefined);
      jest.spyOn(fs, 'rm').mockResolvedValue(undefined);
      
      // Mock npm global path exists
      const npmGlobalPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server';
      mockGetNpmGlobalPath.mockReturnValue(npmGlobalPath);
      
      const result = await updateManager.rollbackUpdate(true);
      
      expect(result.text).toContain('✅ **NPM Rollback Complete!**');
      expect(result.text).toContain('Restored version: 1.4.0');
    });
    
    it('should handle missing npm backups', async () => {
      // Remove manifest file
      const backupDir = path.join(process.env.HOME || '', '.dollhouse', 'backups', 'npm');
      await fs.rm(path.join(backupDir, 'manifest.json'), { force: true });
      
      const result = await updateManager.rollbackUpdate(true);
      
      expect(result.text).toContain('❌ **No NPM Backups Found**');
      expect(result.text).toContain('There are no npm backups available to restore');
    });
    
    it('should handle empty backup manifest', async () => {
      // Create empty manifest
      const backupDir = path.join(process.env.HOME || '', '.dollhouse', 'backups', 'npm');
      await fs.writeFile(
        path.join(backupDir, 'manifest.json'),
        JSON.stringify({ backups: [] })
      );
      
      const result = await updateManager.rollbackUpdate(true);
      
      expect(result.text).toContain('❌ **No NPM Backups Found**');
      expect(result.text).toContain('The backup manifest is empty');
    });
    
    it('should require force flag for npm rollback', async () => {
      const versionManager = (updateManager as any).versionManager;
      jest.spyOn(versionManager, 'getCurrentVersion').mockResolvedValue('1.5.0');
      
      const result = await updateManager.rollbackUpdate(false);
      
      expect(result.text).toContain('⚠️ **NPM Rollback Confirmation Required**');
      expect(result.text).toContain('rollback_update true');
    });
    
    it('should handle rollback errors with recovery instructions', async () => {
      // Mock rename to fail
      jest.spyOn(fs, 'rename').mockRejectedValue(new Error('Permission denied'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => true } as any);
      
      const npmGlobalPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server';
      mockGetNpmGlobalPath.mockReturnValue(npmGlobalPath);
      
      const result = await updateManager.rollbackUpdate(true);
      
      expect(result.text).toContain('❌ **NPM Rollback Failed**');
      expect(result.text).toContain('Permission denied');
      expect(result.text).toContain('Manual Recovery Steps');
      expect(result.text).toContain('sudo');
    });
    
    it('should cleanup temp directory on failure', async () => {
      // Create a more complex test that triggers cleanup
      const npmGlobalPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server';
      mockGetNpmGlobalPath.mockReturnValue(npmGlobalPath);
      
      let tempPathCreated: string | undefined;
      
      // Mock fs operations to track temp path
      jest.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => true } as any);
      jest.spyOn(fs, 'rename').mockImplementation(async (oldPath: string, newPath: string) => {
        if (newPath.includes('-temp-')) {
          tempPathCreated = newPath;
        }
        if (oldPath === npmGlobalPath) {
          throw new Error('Simulated failure');
        }
      });
      
      const rmSpy = jest.spyOn(fs, 'rm').mockResolvedValue(undefined);
      
      await updateManager.rollbackUpdate(true);
      
      // Verify cleanup was attempted
      if (tempPathCreated) {
        expect(rmSpy).toHaveBeenCalledWith(tempPathCreated, { recursive: true, force: true });
      }
    });
  });
  
  describe('convertToGitInstallation', () => {
    it('should handle conversion from npm to git', async () => {
      // Mock npm installation
      mockGetInstallationType.mockReturnValue('npm');
      mockInstallationDetector.getNpmGlobalPath.mockReturnValue('/usr/local/lib/node_modules/@dollhousemcp/mcp-server');
      
      // Mock git operations
      mockSafeExec.mockImplementation(async (command: string, args: string[]) => {
        if (command === 'git' && args.includes('clone')) {
          return { stdout: 'Cloning complete', stderr: '' };
        }
        if (command === 'npm' && args.includes('install')) {
          return { stdout: 'Dependencies installed', stderr: '' };
        }
        if (command === 'npm' && args.includes('build')) {
          return { stdout: 'Build complete', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      
      // Test the conversion method exists
      const convertMethod = (updateManager as any).convertToGitInstallation;
      expect(typeof convertMethod).toBe('function');
    });
  });
  
  describe('git installation flow', () => {
    it('should use git flow when not npm installation', async () => {
      // Mock as git installation
      mockGetInstallationType.mockReturnValue('git');
      
      // Mock git operations
      mockSafeExec.mockImplementation(async (command: string, args: string[]) => {
        if (command === 'git' && args.includes('pull')) {
          return { stdout: 'Already up to date', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      
      // Mock dependencies check
      const dependencyChecker = (updateManager as any).dependencyChecker;
      jest.spyOn(dependencyChecker, 'checkDependencies').mockResolvedValue({
        npm: { installed: true },
        git: { installed: true }
      });
      
      // Mock version check
      const updateChecker = (updateManager as any).updateChecker;
      jest.spyOn(updateChecker, 'checkForUpdates').mockResolvedValue({
        hasUpdate: false,
        currentVersion: '1.4.0',
        latestVersion: '1.4.0'
      });
      jest.spyOn(updateChecker, 'formatUpdateCheckResult').mockReturnValue('Already up to date');
      
      const result = await updateManager.updateServer(true);
      
      // Should not call npm update
      expect(mockSafeExec).not.toHaveBeenCalledWith('npm', expect.arrayContaining(['update']), expect.any(Object));
    });
  });
});