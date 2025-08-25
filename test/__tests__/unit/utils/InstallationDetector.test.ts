import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { InstallationDetector } from '../../../../src/utils/installation.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Mock modules
jest.mock('../../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

// Mock fs module methods
let mockRealpathSync = jest.fn();
let mockExistsSync = jest.fn();
let mockStatSync = jest.fn();

jest.mock('fs', () => ({
  ...(jest.requireActual('fs') as any),
  realpathSync: mockRealpathSync,
  existsSync: mockExistsSync,
  statSync: mockStatSync
}));

describe('InstallationDetector', () => {
  const originalUrl = import.meta.url;
  
  beforeEach(() => {
    // Clear cache before each test
    InstallationDetector.clearCache();
    jest.clearAllMocks();
  });
  
  afterEach(() => {
    // Reset import.meta.url
    Object.defineProperty(import.meta, 'url', {
      value: originalUrl,
      writable: true
    });
  });
  
  describe('getInstallationType', () => {
    describe('npm installation detection', () => {
      it('should detect npm installation when in node_modules', () => {
        // Mock file path in node_modules
        const npmPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';
        Object.defineProperty(import.meta, 'url', {
          value: `file://${npmPath}`,
          writable: true
        });
        
        // Mock realpath to return same path
        mockRealpathSync.mockReturnValue(path.dirname(npmPath));
        
        // Mock fs.existsSync to return false for .git directories (ensure npm detection takes precedence)
        mockExistsSync.mockReturnValue(false);
        
        const result = InstallationDetector.getInstallationType();
        
        expect(result).toBe('npm');
      });
      
      it('should detect npm installation with Windows paths', () => {
        // Mock Windows npm path
        const npmPath = 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@dollhousemcp\\mcp-server\\dist\\utils\\installation.js';
        Object.defineProperty(import.meta, 'url', {
          value: `file:///${npmPath}`,
          writable: true
        });
        
        // Mock realpath to return same path
        mockRealpathSync.mockReturnValue(path.dirname(npmPath));
        
        // Mock fs.existsSync to return false for .git directories (ensure npm detection takes precedence)
        mockExistsSync.mockReturnValue(false);
        
        const result = InstallationDetector.getInstallationType();
        
        expect(result).toBe('npm');
      });
      
      it('should handle symlinked npm installations', () => {
        // Mock symlinked path
        const symlinkPath = '/home/user/projects/mcp/dist/utils/installation.js';
        const realPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';
        
        Object.defineProperty(import.meta, 'url', {
          value: `file://${symlinkPath}`,
          writable: true
        });
        
        // Mock realpath to resolve symlink
        mockRealpathSync = jest.fn().mockReturnValue(path.dirname(realPath));
        
        // Mock fs.existsSync to return false for .git directories (ensure npm detection takes precedence)
        mockExistsSync.mockReturnValue(false);
        
        const result = InstallationDetector.getInstallationType();
        
        expect(result).toBe('npm');
      });
    });
    
    describe('git installation detection', () => {
      it('should detect git installation when .git directory exists', () => {
        // Mock git repository path
        const gitPath = '/home/user/projects/DollhouseMCP/src/utils/installation.js';
        Object.defineProperty(import.meta, 'url', {
          value: `file://${gitPath}`,
          writable: true
        });
        
        mockRealpathSync = jest.fn().mockReturnValue(path.dirname(gitPath));
        mockExistsSync = jest.fn().mockImplementation((p: any) => {
          return p.endsWith('.git');
        });
        mockStatSync = jest.fn().mockReturnValue({
          isDirectory: () => true
        });
        
        const result = InstallationDetector.getInstallationType();
        
        expect(result).toBe('git');
      });
      
      it('should search up to MAX_SEARCH_DEPTH for .git directory', () => {
        // Mock deep nested path
        const deepPath = '/home/user/projects/DollhouseMCP/src/deep/nested/path/to/file/installation.js';
        Object.defineProperty(import.meta, 'url', {
          value: `file://${deepPath}`,
          writable: true
        });
        
        mockRealpathSync = jest.fn().mockReturnValue(path.dirname(deepPath));
        let searchCount = 0;
        mockExistsSync = jest.fn().mockImplementation((p: any) => {
          searchCount++;
          // Return true on the 3rd search
          return searchCount === 3 && p.endsWith('.git');
        });
        mockStatSync = jest.fn().mockReturnValue({
          isDirectory: () => true
        });
        
        const result = InstallationDetector.getInstallationType();
        
        expect(result).toBe('git');
        expect(searchCount).toBeGreaterThan(1);
      });
      
      it('should return unknown if .git not found within search depth', () => {
        // Mock path without .git
        const noGitPath = '/tmp/random/location/installation.js';
        Object.defineProperty(import.meta, 'url', {
          value: `file://${noGitPath}`,
          writable: true
        });
        
        mockRealpathSync = jest.fn().mockReturnValue(path.dirname(noGitPath));
        mockExistsSync = jest.fn().mockReturnValue(false);
        
        const result = InstallationDetector.getInstallationType();
        
        expect(result).toBe('unknown');
      });
    });
    
    describe('caching behavior', () => {
      it('should cache the result after first call', () => {
        // Setup npm installation
        const npmPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';
        Object.defineProperty(import.meta, 'url', {
          value: `file://${npmPath}`,
          writable: true
        });
        
        mockRealpathSync = jest.fn().mockReturnValue(path.dirname(npmPath));
        
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
        // Setup initial npm detection
        const npmPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';
        Object.defineProperty(import.meta, 'url', {
          value: `file://${npmPath}`,
          writable: true
        });
        
        mockRealpathSync = jest.fn().mockReturnValue(path.dirname(npmPath));
        
        // First call
        InstallationDetector.getInstallationType();
        expect(mockRealpathSync).toHaveBeenCalledTimes(1);
        
        // Clear cache
        InstallationDetector.clearCache();
        
        // Next call should re-detect
        InstallationDetector.getInstallationType();
        expect(mockRealpathSync).toHaveBeenCalledTimes(2);
      });
    });
    
    describe('error handling', () => {
      it('should handle realpath errors gracefully', () => {
        const gitPath = '/home/user/projects/DollhouseMCP/src/utils/installation.js';
        Object.defineProperty(import.meta, 'url', {
          value: `file://${gitPath}`,
          writable: true
        });
        
        // Mock realpath to throw error
        mockRealpathSync = jest.fn().mockImplementation(() => {
          throw new Error('Permission denied');
        });
        
        mockExistsSync = jest.fn().mockImplementation((p: any) => {
          return p.endsWith('.git');
        });
        mockStatSync = jest.fn().mockReturnValue({
          isDirectory: () => true
        });
        
        const result = InstallationDetector.getInstallationType();
        
        // Should still work with original path
        expect(result).toBe('git');
      });
      
      it('should handle existsSync errors during search', () => {
        const path = '/home/user/projects/src/installation.js';
        Object.defineProperty(import.meta, 'url', {
          value: `file://${path}`,
          writable: true
        });
        
        mockRealpathSync = jest.fn().mockReturnValue(path);
        mockExistsSync = jest.fn().mockImplementation(() => {
          throw new Error('Access denied');
        });
        
        const result = InstallationDetector.getInstallationType();
        
        expect(result).toBe('unknown');
      });
      
      it('should return unknown on any unexpected error', () => {
        // Mock import.meta.url to throw
        Object.defineProperty(import.meta, 'url', {
          get() {
            throw new Error('Unexpected error');
          }
        });
        
        const result = InstallationDetector.getInstallationType();
        
        expect(result).toBe('unknown');
      });
    });
  });
  
  describe('getNpmGlobalPath', () => {
    it('should return npm global path for npm installations', () => {
      // Mock npm installation
      const npmPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';
      const expectedRoot = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server';
      
      Object.defineProperty(import.meta, 'url', {
        value: `file://${npmPath}`,
        writable: true
      });
      
      mockRealpathSync = jest.fn().mockReturnValue(path.dirname(npmPath));
      mockExistsSync = jest.fn().mockImplementation((p: any) => {
        return p === path.join(expectedRoot, 'package.json');
      });
      
      const result = InstallationDetector.getNpmGlobalPath();
      
      expect(result).toBe(expectedRoot);
    });
    
    it('should return null for non-npm installations', () => {
      // Mock git installation
      const gitPath = '/home/user/projects/DollhouseMCP/src/utils/installation.js';
      Object.defineProperty(import.meta, 'url', {
        value: `file://${gitPath}`,
        writable: true
      });
      
      mockRealpathSync = jest.fn().mockReturnValue(path.dirname(gitPath));
      mockExistsSync = jest.fn().mockImplementation((p: any) => {
        return p.endsWith('.git');
      });
      mockStatSync = jest.fn().mockReturnValue({
        isDirectory: () => true
      });
      
      const result = InstallationDetector.getNpmGlobalPath();
      
      expect(result).toBeNull();
    });
    
    it('should handle errors and return null', () => {
      // Mock npm installation but throw on package.json check
      const npmPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';
      Object.defineProperty(import.meta, 'url', {
        value: `file://${npmPath}`,
        writable: true
      });
      
      mockRealpathSync = jest.fn().mockReturnValue(path.dirname(npmPath));
      mockExistsSync = jest.fn().mockImplementation(() => {
        throw new Error('Access denied');
      });
      
      const result = InstallationDetector.getNpmGlobalPath();
      
      expect(result).toBeNull();
    });
  });
  
  describe('getGitRepositoryPath', () => {
    it('should return git repository root for git installations', () => {
      // Mock git installation
      const gitPath = '/home/user/projects/DollhouseMCP/src/utils/installation.js';
      const expectedRoot = '/home/user/projects/DollhouseMCP';
      
      Object.defineProperty(import.meta, 'url', {
        value: `file://${gitPath}`,
        writable: true
      });
      
      mockRealpathSync = jest.fn().mockReturnValue(path.dirname(gitPath));
      mockExistsSync = jest.fn().mockImplementation((p: any) => {
        return p === path.join(expectedRoot, '.git');
      });
      mockStatSync = jest.fn().mockReturnValue({
        isDirectory: () => true
      });
      
      const result = InstallationDetector.getGitRepositoryPath();
      
      expect(result).toBe(expectedRoot);
    });
    
    it('should return null for non-git installations', () => {
      // Mock npm installation
      const npmPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/dist/utils/installation.js';
      Object.defineProperty(import.meta, 'url', {
        value: `file://${npmPath}`,
        writable: true
      });
      
      mockRealpathSync = jest.fn().mockReturnValue(path.dirname(npmPath));
      
      const result = InstallationDetector.getGitRepositoryPath();
      
      expect(result).toBeNull();
    });
    
    it('should handle search depth limits', () => {
      // Mock very deep path
      const deepPath = '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/installation.js';
      Object.defineProperty(import.meta, 'url', {
        value: `file://${deepPath}`,
        writable: true
      });
      
      mockRealpathSync = jest.fn().mockReturnValue(path.dirname(deepPath));
      mockExistsSync = jest.fn().mockReturnValue(false);
      mockStatSync = jest.fn().mockReturnValue({
        isDirectory: () => true
      });
      
      // First need to set as git installation
      InstallationDetector.clearCache();
      jest.spyOn(InstallationDetector, 'getInstallationType').mockReturnValue('git');
      
      const result = InstallationDetector.getGitRepositoryPath();
      
      expect(result).toBeNull();
    });
  });
  
  describe('getInstallationDescription', () => {
    it('should describe npm installation with path', () => {
      const npmPath = '/usr/local/lib/node_modules/@dollhousemcp/mcp-server';
      jest.spyOn(InstallationDetector, 'getInstallationType').mockReturnValue('npm');
      jest.spyOn(InstallationDetector, 'getNpmGlobalPath').mockReturnValue(npmPath);
      
      const result = InstallationDetector.getInstallationDescription();
      
      expect(result).toBe(`npm global installation at ${npmPath}`);
    });
    
    it('should describe npm installation without path', () => {
      jest.spyOn(InstallationDetector, 'getInstallationType').mockReturnValue('npm');
      jest.spyOn(InstallationDetector, 'getNpmGlobalPath').mockReturnValue(null);
      
      const result = InstallationDetector.getInstallationDescription();
      
      expect(result).toBe('npm global installation');
    });
    
    it('should describe git installation with path', () => {
      const gitPath = '/home/user/projects/DollhouseMCP';
      jest.spyOn(InstallationDetector, 'getInstallationType').mockReturnValue('git');
      jest.spyOn(InstallationDetector, 'getGitRepositoryPath').mockReturnValue(gitPath);
      
      const result = InstallationDetector.getInstallationDescription();
      
      expect(result).toBe(`git installation at ${gitPath}`);
    });
    
    it('should describe git installation without path', () => {
      jest.spyOn(InstallationDetector, 'getInstallationType').mockReturnValue('git');
      jest.spyOn(InstallationDetector, 'getGitRepositoryPath').mockReturnValue(null);
      
      const result = InstallationDetector.getInstallationDescription();
      
      expect(result).toBe('git installation');
    });
    
    it('should describe unknown installation type', () => {
      jest.spyOn(InstallationDetector, 'getInstallationType').mockReturnValue('unknown');
      
      const result = InstallationDetector.getInstallationDescription();
      
      expect(result).toBe('unknown installation type');
    });
  });
});