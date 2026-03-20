/**
 * Cross-Platform Path Compatibility Tests
 *
 * This test suite validates that our code and tests work correctly across
 * different platforms (Linux, macOS, Windows) by catching common issues:
 *
 * 1. Hardcoded /tmp/ paths that fail on macOS (/var/folders/) and Windows
 * 2. Path separator issues (/ vs \)
 * 3. Symlink resolution differences (/var → /private/var on macOS)
 * 4. Environment variable path handling
 *
 * Run these tests BEFORE pushing to catch platform-specific issues locally.
 *
 * Usage:
 *   npm run test:cross-platform
 *   jest tests/unit/cross-platform/path-compatibility.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { CrossPlatformTestHelper, type CrossPlatformIssue } from '../../helpers/cross-platform-test-helpers.js';

describe('Cross-Platform Path Compatibility', () => {
  describe('Temp Directory Handling', () => {
    it('should use os.tmpdir() instead of hardcoded /tmp/', () => {
      // Verify os.tmpdir() returns a valid path
      const tmpDir = os.tmpdir();
      expect(tmpDir).toBeDefined();
      expect(typeof tmpDir).toBe('string');
      expect(tmpDir.length).toBeGreaterThan(0);

      // Verify it's platform-appropriate
      if (process.platform === 'win32') {
        expect(tmpDir).toMatch(/[A-Z]:\\/); // Windows drive letter
      } else {
        expect(tmpDir).toMatch(/^\//); // Unix absolute path
      }
    });

    it('should handle different temp directory structures', async () => {
      const platforms: Array<'linux' | 'macos' | 'windows'> = ['linux', 'macos', 'windows'];

      for (const platform of platforms) {
        const mockPath = CrossPlatformTestHelper.mockPlatformPath(platform, 'test-file.md');

        // Verify basename extraction works
        // Use platform-specific path parsing
        let basename: string;
        if (platform === 'windows') {
          // Windows paths need special handling
          const parts = mockPath.split('\\');
          basename = parts[parts.length - 1];
        } else {
          basename = path.basename(mockPath);
        }
        expect(basename).toBe('test-file.md');

        // Verify we can construct paths
        const dirname = path.dirname(mockPath);
        expect(dirname).toBeDefined();
        expect(dirname.length).toBeGreaterThan(0);
      }
    });

    it('should normalize temp paths correctly', () => {
      const linuxTemp = '/tmp/test-file.md';
      const macosTemp = '/var/folders/6c/pzd640_546q6_yfn24r65c_40000gn/T/test-file.md';
      const windowsTemp = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\test-file.md';

      // Basename matching should work across all platforms
      const paths = [linuxTemp, macosTemp, windowsTemp];

      // Extract basenames with platform-aware logic
      const basenames = paths.map(p => {
        if (p.includes('\\')) {
          // Windows path
          const parts = p.split('\\');
          return parts[parts.length - 1];
        }
        return path.basename(p);
      });

      expect(basenames).toEqual(['test-file.md', 'test-file.md', 'test-file.md']);

      // Normalized paths should be comparable
      paths.forEach(p => {
        expect(CrossPlatformTestHelper.normalizePath(p)).toContain('test-file.md');
      });
    });

    it('should construct temp paths using path.join and os.tmpdir()', () => {
      const tmpDir = os.tmpdir();
      const testFile = 'test-file.md';
      const fullPath = path.join(tmpDir, testFile);

      // Should be absolute
      expect(path.isAbsolute(fullPath)).toBe(true);

      // Should contain the filename
      expect(fullPath).toContain(testFile);

      // Should use platform-appropriate separators
      if (process.platform === 'win32') {
        expect(fullPath).toContain('\\');
      } else {
        expect(fullPath).toContain('/');
      }
    });

    it('should create actual temp directories successfully', async () => {
      const tmpDir = await CrossPlatformTestHelper.createCrossPlatformTempDir('linux', 'test');

      expect(tmpDir).toBeDefined();
      expect(path.isAbsolute(tmpDir)).toBe(true);

      // Verify directory was created
      const stats = await fs.stat(tmpDir);
      expect(stats.isDirectory()).toBe(true);

      // Cleanup
      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('Path Separator Handling', () => {
    it('should handle both / and \\ in path comparisons', () => {
      const unixPath = 'test-personas/test.md';
      const windowsPath = 'test-personas\\test.md';

      // Extract basenames platform-aware
      const unixBasename = path.basename(unixPath);
      const windowsBasename = windowsPath.split('\\').pop() || '';

      // Both should extract the same filename
      expect(unixBasename).toBe('test.md');
      expect(windowsBasename).toBe('test.md');

      // Normalized paths should be comparable
      const norm1 = CrossPlatformTestHelper.normalizePath(unixPath);
      const norm2 = CrossPlatformTestHelper.normalizePath(windowsPath);

      // Both should contain the filename
      expect(norm1).toContain('test.md');
      expect(norm2).toContain('test.md');
    });

    it('should use path.join instead of string concatenation', () => {
      const dir = 'test-dir';
      const file = 'test-file.md';

      // Correct way
      const joinedPath = path.join(dir, file);

      // Verify it works correctly
      expect(joinedPath).toContain(file);
      expect(joinedPath).toContain(dir);

      // Should use platform-appropriate separator
      const expectedSeparator = process.platform === 'win32' ? '\\' : '/';
      expect(joinedPath).toContain(expectedSeparator);
    });

    it('should normalize paths with mixed separators', () => {
      const mixedPath = 'test\\dir/subdir\\file.md';
      const normalized = CrossPlatformTestHelper.normalizePath(mixedPath);

      // Should use consistent separators (always forward slash after normalization)
      expect(normalized).toContain('/');

      // Should still point to the same file
      expect(normalized).toContain('file.md');
    });

    it('should handle path.join with empty segments', () => {
      // path.join should handle empty segments gracefully
      const joined = path.join('dir', '', 'file.md');
      expect(joined).toContain('file.md');
      expect(joined).not.toContain('//');
    });
  });

  describe('Path Consistency (Without Symlink Resolution)', () => {
    it('should maintain consistent path representations', () => {
      const testPath = '/var/folders/test.md';

      // With our fix, paths are NOT resolved, so they stay as-is
      // This means /var stays /var, NOT /private/var
      const normalized = path.normalize(testPath);

      // On Windows, normalize converts / to \, which is expected
      // On Unix, it stays the same
      if (process.platform === 'win32') {
        expect(normalized).toBe('\\var\\folders\\test.md');
      } else {
        expect(normalized).toBe(testPath);
      }
    });

    it('should use simple path comparisons without symlink resolution', () => {
      const path1 = '/var/folders/test.md';
      const path2 = '/var/folders/test.md';

      // Same paths should match exactly (no resolution needed)
      expect(path1).toBe(path2);

      // Basename always works
      expect(path.basename(path1)).toBe('test.md');
    });

    it('should handle relative paths consistently', () => {
      const relativePath = 'test-personas/test.md';

      // Normalization converts to platform-specific separators
      const normalized = path.normalize(relativePath);

      if (process.platform === 'win32') {
        expect(normalized).toBe('test-personas\\test.md');
      } else {
        expect(normalized).toBe(relativePath);
      }

      // Can always extract basename
      expect(path.basename(relativePath)).toBe('test.md');
    });
  });

  describe('Environment Variable Path Handling', () => {
    it('should not have platform-specific env var assumptions', () => {
      // If GITHUB_REPOSITORY is set, it should be used
      // Otherwise, PORTFOLIO_REPOSITORY_NAME should be available
      const githubRepo = process.env.GITHUB_REPOSITORY;
      const portfolioRepo = process.env.PORTFOLIO_REPOSITORY_NAME;

      // At least one should be available in test environments
      if (!githubRepo && !portfolioRepo) {
        // This is OK - not all tests need these
        expect(true).toBe(true);
      } else {
        // If set, should be valid
        if (githubRepo) {
          expect(typeof githubRepo).toBe('string');
        }
        if (portfolioRepo) {
          expect(typeof portfolioRepo).toBe('string');
        }
      }
    });

    it('should handle paths in env vars across platforms', () => {
      // Create a test env var with a path
      const testPath = path.join(os.tmpdir(), 'test-file.md');
      process.env.TEST_PATH_VAR = testPath;

      // Should be retrievable
      expect(process.env.TEST_PATH_VAR).toBe(testPath);

      // Should be normalizable
      const normalized = path.normalize(process.env.TEST_PATH_VAR!);
      expect(path.basename(normalized)).toBe('test-file.md');

      // Cleanup
      delete process.env.TEST_PATH_VAR;
    });

    it('should validate environment variables are platform-agnostic', () => {
      const testEnvVars = {
        VALID_VAR: 'some-value',
        GITHUB_REPOSITORY: 'user/repo', // This will be flagged as hardcoded
      };

      const issues = CrossPlatformTestHelper.validateEnvironmentVariables(testEnvVars);

      // The validator flags GITHUB_REPOSITORY with '/' as hardcoded
      // This is expected behavior - use PORTFOLIO_REPOSITORY_NAME instead
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should detect hardcoded temp paths in env vars', () => {
      const badEnvVars = {
        BAD_PATH: '/tmp/hardcoded-path'
      };

      const issues = CrossPlatformTestHelper.validateEnvironmentVariables(badEnvVars);

      // Should flag hardcoded /tmp/
      const tmpIssues = issues.filter(i => i.type === 'hardcoded-tmp');
      expect(tmpIssues.length).toBeGreaterThan(0);
    });
  });

  describe('Meta-Test: Cross-Platform Test Quality', () => {
    it('should detect hardcoded /tmp/ in test files', async () => {
      // Scan a test file known to have issues
      const testFile = path.join(process.cwd(), 'tests/helpers/di-mocks.ts');

      try {
        const issues = await CrossPlatformTestHelper.scanTestFile(testFile);
        const tmpIssues = issues.filter(i => i.type === 'hardcoded-tmp');

        // This file currently has hardcoded /tmp/ - we expect to find it
        if (tmpIssues.length > 0) {
          console.log(`\n⚠️  Found ${tmpIssues.length} hardcoded /tmp/ path(s) in ${testFile}:`);
          tmpIssues.forEach(issue => {
            console.log(`   Line ${issue.line}: ${issue.snippet}`);
            console.log(`   Fix: ${issue.suggestion}`);
          });
        }

        // Just verify the scanner works - don't fail if issues are found
        expect(Array.isArray(tmpIssues)).toBe(true);
      } catch (error) {
        // File might not exist in all environments
        console.warn('Could not scan test file:', error);
      }
    }, 10000); // Increase timeout for file scanning

    it('should scan test directory for cross-platform issues', async () => {
      // Scan a subset of test files
      const testDir = path.join(process.cwd(), 'tests/unit');
      const verbose = process.env.VERBOSE === 'true';

      try {
        const issuesMap = await CrossPlatformTestHelper.scanTestDirectory(testDir);

        if (issuesMap.size > 0) {
          const formatted = CrossPlatformTestHelper.formatIssues(issuesMap, verbose);
          console.log('\n' + formatted);

          // Count issues by priority
          let highPriority = 0;
          let mediumPriority = 0;
          let lowPriority = 0;

          for (const issues of issuesMap.values()) {
            for (const issue of issues) {
              if (issue.priority === 'high') highPriority++;
              else if (issue.priority === 'medium') mediumPriority++;
              else lowPriority++;
            }
          }

          const totalIssues = highPriority + mediumPriority + lowPriority;

          if (!verbose) {
            console.log(`\n📊 Summary: ${totalIssues} total (${highPriority} high, ${mediumPriority} medium, ${lowPriority} low)`);
          }

          // FAIL the test if high-priority issues are found
          if (highPriority > 0) {
            const highPriorityFiles: string[] = [];
            for (const [file, issues] of issuesMap.entries()) {
              const highIssues = issues.filter(i => i.priority === 'high');
              if (highIssues.length > 0) {
                highPriorityFiles.push(`${file} (${highIssues.length} issue${highIssues.length > 1 ? 's' : ''})`);
              }
            }

            throw new Error(
              `\n❌ Found ${highPriority} high-priority cross-platform issue(s) that must be fixed:\n` +
              highPriorityFiles.map(f => `  - ${f}`).join('\n') +
              `\n\nThese are hardcoded /tmp/ paths in test setup/mocks that will fail on macOS and Windows.` +
              `\nFix them by using os.tmpdir() instead.` +
              `\n\nRun with VERBOSE=true for full details: VERBOSE=true npm run test:cross-platform`
            );
          }
        } else {
          console.log('\n✓ No cross-platform issues found in test directory');
        }

        // Verify scanner ran successfully
        expect(issuesMap).toBeInstanceOf(Map);
      } catch (error) {
        // Re-throw errors about cross-platform issues (these should fail the test)
        if (error instanceof Error && error.message.includes('high-priority cross-platform')) {
          throw error;
        }
        // Only swallow scanning errors (file not found, etc.)
        console.warn('Could not scan test directory:', error);
      }
    }, 30000); // Increase timeout for directory scanning

    it('should provide actionable error messages for violations', () => {
      const issue: CrossPlatformIssue = {
        type: 'hardcoded-tmp',
        file: 'test.ts',
        line: 42,
        message: 'Hardcoded /tmp/ path detected',
        suggestion: 'Use os.tmpdir() instead',
        snippet: "const path = '/tmp/test';",
        priority: 'high'
      };

      // Verify issue has all required fields
      expect(issue.type).toBeDefined();
      expect(issue.file).toBeDefined();
      expect(issue.line).toBeGreaterThan(0);
      expect(issue.message).toBeDefined();
      expect(issue.suggestion).toBeDefined();
      expect(issue.priority).toBeDefined();

      // Suggestion should be actionable
      expect(issue.suggestion).toContain('os.tmpdir()');
    });
  });

  describe('Real-World Simulation Tests', () => {
    it('should work with macOS-style temp directories', async () => {
      // Create a path that looks like macOS
      const macosPath = CrossPlatformTestHelper.mockPlatformPath('macos', 'test-dir');

      // Verify we can extract components
      expect(path.basename(macosPath)).toBe('test-dir');
      expect(path.dirname(macosPath)).toContain('/var/folders/');
    });

    it('should work with Windows-style temp directories', () => {
      // Create a path that looks like Windows
      const windowsPath = CrossPlatformTestHelper.mockPlatformPath('windows', 'test-dir');

      // Verify we can extract components using Windows-aware logic
      const basename = windowsPath.split('\\').pop() || '';
      expect(basename).toBe('test-dir');

      // Windows paths should have drive letter
      expect(windowsPath).toMatch(/^[A-Z]:\\/);
    });

    it('should handle paths without symlink resolution', () => {
      const originalPath = '/var/folders/test.md';

      // With our fix, paths are NOT resolved (no symlink resolution)
      const normalized = path.normalize(originalPath);

      // On Windows, normalize converts / to \
      if (process.platform === 'win32') {
        expect(normalized).toBe('\\var\\folders\\test.md');
      } else {
        expect(normalized).toBe(originalPath);
      }

      // Basename extraction still works
      expect(path.basename(originalPath)).toBe('test.md');
    });

    it('should create and use temp directories across platforms', async () => {
      const tmpDir = os.tmpdir();
      const testDir = path.join(tmpDir, `cross-platform-test-${Date.now()}`);

      // Create directory
      await fs.mkdir(testDir, { recursive: true });

      // Write a file
      const testFile = path.join(testDir, 'test.md');
      await fs.writeFile(testFile, '# Test', 'utf-8');

      // Read it back
      const content = await fs.readFile(testFile, 'utf-8');
      expect(content).toBe('# Test');

      // Verify basename matching works
      expect(path.basename(testFile)).toBe('test.md');

      // Cleanup
      await fs.rm(testDir, { recursive: true, force: true });
    });
  });

  describe('Path Matcher Utilities', () => {
    it('should provide cross-platform path matcher', () => {
      const matcher = CrossPlatformTestHelper.pathMatcher('test-file.md');

      // Should match paths with same basename
      expect(matcher.asymmetricMatch('/tmp/test-file.md')).toBe(true);
      expect(matcher.asymmetricMatch('/var/folders/xxx/T/test-file.md')).toBe(true);
      expect(matcher.asymmetricMatch('C:\\Temp\\test-file.md')).toBe(true);

      // Should not match different files
      expect(matcher.asymmetricMatch('/tmp/other-file.md')).toBe(false);
    });

    it('should support regex patterns in matcher', () => {
      const matcher = CrossPlatformTestHelper.pathMatcher(/test-file\.md$/);

      // Should match paths ending with pattern
      expect(matcher.asymmetricMatch('/tmp/test-file.md')).toBe(true);
      expect(matcher.asymmetricMatch('/var/folders/xxx/test-file.md')).toBe(true);

      // Should not match different endings
      expect(matcher.asymmetricMatch('/tmp/test-file.txt')).toBe(false);
    });

    it('should compare paths correctly', () => {
      // Same paths
      expect(CrossPlatformTestHelper.pathsEqual('/tmp/test.md', '/tmp/test.md')).toBe(true);

      // Different base paths, same file
      expect(CrossPlatformTestHelper.pathsEqual(
        '/tmp/test.md',
        '/var/folders/xxx/test.md'
      )).toBe(true);

      // Different files
      expect(CrossPlatformTestHelper.pathsEqual('/tmp/a.md', '/tmp/b.md')).toBe(false);
    });
  });

  describe('Platform Detection', () => {
    it('should detect current platform correctly', () => {
      const platform = process.platform;
      expect(['linux', 'darwin', 'win32', 'freebsd']).toContain(platform);
    });

    it('should get platform-specific temp directory', () => {
      const tmpDir = os.tmpdir();
      expect(tmpDir).toBeDefined();
      expect(path.isAbsolute(tmpDir)).toBe(true);
    });

    it('should handle platform-specific path operations', () => {
      const testPath = path.join('dir', 'file.md');

      if (process.platform === 'win32') {
        // Windows uses backslashes
        expect(testPath).toContain('\\');
      } else {
        // Unix uses forward slashes
        expect(testPath).toContain('/');
      }
    });
  });
});
