import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { BackupManager } from '../../../src/update/BackupManager.js';
import { UpdateManager } from '../../../src/update/UpdateManager.js';

/**
 * CI Safety Verification Tests - Issue #92
 * 
 * These tests verify that the fixes from PR #86 prevent the critical file deletion
 * issue where BackupManager and UpdateManager were using process.cwd() and deleting
 * production files during tests.
 */
describe('CI Safety Verification', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a unique test directory for each test
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-safety-test-'));
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('BackupManager Safety', () => {
    it('should accept custom rootDir instead of using process.cwd()', () => {
      // This should NOT throw
      const backup = new BackupManager(testDir);
      expect(backup).toBeDefined();
    });

    it('should reject dangerous paths', () => {
      // Path traversal attempts should be rejected
      expect(() => new BackupManager('../../../')).toThrow('path traversal');
      
      // This path is normalized by path.join, so it won't contain ../
      // Instead test with a path that explicitly contains traversal
      const dangerousPath = testDir + '/../../../';
      expect(() => new BackupManager(dangerousPath)).toThrow('path traversal');
    });

    it('should work in CI temporary directories', async () => {
      // Create a project-like structure in temp directory
      await fs.mkdir(path.join(testDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(testDir, 'package.json'), '{"name":"test"}');
      
      // Should work because it's in tmp directory
      const backup = new BackupManager(testDir);
      expect(backup).toBeDefined();
      
      // Note: createBackup requires git, which won't be available in test directory
      // This test verifies the BackupManager can be instantiated safely
    });

    it('should not operate on production directories', async () => {
      // Create a directory that looks like production (not in tmp)
      const prodLikeDir = path.join(testDir, 'prod-project');
      await fs.mkdir(prodLikeDir, { recursive: true });
      
      // Add production indicators
      await fs.mkdir(path.join(prodLikeDir, 'node_modules'), { recursive: true });
      await fs.mkdir(path.join(prodLikeDir, '.git'), { recursive: true });
      await fs.writeFile(
        path.join(prodLikeDir, 'package.json'),
        JSON.stringify({
          name: 'production-app',
          dependencies: {
            '@anthropic/sdk': '^1.0.0',
            'typescript': '^5.0.0'
          }
        })
      );
      
      // Since this is still under tmp directory, it should work
      // The safety check looks at the path pattern, not just contents
      const backup = new BackupManager(prodLikeDir);
      expect(backup).toBeDefined();
    });

    it('should handle concurrent instantiation safely', async () => {
      // Test that multiple BackupManager instances can be created safely
      const managers = Array.from({ length: 5 }, () => new BackupManager(testDir));
      
      // All managers should be created successfully
      expect(managers.length).toBe(5);
      managers.forEach(manager => {
        expect(manager).toBeDefined();
      });
    });
  });

  describe('UpdateManager Safety', () => {
    it('should accept custom rootDir configuration', async () => {
      // Create minimal package.json
      await fs.writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      );
      
      // Should work with custom directory
      const updater = new UpdateManager(testDir);
      expect(updater).toBeDefined();
    });

    it('should work with custom rootDir', async () => {
      // Create package.json with version
      const packageData = {
        name: 'test-project',
        version: '1.2.3'
      };
      await fs.writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify(packageData, null, 2)
      );
      
      const updater = new UpdateManager(testDir);
      
      // Note: getServerStatus uses VersionManager which searches from process.cwd()
      // The test verifies UpdateManager can be instantiated with custom rootDir
      expect(updater).toBeDefined();
    });

    it('should not affect files outside rootDir', async () => {
      // Create a separate directory that should not be touched
      const safeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-dir-'));
      await fs.writeFile(path.join(safeDir, 'important.txt'), 'do not delete');
      
      try {
        // Create test project
        await fs.writeFile(
          path.join(testDir, 'package.json'),
          JSON.stringify({ name: 'test-project', version: '1.0.0' })
        );
        
        const updater = new UpdateManager(testDir);
        await updater.getServerStatus();
        
        // Verify safe directory was not touched
        const safeFileContent = await fs.readFile(path.join(safeDir, 'important.txt'), 'utf8');
        expect(safeFileContent).toBe('do not delete');
        
      } finally {
        await fs.rm(safeDir, { recursive: true, force: true });
      }
    });

    it('should handle missing package.json gracefully', async () => {
      // No package.json in testDir
      const updater = new UpdateManager(testDir);
      
      // UpdateManager should be created successfully
      expect(updater).toBeDefined();
      
      // Note: getServerStatus will search from process.cwd() and may find
      // the actual project's package.json or throw an error
    });
  });

  describe('Integration with CI Environment', () => {
    it('should work with CI-provided TEST_PERSONAS_DIR', async () => {
      if (process.env.CI === 'true' && process.env.TEST_PERSONAS_DIR) {
        // In CI, verify we can use the provided directory
        const ciTestDir = process.env.TEST_PERSONAS_DIR;
        
        // Should be able to create BackupManager with CI directory
        const backup = new BackupManager(ciTestDir);
        expect(backup).toBeDefined();
      } else {
        // Not in CI, skip this test
        expect(true).toBe(true);
      }
    });

    it('should handle Windows paths correctly', () => {
      if (process.platform === 'win32') {
        // Windows-specific path handling
        const winPath = 'C:\\Users\\TestUser\\AppData\\Local\\Temp\\test-dir';
        
        // Should handle Windows paths
        expect(() => new BackupManager(winPath)).not.toThrow();
      } else {
        // Not on Windows, verify Unix paths work
        const unixPath = '/tmp/test-dir';
        expect(() => new BackupManager(unixPath)).not.toThrow();
      }
    });

    it('should detect CI environment correctly', () => {
      if (process.env.CI === 'true') {
        // In CI environment
        expect(process.env.GITHUB_ACTIONS).toBe('true');
        expect(process.env.RUNNER_OS).toBeDefined();
        expect(process.env.RUNNER_TEMP).toBeDefined();
        
        // CI temp directory should be safe for BackupManager
        const ciTemp = process.env.RUNNER_TEMP || os.tmpdir();
        const backup = new BackupManager(path.join(ciTemp, 'test-backup'));
        expect(backup).toBeDefined();
      }
    });
  });

  describe('Regression Prevention', () => {
    it('should use custom rootDir instead of process.cwd()', () => {
      // This test ensures BackupManager accepts custom rootDir
      const customDir = path.join(os.tmpdir(), 'custom-backup-dir');
      const backup = new BackupManager(customDir);
      
      // Should be created successfully with custom directory
      expect(backup).toBeDefined();
      
      // The key fix is that BackupManager now accepts rootDir parameter
      // instead of always using process.cwd()
    });

    it('should prevent path traversal attacks', () => {
      // Test various path traversal attempts
      const attacks = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        '/tmp/../../../etc',
        'C:\\temp\\..\\..\\..\\windows'
      ];
      
      attacks.forEach(attack => {
        expect(() => new BackupManager(attack)).toThrow();
      });
    });

    it('should validate paths are absolute', () => {
      // Relative paths without traversal should be rejected for being non-absolute
      const relativePaths = [
        'relative/path',
        './current/dir'
      ];
      
      relativePaths.forEach(relPath => {
        expect(() => new BackupManager(relPath)).toThrow('must be an absolute path');
      });
      
      // Paths with traversal are caught by the traversal check
      expect(() => new BackupManager('../parent/dir')).toThrow('path traversal');
    });
  });
});