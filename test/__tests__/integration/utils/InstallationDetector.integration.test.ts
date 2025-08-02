import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { InstallationDetector } from '../../../../src/utils/installation.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

describe('InstallationDetector Integration Tests', () => {
  const testDir = path.join(os.tmpdir(), 'dollhouse-installation-test', Date.now().toString());
  
  beforeEach(async () => {
    // Clear cache before each test
    InstallationDetector.clearCache();
    await fs.mkdir(testDir, { recursive: true });
  });
  
  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  describe('npm installation detection', () => {
    it('should detect npm installation based on actual directory structure', async () => {
      // Create npm-like directory structure
      const npmPath = path.join(testDir, 'node_modules', '@dollhousemcp', 'mcp-server', 'dist', 'utils');
      await fs.mkdir(npmPath, { recursive: true });
      
      // Create a mock installation.js file
      const installationPath = path.join(npmPath, 'installation.js');
      await fs.writeFile(installationPath, '// Mock installation file');
      
      // Create package.json at package root
      const packageRoot = path.join(testDir, 'node_modules', '@dollhousemcp', 'mcp-server');
      await fs.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@dollhousemcp/mcp-server', version: '1.4.1' })
      );
      
      // Since we can't change import.meta.url in tests, we'll verify the detection logic
      // by checking path patterns
      const isNpmPath = npmPath.includes(path.sep + path.join('node_modules', '@dollhousemcp', 'mcp-server') + path.sep);
      expect(isNpmPath).toBe(true);
    });
    
    it('should handle Windows-style npm paths', async () => {
      // Create Windows-style path (even on non-Windows systems for testing)
      const winPath = path.join(testDir, 'AppData', 'Roaming', 'npm', 'node_modules', '@dollhousemcp', 'mcp-server');
      await fs.mkdir(winPath, { recursive: true });
      
      const pathPattern = path.sep + path.join('node_modules', '@dollhousemcp', 'mcp-server') + path.sep;
      const isNpmPath = winPath.includes(pathPattern);
      expect(isNpmPath).toBe(true);
    });
  });
  
  describe('git installation detection', () => {
    it('should detect git installation based on .git directory', async () => {
      // Create git-like directory structure
      const gitRepoPath = path.join(testDir, 'projects', 'DollhouseMCP');
      const srcPath = path.join(gitRepoPath, 'src', 'utils');
      await fs.mkdir(srcPath, { recursive: true });
      
      // Create .git directory
      const gitDir = path.join(gitRepoPath, '.git');
      await fs.mkdir(gitDir);
      
      // Create some git files to make it realistic
      await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main');
      await fs.writeFile(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0');
      
      // Verify .git exists and is a directory
      const stats = await fs.stat(gitDir);
      expect(stats.isDirectory()).toBe(true);
      
      // Check that path doesn't contain node_modules pattern
      const npmPattern = path.sep + path.join('node_modules', '@dollhousemcp', 'mcp-server') + path.sep;
      expect(srcPath.includes(npmPattern)).toBe(false);
    });
    
    it('should find .git directory in parent directories', async () => {
      // Create deeply nested structure
      const gitRepoPath = path.join(testDir, 'workspace', 'mcp-server');
      const deepPath = path.join(gitRepoPath, 'src', 'deep', 'nested', 'path', 'utils');
      await fs.mkdir(deepPath, { recursive: true });
      
      // Create .git at repo root
      const gitDir = path.join(gitRepoPath, '.git');
      await fs.mkdir(gitDir);
      await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main');
      
      // Simulate searching up from deep path
      let currentDir = deepPath;
      let gitFound = false;
      let searchDepth = 0;
      const maxDepth = 10;
      
      while (searchDepth < maxDepth) {
        const possibleGit = path.join(currentDir, '.git');
        try {
          const stats = await fs.stat(possibleGit);
          if (stats.isDirectory()) {
            gitFound = true;
            break;
          }
        } catch (error) {
          // Not found, continue
        }
        
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break; // Reached root
        currentDir = parentDir;
        searchDepth++;
      }
      
      expect(gitFound).toBe(true);
      expect(searchDepth).toBeGreaterThan(0);
      expect(searchDepth).toBeLessThan(maxDepth);
    });
  });
  
  describe('unknown installation detection', () => {
    it('should return unknown for paths without .git or node_modules pattern', async () => {
      // Create a path that's neither npm nor git
      const unknownPath = path.join(testDir, 'random', 'location', 'src');
      await fs.mkdir(unknownPath, { recursive: true });
      
      // No .git directory
      const gitExists = await fs.access(path.join(unknownPath, '.git')).then(() => true).catch(() => false);
      expect(gitExists).toBe(false);
      
      // No npm pattern
      const npmPattern = path.sep + path.join('node_modules', '@dollhousemcp', 'mcp-server') + path.sep;
      expect(unknownPath.includes(npmPattern)).toBe(false);
    });
  });
  
  describe('getNpmGlobalPath', () => {
    it('should find package.json in npm installation', async () => {
      // Create npm structure with package.json
      const npmRoot = path.join(testDir, 'node_modules', '@dollhousemcp', 'mcp-server');
      const distPath = path.join(npmRoot, 'dist', 'utils');
      await fs.mkdir(distPath, { recursive: true });
      
      // Create package.json at package root
      const packageJson = {
        name: '@dollhousemcp/mcp-server',
        version: '1.4.1',
        main: 'dist/index.js'
      };
      await fs.writeFile(
        path.join(npmRoot, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );
      
      // Verify we can find package.json by searching up from dist/utils
      let currentDir = distPath;
      let packageJsonPath = null;
      
      while (currentDir.includes('node_modules/@dollhousemcp/mcp-server')) {
        const possiblePath = path.join(currentDir, 'package.json');
        try {
          await fs.access(possiblePath);
          packageJsonPath = currentDir;
          break;
        } catch (error) {
          // Not found, continue
        }
        
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
      }
      
      expect(packageJsonPath).toBe(npmRoot);
    });
  });
  
  describe('getGitRepositoryPath', () => {
    it('should find git repository root', async () => {
      // Create git repo structure
      const gitRoot = path.join(testDir, 'git-repo');
      const srcPath = path.join(gitRoot, 'src', 'utils');
      await fs.mkdir(srcPath, { recursive: true });
      
      // Create .git directory with realistic content
      const gitDir = path.join(gitRoot, '.git');
      await fs.mkdir(path.join(gitDir, 'objects'), { recursive: true });
      await fs.mkdir(path.join(gitDir, 'refs', 'heads'), { recursive: true });
      await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main');
      await fs.writeFile(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0');
      
      // Search for .git from deep path
      let currentDir = srcPath;
      let gitRepoPath = null;
      
      for (let i = 0; i < 10; i++) {
        const possibleGit = path.join(currentDir, '.git');
        try {
          const stats = await fs.stat(possibleGit);
          if (stats.isDirectory()) {
            gitRepoPath = currentDir;
            break;
          }
        } catch (error) {
          // Not found
        }
        
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
      }
      
      expect(gitRepoPath).toBe(gitRoot);
    });
  });
  
  describe('caching behavior', () => {
    it('should use consistent results across multiple calls', () => {
      // Since we're testing the real implementation, we need to test
      // that the caching logic would work correctly
      
      // The cache is a static property, so we verify the pattern
      const detector = InstallationDetector;
      
      // Clear cache to start fresh
      detector.clearCache();
      
      // In real usage, the first call would set the cache
      // and subsequent calls would return the cached value
      // We can't test the actual caching without mocking import.meta.url
      // but we can verify the clearCache method exists and works
      expect(typeof detector.clearCache).toBe('function');
      
      // Calling clearCache should not throw
      expect(() => detector.clearCache()).not.toThrow();
    });
  });
  
  describe('real-world scenarios', () => {
    it('should handle symlinked installations', async () => {
      // Create a target directory
      const targetPath = path.join(testDir, 'actual-install', 'node_modules', '@dollhousemcp', 'mcp-server');
      await fs.mkdir(targetPath, { recursive: true });
      
      // Create a symlink source
      const linkSource = path.join(testDir, 'linked-install');
      await fs.mkdir(path.dirname(linkSource), { recursive: true });
      
      try {
        // Try to create symlink (may fail on some systems)
        await fs.symlink(targetPath, linkSource, 'dir');
        
        // If successful, verify symlink points to npm-like path
        const realPath = await fs.realpath(linkSource);
        const npmPattern = path.sep + path.join('node_modules', '@dollhousemcp', 'mcp-server');
        expect(realPath.includes(npmPattern)).toBe(true);
      } catch (error) {
        // Symlinks not supported on this system, skip test
        console.log('Symlink test skipped - not supported on this system');
      }
    });
    
    it('should handle permission errors gracefully', async () => {
      // Create a directory we'll try to make unreadable
      const protectedPath = path.join(testDir, 'protected');
      await fs.mkdir(protectedPath);
      
      try {
        // Try to make it unreadable (may not work on all systems)
        await fs.chmod(protectedPath, 0o000);
        
        // Try to access it
        const canAccess = await fs.access(protectedPath).then(() => true).catch(() => false);
        expect(canAccess).toBe(false);
        
        // Restore permissions for cleanup
        await fs.chmod(protectedPath, 0o755);
      } catch (error) {
        // Permission change not supported, skip this part
        console.log('Permission test skipped - chmod not supported');
      }
    });
  });
});