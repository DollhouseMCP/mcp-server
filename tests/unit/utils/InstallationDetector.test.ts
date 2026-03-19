import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InstallationDetector, type IFileSystem } from '../../../src/utils/installation.js';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

/**
 * Note: We now use Node.js built-in pathToFileURL from 'url' module
 * which correctly handles platform-specific path formats including Windows paths.
 */

/**
 * Helper to convert file path to file:// URL string (not URL object)
 * This wraps Node.js pathToFileURL and returns the string representation.
 */
function pathToFileURLString(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/**
 * Get the directory path in the format that fileURLToPath produces
 * On Windows: fileURLToPath returns /C:/... (with leading slash)
 * On Unix: fileURLToPath returns /usr/... (normal Unix path)
 *
 * This ensures test mocks return paths in the same format as runtime.
 */
function getExpectedDirFormat(filePath: string): string {
  const fileUrl = pathToFileURL(filePath);
  const actualFormat = fileURLToPath(fileUrl);
  return path.dirname(actualFormat);
}

// Mock logger module only
jest.mock('../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

describe('InstallationDetector', () => {
  beforeEach(() => {
    // Clear cache and DI overrides before each test
    InstallationDetector.clearCache();
    jest.clearAllMocks();
  });

  describe('getInstallationType', () => {
    describe('npm installation detection', () => {
      it('should detect npm installation when in node_modules', () => {
        // FIX: Use platform-specific paths for cross-platform compatibility
        const isWindows = process.platform === 'win32';

        const npmPath = isWindows
          ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
          : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';

        const mockFs: IFileSystem = {
          realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(npmPath)),
          existsSync: jest.fn().mockReturnValue(false),
          statSync: jest.fn()
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

        const result = InstallationDetector.getInstallationType();

        expect(result).toBe('npm');
      });

      it('should detect npm installation with Windows paths', () => {
        // FIX: Test with actual Windows-format path (cross-platform compatible)
        // This test specifically validates Windows path detection works correctly
        const isWindows = process.platform === 'win32';

        // Build actual Windows path format or Unix equivalent for testing
        const npmPath = isWindows
          ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
          : path.join('/usr', 'local', 'lib', 'node_modules', '@dollhousemcp', 'mcp-server', 'dist', 'utils', 'installation.js');

        const mockFs: IFileSystem = {
          realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(npmPath)),
          existsSync: jest.fn().mockReturnValue(false),
          statSync: jest.fn()
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use helper function to create proper file:// URL for Windows and Unix
        InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

        const result = InstallationDetector.getInstallationType();

        expect(result).toBe('npm');
      });

      it('should handle symlinked npm installations', () => {
        // FIX: Use platform-specific paths for cross-platform compatibility
        const isWindows = process.platform === 'win32';

        const symlinkPath = isWindows
          ? 'C:\\Users\\user\\projects\\mcp\\dist\\utils\\installation.js'
          : '/home/user/projects/mcp/dist/utils/installation.js';

        const realPath = isWindows
          ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
          : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';

        const mockFs: IFileSystem = {
          realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(realPath)),
          existsSync: jest.fn().mockReturnValue(false),
          statSync: jest.fn()
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(symlinkPath));

        const result = InstallationDetector.getInstallationType();

        expect(result).toBe('npm');
      });
    });

    describe('git installation detection', () => {
      it('should detect git installation when .git directory exists', () => {
        // FIX: Use platform-specific paths for cross-platform compatibility
        const isWindows = process.platform === 'win32';

        const gitPath = isWindows
          ? 'C:\\Users\\user\\projects\\DollhouseMCP\\src\\utils\\installation.js'
          : '/home/user/projects/DollhouseMCP/src/utils/installation.js';

        const mockFs: IFileSystem = {
          realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(gitPath)),
          existsSync: jest.fn().mockImplementation((p: string) => p.endsWith('.git')),
          statSync: jest.fn().mockReturnValue({
            isDirectory: () => true
          })
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(gitPath));

        const result = InstallationDetector.getInstallationType();

        expect(result).toBe('git');
      });

      it('should search up to MAX_SEARCH_DEPTH for .git directory', () => {
        // FIX: Use platform-specific paths for cross-platform compatibility
        const isWindows = process.platform === 'win32';

        const deepPath = isWindows
          ? 'C:\\Users\\user\\projects\\DollhouseMCP\\src\\deep\\nested\\path\\to\\file\\installation.js'
          : '/home/user/projects/DollhouseMCP/src/deep/nested/path/to/file/installation.js';

        let searchCount = 0;
        const mockFs: IFileSystem = {
          realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(deepPath)),
          existsSync: jest.fn().mockImplementation((p: string) => {
            searchCount++;
            // Return true on the 3rd search
            return searchCount === 3 && p.endsWith('.git');
          }),
          statSync: jest.fn().mockReturnValue({
            isDirectory: () => true
          })
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(deepPath));

        const result = InstallationDetector.getInstallationType();

        expect(result).toBe('git');
        expect(searchCount).toBeGreaterThan(1);
      });

      it('should return unknown if .git not found within search depth', () => {
        // FIX: Use platform-specific paths for cross-platform compatibility
        const isWindows = process.platform === 'win32';

        const noGitPath = isWindows
          ? 'C:\\Temp\\random\\location\\installation.js'
          : '/tmp/random/location/installation.js';

        const mockFs: IFileSystem = {
          realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(noGitPath)),
          existsSync: jest.fn().mockReturnValue(false),
          statSync: jest.fn()
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(noGitPath));

        const result = InstallationDetector.getInstallationType();

        expect(result).toBe('unknown');
      });
    });

    describe('caching behavior', () => {
      it('should cache the result after first call', () => {
        // FIX: Use platform-specific paths for cross-platform compatibility
        const isWindows = process.platform === 'win32';

        const npmPath = isWindows
          ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
          : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';

        const mockRealpathSync = jest.fn().mockReturnValue(path.dirname(npmPath));
        const mockFs: IFileSystem = {
          realpathSync: mockRealpathSync,
          existsSync: jest.fn().mockReturnValue(false),
          statSync: jest.fn()
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

        // First call
        const result1 = InstallationDetector.getInstallationType();
        expect(result1).toBe('npm');
        expect(mockRealpathSync).toHaveBeenCalledTimes(1);

        // Second call should use cache
        const result2 = InstallationDetector.getInstallationType();
        expect(result2).toBe('npm');
        expect(mockRealpathSync).toHaveBeenCalledTimes(1); // Not called again
      });

      it('should clear cache when clearCache is called', () => {
        // FIX: Use platform-specific paths for cross-platform compatibility
        const isWindows = process.platform === 'win32';

        const npmPath = isWindows
          ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
          : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';

        const mockRealpathSync = jest.fn().mockReturnValue(path.dirname(npmPath));
        const mockFs: IFileSystem = {
          realpathSync: mockRealpathSync,
          existsSync: jest.fn().mockReturnValue(false),
          statSync: jest.fn()
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

        // First call
        InstallationDetector.getInstallationType();
        expect(mockRealpathSync).toHaveBeenCalledTimes(1);

        // Clear cache
        InstallationDetector.clearCache();

        // After clearCache, need to re-set the DI overrides
        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

        // Next call should re-detect
        InstallationDetector.getInstallationType();
        expect(mockRealpathSync).toHaveBeenCalledTimes(2);
      });
    });

    describe('error handling', () => {
      it('should handle realpath errors gracefully', () => {
        // FIX: Use platform-specific paths for cross-platform compatibility
        const isWindows = process.platform === 'win32';

        const gitPath = isWindows
          ? 'C:\\Users\\user\\projects\\DollhouseMCP\\src\\utils\\installation.js'
          : '/home/user/projects/DollhouseMCP/src/utils/installation.js';

        const mockFs: IFileSystem = {
          realpathSync: jest.fn().mockImplementation(() => {
            throw new Error('Permission denied');
          }),
          existsSync: jest.fn().mockImplementation((p: string) => p.endsWith('.git')),
          statSync: jest.fn().mockReturnValue({
            isDirectory: () => true
          })
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(gitPath));

        const result = InstallationDetector.getInstallationType();

        // Should still work with original path
        expect(result).toBe('git');
      });

      it('should handle existsSync errors during search', () => {
        // FIX: Use platform-specific paths for cross-platform compatibility
        const isWindows = process.platform === 'win32';

        const testPath = isWindows
          ? 'C:\\Users\\user\\projects\\src\\installation.js'
          : '/home/user/projects/src/installation.js';

        const mockFs: IFileSystem = {
          realpathSync: jest.fn().mockReturnValue(testPath),
          existsSync: jest.fn().mockImplementation(() => {
            throw new Error('Access denied');
          }),
          statSync: jest.fn()
        };

        InstallationDetector.setFileSystem(mockFs);
        // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
        InstallationDetector.setImportMetaUrl(pathToFileURLString(testPath));

        const result = InstallationDetector.getInstallationType();

        expect(result).toBe('unknown');
      });

      it('should return unknown on any unexpected error', () => {
        // Mock import.meta.url that will cause fileURLToPath to throw
        const mockFs: IFileSystem = {
          realpathSync: jest.fn(),
          existsSync: jest.fn(),
          statSync: jest.fn()
        };

        InstallationDetector.setFileSystem(mockFs);
        InstallationDetector.setImportMetaUrl('invalid-url-format');

        const result = InstallationDetector.getInstallationType();

        expect(result).toBe('unknown');
      });
    });
  });

  describe('getNpmGlobalPath', () => {
    it('should return npm global path for npm installations', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const npmPath = isWindows
        ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
        : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';

      const expectedRoot = isWindows
        ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server'
        : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(npmPath)),
        existsSync: jest.fn().mockImplementation((p: string) => {
          return p === path.join(expectedRoot, 'package.json');
        }),
        statSync: jest.fn()
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

      const result = InstallationDetector.getNpmGlobalPath();

      expect(result).toBe(expectedRoot);
    });

    it('should return null for non-npm installations', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const gitPath = isWindows
        ? 'C:\\Users\\user\\projects\\DollhouseMCP\\src\\utils\\installation.js'
        : '/home/user/projects/DollhouseMCP/src/utils/installation.js';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(gitPath)),
        existsSync: jest.fn().mockImplementation((p: string) => p.endsWith('.git')),
        statSync: jest.fn().mockReturnValue({
          isDirectory: () => true
        })
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(gitPath));

      const result = InstallationDetector.getNpmGlobalPath();

      expect(result).toBeNull();
    });

    it('should handle errors and return null', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const npmPath = isWindows
        ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
        : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(npmPath)),
        existsSync: jest.fn().mockImplementation(() => {
          throw new Error('Access denied');
        }),
        statSync: jest.fn()
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

      const result = InstallationDetector.getNpmGlobalPath();

      expect(result).toBeNull();
    });
  });

  describe('getGitRepositoryPath', () => {
    it('should return git repository root for git installations', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const gitPath = isWindows
        ? 'C:\\Users\\user\\projects\\DollhouseMCP\\src\\utils\\installation.js'
        : '/home/user/projects/DollhouseMCP/src/utils/installation.js';

      const expectedRoot = isWindows
        ? 'C:\\Users\\user\\projects\\DollhouseMCP'
        : '/home/user/projects/DollhouseMCP';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(gitPath)),
        existsSync: jest.fn().mockImplementation((p: string) => {
          return p === path.join(expectedRoot, '.git');
        }),
        statSync: jest.fn().mockReturnValue({
          isDirectory: () => true
        })
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(gitPath));

      const result = InstallationDetector.getGitRepositoryPath();

      expect(result).toBe(expectedRoot);
    });

    it('should return null for non-npm installations', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const npmPath = isWindows
        ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
        : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(npmPath)),
        existsSync: jest.fn().mockReturnValue(false),
        statSync: jest.fn()
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

      const result = InstallationDetector.getGitRepositoryPath();

      expect(result).toBeNull();
    });

    it('should handle search depth limits', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const deepPath = isWindows
        ? 'C:\\a\\b\\c\\d\\e\\f\\g\\h\\i\\j\\k\\l\\m\\n\\installation.js'
        : '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/installation.js';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(deepPath)),
        existsSync: jest.fn().mockReturnValue(false),
        statSync: jest.fn().mockReturnValue({
          isDirectory: () => true
        })
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(deepPath));

      // First call to set installation type as 'git'
      // We need to mock it as git first
      const gitMockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(deepPath)),
        existsSync: jest.fn().mockImplementation((p: string) => p === path.join(path.dirname(deepPath), '.git')),
        statSync: jest.fn().mockReturnValue({
          isDirectory: () => true
        })
      };

      InstallationDetector.setFileSystem(gitMockFs);
      InstallationDetector.getInstallationType(); // This will cache 'git'

      // Now set the fs that won't find .git
      InstallationDetector.setFileSystem(mockFs);

      const result = InstallationDetector.getGitRepositoryPath();

      expect(result).toBeNull();
    });
  });

  describe('getInstallationDescription', () => {
    it('should describe npm installation with path', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const npmPath = isWindows
        ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
        : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';

      const expectedRoot = isWindows
        ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server'
        : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(npmPath)),
        existsSync: jest.fn().mockImplementation((p: string) => {
          return p === path.join(expectedRoot, 'package.json');
        }),
        statSync: jest.fn()
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

      const result = InstallationDetector.getInstallationDescription();

      expect(result).toBe(`npm global installation at ${expectedRoot}`);
    });

    it('should describe npm installation without path', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const npmPath = isWindows
        ? 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js'
        : '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(npmPath)),
        existsSync: jest.fn().mockReturnValue(false), // package.json not found
        statSync: jest.fn()
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(npmPath));

      const result = InstallationDetector.getInstallationDescription();

      expect(result).toBe('npm global installation');
    });

    it('should describe git installation with path', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const gitPath = isWindows
        ? 'C:\\Users\\user\\projects\\DollhouseMCP\\src\\utils\\installation.js'
        : '/home/user/projects/DollhouseMCP/src/utils/installation.js';

      const expectedRoot = isWindows
        ? 'C:\\Users\\user\\projects\\DollhouseMCP'
        : '/home/user/projects/DollhouseMCP';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(gitPath)),
        existsSync: jest.fn().mockImplementation((p: string) => {
          return p === path.join(expectedRoot, '.git');
        }),
        statSync: jest.fn().mockReturnValue({
          isDirectory: () => true
        })
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(gitPath));

      const result = InstallationDetector.getInstallationDescription();

      expect(result).toBe(`git installation at ${expectedRoot}`);
    });

    it('should describe git installation without path', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const gitPath = isWindows
        ? 'C:\\Users\\user\\projects\\DollhouseMCP\\src\\utils\\installation.js'
        : '/home/user/projects/DollhouseMCP/src/utils/installation.js';

      const expectedGitDir = isWindows
        ? 'C:\\Users\\user\\projects\\DollhouseMCP\\src\\.git'
        : '/home/user/projects/DollhouseMCP/src/.git';

      let isFirstCall = true;
      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(gitPath)),
        existsSync: jest.fn().mockImplementation((p: string) => {
          // Return true for the .git during type detection
          if (isFirstCall && p === expectedGitDir) {
            return true;
          }
          return false;
        }),
        statSync: jest.fn().mockImplementation(() => {
          if (isFirstCall) {
            isFirstCall = false; // After first statSync call, subsequent checks will fail
            return { isDirectory: () => true };
          }
          // Second time (during getGitRepositoryPath), throw an error to simulate permission issue
          throw new Error('Permission denied');
        })
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(gitPath));

      const result = InstallationDetector.getInstallationDescription();

      expect(result).toBe('git installation');
    });

    it('should describe unknown installation type', () => {
      // FIX: Use platform-specific paths for cross-platform compatibility
      const isWindows = process.platform === 'win32';

      const unknownPath = isWindows
        ? 'C:\\Temp\\random\\location\\installation.js'
        : '/tmp/random/location/installation.js';

      const mockFs: IFileSystem = {
        realpathSync: jest.fn().mockReturnValue(getExpectedDirFormat(unknownPath)),
        existsSync: jest.fn().mockReturnValue(false),
        statSync: jest.fn()
      };

      InstallationDetector.setFileSystem(mockFs);
      // FIX: Use proper file:// URL format with triple slash (RFC 8089 standard)
      InstallationDetector.setImportMetaUrl(pathToFileURLString(unknownPath));

      const result = InstallationDetector.getInstallationDescription();

      expect(result).toBe('unknown installation type');
    });
  });
});
