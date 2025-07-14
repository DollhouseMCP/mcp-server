import { describe, it, expect } from '@jest/globals';
import { UpdateChecker } from '../../../../src/update/UpdateChecker.js';
import { VersionManager } from '../../../../src/update/VersionManager.js';

// Simple integration test - runs against real implementation
describe('UpdateChecker (Simple)', () => {
  let updateChecker: UpdateChecker;

  beforeEach(() => {
    const versionManager = new VersionManager();
    updateChecker = new UpdateChecker(versionManager);
  });

  describe('basic functionality', () => {
    it('should create an UpdateChecker instance', () => {
      expect(updateChecker).toBeDefined();
      expect(updateChecker).toBeInstanceOf(UpdateChecker);
    });

    it('should have required methods', () => {
      expect(typeof updateChecker.checkForUpdates).toBe('function');
      expect(typeof updateChecker.formatUpdateCheckResult).toBe('function');
    });

    it('should format update check results', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05',
        releaseNotes: 'Major release',
        releaseUrl: 'https://github.com'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);

      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('Update Available');
      expect(formatted).toContain('1.0.0');
      expect(formatted).toContain('2.0.0');
      expect(formatted).toContain('Major release');
    });

    it('should format no update result', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        isUpdateAvailable: false,
        releaseDate: '2025-01-01',
        releaseNotes: '',
        releaseUrl: ''
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);

      expect(formatted).toContain('Up to Date');
      expect(formatted).toContain('1.0.0');
    });

    it('should format error result', () => {
      const error = new Error('Network error');
      const formatted = updateChecker.formatUpdateCheckResult(null, error);

      expect(formatted).toContain('Update Check Failed');
      expect(formatted).toContain('Network error');
    });
  });
});