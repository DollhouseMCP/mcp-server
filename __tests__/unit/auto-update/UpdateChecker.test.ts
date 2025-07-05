import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock modules before imports
jest.mock('fs/promises');
jest.mock('../../../src/update/VersionManager');

// Import after mocking
import { UpdateChecker } from '../../../src/update/UpdateChecker';
import { VersionManager } from '../../../src/update/VersionManager';

describe('UpdateChecker Simplified Tests', () => {
  let updateChecker: UpdateChecker;
  let mockVersionManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create mock version manager
    mockVersionManager = {
      getCurrentVersion: jest.fn().mockResolvedValue('1.0.0'),
      compareVersions: jest.fn().mockImplementation((v1: string, v2: string) => {
        const normalize = (v: string) => v.replace('v', '');
        const n1 = normalize(v1);
        const n2 = normalize(v2);
        if (n1 === n2) return 0;
        return n1 < n2 ? -1 : 1;
      })
    };
    
    // Override the VersionManager mock
    (VersionManager as jest.MockedClass<typeof VersionManager>).mockImplementation(() => mockVersionManager);
    
    updateChecker = new UpdateChecker(new VersionManager());
  });

  describe('formatUpdateCheckResult', () => {
    it('should format update available result', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05',
        releaseNotes: 'Major release',
        releaseUrl: 'https://github.com'
      };

      const formatted = updateChecker.formatUpdateCheckResult(result);

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

    it('should include persona indicator when provided', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        isUpdateAvailable: false,
        releaseDate: '2025-01-01',
        releaseNotes: '',
        releaseUrl: ''
      };

      const formatted = updateChecker.formatUpdateCheckResult(result, undefined, '[TestPersona]');

      expect(formatted).toContain('[TestPersona]');
    });
  });

  describe('constructor and initialization', () => {
    it('should create instance with version manager', () => {
      expect(updateChecker).toBeDefined();
      expect(VersionManager).toHaveBeenCalled();
    });
  });
});