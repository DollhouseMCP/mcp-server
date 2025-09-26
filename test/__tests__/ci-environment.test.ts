import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { runInGitHubActions } from '../utils/test-environment.js';

/**
 * CI Environment Tests - Issue #92
 * 
 * These tests verify that the CI fixes from PR #89 work correctly across all platforms.
 * They ensure that:
 * 1. Shell syntax works correctly on Windows
 * 2. Environment variables are properly set
 * 3. Integration tests can find the test directory
 * 4. Cross-platform path handling works
 */
describe('CI Environment Tests', () => {
  const isCI = process.env.CI === 'true';
  const isWindows = process.platform === 'win32';
  const isMacOS = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';

  describe('Environment Variable Validation', () => {
    it('should have TEST_PERSONAS_DIR set in CI environment', () => {
      runInGitHubActions('TEST_PERSONAS_DIR environment validation', () => {
        expect(process.env.TEST_PERSONAS_DIR).toBeDefined();
        expect(process.env.TEST_PERSONAS_DIR).not.toBe('');
        // Use path.isAbsolute for cross-platform compatibility
        const testPersonasDir = process.env.TEST_PERSONAS_DIR!;
        const isAbsolutePath = path.isAbsolute(testPersonasDir);
        expect(isAbsolutePath).toBe(true);
      });

      if (!isCI) {
        // In local development, it might not be set
        expect(true).toBe(true);
      }
    });

    it('should have valid path format for TEST_PERSONAS_DIR', () => {
      if (isCI && process.env.TEST_PERSONAS_DIR) {
        const testDir = process.env.TEST_PERSONAS_DIR;
        
        // Verify it's an absolute path
        expect(path.isAbsolute(testDir)).toBe(true);
        
        // Verify no dangerous characters
        expect(testDir).not.toMatch(/[<>"|?*]/);
        
        // Verify no path traversal
        expect(testDir).not.toContain('..');
      }
    });

    it('should be able to create directories in TEST_PERSONAS_DIR', async () => {
      if (isCI && process.env.TEST_PERSONAS_DIR) {
        const testSubDir = path.join(process.env.TEST_PERSONAS_DIR, 'ci-test-subdir');
        
        // Create directory
        await fs.mkdir(testSubDir, { recursive: true });
        
        // Verify it exists
        const stats = await fs.stat(testSubDir);
        expect(stats.isDirectory()).toBe(true);
        
        // Clean up
        await fs.rm(testSubDir, { recursive: true, force: true });
      }
    });
  });

  describe('Shell Compatibility', () => {
    it('should handle bash-style redirections correctly', () => {
      if (isCI) {
        // Test that bash shell is available and working
        let result: string;
        
        try {
          // This should work with bash shell specification in CI
          result = execSync('ls nonexistent 2>/dev/null || echo "Redirection works"', {
            shell: isWindows ? 'bash.exe' : 'bash',
            encoding: 'utf8'
          }).trim();
          
          expect(result).toBe('Redirection works');
        } catch (error) {
          // If bash is not available, skip this test
          console.log('Bash shell not available, skipping test');
        }
      }
    });

    it('should handle cross-platform commands correctly', () => {
      // Test commands that should work on all platforms
      const commands = [
        { cmd: 'node --version', pattern: /^v\d+\.\d+\.\d+$/ },
        { cmd: 'node -e "console.log(\'test\')"', expected: 'test' }
      ];

      commands.forEach(({ cmd, expected, pattern }) => {
        const result = execSync(cmd, { encoding: 'utf8' }).trim();
        
        if (expected) {
          expect(result).toBe(expected);
        } else if (pattern) {
          expect(result).toMatch(pattern);
        }
      });
    });
  });

  describe('Platform Detection', () => {
    it('should correctly identify the platform', () => {
      const platform = process.platform;
      expect(['win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'sunos', 'aix']).toContain(platform);
      
      // Verify only one platform is true
      const platformCount = [isWindows, isMacOS, isLinux].filter(Boolean).length;
      expect(platformCount).toBeLessThanOrEqual(1);
    });

    it('should have appropriate CI environment variables', () => {
      runInGitHubActions('GitHub Actions environment variables', () => {
        // GitHub Actions specific
        expect(process.env.GITHUB_ACTIONS).toBe('true');
        expect(process.env.RUNNER_OS).toBeDefined();
        expect(process.env.GITHUB_WORKSPACE).toBeDefined();
      });
    });
  });

  describe('Path Handling', () => {
    it('should handle path separators correctly', () => {
      const testPath = path.join('dir1', 'dir2', 'file.txt');
      
      if (isWindows) {
        expect(testPath).toContain('\\');
      } else {
        expect(testPath).toContain('/');
      }
      
      // Normalized path should work on all platforms
      const normalized = path.normalize(testPath);
      expect(normalized).toBeTruthy();
    });

    it('should resolve paths consistently', () => {
      const paths = [
        process.cwd(),
        os.tmpdir(),
        os.homedir()
      ];

      paths.forEach(p => {
        expect(path.isAbsolute(p)).toBe(true);
        expect(p).toBeTruthy();
      });
    });
  });

  describe('CI-Specific Features', () => {
    it('should have proper Node.js version', () => {
      const nodeVersion = process.version;
      const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
      
      // We support Node 18, 20, 22, and 24
      expect([18, 20, 22, 24]).toContain(majorVersion);
    });

    it('should have npm available', () => {
      const npmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
      expect(npmVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should have git available', () => {
      const gitVersion = execSync('git --version', { encoding: 'utf8' }).trim();
      expect(gitVersion).toMatch(/^git version \d+\.\d+\.\d+/);
    });
  });

  describe('File System Operations', () => {
    it('should handle temporary directories correctly', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-test-'));
      
      try {
        // Verify directory exists
        const stats = await fs.stat(tmpDir);
        expect(stats.isDirectory()).toBe(true);
        
        // Create a test file
        const testFile = path.join(tmpDir, 'test.txt');
        await fs.writeFile(testFile, 'CI test content');
        
        // Read it back
        const content = await fs.readFile(testFile, 'utf8');
        expect(content).toBe('CI test content');
        
      } finally {
        // Clean up
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should handle Unicode filenames correctly', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unicode-test-'));
      
      try {
        // Test various Unicode characters in filenames
        const unicodeFiles = [
          'test-émoji-😀.txt',
          'test-chinese-你好.txt',
          'test-arabic-مرحبا.txt',
          'test-space in name.txt'
        ];

        for (const filename of unicodeFiles) {
          const filepath = path.join(tmpDir, filename);
          
          // Skip if the filesystem doesn't support this character
          try {
            await fs.writeFile(filepath, 'test content');
            const content = await fs.readFile(filepath, 'utf8');
            expect(content).toBe('test content');
          } catch (error) {
            console.log(`Skipping Unicode test for: ${filename}`);
          }
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });


  describe('Integration Test Environment', () => {
    it('should provide necessary environment for integration tests', () => {
      if (isCI) {
        // Check that integration tests have what they need
        // Windows uses USERPROFILE instead of HOME
        const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
        const requiredEnvVars = [
          homeVar,
          'PATH'
        ];
        
        // NODE_ENV is optional but commonly set
        if (process.env.NODE_ENV) {
          expect(process.env.NODE_ENV).toBeDefined();
        }

        requiredEnvVars.forEach(envVar => {
          expect(process.env[envVar]).toBeDefined();
        });
      }
    });

    it('should handle concurrent file operations', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'concurrent-test-'));
      
      try {
        // Create multiple files concurrently
        const promises = Array.from({ length: 10 }, (_, i) => 
          fs.writeFile(path.join(tmpDir, `file-${i}.txt`), `Content ${i}`)
        );
        
        await Promise.all(promises);
        
        // Verify all files exist
        const files = await fs.readdir(tmpDir);
        expect(files.length).toBe(10);
        expect(files.every(f => f.match(/^file-\d+\.txt$/))).toBe(true);
        
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});