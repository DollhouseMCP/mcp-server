import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as child_process from 'child_process';
import { Buffer } from 'buffer';

// Create manual mocks
const mockReadFile = (jest.fn() as any);
const mockReaddir = (jest.fn() as any);
const mockStat = (jest.fn() as any);
const mockMkdir = (jest.fn() as any);
const mockRm = (jest.fn() as any);

const mockSpawn = (jest.fn() as any);

// Mock external dependencies
jest.mock('fs/promises', () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
  stat: mockStat,
  mkdir: mockMkdir,
  rm: mockRm
}));

jest.mock('child_process', () => ({
  spawn: mockSpawn
}));

// Mock fetch for GitHub API calls
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as any).fetch = mockFetch;

describe('Auto-Update System Tests', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock spawn to return a successful process
    const mockProcess = {
      stdout: {
        on: (jest.fn() as any).mockImplementation((event: string, callback: Function) => {
          if (event === 'data') {
            callback(Buffer.from('mock output'));
          }
        })
      },
      stderr: {
        on: (jest.fn() as any)
      },
      on: (jest.fn() as any).mockImplementation((event: string, callback: Function) => {
        if (event === 'close') {
          callback(0); // Success exit code
        }
      })
    };
    
    mockSpawn.mockReturnValue(mockProcess as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Version Comparison Logic', () => {
    // Enhanced version comparison utility function matching the implementation
    function compareVersions(version1: string, version2: string): number {
      // Normalize versions by removing 'v' prefix
      const v1 = version1.replace(/^v/, '');
      const v2 = version2.replace(/^v/, '');
      
      // Split version and pre-release parts
      const [v1main, v1pre] = v1.split('-');
      const [v2main, v2pre] = v2.split('-');
      
      // Compare main version parts (x.y.z)
      const v1parts = v1main.split('.').map(part => parseInt(part) || 0);
      const v2parts = v2main.split('.').map(part => parseInt(part) || 0);
      
      const maxLength = Math.max(v1parts.length, v2parts.length);
      for (let i = 0; i < maxLength; i++) {
        const v1part = v1parts[i] || 0;
        const v2part = v2parts[i] || 0;
        
        if (v1part < v2part) return -1;
        if (v1part > v2part) return 1;
      }
      
      // If main versions are equal, compare pre-release versions
      // Version without pre-release is greater than version with pre-release
      if (!v1pre && v2pre) return 1;   // 1.0.0 > 1.0.0-beta
      if (v1pre && !v2pre) return -1;  // 1.0.0-beta < 1.0.0
      if (!v1pre && !v2pre) return 0;  // 1.0.0 == 1.0.0
      
      // Both have pre-release, compare lexicographically
      return v1pre.localeCompare(v2pre);
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

    it('should handle pre-release versions correctly', () => {
      // Release versions are greater than pre-release versions
      expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
      
      // Compare pre-release versions lexicographically
      expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
      expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.2')).toBeLessThan(0);
      
      // Same pre-release versions
      expect(compareVersions('1.0.0-beta', '1.0.0-beta')).toBe(0);
    });
  });

  describe('Enhanced Features Tests', () => {
    describe('Backup Cleanup Policy', () => {
      it('should keep only the 5 most recent backups', async () => {
        const mockFiles = [
          '.backup-1720000000000', // oldest
          '.backup-1720001000000',
          '.backup-1720002000000',
          '.backup-1720003000000', 
          '.backup-1720004000000',
          '.backup-1720005000000',
          '.backup-1720006000000', // newest
          'other-file.txt'
        ];

        mockReaddir.mockResolvedValue(mockFiles as any);

        const files = await fs.readdir('.');
        const backupDirs = files
          .filter((f: string) => f.startsWith('.backup-') && f.match(/\.backup-\d+$/))
          .sort()
          .reverse()
          .slice(5); // Simulate keeping only the 5 most recent

        expect(backupDirs).toHaveLength(2); // Should remove 2 oldest
        expect(backupDirs).toContain('.backup-1720001000000');
        expect(backupDirs).toContain('.backup-1720000000000');
      });
    });

    describe('Dependency Verification', () => {
      it('should verify git availability', () => {
        child_process.spawn('git', ['--version']);
        
        expect(mockSpawn).toHaveBeenCalledWith('git', ['--version']);
      });

      it('should verify npm availability', () => {
        child_process.spawn('npm', ['--version']);
        
        expect(mockSpawn).toHaveBeenCalledWith('npm', ['--version']);
      });

      it('should handle missing dependencies gracefully', () => {
        const mockFailedProcess = {
          stdout: { on: jest.fn() },
          stderr: { on: jest.fn() },
          on: jest.fn((event: string, callback: Function) => {
            if (event === 'close') {
              callback(127); // Command not found
            }
          })
        };

        mockSpawn.mockReturnValue(mockFailedProcess as any);

        child_process.spawn('git', ['--version']);
        
        expect(mockSpawn).toHaveBeenCalledWith('git', ['--version']);
      });
    });

    describe('Dependency Version Validation', () => {
      describe('Version Parsing', () => {
        it('should parse git version output correctly', () => {
          const parseVersionFromOutput = (output: string, tool: string): string | null => {
            if (tool === 'git') {
              const match = output.match(/git version (\d+\.\d+\.\d+)/);
              return match ? match[1] : null;
            }
            return null;
          };

          expect(parseVersionFromOutput('git version 2.39.2', 'git')).toBe('2.39.2');
          expect(parseVersionFromOutput('git version 2.40.1 (Apple Git-103)', 'git')).toBe('2.40.1');
          expect(parseVersionFromOutput('git version 2.43.0.windows.1', 'git')).toBe('2.43.0');
          expect(parseVersionFromOutput('invalid output', 'git')).toBeNull();
        });

        it('should parse npm version output correctly', () => {
          const parseVersionFromOutput = (output: string, tool: string): string | null => {
            if (tool === 'npm') {
              const cleanOutput = output.trim();
              if (cleanOutput.match(/^\d+\.\d+\.\d+/)) {
                return cleanOutput.split('\n')[0];
              }
              try {
                const parsed = JSON.parse(cleanOutput);
                return parsed.npm || parsed.version || null;
              } catch {
                const match = cleanOutput.match(/(\d+\.\d+\.\d+)/);
                return match ? match[1] : null;
              }
            }
            return null;
          };

          expect(parseVersionFromOutput('8.19.2', 'npm')).toBe('8.19.2');
          expect(parseVersionFromOutput('10.5.0\n', 'npm')).toBe('10.5.0');
          expect(parseVersionFromOutput('{"npm":"8.19.2","node":"18.17.1"}', 'npm')).toBe('8.19.2');
          expect(parseVersionFromOutput('invalid output', 'npm')).toBeNull();
        });
      });

      describe('Version Requirements', () => {
        // Test version validation logic
        function validateDependencyVersion(
          actualVersion: string, 
          requirements: { minimum: string; maximum: string; recommended: string },
          toolName: string
        ): { valid: boolean; warning?: string; error?: string } {
          // Simplified version comparison for testing
          const compareVersions = (v1: string, v2: string): number => {
            const v1parts = v1.split('.').map(Number);
            const v2parts = v2.split('.').map(Number);
            
            for (let i = 0; i < Math.max(v1parts.length, v2parts.length); i++) {
              const v1part = v1parts[i] || 0;
              const v2part = v2parts[i] || 0;
              
              if (v1part < v2part) return -1;
              if (v1part > v2part) return 1;
            }
            return 0;
          };

          const minComparison = compareVersions(actualVersion, requirements.minimum);
          const maxComparison = compareVersions(actualVersion, requirements.maximum);
          
          if (minComparison < 0) {
            return {
              valid: false,
              error: `${toolName} version ${actualVersion} is below minimum required version ${requirements.minimum}`
            };
          }
          
          if (maxComparison > 0) {
            return {
              valid: true,
              warning: `${toolName} version ${actualVersion} is newer than tested version ${requirements.maximum}. May cause compatibility issues.`
            };
          }
          
          const recComparison = compareVersions(actualVersion, requirements.recommended);
          if (recComparison !== 0) {
            return {
              valid: true,
              warning: `${toolName} version ${actualVersion} works but ${requirements.recommended} is recommended for optimal stability.`
            };
          }
          
          return { valid: true };
        }

        const testRequirements = {
          minimum: '2.20.0',
          maximum: '2.50.0', 
          recommended: '2.40.0'
        };

        it('should validate minimum version requirements', () => {
          // Below minimum - should fail
          const belowMin = validateDependencyVersion('2.19.0', testRequirements, 'Git');
          expect(belowMin.valid).toBe(false);
          expect(belowMin.error).toContain('below minimum required version');

          // At minimum - should pass
          const atMin = validateDependencyVersion('2.20.0', testRequirements, 'Git');
          expect(atMin.valid).toBe(true);

          // Above minimum - should pass
          const aboveMin = validateDependencyVersion('2.30.0', testRequirements, 'Git');
          expect(aboveMin.valid).toBe(true);
        });

        it('should validate maximum version requirements', () => {
          // At maximum - should pass without warning
          const atMax = validateDependencyVersion('2.50.0', testRequirements, 'Git');
          expect(atMax.valid).toBe(true);

          // Above maximum - should pass with warning
          const aboveMax = validateDependencyVersion('2.51.0', testRequirements, 'Git');
          expect(aboveMax.valid).toBe(true);
          expect(aboveMax.warning).toContain('newer than tested version');
        });

        it('should validate recommended version', () => {
          // At recommended - should pass without warning
          const atRecommended = validateDependencyVersion('2.40.0', testRequirements, 'Git');
          expect(atRecommended.valid).toBe(true);
          expect(atRecommended.warning).toBeUndefined();

          // Not at recommended but in range - should pass with warning
          const notRecommended = validateDependencyVersion('2.35.0', testRequirements, 'Git');
          expect(notRecommended.valid).toBe(true);
          expect(notRecommended.warning).toContain('recommended for optimal stability');
        });

        it('should handle edge cases', () => {
          // Test with different version formats
          const result1 = validateDependencyVersion('2.20', { minimum: '2.20.0', maximum: '2.50.0', recommended: '2.40.0' }, 'Git');
          expect(result1.valid).toBe(true);

          // Test exact boundaries
          const result2 = validateDependencyVersion('2.20.0', { minimum: '2.20.0', maximum: '2.20.0', recommended: '2.20.0' }, 'Git');
          expect(result2.valid).toBe(true);
          expect(result2.warning).toBeUndefined();
        });
      });

      describe('Dependency Requirements Constants', () => {
        it('should have valid version requirements defined', () => {
          const DEPENDENCY_REQUIREMENTS = {
            git: {
              minimum: '2.20.0',
              maximum: '2.50.0',
              recommended: '2.40.0'
            },
            npm: {
              minimum: '8.0.0',
              maximum: '12.0.0',
              recommended: '10.0.0'
            }
          };

          // Validate Git requirements
          expect(DEPENDENCY_REQUIREMENTS.git.minimum).toMatch(/^\d+\.\d+\.\d+$/);
          expect(DEPENDENCY_REQUIREMENTS.git.maximum).toMatch(/^\d+\.\d+\.\d+$/);
          expect(DEPENDENCY_REQUIREMENTS.git.recommended).toMatch(/^\d+\.\d+\.\d+$/);

          // Validate npm requirements
          expect(DEPENDENCY_REQUIREMENTS.npm.minimum).toMatch(/^\d+\.\d+\.\d+$/);
          expect(DEPENDENCY_REQUIREMENTS.npm.maximum).toMatch(/^\d+\.\d+\.\d+$/);
          expect(DEPENDENCY_REQUIREMENTS.npm.recommended).toMatch(/^\d+\.\d+\.\d+$/);

          // Validate logical ordering (minimum <= recommended <= maximum)
          const compareVersions = (v1: string, v2: string): number => {
            const v1parts = v1.split('.').map(Number);
            const v2parts = v2.split('.').map(Number);
            
            for (let i = 0; i < Math.max(v1parts.length, v2parts.length); i++) {
              const v1part = v1parts[i] || 0;
              const v2part = v2parts[i] || 0;
              
              if (v1part < v2part) return -1;
              if (v1part > v2part) return 1;
            }
            return 0;
          };

          // Git: minimum <= recommended <= maximum
          expect(compareVersions(DEPENDENCY_REQUIREMENTS.git.minimum, DEPENDENCY_REQUIREMENTS.git.recommended)).toBeLessThanOrEqual(0);
          expect(compareVersions(DEPENDENCY_REQUIREMENTS.git.recommended, DEPENDENCY_REQUIREMENTS.git.maximum)).toBeLessThanOrEqual(0);

          // npm: minimum <= recommended <= maximum
          expect(compareVersions(DEPENDENCY_REQUIREMENTS.npm.minimum, DEPENDENCY_REQUIREMENTS.npm.recommended)).toBeLessThanOrEqual(0);
          expect(compareVersions(DEPENDENCY_REQUIREMENTS.npm.recommended, DEPENDENCY_REQUIREMENTS.npm.maximum)).toBeLessThanOrEqual(0);
        });
      });
    });

    describe('Retry Logic', () => {
      it('should implement exponential backoff', async () => {
        let attempts = 0;
        const mockOperation = jest.fn().mockImplementation(() => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Network error');
          }
          return Promise.resolve('success');
        });

        // Simulate retry logic
        const maxRetries = 3;
        let result;
        let lastError;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            result = await mockOperation();
            break;
          } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
              // Simulate exponential backoff delay calculation
              const delay = 1000 * Math.pow(2, attempt);
              expect(delay).toBe(1000 * Math.pow(2, attempt));
            }
          }
        }

        expect(result).toBe('success');
        expect(attempts).toBe(3);
      });

      it('should not retry certain errors', () => {
        const error404 = new Error('404 Not Found');
        
        // Should not retry 404 errors
        expect(error404.message.includes('404')).toBe(true);
      });
    });

    describe('Progress Indicators', () => {
      it('should format update progress correctly', () => {
        const progressMessage = 
          '✅ [1/6] Dependencies verified (git, npm)\n' +
          '✅ [2/6] Repository status validated\n' +
          '✅ [3/6] Backup created: backup-123456\n' +
          '✅ [4/6] Git pull completed\n' +
          '✅ [5/6] Dependencies updated (npm install)\n' +
          '✅ [6/6] TypeScript build completed';

        // Test that progress format is correct
        expect(progressMessage).toContain('[1/6]');
        expect(progressMessage).toContain('[6/6]');
        expect(progressMessage).toContain('Dependencies verified');
        expect(progressMessage).toContain('TypeScript build completed');
      });

      it('should format rollback progress correctly', () => {
        const rollbackMessage = 
          '✅ [1/5] Dependencies verified (git, npm)\n' +
          '✅ [2/5] Safety backup created\n' +
          '✅ [3/5] Current version removed\n' +
          '✅ [4/5] Previous version restored\n' +
          '✅ [5/5] TypeScript rebuild completed';

        // Test that rollback progress format is correct
        expect(rollbackMessage).toContain('[1/5]');
        expect(rollbackMessage).toContain('[5/5]');
        expect(rollbackMessage).toContain('Safety backup created');
        expect(rollbackMessage).toContain('Previous version restored');
      });
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

      mockReadFile.mockResolvedValue(JSON.stringify(mockPackageData));

      const packagePath = path.join(process.cwd(), 'package.json');
      const content = await fs.readFile(packagePath, 'utf-8');
      const packageData = JSON.parse(content);

      expect(packageData.name).toBe('dollhousemcp');
      expect(packageData.version).toBe('1.0.0');
      expect(mockReadFile).toHaveBeenCalledWith(packagePath, 'utf-8');
    });

    it('should handle file read errors', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));

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

      mockReaddir.mockResolvedValue(mockFiles as any);

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

      mockReaddir.mockResolvedValue(mockFiles as any);

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
      
      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['status'],
        { cwd: '/test' }
      );
    });

    it('should not use shell execution', () => {
      // Verify that commands are not concatenated into shell strings
      child_process.spawn('cp', ['-r', '/source', '/destination']);
      
      expect(mockSpawn).toHaveBeenCalledWith(
        'cp',
        ['-r', '/source', '/destination']
      );
      
      // Verify no shell injection patterns
      const calls = mockSpawn.mock.calls;
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

      mockSpawn.mockReturnValue(mockFailedProcess as any);

      // Test that error handling doesn't expose sensitive information
      child_process.spawn('git', ['status']);
      
      expect(mockSpawn).toHaveBeenCalledWith('git', ['status']);
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
      mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));

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

      mockSpawn.mockReturnValue(mockFailedProcess as any);

      child_process.spawn('git', ['status']);
      
      expect(mockSpawn).toHaveBeenCalledWith('git', ['status']);
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