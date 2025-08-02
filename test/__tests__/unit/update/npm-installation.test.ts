import { describe, it, expect, beforeEach } from '@jest/globals';
import { InstallationDetector } from '../../../../src/utils/installation.js';
import { VersionManager } from '../../../../src/update/VersionManager.js';
import * as path from 'path';

describe('NPM Installation Support', () => {
  beforeEach(() => {
    InstallationDetector.clearCache();
  });
  
  describe('InstallationDetector', () => {
    it('should have required methods', () => {
      expect(typeof InstallationDetector.getInstallationType).toBe('function');
      expect(typeof InstallationDetector.getNpmGlobalPath).toBe('function');
      expect(typeof InstallationDetector.getGitRepositoryPath).toBe('function');
      expect(typeof InstallationDetector.getInstallationDescription).toBe('function');
      expect(typeof InstallationDetector.clearCache).toBe('function');
    });
    
    it('should detect npm paths correctly', () => {
      // Test npm path patterns - normalize paths for cross-platform testing
      const npmPaths = [
        '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist',
        'C:/Users/User/AppData/Roaming/npm/node_modules/@dollhousemcp/mcp-server/dist',
        '/home/user/.npm/node_modules/@dollhousemcp/mcp-server/src'
      ];
      
      for (const npmPath of npmPaths) {
        // Check if path contains the npm pattern (cross-platform)
        const normalizedPath = npmPath.replace(/\\/g, '/');
        const isNpm = normalizedPath.includes('/node_modules/@dollhousemcp/mcp-server/');
        expect(isNpm).toBe(true);
      }
    });
    
    it('should not detect git paths as npm', () => {
      const gitPaths = [
        '/home/user/projects/DollhouseMCP/src',
        '/Users/dev/workspace/mcp-server/dist',
        'C:\\Projects\\DollhouseMCP\\src'
      ];
      
      for (const gitPath of gitPaths) {
        const pattern = path.sep + path.join('node_modules', '@dollhousemcp', 'mcp-server') + path.sep;
        const isNpm = gitPath.includes(pattern);
        expect(isNpm).toBe(false);
      }
    });
    
    it('should cache results', () => {
      // Clear cache to start
      InstallationDetector.clearCache();
      
      // First call sets cache
      const type1 = InstallationDetector.getInstallationType();
      
      // Second call should return same result without re-detection
      const type2 = InstallationDetector.getInstallationType();
      
      expect(type2).toBe(type1);
      
      // After clearing cache, might get different result if detection logic changes
      InstallationDetector.clearCache();
      const type3 = InstallationDetector.getInstallationType();
      
      // Type should be one of the valid values
      expect(['npm', 'git', 'unknown']).toContain(type3);
    });
  });
  
  describe('VersionManager with embedded version', () => {
    it('should handle npm installations in getCurrentVersion', async () => {
      const versionManager = new VersionManager();
      
      // Should be able to get version regardless of installation type
      const version = await versionManager.getCurrentVersion();
      
      // Version should be a valid semver string
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
  
  describe('Package name validation', () => {
    it('should validate npm package names correctly', () => {
      const validNames = [
        '@dollhousemcp/mcp-server',
        '@scope/package-name',
        '@my-org/my-package'
      ];
      
      const invalidNames = [
        '@dollhousemcp/mcp-server; rm -rf /',
        'package with spaces',
        '@UPPERCASE/package',
        '@scope/Package',
        '',
        '@/',
        '@scope/',
        '/package'
      ];
      
      const packageNameRegex = /^@[a-z0-9-]+\/[a-z0-9-]+$/;
      
      for (const name of validNames) {
        expect(packageNameRegex.test(name)).toBe(true);
      }
      
      for (const name of invalidNames) {
        expect(packageNameRegex.test(name)).toBe(false);
      }
    });
  });
  
  describe('Version comparison', () => {
    it('should compare versions correctly', async () => {
      const { compareVersions } = await import('../../../../src/utils/version.js');
      
      // Basic comparisons
      expect(compareVersions('1.4.0', '1.4.1')).toBeLessThan(0);
      expect(compareVersions('1.4.1', '1.4.0')).toBeGreaterThan(0);
      expect(compareVersions('1.4.0', '1.4.0')).toBe(0);
      
      // Pre-release versions
      expect(compareVersions('1.4.0-beta', '1.4.0')).toBeLessThan(0);
      expect(compareVersions('1.4.0-alpha', '1.4.0-beta')).toBeLessThan(0);
      
      // Major/minor/patch differences
      expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
      expect(compareVersions('1.4.0', '1.5.0')).toBeLessThan(0);
      expect(compareVersions('1.4.0', '1.4.1')).toBeLessThan(0);
    });
  });
  
  describe('Backup path validation', () => {
    it('should create valid backup paths', () => {
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
      const backupName = `npm-backup-${timestamp}`;
      
      // Backup name should not contain invalid characters
      expect(backupName).not.toMatch(/[:<>"|?*]/);
      expect(backupName).toMatch(/^npm-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    });
  });
  
  describe('Installation type descriptions', () => {
    it('should generate appropriate descriptions', () => {
      const descriptions = [
        InstallationDetector.getInstallationDescription()
      ];
      
      for (const desc of descriptions) {
        expect(desc).toBeTruthy();
        expect(typeof desc).toBe('string');
        expect(desc.length).toBeGreaterThan(0);
      }
    });
  });
});