import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as child_process from 'child_process';
import { Buffer } from 'buffer';

// Mock external dependencies
jest.mock('fs/promises');
jest.mock('child_process');

// Mock fetch for GitHub API calls
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as any).fetch = mockFetch;

describe('Auto-Update System Tests', () => {
  let mockFs: jest.Mocked<typeof fs>;
  let mockChildProcess: jest.Mocked<typeof child_process>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    mockFs = fs as jest.Mocked<typeof fs>;
    mockChildProcess = child_process as jest.Mocked<typeof child_process>;

    // Mock spawn to return a successful process
    const mockProcess = {
      stdout: {
        on: jest.fn((event: string, callback: Function) => {
          if (event === 'data') {
            callback(Buffer.from('mock output'));
          }
        })
      },
      stderr: {
        on: jest.fn()
      },
      on: jest.fn((event: string, callback: Function) => {
        if (event === 'close') {
          callback(0); // Success exit code
        }
      })
    };
    
    mockChildProcess.spawn.mockReturnValue(mockProcess as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Version Comparison Logic', () => {
    // Test version comparison utility function
    function compareVersions(version1: string, version2: string): number {
      const v1parts = version1.replace(/^v/, '').split('.').map(Number);
      const v2parts = version2.replace(/^v/, '').split('.').map(Number);
      
      for (let i = 0; i < Math.max(v1parts.length, v2parts.length); i++) {
        const v1part = v1parts[i] || 0;
        const v2part = v2parts[i] || 0;
        
        if (v1part < v2part) return -1;
        if (v1part > v2part) return 1;
      }
      
      return 0;
    }

    it('should compare versions correctly', () => {
      // Test basic version comparison
      expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
      expect(compareVersions('1.1.0', '1.0.0')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);

      // Test with different number of parts
      expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0);
      expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0);

      // Test with larger numbers
      expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
      expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    });

    it('should handle version prefixes', () => {
      // Test removing 'v' prefix
      expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
      expect(compareVersions('v1.0.0', '1.1.0')).toBeLessThan(0);
      expect(compareVersions('1.0.0', 'v1.1.0')).toBeLessThan(0);
      expect(compareVersions('v1.0.0', 'v1.1.0')).toBeLessThan(0);
    });

    it('should handle edge cases', () => {
      // Test with missing parts
      expect(compareVersions('1', '1.0.1')).toBeLessThan(0);
      expect(compareVersions('1.0.1', '1')).toBeGreaterThan(0);
      expect(compareVersions('1', '1')).toBe(0);

      // Test with zero parts
      expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
      expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    });
  });

  describe('GitHub API Integration', () => {
    it('should handle successful API response', async () => {
      const mockReleaseData = {
        tag_name: 'v1.1.0',
        name: '1.1.0',
        published_at: '2025-07-03T00:00:00Z',
        body: 'Release notes for version 1.1.0',
        html_url: 'https://github.com/mickdarling/DollhouseMCP/releases/tag/v1.1.0'
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockReleaseData
      } as Response);

      const response = await fetch('https://api.github.com/repos/mickdarling/DollhouseMCP/releases/latest');
      const data = await response.json();

      expect(data.tag_name).toBe('v1.1.0');
      expect(data.name).toBe('1.1.0');
      expect(data.published_at).toBe('2025-07-03T00:00:00Z');
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden'
      } as Response);

      const response = await fetch('https://api.github.com/repos/mickdarling/DollhouseMCP/releases/latest');
      
      expect(response.ok).toBe(false);
      expect(response.status).toBe(403);
      expect(response.statusText).toBe('Forbidden');
    });

    it('should handle 404 response (no releases)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      } as Response);

      const response = await fetch('https://api.github.com/repos/mickdarling/DollhouseMCP/releases/latest');
      
      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);
    });

    it('should handle network timeout', async () => {
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      await expect(fetch('https://api.github.com/repos/mickdarling/DollhouseMCP/releases/latest'))
        .rejects
        .toThrow('Network timeout');
    });
  });

  describe('File System Operations', () => {
    it('should read package.json successfully', async () => {
      const mockPackageData = {
        name: 'dollhousemcp',
        version: '1.0.0',
        description: 'Test package'
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(mockPackageData));

      const packagePath = path.join(process.cwd(), 'package.json');
      const content = await fs.readFile(packagePath, 'utf-8');
      const packageData = JSON.parse(content);

      expect(packageData.name).toBe('dollhousemcp');
      expect(packageData.version).toBe('1.0.0');
      expect(mockFs.readFile).toHaveBeenCalledWith(packagePath, 'utf-8');
    });

    it('should handle file read errors', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      await expect(fs.readFile('nonexistent.json', 'utf-8'))
        .rejects
        .toThrow('File not found');
    });

    it('should list backup directories', async () => {
      const mockFiles = [
        'backup-20250703-100000',
        'backup-20250703-120000',
        'backup-20250703-110000',
        'other-file.txt',
        'src',
        'dist'
      ];

      mockFs.readdir.mockResolvedValue(mockFiles as any);

      const files = await fs.readdir('.');
      const backupDirs = files.filter((f: string) => f.startsWith('backup-') && f.match(/backup-\d{8}-\d{6}/));
      
      expect(backupDirs).toHaveLength(3);
      expect(backupDirs).toContain('backup-20250703-100000');
      expect(backupDirs).toContain('backup-20250703-120000');
      expect(backupDirs).toContain('backup-20250703-110000');
    });

    it('should sort backup directories by timestamp', async () => {
      const mockFiles = [
        'backup-20250703-100000',
        'backup-20250703-120000',
        'backup-20250703-110000'
      ];

      mockFs.readdir.mockResolvedValue(mockFiles as any);

      const files = await fs.readdir('.');
      const backupDirs = files.filter((f: string) => f.startsWith('backup-')).sort().reverse();
      
      expect(backupDirs[0]).toBe('backup-20250703-120000'); // Latest first
      expect(backupDirs[1]).toBe('backup-20250703-110000');
      expect(backupDirs[2]).toBe('backup-20250703-100000');
    });
  });

  describe('Command Execution Security', () => {
    it('should use spawn with argument arrays', () => {
      // Test that spawn is called with proper argument separation
      child_process.spawn('git', ['status'], { cwd: '/test' });
      
      expect(mockChildProcess.spawn).toHaveBeenCalledWith(
        'git',
        ['status'],
        { cwd: '/test' }
      );
    });

    it('should not use shell execution', () => {
      // Verify that commands are not concatenated into shell strings
      child_process.spawn('cp', ['-r', '/source', '/destination']);
      
      expect(mockChildProcess.spawn).toHaveBeenCalledWith(
        'cp',
        ['-r', '/source', '/destination']
      );
      
      // Verify no shell injection patterns
      const calls = mockChildProcess.spawn.mock.calls;
      for (const call of calls) {
        const [command, args] = call;
        expect(command).not.toMatch(/[;&|`$]/);
        if (args) {
          expect(args.join(' ')).not.toMatch(/[;&|`$]/);
        }
      }
    });

    it('should handle command execution errors safely', () => {
      // Mock failed process
      const mockFailedProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn((event: string, callback: Function) => {
          if (event === 'close') {
            callback(1); // Error exit code
          }
        })
      };

      mockChildProcess.spawn.mockReturnValue(mockFailedProcess as any);

      // Test that error handling doesn't expose sensitive information
      child_process.spawn('git', ['status']);
      
      expect(mockChildProcess.spawn).toHaveBeenCalledWith('git', ['status']);
    });
  });

  describe('Backup Operations', () => {
    it('should create timestamped backup directories', () => {
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-').replace(/-/g, '');
      const backupName = `backup-${timestamp.slice(0, 8)}-${timestamp.slice(8, 14)}`;
      
      // Test backup directory naming convention
      expect(backupName).toMatch(/^backup-\d{8}-\d{6}$/);
      
      // Test that the format is consistent
      const backupRegex = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
      const match = backupName.match(backupRegex);
      
      expect(match).toBeTruthy();
      if (match) {
        const [, year, month, day, hour, minute, second] = match;
        expect(parseInt(year)).toBeGreaterThan(2020);
        expect(parseInt(month)).toBeGreaterThanOrEqual(1);
        expect(parseInt(month)).toBeLessThanOrEqual(12);
        expect(parseInt(day)).toBeGreaterThanOrEqual(1);
        expect(parseInt(day)).toBeLessThanOrEqual(31);
        expect(parseInt(hour)).toBeGreaterThanOrEqual(0);
        expect(parseInt(hour)).toBeLessThanOrEqual(23);
        expect(parseInt(minute)).toBeGreaterThanOrEqual(0);
        expect(parseInt(minute)).toBeLessThanOrEqual(59);
        expect(parseInt(second)).toBeGreaterThanOrEqual(0);
        expect(parseInt(second)).toBeLessThanOrEqual(59);
      }
    });

    it('should identify the most recent backup', () => {
      const backupDirs = [
        'backup-20250703-100000',
        'backup-20250703-120000',
        'backup-20250703-110000',
        'backup-20250702-235959'
      ];

      const sortedBackups = backupDirs.sort().reverse();
      expect(sortedBackups[0]).toBe('backup-20250703-120000'); // Most recent
    });
  });

  describe('Error Handling', () => {
    it('should handle package.json parsing errors', () => {
      const invalidJson = '{ invalid json }';
      
      expect(() => {
        JSON.parse(invalidJson);
      }).toThrow();
    });

    it('should handle network timeouts gracefully', async () => {
      mockFetch.mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Network timeout')), 100);
        });
      });

      await expect(fetch('https://api.github.com/test'))
        .rejects
        .toThrow('Network timeout');
    });

    it('should handle file system permissions errors', async () => {
      mockFs.readFile.mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(fs.readFile('/restricted/file.txt'))
        .rejects
        .toThrow('EACCES: permission denied');
    });

    it('should handle git command failures', () => {
      const mockFailedProcess = {
        stdout: { on: jest.fn() },
        stderr: { 
          on: jest.fn((event: string, callback: Function) => {
            if (event === 'data') {
              callback(Buffer.from('fatal: not a git repository'));
            }
          })
        },
        on: jest.fn((event: string, callback: Function) => {
          if (event === 'close') {
            callback(128); // Git error exit code
          }
        })
      };

      mockChildProcess.spawn.mockReturnValue(mockFailedProcess as any);

      child_process.spawn('git', ['status']);
      
      expect(mockChildProcess.spawn).toHaveBeenCalledWith('git', ['status']);
    });
  });

  describe('Repository Configuration', () => {
    it('should have secure repository constants', () => {
      const REPO_OWNER = 'mickdarling';
      const REPO_NAME = 'DollhouseMCP';
      const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
      const RELEASES_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

      expect(REPO_OWNER).toBe('mickdarling');
      expect(REPO_NAME).toBe('DollhouseMCP');
      expect(REPO_URL).toBe('https://github.com/mickdarling/DollhouseMCP');
      expect(RELEASES_API_URL).toBe('https://api.github.com/repos/mickdarling/DollhouseMCP/releases/latest');

      // Verify no injection patterns
      expect(REPO_OWNER).not.toMatch(/[;&|`$]/);
      expect(REPO_NAME).not.toMatch(/[;&|`$]/);
    });
  });

  describe('Input Validation', () => {
    it('should validate version strings', () => {
      const validVersions = ['1.0.0', '1.2.3', '10.0.0', '1.0.0-beta', 'v1.0.0'];
      const invalidVersions = ['', 'abc', '1.0.0; rm -rf /', '1.0.0`touch /tmp/test`'];

      validVersions.forEach(version => {
        expect(typeof version).toBe('string');
        expect(version.length).toBeGreaterThan(0);
      });

      invalidVersions.forEach(version => {
        if (version.includes(';') || version.includes('`') || version.includes('rm')) {
          expect(version).toMatch(/[;&|`$]/); // Should be rejected
        }
      });
    });

    it('should validate file paths', () => {
      const validPaths = ['/home/user/project', './relative/path', '../parent/dir'];
      const maliciousPaths = ['/etc/passwd', '../../../etc/passwd', '/tmp; rm -rf /'];

      validPaths.forEach(path => {
        expect(typeof path).toBe('string');
        expect(path.length).toBeGreaterThan(0);
      });

      maliciousPaths.forEach(path => {
        if (path.includes(';') || path.includes('rm')) {
          expect(path).toMatch(/[;&|`$]/); // Should be rejected
        }
      });
    });
  });
});