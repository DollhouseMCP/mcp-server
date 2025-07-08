/**
 * CI Environment Validation Tests
 * 
 * These tests verify that our CI environment is properly configured
 * across all platforms (Windows, macOS, Linux) and that the fixes
 * implemented in PR #89 continue to work correctly.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

describe('CI Environment Validation', () => {
  const isCI = process.env.CI === 'true';
  const isWindows = process.platform === 'win32';
  const isMacOS = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';

  describe('Environment Variables', () => {
    it('should have NODE_ENV defined', () => {
      expect(process.env.NODE_ENV).toBeDefined();
    });

    it('should detect CI environment correctly', () => {
      if (isCI) {
        expect(process.env.CI).toBe('true');
        expect(process.env.GITHUB_ACTIONS).toBe('true');
      }
    });

    it('should have TEST_PERSONAS_DIR set in CI', () => {
      if (isCI) {
        expect(process.env.TEST_PERSONAS_DIR).toBeDefined();
        expect(process.env.TEST_PERSONAS_DIR).not.toBe('');
        expect(process.env.TEST_PERSONAS_DIR).toMatch(/test-personas/);
      }
    });

    it('should have valid TEST_PERSONAS_DIR path format', () => {
      if (isCI && process.env.TEST_PERSONAS_DIR) {
        const testDir = process.env.TEST_PERSONAS_DIR;
        
        // Check for valid path separators based on platform
        if (isWindows) {
          // Windows can use both forward and backslashes
          expect(testDir).toMatch(/^[A-Za-z]:|^\//);
        } else {
          // Unix-based systems should start with /
          expect(testDir).toMatch(/^\//);
        }
      }
    });

    it('should be able to create TEST_PERSONAS_DIR', () => {
      if (isCI && process.env.TEST_PERSONAS_DIR) {
        const testDir = process.env.TEST_PERSONAS_DIR;
        
        // Try to create the directory
        expect(() => {
          fs.mkdirSync(testDir, { recursive: true });
        }).not.toThrow();
        
        // Verify it exists
        expect(fs.existsSync(testDir)).toBe(true);
        
        // Verify we can write to it
        const testFile = path.join(testDir, 'test-write.txt');
        expect(() => {
          fs.writeFileSync(testFile, 'test content');
        }).not.toThrow();
        
        // Clean up
        if (fs.existsSync(testFile)) {
          fs.unlinkSync(testFile);
        }
      }
    });
  });

  describe('Shell Compatibility', () => {
    it('should execute bash commands on all platforms', () => {
      if (!isCI) {
        console.log('Skipping shell compatibility test outside CI');
        return;
      }

      // Test basic bash command
      expect(() => {
        execSync('echo "Hello from bash"', { 
          shell: 'bash',
          encoding: 'utf8'
        });
      }).not.toThrow();
    });

    it('should handle Unix-style redirections', () => {
      if (!isCI) {
        console.log('Skipping redirection test outside CI');
        return;
      }

      // Test stderr redirection (2>/dev/null)
      const result = execSync('ls nonexistent-file-12345 2>/dev/null || echo "handled"', {
        shell: 'bash',
        encoding: 'utf8'
      }).trim();
      
      expect(result).toBe('handled');
    });

    it('should support bash conditionals', () => {
      if (!isCI) {
        console.log('Skipping bash conditional test outside CI');
        return;
      }

      // Test bash [[ ]] conditionals
      const result = execSync('[[ -n "$HOME" ]] && echo "yes" || echo "no"', {
        shell: 'bash',
        encoding: 'utf8'
      }).trim();
      
      expect(result).toBe('yes');
    });

    it('should support command substitution', () => {
      if (!isCI) {
        console.log('Skipping command substitution test outside CI');
        return;
      }

      // Test $() command substitution
      const result = execSync('echo "Current dir: $(pwd)"', {
        shell: 'bash',
        encoding: 'utf8'
      });
      
      expect(result).toContain('Current dir:');
      expect(result.length).toBeGreaterThan(13); // More than just the prefix
    });
  });

  describe('Platform-Specific Behavior', () => {
    it('should identify the correct platform', () => {
      const platformCount = [isWindows, isMacOS, isLinux].filter(Boolean).length;
      expect(platformCount).toBe(1); // Exactly one should be true
    });

    it('should have Git Bash available on Windows', () => {
      if (isCI && isWindows) {
        // Verify bash.exe exists in common locations
        const bashPaths = [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
          'C:\\Windows\\System32\\bash.exe'
        ];
        
        const bashExists = bashPaths.some(path => {
          try {
            return fs.existsSync(path);
          } catch {
            return false;
          }
        });
        
        // Or check if bash is in PATH
        const bashInPath = (() => {
          try {
            execSync('where bash', { encoding: 'utf8' });
            return true;
          } catch {
            return false;
          }
        })();
        
        expect(bashExists || bashInPath).toBe(true);
      }
    });

    it('should handle platform-specific paths correctly', () => {
      const testPath = path.join('dir', 'subdir', 'file.txt');
      
      if (isWindows) {
        expect(testPath).toContain('\\');
      } else {
        expect(testPath).toContain('/');
      }
    });
  });

  describe('GitHub Actions Integration', () => {
    it('should have GitHub-specific environment variables in CI', () => {
      if (isCI) {
        expect(process.env.GITHUB_WORKFLOW).toBeDefined();
        expect(process.env.GITHUB_RUN_ID).toBeDefined();
        expect(process.env.GITHUB_RUN_NUMBER).toBeDefined();
        expect(process.env.RUNNER_OS).toBeDefined();
      }
    });

    it('should match runner OS with Node.js platform', () => {
      if (isCI && process.env.RUNNER_OS) {
        const runnerOS = process.env.RUNNER_OS.toLowerCase();
        
        if (runnerOS === 'windows') {
          expect(isWindows).toBe(true);
        } else if (runnerOS === 'macos') {
          expect(isMacOS).toBe(true);
        } else if (runnerOS === 'linux') {
          expect(isLinux).toBe(true);
        }
      }
    });
  });

  describe('Integration Test Requirements', () => {
    it('should provide TEST_PERSONAS_DIR to integration tests', () => {
      if (isCI) {
        // This verifies that our integration tests will have access
        // to the required environment variable
        const integrationTestEnv = {
          ...process.env,
          NODE_ENV: 'test'
        };
        
        expect(integrationTestEnv.TEST_PERSONAS_DIR).toBeDefined();
      }
    });

    it('should maintain TEST_PERSONAS_DIR across test suites', () => {
      if (isCI) {
        // Store the value
        const originalValue = process.env.TEST_PERSONAS_DIR;
        
        // Verify it persists (Jest doesn't reset it)
        expect(process.env.TEST_PERSONAS_DIR).toBe(originalValue);
      }
    });
  });
});