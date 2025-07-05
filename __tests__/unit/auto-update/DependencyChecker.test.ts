import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execSync } from 'child_process';

// Create manual mocks
const mockExecSync = jest.fn() as any;

// Mock child_process
jest.mock('child_process', () => ({
  execSync: mockExecSync
}));

// Mock VersionManager
const mockValidateDependencyVersion = jest.fn() as any;
const mockParseVersionFromOutput = jest.fn() as any;

const mockVersionManager = {
  validateDependencyVersion: mockValidateDependencyVersion,
  parseVersionFromOutput: mockParseVersionFromOutput
};

jest.mock('../../../src/update/VersionManager', () => ({
  VersionManager: jest.fn().mockImplementation(() => mockVersionManager)
}));

// Import after mocking
import { DependencyChecker } from '../../../src/update/DependencyChecker';
import { VersionManager } from '../../../src/update/VersionManager';

describe('DependencyChecker', () => {
  let dependencyChecker: DependencyChecker;
  let versionManager: VersionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    versionManager = new VersionManager();
    dependencyChecker = new DependencyChecker(versionManager);
    
    // Default mock behavior for version parsing
    mockParseVersionFromOutput.mockImplementation((output: string, tool: string) => {
      if (tool === 'git' && output.includes('git version')) {
        const match = output.match(/git version ([0-9.]+)/); 
        return match ? match[1] : null;
      }
      if (tool === 'npm') {
        return output.trim();
      }
      if (tool === 'node') {
        return output.replace('v', '').trim();
      }
      return null;
    });
    
    // Default mock behavior for version validation
    mockValidateDependencyVersion.mockImplementation((version: string, requirements: any) => {
      return { valid: true };
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkDependencies', () => {
    it('should pass when all dependencies are satisfied', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('git version 2.30.0');
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('8.5.0');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.12.0');
        }
        return Buffer.from('');
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.git.installed).toBe(true);
      expect(result.git.version).toBe('2.30.0');
      expect(result.git.valid).toBe(true);
      expect(result.npm.installed).toBe(true);
      expect(result.npm.version).toBe('8.5.0');
      expect(result.npm.valid).toBe(true);
    });

    it('should fail when git version is too old', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('git version 2.19.0');
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('8.5.0');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.12.0');
        }
        return Buffer.from('');
      });
      
      mockValidateDependencyVersion.mockImplementation((version: string, requirements: any, tool: string) => {
        if (tool === 'git' && version === '2.19.0') {
          return { valid: false, error: 'Git version 2.19.0 found, but 2.20.0+ required' };
        }
        return { valid: true };
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.git.valid).toBe(false);
      expect(result.git.error).toContain('Git version 2.19.0 found, but 2.20.0+ required');
    });

    it('should fail when npm version is too old', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('git version 2.30.0');
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('7.24.0');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.12.0');
        }
        return Buffer.from('');
      });
      
      mockValidateDependencyVersion.mockImplementation((version: string, requirements: any, tool: string) => {
        if (tool === 'npm' && version === '7.24.0') {
          return { valid: false, error: 'npm version 7.24.0 found, but 8.0.0+ required' };
        }
        return { valid: true };
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.npm.valid).toBe(false);
      expect(result.npm.error).toContain('npm version 7.24.0 found, but 8.0.0+ required');
    });

    it('should detect when node version info exists in npm output', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('git version 2.30.0');
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('8.5.0');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.20.0');
        }
        return Buffer.from('');
      });

      const result = await dependencyChecker.checkDependencies();

      // Should parse node version from npm if available
      expect(result.npm.version).toBe('8.5.0');
    });

    it('should handle missing git', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          throw new Error('Command not found: git');
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('8.5.0');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.12.0');
        }
        return Buffer.from('');
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.git.installed).toBe(false);
      expect(result.git.error).toContain('Git is not installed');
    });

    it('should handle missing npm', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('git version 2.30.0');
        }
        if (cmd.includes('npm --version')) {
          throw new Error('Command not found: npm');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.12.0');
        }
        return Buffer.from('');
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.npm.installed).toBe(false);
      expect(result.npm.error).toContain('npm is not installed');
    });

    it('should handle different version output formats', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('git version 2.30.0.windows.1');
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('8.5.0\n');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.12.0\r\n');
        }
        return Buffer.from('');
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.git.version).toBe('2.30.0');
      expect(result.npm.version).toBe('8.5.0');
      expect(result.git.valid).toBe(true);
      expect(result.npm.valid).toBe(true);
    });

    it('should handle pre-release versions', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('git version 2.30.0-rc1');
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('8.5.0-beta.1');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.12.0-nightly');
        }
        return Buffer.from('');
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.git.version).toBe('2.30.0-rc1');
      expect(result.git.valid).toBe(true);
    });

    it('should check maximum version constraints', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('git version 3.0.0'); // Too new
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('10.0.0');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.12.0');
        }
        return Buffer.from('');
      });
      
      mockValidateDependencyVersion.mockImplementation((version: string, requirements: any, tool: string) => {
        if (tool === 'git' && version === '3.0.0') {
          return { valid: true, warning: 'Git version 3.0.0 is newer than tested maximum 2.50.0' };
        }
        return { valid: true };
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.git.valid).toBe(true);
      expect(result.git.warning).toContain('newer than tested maximum');
    });

    it('should provide helpful error messages', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('git version 1.8.0');
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('6.14.0');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v14.17.0');
        }
        return Buffer.from('');
      });
      
      mockValidateDependencyVersion.mockImplementation((version: string, requirements: any, tool: string) => {
        const errors: Record<string, string> = {
          'git:1.8.0': 'Git version 1.8.0 found, but 2.20.0+ required',
          'npm:6.14.0': 'npm version 6.14.0 found, but 8.0.0+ required'
        };
        const key = `${tool}:${version}`;
        if (errors[key]) {
          return { valid: false, error: errors[key] };
        }
        return { valid: true };
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.git.valid).toBe(false);
      expect(result.git.error).toContain('Git version 1.8.0 found, but 2.20.0+ required');
      expect(result.npm.valid).toBe(false);
      expect(result.npm.error).toContain('npm version 6.14.0 found, but 8.0.0+ required');
    });

    it('should format dependency status correctly', () => {
      const status = {
        git: { installed: true, version: '2.30.0', valid: true },
        npm: { installed: true, version: '8.5.0', valid: true }
      };

      const formatted = dependencyChecker.formatDependencyStatus(status);

      expect(formatted).toContain('Git');
      expect(formatted).toContain('2.30.0');
      expect(formatted).toContain('npm');
      expect(formatted).toContain('8.5.0');
    });

    it('should handle parsing errors gracefully', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git --version')) {
          return Buffer.from('invalid output');
        }
        if (cmd.includes('npm --version')) {
          return Buffer.from('8.5.0');
        }
        if (cmd.includes('node --version')) {
          return Buffer.from('v18.12.0');
        }
        return Buffer.from('');
      });

      mockParseVersionFromOutput.mockImplementation((output: string, tool: string) => {
        if (tool === 'git') return null; // Unable to parse
        return output.trim();
      });

      const result = await dependencyChecker.checkDependencies();

      expect(result.git.installed).toBe(true);
      expect(result.git.version).toBeUndefined();
      expect(result.git.error).toContain('Unable to parse Git version');
    });
  });

  describe('formatDependencyStatus', () => {
    it('should format status with errors', () => {
      const status = {
        git: { installed: false, error: 'Git is not installed' },
        npm: { installed: true, version: '8.5.0', valid: false, error: 'npm version too old' }
      };

      const formatted = dependencyChecker.formatDependencyStatus(status);

      expect(formatted).toContain('Git is not installed');
      expect(formatted).toContain('npm version too old');
    });

    it('should format status with warnings', () => {
      const status = {
        git: { installed: true, version: '3.0.0', valid: true, warning: 'Newer than tested' },
        npm: { installed: true, version: '8.5.0', valid: true }
      };

      const formatted = dependencyChecker.formatDependencyStatus(status);

      expect(formatted).toContain('Newer than tested');
    });
  });
});